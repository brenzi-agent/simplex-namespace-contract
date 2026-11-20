import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { keccak256, pad, toHex, zeroAddress } from 'viem'
import { checkGovernance, entryFailures, loadGovernance } from './governance-check.mjs'
import { REPO_ROOT } from './stack.mjs'

const SAFE_PROXY_CODE = '0x608060405260005463a619486e60003560e01c14156024578060601b606c5260206060f35b3660008037600080366000845af43d6000803e806040573d6000fd5b3d6000f3fea2646970667358221220e61834ebd2d8cd909d362bf67c47ef58fd665df38e6dd036ce65611101d072e964736f6c63430007060033'
const SINGLETON = '0xFf51A5898e281Db6DfC7855790607438dF2ca44b'
const FALLBACK_HANDLER = '0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4'
const GUARD_SLOT = BigInt(keccak256(toHex('guard_manager.guard.address')))
const FALLBACK_HANDLER_SLOT = BigInt(keccak256(toHex('fallback_manager.handler.address')))
const OTHER = '0x000000000000000000000000000000000000bEEF'
const SECOND = '0x0000000000000000000000000000000000005678'
const DEPLOY_KEY = '0x38D19404644fe24EE7d638229a732CbE8275E333'

const { adminSafe } = loadGovernance()

const deployedSafe = {
  code: SAFE_PROXY_CODE,
  slots: new Map([[0n, SINGLETON], [GUARD_SLOT, zeroAddress], [FALLBACK_HANDLER_SLOT, FALLBACK_HANDLER]]),
  VERSION: '1.5.0',
  getThreshold: 2n,
  getOwners: adminSafe.owners,
  getModulesPaginated: [[], '0x0000000000000000000000000000000000000001'],
  nonce: 1n,
}

const clientOf = (state) => ({
  getCode: async () => state.code,
  getStorageAt: async ({ slot }) => pad(state.slots.get(BigInt(slot)) ?? zeroAddress),
  getBlockNumber: async () => 1n,
  getLogs: async () => (typeof state.logs === 'function' ? state.logs() : state.logs),
  readContract: async ({ functionName, args }) =>
    typeof state[functionName] === 'function' ? state[functionName](...args) : state[functionName],
})

const safeFailures = (changes) => entryFailures(clientOf({ ...deployedSafe, ...changes }), adminSafe)

const slotsWith = (slot, value) => new Map([...deployedSafe.slots, [slot, value]])

test('the admin Safe as deployed is accepted', async () => {
  assert.deepEqual(await safeFailures({}), [])
})

test('a Safe that lists its owners in another order is accepted', async () => {
  assert.deepEqual(await safeFailures({ getOwners: [...adminSafe.owners].reverse() }), [])
})

for (const [refused, changes, failure] of [
  ['a different threshold', { getThreshold: 1n }, /^threshold is 1, expected 2$/],
  ['different owners', { getOwners: [...adminSafe.owners.slice(1), OTHER] }, /^owners is \[0x0+bEEF, /],
  ['an enabled module', { getModulesPaginated: [[OTHER], '0x0000000000000000000000000000000000000001'] }, /^modules is \[0x0+bEEF\], expected \[\]$/],
  ['a guard', { slots: slotsWith(GUARD_SLOT, OTHER) }, /^guard is 0x0+bEEF, expected 0x0{40}$/],
  ['a different singleton', { slots: slotsWith(0n, OTHER) }, /^singleton is 0x0+bEEF, expected 0xFf51/],
  ['a different fallback handler', { slots: slotsWith(FALLBACK_HANDLER_SLOT, OTHER) }, /^fallback handler is 0x0+bEEF, expected 0x3EfC/],
  ['nonce 0', { nonce: 0n }, /^nonce is 0, /],
  ['an address without code', { code: undefined }, /^has no code$/],
  ['code other than SafeProxy 1.5.0', { code: '0x6000' }, /^code hash is 0x[0-9a-f]{64}, not that of SafeProxy 1\.5\.0$/],
]) {
  test(`a Safe with ${refused} is refused`, async () => {
    const failures = await safeFailures(changes)
    assert.equal(failures.length, 1, failures.join('; '))
    assert.match(failures[0], failure)
  })
}

const wallet = { kind: 'EOA', address: OTHER, allowance: 1n }

test('a registrar wallet without code is accepted', async () => {
  assert.deepEqual(await entryFailures(clientOf({ code: undefined }), wallet), [])
})

test('a registrar wallet with code is refused', async () => {
  assert.deepEqual(await entryFailures(clientOf({ code: '0xef0100' }), wallet), ['has code 0xef0100…'])
})

const committed = JSON.parse(readFileSync(join(REPO_ROOT, 'governance.mainnet.json'), 'utf8'))
const loadWith = (entries) => {
  const dir = mkdtempSync(join(tmpdir(), 'governance-'))
  try {
    const path = join(dir, 'governance.mainnet.json')
    writeFileSync(path, JSON.stringify(entries))
    return loadGovernance(path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the committed governance file loads without a registrarWallet entry', () => {
  assert.equal(loadGovernance().registrarWallet, undefined)
})

test('a registrarWallet entry, where present, loads as an EOA with its allowance in attoUSD', () => {
  assert.deepEqual(loadWith({ ...committed, registrarWallet: { kind: 'EOA', address: SECOND, allowance: '5' } }).registrarWallet,
    { kind: 'EOA', address: SECOND, allowance: 5n })
})

test('an allowance given as a JSON number is refused', () => {
  assert.throws(() => loadWith({ ...committed, registrarWallet: { kind: 'EOA', address: SECOND, allowance: 1e23 } }),
    { message: /: registrarWallet\.allowance: expected attoUSD as a decimal string$/ })
})

test('a registrarWallet entry of another kind is refused', () => {
  assert.throws(() => loadWith({ ...committed, registrarWallet: committed.guardianSafe }),
    { message: /: registrarWallet, where present, must be an entry of kind EOA$/ })
})

test('a governance file without the guardian Safe is refused', () => {
  const { guardianSafe, ...withoutGuardian } = committed
  assert.throws(() => loadWith(withoutGuardian), { message: /: guardianSafe must be an entry of kind Safe$/ })
})

test('the governance check fails when an entry before the last one fails', async () => {
  const client = { ...clientOf({}), getCode: async ({ address }) => (address === OTHER ? '0xef0100' : undefined) }
  assert.equal(await checkGovernance(client, { first: wallet, last: { ...wallet, address: SECOND } }), false)
})

const TIMELOCK_CODE = '0x6001'
const ROLE = (name) => keccak256(toHex(name))
const ADMIN_ROLE = pad('0x00', { size: 32 })
const timelock = {
  kind: 'TimelockController',
  address: OTHER,
  codeHash: keccak256(TIMELOCK_CODE),
  deployBlock: 1,
  minDelay: 604800,
  proposers: [adminSafe.address],
  executors: [adminSafe.address],
  cancellers: ['0xE6623AA6b8d335367828C2A8b06A714678d22e2c'],
}
const roles = new Set([
  `${ROLE('PROPOSER_ROLE')}:${timelock.proposers[0]}`,
  `${ROLE('EXECUTOR_ROLE')}:${timelock.executors[0]}`,
  `${ROLE('CANCELLER_ROLE')}:${timelock.cancellers[0]}`,
])
const granted = (account, role = ADMIN_ROLE) => ({ args: { role, account, sender: account } })
const holding = (role, extra) => (asked, account) => (asked === role && account === extra) || roles.has(`${asked}:${account}`)
const deployedTimelock = {
  code: TIMELOCK_CODE,
  logs: [granted(timelock.address)],
  getMinDelay: 604800n,
  getRoleAdmin: () => ADMIN_ROLE,
  hasRole: (role, account) => (role === ADMIN_ROLE && account === timelock.address) || roles.has(`${role}:${account}`),
}
const timelockFailures = (changes) => entryFailures(clientOf({ ...deployedTimelock, ...changes }), timelock, DEPLOY_KEY)

test('a timelock as configured is accepted', async () => {
  assert.deepEqual(await timelockFailures({}), [])
})

for (const [refused, changes, failure] of [
  ['a different minimum delay', { getMinDelay: 86400n }, /^minimum delay is 86400, expected 604800$/],
  ['a canceller without its role', { hasRole: (role, account) => role === ROLE('CANCELLER_ROLE') ? false : roles.has(`${role}:${account}`) }, /^0xE662.* is not among the cancellers$/],
  ['the admin role held by the deploy key', { hasRole: (role, account) => (role === ADMIN_ROLE && account === DEPLOY_KEY) || roles.has(`${role}:${account}`) }, /^0x38D1.* holds the admin role$/],
  ['the admin role held by an account its logs name', {
    logs: [granted(timelock.address), granted(SECOND)],
    hasRole: (role, account) => (role === ADMIN_ROLE && account === SECOND) || roles.has(`${role}:${account}`),
  }, /^0x0+5678 holds the admin role$/],
  ['a proposer its entry does not list', {
    logs: [granted(timelock.address), granted(SECOND, ROLE('PROPOSER_ROLE'))],
    hasRole: holding(ROLE('PROPOSER_ROLE'), SECOND),
  }, /^0x0+5678 is among the proposers, which the entry does not list$/],
  ['an executor role open to every account', {
    hasRole: holding(ROLE('EXECUTOR_ROLE'), zeroAddress),
  }, /^0x0{40} is among the executors, which the entry does not list$/],
  ['logs that cannot be read', { logs: () => { throw new Error('range too large') } }, /^its RoleGranted logs from block 1 could not be read: range too large$/],
  ['a deployment block later than its deployment', { logs: [] }, /^the grant of the admin role to itself is missing from its RoleGranted logs from block 1: /],
  ['other code', { code: '0x6002' }, /^code hash is /],
]) {
  test(`a timelock with ${refused} is refused`, async () => {
    const failures = await timelockFailures(changes)
    assert.equal(failures.length, 1, failures.join('; '))
    assert.match(failures[0], failure)
  })
}
