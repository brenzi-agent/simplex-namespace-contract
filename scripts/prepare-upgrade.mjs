#!/usr/bin/env node
import {
  BaseError, ContractFunctionRevertedError, createWalletClient, encodeFunctionData, encodeDeployData, http, keccak256,
  pad, parseAbi, parseGwei, toFunctionSelector, zeroAddress,
} from 'viem'
import { mainnet } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { createWaitForBaseRunner, promptYesNo, DEFAULTS } from './gas-tools.mjs'
import { entryFailures, loadGovernance } from './governance-check.mjs'
import {
  ADDRESSES_PATH, ERC1967_ADMIN_SLOT, ERC1967_IMPLEMENTATION_SLOT, REPO_ROOT, TLD, UPGRADEABLE, VERIFICATION_PATH,
  artifact, assertBuildFresh, assertTaggedSource, constructorArgs, immutableNames, immutablesIn, mainnetClient,
  placeImmutables, proxyAdminOf, proxySlots, requireEnv, storageLayout, storedValue,
} from './stack.mjs'

const journalPath = join(REPO_ROOT, `deployments.mainnet.${TLD}.upgrades.journal.jsonl`)
const attemptsLogPath = join(REPO_ROOT, `deployments.mainnet.${TLD}.upgrades.attempts.log`)
const UUPS_SELECTORS = new Set(['0x3659cfe6', '0x4f1ef286', '0x52d1902d'])
const PROXY_ADMIN_ABI = parseAbi([
  'function owner() view returns (address)',
  'function renounceOwnership()',
  'function transferOwnership(address newOwner)',
  'function upgradeAndCall(address proxy, address implementation, bytes data) payable',
])
const PROXY_ADMIN_PLACEHOLDER = 'proxyAdmin'

const qualified = ({ contract, label }) => `${contract}.${label}`
const isGap = (variable) => variable?.label === '__gap'
const endSlot = ({ slot, type }) => BigInt(slot) + BigInt(type.numberOfBytes) / 32n
const place = ({ slot, offset, type }) => `slot ${slot}, offset ${offset}, ${type.label}`
const follows = (variable, end) =>
  BigInt(variable.slot) > BigInt(end.slot) || (variable.slot === end.slot && variable.offset > end.offset)
const prefixOf = (current = [], next = []) => current.every((value, i) => next[i] === value)
const samePart = (current, next) => (current === undefined ? next === undefined : next !== undefined && sameType(current, next))
const sameMembers = (current = [], next = []) => current.length === next.length && current.every((member, i) =>
  member.label === next[i].label && place(member) === place(next[i]) && sameType(member.type, next[i].type))

function sameType(current, next) {
  return current.label === next.label &&
    current.encoding === next.encoding &&
    current.numberOfBytes === next.numberOfBytes &&
    prefixOf(current.enumValues, next.enumValues) &&
    sameMembers(current.members, next.members) &&
    samePart(current.key, next.key) &&
    samePart(current.value, next.value) &&
    samePart(current.base, next.base)
}

export function layoutFailures(current, candidate) {
  const gap = isGap(current.at(-1)) ? current.at(-1) : undefined
  const kept = gap ? current.slice(0, -1) : current
  const byName = new Map(candidate.map((variable) => [qualified(variable), variable]))
  const known = new Set(current.map(qualified))
  const end = kept.at(-1)
  const inserted = end
    ? candidate.filter((variable) => !known.has(qualified(variable)) && !follows(variable, end))
      .map((variable) => `${qualified(variable)} is new at ${place(variable)}, inside the current layout, which ends at ${place(end)}`)
    : []
  const moved = kept.flatMap((variable) => {
    const next = byName.get(qualified(variable))
    if (!next) return [`${qualified(variable)} is gone`]
    if (place(next) !== place(variable)) return [`${qualified(variable)} changed from ${place(variable)} to ${place(next)}`]
    return sameType(variable.type, next.type)
      ? []
      : [`${qualified(variable)}: the layout inside ${variable.type.label} changed`]
  })
  const last = candidate.at(-1)
  const gapMoved = gap && !(isGap(last) && qualified(last) === qualified(gap) && endSlot(last) === endSlot(gap))
    ? [`the candidate does not end with ${qualified(gap)} ending at slot ${endSlot(gap)}`]
    : []
  return [...moved, ...inserted, ...gapMoved]
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

export function artifactFailures({ abi, deployedBytecode, immutableReferences }, names, layout, current, intended) {
  const immutables = Object.keys(immutableReferences).map((id) => names.get(Number(id)))
  return [
    ...layoutFailures(current.storageLayout, layout),
    ...interfaceFailures(abi),
    ...slotFailures(deployedBytecode),
    ...Object.keys(current.immutables).filter((name) => !immutables.includes(name) && !intended.includes(name))
      .map((name) => `it has no immutable named ${name}, which the current implementation holds as ${current.immutables[name]}`),
    ...intended.filter((name) => !immutables.includes(name) && !Object.hasOwn(current.immutables, name))
      .map((name) => `neither it nor the current implementation has an immutable named ${name}`),
  ]
}

export function immutableReview(compiled, names, code, current, own, intended) {
  const found = immutablesIn(compiled, names, code)
  const word = (value) => value && pad(value).toLowerCase()
  const expected = Object.fromEntries(Object.keys(found).map((name) =>
    [name, Object.hasOwn(own, name) ? own[name] : intended.includes(name) ? found[name] : current[name]]))
  return {
    failures: [
      ...Object.keys(found).filter((name) => word(found[name]) !== word(expected[name]))
        .map((name) => `its immutable ${name} is ${found[name]}, expected ${expected[name] ?? 'none: the current implementation has no such immutable'}`),
      ...(code === placeImmutables(compiled, names, found) ? [] : ['its runtime code differs from the artifact outside its immutables']),
    ],
    changes: intended.map((name) => ({ name, current: current[name], next: found[name] })),
  }
}

export function ownImmutables(name, addresses, deployer, candidate, proxyAdmin) {
  const definition = UPGRADEABLE[name]
  const fresh = definition.immutables(addresses, { tld: TLD, deployer, self: candidate })
  return {
    ...Object.fromEntries((definition.ownImmutables ?? []).map((immutable) => [immutable, fresh[immutable]])),
    _proxyAdmin: proxyAdmin,
  }
}

export function upgradeData(abi, call) {
  if (!call) return { data: '0x' }
  const { signature, args } = call
  try {
    const selector = toFunctionSelector(signature)
    const item = abi.find((entry) => entry.type === 'function' && toFunctionSelector(entry) === selector)
    if (!item) return { refused: [`it has no function ${signature}`] }
    return { data: encodeFunctionData({ abi: [item], functionName: item.name, args }) }
  } catch (error) {
    return { refused: [`DATA ${signature} with DATA_ARGS ${JSON.stringify(args)} does not encode: ${error.shortMessage ?? error.message}`] }
  }
}

function constructorFailures(abi, args) {
  try {
    constructorArgs(abi, args)
    return []
  } catch (error) {
    return [`CTOR_ARGS ${JSON.stringify(args)} do not encode for its constructor: ${error.shortMessage ?? error.message}`]
  }
}

export async function upgradeCallFailures(client, { proxy, proxyAdmin, owner }, candidate, data, errors = []) {
  try {
    await client.simulateContract({
      account: owner, address: proxyAdmin, abi: [...PROXY_ADMIN_ABI, ...errors], functionName: 'upgradeAndCall',
      args: [proxy, candidate, data],
    })
    return []
  } catch (error) {
    const reverted = error instanceof BaseError && error.walk((cause) => cause instanceof ContractFunctionRevertedError)
    if (!reverted) throw error
    return [`upgradeAndCall(${proxy}, ${candidate}, ${data}) from ${owner} reverts: ${reverted.shortMessage.replaceAll('\n', ' ')}`]
  }
}

export async function checkedProxyAdmin(client, addresses, name) {
  if (!Object.hasOwn(UPGRADEABLE, name)) {
    return { refused: [`CONTRACT must be one of ${Object.keys(UPGRADEABLE).join(', ')}, not ${name}`] }
  }
  const proxy = addresses[UPGRADEABLE[name].key]
  const { implementation, admin } = await proxySlots(client, proxy)
  if (admin !== proxyAdminOf(proxy)) {
    return { refused: [`the admin slot of the ${name} proxy ${proxy} holds ${admin}, not ${proxyAdminOf(proxy)}`] }
  }
  const owner = await client.readContract({ address: admin, abi: PROXY_ADMIN_ABI, functionName: 'owner' })
  return owner === zeroAddress
    ? { refused: [`the ProxyAdmin ${admin} of ${name} is renounced`] }
    : { name, proxy, implementation, proxyAdmin: admin, owner }
}

export async function transferCall(client, addresses, governance, name, nextName, deployer) {
  const next = governance[nextName]
  if (next?.kind !== 'TimelockController') {
    return { refused: [`NEXT must name a TimelockController entry of governance.mainnet.json, not ${nextName}`] }
  }
  const failures = await entryFailures(client, next, deployer)
  if (failures.length) return { refused: failures.map((failure) => `${nextName} ${next.address} ${failure}`) }
  const target = await checkedProxyAdmin(client, addresses, name)
  return target.refused ? target : { target, functionName: 'transferOwnership', args: [next.address] }
}

export async function prepareUpgrade({ deploy }, client, name, addresses, verification, deployer, request = {}) {
  const { intended = [], constructorArgs: requestedArgs, call } = request
  const definition = UPGRADEABLE[name]
  const admin = await checkedProxyAdmin(client, addresses, name)
  if (admin.refused) return admin
  const current = Object.values(verification.contracts).find(({ address, storageLayout, immutables }) =>
    address.toLowerCase() === admin.implementation.toLowerCase() && storageLayout && immutables)
  if (!current) throw new Error(`${VERIFICATION_PATH} does not record ${admin.implementation}, the implementation of ${name}`)
  const compiled = artifact(definition.artifact)
  const names = immutableNames(compiled)
  const layout = storageLayout(compiled)
  const args = (requestedArgs ?? definition.args(addresses, { tld: TLD }))
    .map((arg) => (arg === PROXY_ADMIN_PLACEHOLDER ? admin.proxyAdmin : arg))
  const { data, refused: undecodable = [] } = upgradeData(compiled.abi, call)
  const refused = [
    ...artifactFailures(compiled, names, layout, current, intended),
    ...constructorFailures(compiled.abi, args),
    ...undecodable,
  ]
  if (refused.length) return { refused }

  const initcode = encodeDeployData({ abi: compiled.abi, bytecode: compiled.bytecode, args })
  const { address: candidate } = await deploy(`${name}@${keccak256(initcode).slice(0, 18)}`, compiled.abi, compiled.bytecode, args)
  const code = await client.getCode({ address: candidate })
  const own = ownImmutables(name, addresses, deployer, candidate, admin.proxyAdmin)
  const { failures, changes } = immutableReview(compiled, names, code, current.immutables, own, intended)
  const initialized = definition.initialize ? await storedValue(client, candidate, compiled, '_initialized') : 255n
  const uninitialized = initialized === 255n ? [] : [`its _initialized is ${initialized}, not 255`]
  const errors = compiled.abi.filter(({ type }) => type === 'error')
  const reverting = await upgradeCallFailures(client, admin, candidate, data, errors)
  if (failures.length || uninitialized.length || reverting.length) {
    return { refused: [...failures, ...uninitialized, ...reverting], candidate }
  }
  return {
    ...admin,
    candidate,
    data,
    changes,
    entry: {
      address: candidate,
      artifact: definition.artifact,
      constructorArgs: constructorArgs(compiled.abi, args),
      storageLayout: layout,
      immutables: immutablesIn(compiled, names, code),
      buildInfoId: compiled.buildInfoId,
    },
  }
}

function jsonArrayEnv(name) {
  const text = process.env[name]
  if (text === undefined) return undefined
  let value
  try { value = JSON.parse(text) } catch {}
  if (!Array.isArray(value)) {
    console.error(`${name} must be a JSON array, not ${text}`)
    process.exit(1)
  }
  return value
}

const ACTIONS = {
  upgrade: async (client, addresses, name) => {
    const deployerKey = requireEnv('DEPLOYER_KEY')
    const rpcUrl = requireEnv('MAINNET_RPC_URL')
    const maxBaseFeeGwei = requireEnv('MAX_BASE_FEE_GWEI')
    const request = {
      intended: (process.env.INTENDED ?? '').split(',').filter(Boolean),
      constructorArgs: jsonArrayEnv('CTOR_ARGS'),
      call: process.env.DATA ? { signature: process.env.DATA, args: jsonArrayEnv('DATA_ARGS') ?? [] } : undefined,
    }
    const account = privateKeyToAccount(deployerKey)
    const walletClient = createWalletClient({ chain: mainnet, transport: http(rpcUrl), account })
    const source = assertTaggedSource()
    assertBuildFresh()
    const verification = JSON.parse(readFileSync(VERIFICATION_PATH, 'utf8'))
    const runner = createWaitForBaseRunner({
      publicClient: client, walletClient, account,
      maxBaseFeeWei: parseGwei(maxBaseFeeGwei),
      bumpAfterMs: DEFAULTS.BUMP_AFTER_MS, bumpPct: DEFAULTS.BUMP_PCT,
      journalPath, attemptsLogPath,
    })
    const confirmed = {
      ...runner,
      deploy: async (step, abi, bytecode, args) => {
        if (!runner.completedSteps().has(`deploy:${step}`)) {
          console.log(`\nThe deploy key ${account.address} deploys the ${name} candidate ${step}, built from ens-contracts ` +
            `${source.commit} (${source.tags.join(', ')}), with constructor arguments (${args.join(', ')}), ` +
            `at a base fee of at most ${maxBaseFeeGwei} gwei.`)
          if (!(await promptYesNo('Proceed? [y/N] '))) throw new Error(`the ${name} candidate was not deployed`)
        }
        return runner.deploy(step, abi, bytecode, args)
      },
    }
    const prepared = await prepareUpgrade(confirmed, client, name, addresses, verification, account.address, request)
    if (prepared.refused) return prepared
    verification.contracts[`${name}@${prepared.candidate}`] = { ...prepared.entry, ensContractsCommit: source.commit }
    writeFileSync(VERIFICATION_PATH, JSON.stringify(verification, null, 2))
    console.log(`✓ ${name} candidate ${prepared.candidate} keeps the storage layout and the current immutables`)
    for (const { name: immutable, current, next } of prepared.changes) {
      console.log(`  intended change of ${immutable}: ${current ?? 'none'} → ${next ?? 'none'}`)
    }
    console.log(`  upgradeAndCall from the ProxyAdmin owner ${prepared.owner} succeeds in a simulation`)
    console.log(`Wrote ${VERIFICATION_PATH}: commit it and verify the candidate on Etherscan before the upgrade.`)
    return { target: prepared, functionName: 'upgradeAndCall', args: [prepared.proxy, prepared.candidate, prepared.data] }
  },
  freeze: async (client, addresses, name) => {
    const target = await checkedProxyAdmin(client, addresses, name)
    return target.refused ? target : { target, functionName: 'renounceOwnership', args: [] }
  },
  transfer: async (client, addresses, name) => {
    const { deployer } = JSON.parse(readFileSync(VERIFICATION_PATH, 'utf8'))
    return transferCall(client, addresses, loadGovernance(), name, requireEnv('NEXT'), deployer)
  },
}

async function main() {
  const action = ACTIONS[process.env.ACTION]
  if (!action) {
    console.error(`ACTION must be one of ${Object.keys(ACTIONS).join(', ')} (got ${JSON.stringify(process.env.ACTION)})`)
    process.exit(1)
  }
  const client = await mainnetClient(requireEnv('MAINNET_RPC_URL'))
  const call = await action(client, JSON.parse(readFileSync(ADDRESSES_PATH, 'utf8')), requireEnv('CONTRACT'))
  if (call.refused) {
    console.error(`${process.env.ACTION} refused:`)
    for (const failure of call.refused) console.error(`  ✗ ${failure}`)
    process.exit(1)
  }
  const { target: { name, proxy, implementation, proxyAdmin, owner }, functionName, args } = call
  console.log(`\nThe implementation slot of the ${name} proxy ${proxy} holds ${implementation}.`)
  console.log(`The ProxyAdmin owner ${owner} submits to the ProxyAdmin ${proxyAdmin} of ${name}, not to its proxy:`)
  console.log(`  ${functionName}(${args.join(', ')})`)
  console.log(`  calldata ${encodeFunctionData({ abi: PROXY_ADMIN_ABI, functionName, args })}`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
