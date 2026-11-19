#!/usr/bin/env node
import { createPublicClient, createWalletClient, encodeFunctionData, encodeDeployData, http, keccak256, parseGwei, toFunctionSelector } from 'viem'
import { mainnet } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { createWaitForBaseRunner, DEFAULTS } from './gas-tools.mjs'
import {
  ERC1967_ADMIN_SLOT, ERC1967_IMPLEMENTATION_SLOT, OWNABLE_ABI, PROXY_ADMIN, UPGRADEABLE,
  artifact, assertBuildFresh, constructorArgs, proxySlots, runtimeCode, storageLayout,
} from './stack.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TLD = 'simplex'
const addressesPath = join(REPO_ROOT, `deployments.mainnet.${TLD}.json`)
const verificationPath = join(REPO_ROOT, `verification.mainnet.${TLD}.json`)
const journalPath = join(REPO_ROOT, `deployments.mainnet.${TLD}.upgrades.journal.jsonl`)
const attemptsLogPath = join(REPO_ROOT, `deployments.mainnet.${TLD}.upgrades.attempts.log`)
const UUPS_SELECTORS = new Set(['0x3659cfe6', '0x4f1ef286', '0x52d1902d'])

const qualified = ({ contract, label }) => `${contract}.${label}`
const isGap = (variable) => variable?.label === '__gap'
const endSlot = ({ slot, type }) => BigInt(slot) + BigInt(type.numberOfBytes) / 32n
const place = ({ slot, offset, type }) => `slot ${slot}, offset ${offset}, ${type.label}`

export function layoutFailures(current, candidate) {
  const gap = isGap(current.at(-1)) ? current.at(-1) : undefined
  const byName = new Map(candidate.map((variable) => [qualified(variable), variable]))
  const moved = (gap ? current.slice(0, -1) : current).flatMap((variable) => {
    const next = byName.get(qualified(variable))
    if (!next) return [`${qualified(variable)} is gone`]
    const same = next.slot === variable.slot && next.offset === variable.offset &&
      JSON.stringify(next.type) === JSON.stringify(variable.type)
    return same ? [] : [`${qualified(variable)} moved from ${place(variable)} to ${place(next)}`]
  })
  const last = candidate.at(-1)
  const gapMoved = gap && !(isGap(last) && qualified(last) === qualified(gap) && endSlot(last) === endSlot(gap))
    ? [`the candidate does not end with ${qualified(gap)} ending at slot ${endSlot(gap)}`]
    : []
  return [...moved, ...gapMoved]
}

export function interfaceFailures(abi) {
  return abi.flatMap((item) => {
    if (item.type === 'fallback' || item.type === 'receive') return [`has a ${item.type} function`]
    const selector = item.type === 'function' ? toFunctionSelector(item) : undefined
    return UUPS_SELECTORS.has(selector) ? [`has ${item.name}, selector ${selector}`] : []
  })
}

export function slotFailures(bytecode) {
  const code = Buffer.from(bytecode.slice(2), 'hex')
  return [['implementation', ERC1967_IMPLEMENTATION_SLOT], ['admin', ERC1967_ADMIN_SLOT]]
    .filter(([, slot]) => code.includes(Buffer.from(slot.slice(2), 'hex')))
    .map(([which]) => `its bytecode contains the ERC-1967 ${which} slot`)
}

export function artifactFailures({ abi, deployedBytecode }, layout, currentLayout) {
  return [...layoutFailures(currentLayout, layout), ...interfaceFailures(abi), ...slotFailures(deployedBytecode)]
}

export const codeFailures = (code, expected) =>
  code === expected ? [] : [`its runtime code is not the artifact with the deployment's immutables (code hash ${code && keccak256(code)})`]

export async function prepareUpgrade({ deploy }, client, name, addresses, verification, deployer) {
  const definition = UPGRADEABLE[name]
  const proxy = addresses[definition.key]
  const { implementation: current, admin } = await proxySlots(client, proxy)
  const recorded = Object.values(verification.contracts)
    .find(({ address, storageLayout }) => address.toLowerCase() === current.toLowerCase() && storageLayout)
  if (!recorded) throw new Error(`${verificationPath} records no storage layout for ${current}, the implementation of ${name}`)
  const compiled = artifact(definition.artifact)
  const layout = storageLayout(compiled)
  const refused = artifactFailures(compiled, layout, recorded.storageLayout)
  if (refused.length) return { refused }

  const args = definition.args(addresses, { tld: TLD })
  const initcode = encodeDeployData({ abi: compiled.abi, bytecode: compiled.bytecode, args })
  const { address: candidate } = await deploy(`${name}@${keccak256(initcode).slice(0, 18)}`, compiled.abi, compiled.bytecode, args)
  const expected = runtimeCode(compiled, definition.immutables(addresses, { tld: TLD, deployer, self: candidate }))
  const failures = codeFailures(await client.getCode({ address: candidate }), expected)
  if (failures.length) return { refused: failures, candidate }
  return {
    candidate,
    proxy,
    proxyAdmin: admin,
    entry: { address: candidate, artifact: definition.artifact, constructorArgs: constructorArgs(compiled.abi, args), storageLayout: layout },
  }
}

async function main() {
  const name = process.env.CONTRACT
  if (!UPGRADEABLE[name]) {
    console.error(`CONTRACT must be one of ${Object.keys(UPGRADEABLE).join(', ')} (got ${JSON.stringify(name)})`)
    process.exit(1)
  }
  for (const required of ['DEPLOYER_KEY', 'MAINNET_RPC_URL', 'MAX_BASE_FEE_GWEI']) {
    if (!process.env[required]) {
      console.error(`ERROR: ${required} env var is required.`)
      process.exit(1)
    }
  }
  const account = privateKeyToAccount(process.env.DEPLOYER_KEY)
  const transport = http(process.env.MAINNET_RPC_URL)
  const publicClient = createPublicClient({ chain: mainnet, transport })
  const walletClient = createWalletClient({ chain: mainnet, transport, account })
  if ((await publicClient.getChainId()) !== mainnet.id) {
    console.error('MAINNET_RPC_URL is not mainnet')
    process.exit(1)
  }
  assertBuildFresh()
  const addresses = JSON.parse(readFileSync(addressesPath, 'utf8'))
  const verification = JSON.parse(readFileSync(verificationPath, 'utf8'))
  const runner = createWaitForBaseRunner({
    publicClient, walletClient, account,
    maxBaseFeeWei: parseGwei(process.env.MAX_BASE_FEE_GWEI),
    bumpAfterMs: DEFAULTS.BUMP_AFTER_MS, bumpPct: DEFAULTS.BUMP_PCT,
    journalPath, attemptsLogPath,
  })
  const prepared = await prepareUpgrade(runner, publicClient, name, addresses, verification, account.address)
  if (prepared.refused) {
    console.error(`${name} candidate${prepared.candidate ? ` ${prepared.candidate}` : ''} refused:`)
    for (const failure of prepared.refused) console.error(`  ✗ ${failure}`)
    process.exit(1)
  }
  verification.contracts[`${name}@${prepared.candidate}`] = prepared.entry
  writeFileSync(verificationPath, JSON.stringify(verification, null, 2))
  const owner = await publicClient.readContract({ address: prepared.proxyAdmin, abi: OWNABLE_ABI, functionName: 'owner' })
  const data = encodeFunctionData({
    abi: artifact(PROXY_ADMIN).abi,
    functionName: 'upgradeAndCall',
    args: [prepared.proxy, prepared.candidate, '0x'],
  })
  console.log(`\n✓ ${name} candidate ${prepared.candidate} keeps the storage layout and the deployment's immutables`)
  console.log(`Wrote ${verificationPath}: commit it and verify the candidate on Etherscan before the upgrade.`)
  console.log(`\nThe ProxyAdmin owner ${owner} submits to the ProxyAdmin ${prepared.proxyAdmin}:`)
  console.log(`  upgradeAndCall(${prepared.proxy}, ${prepared.candidate}, 0x)`)
  console.log(`  calldata ${data}`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
