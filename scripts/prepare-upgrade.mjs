#!/usr/bin/env node
import {
  BaseError, ContractFunctionRevertedError, createWalletClient, encodeFunctionData, encodeDeployData, http, keccak256,
  pad, parseGwei, toEventSignature, toFunctionSelector, toFunctionSignature, zeroAddress,
} from 'viem'
import { mainnet } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { createWaitForBaseRunner, promptYesNo, DEFAULTS } from './gas-tools.mjs'
import { loadGovernance } from './governance-check.mjs'
import {
  ADDRESSES_PATH, ERC1967_ADMIN_SLOT, ERC1967_IMPLEMENTATION_SLOT, PROXY_ADMIN_ABI, REPO_ROOT, TLD, UPGRADEABLE,
  VERIFICATION_PATH, accepted, artifact, assertBuildFresh, assertCommitted, assertTaggedSource, causes, constructorArgs,
  immutableNames, immutablesIn, interfaceOf, mainnetClient, parentHead, placeImmutables, proxyAdminOf, proxySlots,
  refusal, requireEnv, safeBatch, storageLayout, storedValue,
} from './stack.mjs'

const journalPath = join(REPO_ROOT, `deployments.mainnet.${TLD}.upgrades.journal.jsonl`)
const attemptsLogPath = join(REPO_ROOT, `deployments.mainnet.${TLD}.upgrades.attempts.log`)
const UUPS_SELECTORS = new Set(['0x3659cfe6', '0x4f1ef286', '0x52d1902d'])
const PROXY_ADMIN_IMMUTABLE = '_proxyAdmin'
const PROXY_ADMIN_INPUT = 'proxyAdmin'

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

const INTERFACE = {
  functions: ['function', toFunctionSignature],
  events: ['event', toEventSignature],
  errors: ['error', toFunctionSignature],
}

export function interfaceChanges(current, abi) {
  const next = interfaceOf(abi)
  return Object.entries(INTERFACE).flatMap(([field, [kind, signatureOf]]) =>
    Object.entries(current[field])
      .filter(([selector, shape]) => next[field][selector] !== shape)
      .map(([selector, shape]) => ({ kind, signature: signatureOf(shape), current: shape, next: next[field][selector] })))
}

export function artifactFailures({ abi, deployedBytecode, immutableReferences }, names, layout, current, intended) {
  const immutables = Object.keys(immutableReferences).map((id) => names.get(Number(id)))
  const nameable = new Set([
    ...immutables,
    ...Object.keys(current.immutables),
    ...Object.entries(INTERFACE).flatMap(([field, [, signatureOf]]) => Object.values(current[field]).map(signatureOf)),
  ])
  return [
    ...layoutFailures(current.storageLayout, layout),
    ...interfaceFailures(abi),
    ...slotFailures(deployedBytecode),
    ...Object.keys(current.immutables).filter((name) => !immutables.includes(name) && !intended.includes(name))
      .map((name) => `it has no immutable named ${name}, which the current implementation holds as ${current.immutables[name]}`),
    ...interfaceChanges(current, abi).filter(({ signature }) => !intended.includes(signature))
      .map(({ kind, signature, current: shape, next }) => (next === undefined
        ? `it lacks the ${kind} ${signature} of the current implementation`
        : `its ${kind} ${signature} is ${next}, the current implementation's is ${shape}`)),
    ...intended.filter((name) => !nameable.has(name))
      .map((name) => `INTENDED names ${name}, neither an immutable nor a function, event or error of the current implementation`),
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
    changes: intended.filter((name) => Object.hasOwn(current, name) || Object.hasOwn(found, name))
      .map((name) => ({ name, current: current[name], next: found[name] })),
  }
}

export function ownImmutables(name, addresses, deployer, candidate, proxyAdmin) {
  const definition = UPGRADEABLE[name]
  const fresh = definition.immutables(addresses, { tld: TLD, deployer, self: candidate })
  return {
    ...Object.fromEntries((definition.ownImmutables ?? []).map((immutable) => [immutable, fresh[immutable]])),
    [PROXY_ADMIN_IMMUTABLE]: proxyAdmin,
  }
}

const MULTICALLS = new Set(['multicall(bytes[])', 'multicallWithNodeCheck(bytes32,bytes[])'].map((signature) => toFunctionSelector(signature)))

const selectorOf = (signature) => {
  try {
    return toFunctionSelector(signature)
  } catch {
    return undefined
  }
}

export function dataGuardFailures({ immutableReferences }, names, call) {
  if (!call) return []
  const guarded = Object.keys(immutableReferences).some((id) => names.get(Number(id)) === PROXY_ADMIN_IMMUTABLE)
  return [
    ...(guarded ? [] : [`DATA ${call.signature} requires an immutable ${PROXY_ADMIN_IMMUTABLE}, which the candidate lacks: its data function would stay callable by anyone`]),
    ...(MULTICALLS.has(selectorOf(call.signature))
      ? [`DATA ${call.signature} is a multicall, whose entries run for the ProxyAdmin: one with the selector of upgradeToAndCall would install another implementation`]
      : []),
  ]
}

export function upgradeData(abi, call) {
  if (!call) return accepted({ data: '0x' })
  const { signature, args } = call
  try {
    const selector = toFunctionSelector(signature)
    const item = abi.find((entry) => entry.type === 'function' && toFunctionSelector(entry) === selector)
    if (!item) return refusal([`it has no function ${signature}`])
    return accepted({ data: encodeFunctionData({ abi: [item], functionName: item.name, args }) })
  } catch (error) {
    return refusal([`DATA ${signature} with DATA_ARGS ${JSON.stringify(args)} does not encode: ${error.shortMessage ?? error.message}`])
  }
}

export function candidateArgs(abi, given, proxyAdmin) {
  const inputs = abi.find(({ type }) => type === 'constructor')?.inputs ?? []
  const at = inputs.findIndex(({ name }) => name === PROXY_ADMIN_INPUT)
  const complete = given.length === inputs.length
  if (at !== -1 && complete && String(given[at]).toLowerCase() !== proxyAdmin.toLowerCase()) {
    return refusal([`CTOR_ARGS sets ${PROXY_ADMIN_INPUT} to ${given[at]}, not the proxy's ProxyAdmin ${proxyAdmin}`])
  }
  const args = at !== -1 && !complete ? given.toSpliced(at, 0, proxyAdmin) : given
  try {
    constructorArgs(abi, args)
    return accepted({ args })
  } catch (error) {
    return refusal([`the constructor arguments ${JSON.stringify(args)} do not encode: ${error.shortMessage ?? error.message}`])
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

export async function checkedProxyAdmin(client, addresses, verification, name, adminSafe = loadGovernance().adminSafe.address) {
  if (!Object.hasOwn(UPGRADEABLE, name)) {
    return refusal([`CONTRACT must be one of ${Object.keys(UPGRADEABLE).join(', ')}, not ${name}`])
  }
  const { key, artifact: path } = UPGRADEABLE[name]
  const proxy = addresses[key]
  const { implementation, admin } = await proxySlots(client, proxy)
  if (admin !== proxyAdminOf(proxy)) {
    return refusal([`the admin slot of the ${name} proxy ${proxy} holds ${admin}, not ${proxyAdminOf(proxy)}`])
  }
  const current = Object.values(verification.contracts).find((entry) =>
    entry.address.toLowerCase() === implementation.toLowerCase() && entry.artifact === path)
  if (!current) {
    return refusal([`${VERIFICATION_PATH} records no ${path} at ${implementation}, the implementation of the ${name} proxy ${proxy}`])
  }
  const owner = await client.readContract({ address: admin, abi: PROXY_ADMIN_ABI, functionName: 'owner' })
  if (owner === zeroAddress) return refusal([`the ProxyAdmin ${admin} of ${name} is renounced`])
  const unowned = ownerFailures({ name, proxyAdmin: admin, owner }, adminSafe)
  return unowned.length ? refusal(unowned) : accepted({ name, proxy, implementation, proxyAdmin: admin, owner, current })
}

export function ownerFailures({ name, proxyAdmin, owner }, adminSafe) {
  return owner.toLowerCase() === adminSafe.toLowerCase()
    ? []
    : [`the ProxyAdmin ${proxyAdmin} of ${name} is owned by ${owner}, not the admin Safe ${adminSafe}: a call through it ` +
      'needs the schedule and execute batches of a TimelockController for the admin Safe, which this script does not write yet']
}

export async function prepareUpgrade({ deploy }, client, name, addresses, verification, deployer, request = {}) {
  const { intended = [], constructorArgs: requestedArgs, call } = request
  const definition = UPGRADEABLE[name]
  const admin = await checkedProxyAdmin(client, addresses, verification, name)
  if (admin.refused) return admin
  const { current } = admin
  const unrecorded = ['storageLayout', 'immutables', 'functions', 'events', 'errors'].filter((field) => !current[field])
  if (unrecorded.length) return refusal([`the entry of ${admin.implementation} records no ${unrecorded.join(' and no ')}`])
  const compiled = artifact(definition.artifact)
  const names = immutableNames(compiled)
  const layout = storageLayout(compiled)
  const constructed = candidateArgs(compiled.abi, requestedArgs ?? definition.args(addresses, { tld: TLD, deployer }),
    admin.proxyAdmin)
  const encoded = upgradeData(compiled.abi, call)
  const refused = [
    ...artifactFailures(compiled, names, layout, current, intended),
    ...(constructed.refused ? constructed.failures : []),
    ...(encoded.refused ? encoded.failures : []),
    ...dataGuardFailures(compiled, names, call),
  ]
  if (refused.length) return refusal(refused)

  const { args } = constructed
  const { data } = encoded
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
    return refusal([...failures, ...uninitialized, ...reverting], { candidate })
  }
  return accepted({
    ...admin,
    candidate,
    data,
    changes,
    changed: interfaceChanges(current, compiled.abi),
    entry: {
      address: candidate,
      artifact: definition.artifact,
      constructorArgs: constructorArgs(compiled.abi, args),
      storageLayout: layout,
      immutables: immutablesIn(compiled, names, code),
      ...interfaceOf(compiled.abi),
      buildInfoId: compiled.buildInfoId,
    },
  })
}

export function intendedNames(text) {
  const names = ['']
  let depth = 0
  for (const char of text) {
    if (char === ',' && depth === 0) {
      names.push('')
      continue
    }
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    names[names.length - 1] += char
  }
  return names.map((name) => name.trim()).filter(Boolean)
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

export const ACTIONS = {
  upgrade: async (client, addresses, verification, name) => {
    const deployerKey = requireEnv('DEPLOYER_KEY')
    const rpcUrl = requireEnv('MAINNET_RPC_URL')
    const maxBaseFeeGwei = requireEnv('MAX_BASE_FEE_GWEI')
    const request = {
      intended: intendedNames(process.env.INTENDED ?? ''),
      constructorArgs: jsonArrayEnv('CTOR_ARGS'),
      call: process.env.DATA ? { signature: process.env.DATA, args: jsonArrayEnv('DATA_ARGS') ?? [] } : undefined,
    }
    const account = privateKeyToAccount(deployerKey)
    const walletClient = createWalletClient({ chain: mainnet, transport: http(rpcUrl), account })
    const source = assertTaggedSource()
    assertBuildFresh()
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
    verification.contracts[`${name}@${prepared.candidate}`] = {
      ...prepared.entry, ensContractsCommit: source.commit, parentCommit: parentHead(),
    }
    writeFileSync(VERIFICATION_PATH, JSON.stringify(verification, null, 2))
    console.log(`✓ ${name} candidate ${prepared.candidate} keeps the storage layout, the current immutables and the current interface`)
    for (const { name: immutable, current, next } of prepared.changes) {
      console.log(`  intended change of ${immutable}: ${current ?? 'none'} → ${next ?? 'none'}`)
    }
    for (const { kind, signature, current, next } of prepared.changed) {
      console.log(next === undefined
        ? `  intended removal of the ${kind} ${signature}`
        : `  intended change of the ${kind} ${signature}: ${current} → ${next}`)
    }
    console.log(`  upgradeAndCall from the ProxyAdmin owner ${prepared.owner} succeeds in a simulation`)
    console.log(`Wrote ${VERIFICATION_PATH}: commit it and verify the candidate on Etherscan before the upgrade.`)
    return accepted({ target: prepared, functionName: 'upgradeAndCall', args: [prepared.proxy, prepared.candidate, prepared.data] })
  },
  freeze: async (client, addresses, verification, name) => {
    const target = await checkedProxyAdmin(client, addresses, verification, name)
    return target.refused ? target : refusal([
      `the ProxyAdmin ${target.proxyAdmin} of ${name} is owned by the admin Safe: a freeze waits until GOV8 has ` +
        'moved it to the timelock (launch-to-freeze plan, A7)',
    ])
  },
  transfer: async () => refusal([
    'a transfer of a ProxyAdmin waits for the GOV8 prerequisites: the code of the TimelockController compared with the ' +
      'OpenZeppelin 5.1.0 artifact, and its schedule and execute batches for the admin Safe',
  ]),
}

async function main() {
  const action = ACTIONS[process.env.ACTION]
  if (!action) {
    console.error(`ACTION must be one of ${Object.keys(ACTIONS).join(', ')} (got ${JSON.stringify(process.env.ACTION)})`)
    process.exit(1)
  }
  assertCommitted(['scripts', 'governance.mainnet.json', `deployments.mainnet.${TLD}.json`, `verification.mainnet.${TLD}.json`])
  const client = await mainnetClient(requireEnv('MAINNET_RPC_URL'))
  const addresses = JSON.parse(readFileSync(ADDRESSES_PATH, 'utf8'))
  const verification = JSON.parse(readFileSync(VERIFICATION_PATH, 'utf8'))
  const call = await action(client, addresses, verification, requireEnv('CONTRACT'))
  if (call.refused) {
    console.error(`${process.env.ACTION} refused:`)
    for (const failure of call.failures) console.error(`  ✗ ${failure}`)
    process.exit(1)
  }
  const { target: { name, proxy, implementation, proxyAdmin, owner }, functionName, args } = call
  const data = encodeFunctionData({ abi: PROXY_ADMIN_ABI, functionName, args })
  console.log(`\nThe implementation slot of the ${name} proxy ${proxy} holds ${implementation}.`)
  console.log(`The ProxyAdmin owner ${owner} submits to the ProxyAdmin ${proxyAdmin} of ${name}, not to its proxy:`)
  console.log(`  ${functionName}(${args.join(', ')})`)
  console.log(`  calldata ${data}`)
  const batchPath = join(REPO_ROOT, `safe-transaction.mainnet.${TLD}.${process.env.ACTION}.${name}.json`)
  writeFileSync(batchPath, JSON.stringify(safeBatch({
    safe: owner,
    transactions: [{ to: proxyAdmin, data }],
    name: `${process.env.ACTION} ${name}`,
    description: `${functionName}(${args.join(', ')}) on the ProxyAdmin ${proxyAdmin} of the ${name} proxy ${proxy}`,
  }), null, 2))
  console.log(`Wrote ${batchPath}: load it into the Transaction Builder of the Safe ${owner}; its one transaction goes to the ProxyAdmin ${proxyAdmin}.`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(causes(err).join('\n  ← '))
    process.exit(1)
  })
}
