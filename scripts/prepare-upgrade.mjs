#!/usr/bin/env node
import {
  createPublicClient, createWalletClient, encodeFunctionData, encodeDeployData, http, keccak256, parseAbi, parseGwei,
  toFunctionSelector,
} from 'viem'
import { mainnet } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { createWaitForBaseRunner, DEFAULTS } from './gas-tools.mjs'
import { entryFailures, loadGovernance } from './governance-check.mjs'
import {
  ERC1967_ADMIN_SLOT, ERC1967_IMPLEMENTATION_SLOT, UPGRADEABLE,
  artifact, assertBuildFresh, constructorArgs, proxyAdminOf, proxySlots, runtimeCode, storageLayout,
} from './stack.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TLD = 'simplex'
const addressesPath = join(REPO_ROOT, `deployments.mainnet.${TLD}.json`)
const verificationPath = join(REPO_ROOT, `verification.mainnet.${TLD}.json`)
const journalPath = join(REPO_ROOT, `deployments.mainnet.${TLD}.upgrades.journal.jsonl`)
const attemptsLogPath = join(REPO_ROOT, `deployments.mainnet.${TLD}.upgrades.attempts.log`)
const UUPS_SELECTORS = new Set(['0x3659cfe6', '0x4f1ef286', '0x52d1902d'])
const PROXY_ADMIN_ABI = parseAbi([
  'function owner() view returns (address)',
  'function renounceOwnership()',
  'function transferOwnership(address newOwner)',
  'function upgradeAndCall(address proxy, address implementation, bytes data) payable',
])

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

async function checkedProxyAdmin(client, addresses, name) {
  const proxy = addresses[UPGRADEABLE[name].key]
  const { implementation, admin } = await proxySlots(client, proxy)
  return admin === proxyAdminOf(proxy)
    ? { name, proxy, implementation, proxyAdmin: admin }
    : { refused: [`the admin slot of the ${name} proxy ${proxy} holds ${admin}, not ${proxyAdminOf(proxy)}`] }
}

export async function proxyAdminTarget(client, addresses, target) {
  const admins = await Promise.all(Object.keys(UPGRADEABLE).map((name) => checkedProxyAdmin(client, addresses, name)))
  const refused = admins.flatMap((admin) => admin.refused ?? [])
  if (refused.length) return { refused }
  return admins.find(({ proxyAdmin }) => proxyAdmin.toLowerCase() === target.toLowerCase())
    ?? { refused: [`${target} is not the ProxyAdmin of any of the six proxies of ${addressesPath}`] }
}

export async function prepareUpgrade({ deploy }, client, name, addresses, verification, deployer) {
  const definition = UPGRADEABLE[name]
  const admin = await checkedProxyAdmin(client, addresses, name)
  if (admin.refused) return admin
  const recorded = Object.values(verification.contracts)
    .find(({ address, storageLayout }) => address.toLowerCase() === admin.implementation.toLowerCase() && storageLayout)
  if (!recorded) throw new Error(`${verificationPath} records no storage layout for ${admin.implementation}, the implementation of ${name}`)
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
    ...admin,
    candidate,
    entry: { address: candidate, artifact: definition.artifact, constructorArgs: constructorArgs(compiled.abi, args), storageLayout: layout },
  }
}

function requireEnv(...names) {
  const missing = names.filter((name) => !process.env[name])
  if (missing.length) {
    console.error(`ERROR: ${missing.join(', ')} env var(s) required.`)
    process.exit(1)
  }
  return names.map((name) => process.env[name])
}

const ACTIONS = {
  upgrade: async (client, addresses) => {
    const name = process.env.CONTRACT
    if (!UPGRADEABLE[name]) return { refused: [`CONTRACT must be one of ${Object.keys(UPGRADEABLE).join(', ')}`] }
    const [deployerKey, rpcUrl, maxBaseFeeGwei] = requireEnv('DEPLOYER_KEY', 'MAINNET_RPC_URL', 'MAX_BASE_FEE_GWEI')
    const account = privateKeyToAccount(deployerKey)
    const walletClient = createWalletClient({ chain: mainnet, transport: http(rpcUrl), account })
    assertBuildFresh()
    const verification = JSON.parse(readFileSync(verificationPath, 'utf8'))
    const runner = createWaitForBaseRunner({
      publicClient: client, walletClient, account,
      maxBaseFeeWei: parseGwei(maxBaseFeeGwei),
      bumpAfterMs: DEFAULTS.BUMP_AFTER_MS, bumpPct: DEFAULTS.BUMP_PCT,
      journalPath, attemptsLogPath,
    })
    const prepared = await prepareUpgrade(runner, client, name, addresses, verification, account.address)
    if (prepared.refused) return prepared
    verification.contracts[`${name}@${prepared.candidate}`] = prepared.entry
    writeFileSync(verificationPath, JSON.stringify(verification, null, 2))
    console.log(`✓ ${name} candidate ${prepared.candidate} keeps the storage layout and the deployment's immutables`)
    console.log(`Wrote ${verificationPath}: commit it and verify the candidate on Etherscan before the upgrade.`)
    return { target: prepared, functionName: 'upgradeAndCall', args: [prepared.proxy, prepared.candidate, '0x'] }
  },
  freeze: async (client, addresses) => {
    const [proxyAdmin] = requireEnv('PROXY_ADMIN')
    const target = await proxyAdminTarget(client, addresses, proxyAdmin)
    return target.refused ? target : { target, functionName: 'renounceOwnership', args: [] }
  },
  transfer: async (client, addresses) => {
    const [proxyAdmin, nextName] = requireEnv('PROXY_ADMIN', 'NEXT')
    const next = loadGovernance()[nextName]
    if (next?.kind !== 'Safe' && next?.kind !== 'TimelockController') {
      return { refused: [`NEXT must name a Safe or TimelockController entry of governance.mainnet.json, not ${nextName}`] }
    }
    const { deployer } = JSON.parse(readFileSync(verificationPath, 'utf8'))
    const failures = await entryFailures(client, next, deployer)
    if (failures.length) return { refused: failures.map((failure) => `${nextName} ${next.address} ${failure}`) }
    const target = await proxyAdminTarget(client, addresses, proxyAdmin)
    return target.refused ? target : { target, functionName: 'transferOwnership', args: [next.address] }
  },
}

async function main() {
  const action = ACTIONS[process.env.ACTION]
  if (!action) {
    console.error(`ACTION must be one of ${Object.keys(ACTIONS).join(', ')} (got ${JSON.stringify(process.env.ACTION)})`)
    process.exit(1)
  }
  const [rpcUrl] = requireEnv('MAINNET_RPC_URL')
  const client = createPublicClient({ chain: mainnet, transport: http(rpcUrl) })
  if ((await client.getChainId()) !== mainnet.id) {
    console.error('MAINNET_RPC_URL is not mainnet')
    process.exit(1)
  }
  const call = await action(client, JSON.parse(readFileSync(addressesPath, 'utf8')))
  if (call.refused) {
    console.error(`${process.env.ACTION} refused:`)
    for (const failure of call.refused) console.error(`  ✗ ${failure}`)
    process.exit(1)
  }
  const { target: { name, proxy, proxyAdmin }, functionName, args } = call
  const owner = await client.readContract({ address: proxyAdmin, abi: PROXY_ADMIN_ABI, functionName: 'owner' })
  console.log(`\nThe ProxyAdmin owner ${owner} submits to the ProxyAdmin ${proxyAdmin} of ${name}, not to its proxy ${proxy}:`)
  console.log(`  ${functionName}(${args.join(', ')})`)
  console.log(`  calldata ${encodeFunctionData({ abi: PROXY_ADMIN_ABI, functionName, args })}`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
