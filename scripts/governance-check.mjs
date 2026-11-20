#!/usr/bin/env node
import { getAddress, isHex, keccak256, parseAbi, parseAbiItem, toHex, zeroAddress } from 'viem'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import {
  REPO_ROOT, VERIFICATION_PATH, addressAt, causes, logsSince, mainnetClient, requireEnv, sortedAddresses,
} from './stack.mjs'

const GOVERNANCE_PATH = join(REPO_ROOT, 'governance.mainnet.json')

const SAFE_PROXY_CODE_HASH = '0x4e381985ca68b3e5d27b4425fa581c19cf33146d3f887a3cfca96f55528ea46f'
const SAFE_SINGLETON = '0xFf51A5898e281Db6DfC7855790607438dF2ca44b'
const SAFE_FALLBACK_HANDLER = '0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4'
const SAFE_VERSION = '1.5.0'
const SAFE_SINGLETON_SLOT = toHex(0, { size: 32 })
const SAFE_GUARD_SLOT = keccak256(toHex('guard_manager.guard.address'))
const SAFE_FALLBACK_HANDLER_SLOT = keccak256(toHex('fallback_manager.handler.address'))
const SAFE_MODULES_START = '0x0000000000000000000000000000000000000001'
const SAFE_ABI = parseAbi([
  'function VERSION() view returns (string)',
  'function getThreshold() view returns (uint256)',
  'function getOwners() view returns (address[])',
  'function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)',
  'function nonce() view returns (uint256)',
])
const TIMELOCK_ABI = parseAbi([
  'function getMinDelay() view returns (uint256)',
  'function getRoleAdmin(bytes32 role) view returns (bytes32)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
])
const TIMELOCK_ROLES = {
  proposers: keccak256(toHex('PROPOSER_ROLE')),
  executors: keccak256(toHex('EXECUTOR_ROLE')),
  cancellers: keccak256(toHex('CANCELLER_ROLE')),
}
const ROLE_GRANTED = parseAbiItem('event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)')
const REQUIRED = { adminSafe: 'Safe', guardianSafe: 'Safe' }
const OPTIONAL = { registrarWallet: 'EOA' }

function checksummed(where, value) {
  let address
  try { address = getAddress(value) } catch {}
  if (address !== value) throw new Error(`${where}: ${JSON.stringify(value)} is not a checksummed address`)
  return address
}

function addresses(where, values) {
  if (!Array.isArray(values) || values.length === 0) throw new Error(`${where}: expected a list of addresses`)
  return values.map((value, i) => checksummed(`${where}[${i}]`, value))
}

function count(where, value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${where}: ${JSON.stringify(value)} is not a count`)
  return value
}

const show = (value) => (Array.isArray(value) ? `[${value.join(', ')}]` : String(value))

const mismatches = (pairs) => Object.entries(pairs)
  .filter(([, [got, expected]]) => show(got) !== show(expected))
  .map(([what, [got, expected]]) => `${what} is ${show(got)}, expected ${show(expected)}`)

async function safeFailures(client, { address, threshold, owners }, code) {
  if (keccak256(code) !== SAFE_PROXY_CODE_HASH) return [`code hash is ${keccak256(code)}, not that of SafeProxy ${SAFE_VERSION}`]
  const read = (functionName, args) => client.readContract({ address, abi: SAFE_ABI, functionName, args })
  const [singleton, guard, fallbackHandler, version, actualThreshold, actualOwners, [modules], nonce] = await Promise.all([
    addressAt(client, address, SAFE_SINGLETON_SLOT),
    addressAt(client, address, SAFE_GUARD_SLOT),
    addressAt(client, address, SAFE_FALLBACK_HANDLER_SLOT),
    read('VERSION'),
    read('getThreshold'),
    read('getOwners'),
    read('getModulesPaginated', [SAFE_MODULES_START, 10n]),
    read('nonce'),
  ])
  return [
    ...mismatches({
      singleton: [singleton, SAFE_SINGLETON],
      VERSION: [version, SAFE_VERSION],
      threshold: [actualThreshold, threshold],
      owners: [sortedAddresses(actualOwners), sortedAddresses(owners)],
      modules: [modules, []],
      guard: [guard, zeroAddress],
      'fallback handler': [fallbackHandler, SAFE_FALLBACK_HANDLER],
    }),
    ...(nonce >= 1n ? [] : [`nonce is ${nonce}, so the Safe has executed no transaction`]),
  ]
}

async function timelockFailures(client, entry, code, deployKey) {
  const { address, codeHash, minDelay, deployBlock } = entry
  if (keccak256(code) !== codeHash) return [`code hash is ${keccak256(code)}, expected ${codeHash}`]
  const read = (functionName, args) => client.readContract({ address, abi: TIMELOCK_ABI, functionName, args })
  const roles = { ...TIMELOCK_ROLES, admins: await read('getRoleAdmin', [TIMELOCK_ROLES.proposers]) }
  let grants
  try {
    grants = (await logsSince(client, { address, event: ROLE_GRANTED, args: { role: Object.values(roles) } }, BigInt(deployBlock)))
      .map(({ args }) => ({ role: args.role, account: getAddress(args.account) }))
  } catch (error) {
    return [`its RoleGranted logs from block ${deployBlock} could not be read: ${error.shortMessage ?? error.message}`]
  }
  if (!grants.some(({ role, account }) => role === roles.admins && account === address)) {
    return [`the grant of the admin role to itself is missing from its RoleGranted logs from block ${deployBlock}: deployBlock is later than its deployment`]
  }
  const listed = { proposers: entry.proposers, executors: entry.executors, cancellers: entry.cancellers, admins: [address] }
  const accounts = [...new Set([
    ...Object.values(listed).flat(),
    ...grants.map(({ account }) => account),
    ...(deployKey ? [deployKey] : []),
    zeroAddress,
  ].map((account) => getAddress(account)))]
  const checks = Object.entries(roles).flatMap(([roleName, role]) => accounts.map((account) => ({ roleName, role, account })))
  const [delay, held] = await Promise.all([
    read('getMinDelay'),
    Promise.all(checks.map(({ role, account }) => read('hasRole', [role, account]))),
  ])
  const isListed = ({ roleName, account }) => listed[roleName].includes(account)
  return [
    ...mismatches({ 'minimum delay': [delay, minDelay] }),
    ...checks.filter((check, i) => check.roleName !== 'admins' && isListed(check) && !held[i])
      .map(({ roleName, account }) => `${account} is not among the ${roleName}`),
    ...checks.filter((check, i) => !isListed(check) && held[i])
      .map(({ roleName, account }) => (roleName === 'admins'
        ? `${account} holds the admin role`
        : `${account} is among the ${roleName}, which the entry does not list`)),
  ]
}

const KINDS = {
  Safe: {
    parse: (where, { address, threshold, owners }) => ({
      address: checksummed(`${where}.address`, address),
      threshold: count(`${where}.threshold`, threshold),
      owners: addresses(`${where}.owners`, owners),
    }),
    failures: (client, entry, code) => (code ? safeFailures(client, entry, code) : ['has no code']),
  },
  TimelockController: {
    parse: (where, { address, codeHash, deployBlock, minDelay, proposers, executors, cancellers }) => {
      if (!isHex(codeHash) || codeHash.length !== 66) throw new Error(`${where}.codeHash: expected 32 bytes of hex`)
      return {
        address: checksummed(`${where}.address`, address),
        codeHash,
        deployBlock: count(`${where}.deployBlock`, deployBlock),
        minDelay: count(`${where}.minDelay`, minDelay),
        proposers: addresses(`${where}.proposers`, proposers),
        executors: addresses(`${where}.executors`, executors),
        cancellers: addresses(`${where}.cancellers`, cancellers),
      }
    },
    failures: (client, entry, code, deployKey) => (code ? timelockFailures(client, entry, code, deployKey) : ['has no code']),
  },
  EOA: {
    parse: (where, { address, allowance }) => {
      if (typeof allowance !== 'string' || !/^\d+$/.test(allowance)) throw new Error(`${where}.allowance: expected attoUSD as a decimal string`)
      return { address: checksummed(`${where}.address`, address), allowance: BigInt(allowance) }
    },
    failures: async (client, entry, code) => (code ? [`has code ${code.slice(0, 18)}…`] : []),
  },
}

export function loadGovernance(path = GOVERNANCE_PATH) {
  const governance = Object.fromEntries(Object.entries(JSON.parse(readFileSync(path, 'utf8'))).map(([name, entry]) => {
    if (!KINDS[entry.kind]) throw new Error(`${path}: ${name}.kind must be one of ${Object.keys(KINDS).join(', ')}`)
    return [name, { kind: entry.kind, ...KINDS[entry.kind].parse(`${path}: ${name}`, entry) }]
  }))
  for (const [name, kind] of Object.entries(REQUIRED))
    if (governance[name]?.kind !== kind) throw new Error(`${path}: ${name} must be an entry of kind ${kind}`)
  for (const [name, kind] of Object.entries(OPTIONAL))
    if (governance[name] && governance[name].kind !== kind) throw new Error(`${path}: ${name}, where present, must be an entry of kind ${kind}`)
  return governance
}

export async function entryFailures(client, entry, deployKey) {
  const code = await client.getCode({ address: entry.address })
  return KINDS[entry.kind].failures(client, entry, code, deployKey)
}

export async function checkGovernance(client, governance, deployKey) {
  let passed = true
  for (const [name, entry] of Object.entries(governance)) {
    const failures = await entryFailures(client, entry, deployKey)
    console.log(`  ${failures.length ? '✗' : '✓'} ${name} ${entry.address}${failures.map((failure) => `\n      ${failure}`).join('')}`)
    passed &&= failures.length === 0
  }
  return passed
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rpcUrl = requireEnv('MAINNET_RPC_URL')
  const governance = loadGovernance()
  const names = process.argv.slice(2)
  const unknown = names.filter((name) => !governance[name])
  if (unknown.length) {
    console.error(`not in ${GOVERNANCE_PATH}: ${unknown.join(', ')}`)
    process.exit(1)
  }
  const deployKey = existsSync(VERIFICATION_PATH) ? JSON.parse(readFileSync(VERIFICATION_PATH, 'utf8')).deployer : undefined
  const entries = names.length ? Object.fromEntries(names.map((name) => [name, governance[name]])) : governance
  mainnetClient(rpcUrl).then((client) => checkGovernance(client, entries, deployKey)).then(
    (passed) => process.exit(passed ? 0 : 1),
    (err) => {
      console.error(causes(err).join('\n  ← '))
      process.exit(1)
    },
  )
}
