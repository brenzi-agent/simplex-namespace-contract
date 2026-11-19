import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ContractFunctionRevertedError, encodeFunctionData, keccak256, pad, parseAbi, toHex, zeroAddress } from 'viem'
import {
  artifactFailures, checkedProxyAdmin, immutableReview, interfaceFailures, layoutFailures, ownImmutables, slotFailures,
  transferCall, upgradeCallFailures, upgradeData,
} from './prepare-upgrade.mjs'
import {
  ERC1967_ADMIN_SLOT, ERC1967_IMPLEMENTATION_SLOT, UPGRADEABLE, immutablesIn, placeImmutables, proxyAdminOf,
} from './stack.mjs'

const REGISTRY = '0x000000000000000000000000000000000000c0DE'
const SUBNAME_REGISTRAR = '0x000000000000000000000000000000000000dEaD'
const CONTROLLER = '0x000000000000000000000000000000000000bEEF'
const OTHER = '0x0000000000000000000000000000000000001234'
const ADMIN_SAFE = '0xf38920389740E46A7f4160DaF1672f3df2754Df4'

const uint256 = { label: 'uint256', encoding: 'inplace', numberOfBytes: '32' }
const bytes32 = { label: 'bytes32', encoding: 'inplace', numberOfBytes: '32' }
const address = { label: 'address', encoding: 'inplace', numberOfBytes: '20' }
const bool = { label: 'bool', encoding: 'inplace', numberOfBytes: '1' }
const reason = (enumValues) => ({ label: 'enum SimplexNamePolicy.Reason', encoding: 'inplace', numberOfBytes: '1', enumValues })
const REASONS = ['None', 'Internal', 'Trademark', 'Community']
const gap = (length) => ({ label: `uint256[${length}]`, encoding: 'inplace', numberOfBytes: String(32 * length), base: uint256 })
const variable = (contract, label, slot, offset, type) => ({ contract, label, slot: String(slot), offset, type })
const controller = (label, slot, offset, type) => variable('SimplexController', label, slot, offset, type)
const member = (label, slot, offset, type) => ({ label, slot: String(slot), offset, type })
const names = (members) => ({
  label: 'mapping(bytes32 => struct SimplexNamePolicy.NameEntry)',
  encoding: 'mapping',
  numberOfBytes: '32',
  key: bytes32,
  value: { label: 'struct SimplexNamePolicy.NameEntry', encoding: 'inplace', numberOfBytes: '32', members },
})

const prefix = [
  variable('Initializable', '_initialized', 0, 0, { label: 'uint8', encoding: 'inplace', numberOfBytes: '1' }),
  variable('Initializable', '_initializing', 0, 1, bool),
  variable('ContextUpgradeable', '__gap', 1, 0, gap(50)),
  controller('beneficiary', 51, 0, address),
  controller('sponsor', 52, 0, address),
  controller('defaultResolver', 53, 0, address),
  controller('publicSalesOpen', 53, 20, bool),
  controller('namePolicy', 54, 0, address),
]
const deployed = [...prefix, controller('__gap', 55, 0, gap(43))]

const CONTROLLER_ABI = parseAbi(['function sponsor() view returns (address)', 'function setSponsor(address)'])
const compiledWith = (abi) => ({ abi, deployedBytecode: '0x6000', immutableReferences: {} })

test('an identical rebuild is accepted', () => {
  assert.deepEqual(artifactFailures(compiledWith(CONTROLLER_ABI), new Map(), deployed, { storageLayout: deployed, immutables: {} }, []), [])
})

test('a variable appended in place of the first slot of the trailing __gap is accepted', () => {
  const appended = [...prefix, controller('nextSponsor', 55, 0, address), controller('__gap', 56, 0, gap(42))]
  assert.deepEqual(layoutFailures(deployed, appended), [])
})

test('a reordered state variable is refused', () => {
  const reordered = [
    ...prefix.slice(0, 3),
    controller('sponsor', 51, 0, address),
    controller('beneficiary', 52, 0, address),
    ...prefix.slice(5),
    controller('__gap', 55, 0, gap(43)),
  ]
  assert.deepEqual(layoutFailures(deployed, reordered), [
    'SimplexController.beneficiary changed from slot 51, offset 0, address to slot 52, offset 0, address',
    'SimplexController.sponsor changed from slot 52, offset 0, address to slot 51, offset 0, address',
  ])
})

const policy = (members) => [variable('SimplexNamePolicy', '_names', 0, 0, names(members))]
const policyWith = (reasons) => policy([member('community', 0, 0, bool), member('reserved', 0, 1, reason(reasons))])

test('a reordered member of a stored struct is refused', () => {
  const reordered = policy([member('reserved', 0, 0, reason(REASONS)), member('community', 0, 1, bool)])
  assert.deepEqual(layoutFailures(policyWith(REASONS), reordered), [
    'SimplexNamePolicy._names: the layout inside mapping(bytes32 => struct SimplexNamePolicy.NameEntry) changed',
  ])
})

test('a reordered member of a stored enum is refused', () => {
  const reordered = policyWith(['None', 'Trademark', 'Internal', 'Community'])
  assert.deepEqual(layoutFailures(policyWith(REASONS), reordered), [
    'SimplexNamePolicy._names: the layout inside mapping(bytes32 => struct SimplexNamePolicy.NameEntry) changed',
  ])
})

test('the same stored enum is accepted', () => {
  assert.deepEqual(layoutFailures(policyWith(REASONS), policyWith([...REASONS])), [])
})

test('a member appended to a stored enum is accepted', () => {
  assert.deepEqual(layoutFailures(policyWith(REASONS), policyWith([...REASONS, 'Dispute'])), [])
})

test('a member removed from a stored enum is refused', () => {
  assert.equal(layoutFailures(policyWith(REASONS), policyWith(REASONS.slice(0, -1))).length, 1)
})

test('a retyped state variable is refused', () => {
  const retyped = deployed.map((v) => (v.label === 'publicSalesOpen' ? { ...v, type: { ...uint256, numberOfBytes: '1', label: 'uint8' } } : v))
  assert.equal(layoutFailures(deployed, retyped).length, 1)
})

test('a variable appended without shrinking the trailing __gap is refused', () => {
  const appended = [...prefix, controller('nextSponsor', 55, 0, address), controller('__gap', 56, 0, gap(43))]
  assert.deepEqual(layoutFailures(deployed, appended), [
    'the candidate does not end with SimplexController.__gap ending at slot 98',
  ])
})

test('a variable appended after the trailing __gap is refused', () => {
  const appended = [...deployed, controller('nextSponsor', 98, 0, address)]
  assert.equal(layoutFailures(deployed, appended).length, 1)
})

for (const signature of [
  'function upgradeToAndCall(address newImplementation, bytes data) payable',
  'function upgradeTo(address newImplementation)',
  'function proxiableUUID() view returns (bytes32)',
]) {
  test(`an implementation with ${signature.split('(')[0].replace('function ', '')} is refused`, () => {
    assert.equal(interfaceFailures([...CONTROLLER_ABI, ...parseAbi([signature])]).length, 1)
  })
}

for (const type of ['fallback', 'receive']) {
  test(`an implementation with a ${type} function is refused`, () => {
    assert.deepEqual(interfaceFailures([...CONTROLLER_ABI, { type, stateMutability: 'payable' }]), [`has a ${type} function`])
  })
}

for (const [which, slot] of [['implementation', ERC1967_IMPLEMENTATION_SLOT], ['admin', ERC1967_ADMIN_SLOT]]) {
  test(`bytecode that contains the ERC-1967 ${which} slot is refused`, () => {
    assert.deepEqual(slotFailures(`0x60006000${'7f'}${slot.slice(2)}54`), [`its bytecode contains the ERC-1967 ${which} slot`])
  })
}

test('bytecode with the slot one nibble off its byte boundary is accepted', () => {
  assert.deepEqual(slotFailures(`0x6${ERC1967_IMPLEMENTATION_SLOT.slice(2)}0`), [])
})

const PUSH32 = `7f${'00'.repeat(32)}`
const resolver = {
  contractName: 'SimplexResolver',
  abi: [],
  deployedBytecode: `0x${PUSH32.repeat(4)}00`,
  immutableReferences: {
    11: [{ start: 1, length: 32 }],
    12: [{ start: 34, length: 32 }],
    13: [{ start: 67, length: 32 }],
    14: [{ start: 100, length: 32 }],
  },
}
const immutableNames = new Map([[11, 'ens'], [12, 'nameWrapper'], [13, 'trustedETHController'], [14, 'trustedReverseRegistrar']])
const immutables = { ens: REGISTRY, nameWrapper: SUBNAME_REGISTRAR, trustedETHController: CONTROLLER, trustedReverseRegistrar: zeroAddress }
const currentCode = placeImmutables(resolver, immutableNames, immutables)
const current = immutablesIn(resolver, immutableNames, currentCode)
const replaced = placeImmutables(resolver, immutableNames, { ...immutables, trustedETHController: OTHER })
const word = (value) => pad(value).toLowerCase()

test('a resolver with the current immutables is accepted', () => {
  assert.deepEqual(immutableReview(resolver, immutableNames, currentCode, current, {}, []), { failures: [], changes: [] })
})

test('a resolver with a different trustedETHController is refused', () => {
  assert.deepEqual(immutableReview(resolver, immutableNames, replaced, current, {}, []).failures, [
    `its immutable trustedETHController is ${word(OTHER)}, expected ${word(CONTROLLER)}`,
  ])
})

test('a different trustedETHController named as an intended change is accepted, with both values', () => {
  assert.deepEqual(immutableReview(resolver, immutableNames, replaced, current, {}, ['trustedETHController']), {
    failures: [],
    changes: [{ name: 'trustedETHController', current: word(CONTROLLER), next: word(OTHER) }],
  })
})

const withoutController = { ...resolver, immutableReferences: { 11: resolver.immutableReferences[11], 12: resolver.immutableReferences[12], 14: resolver.immutableReferences[14] } }
const currentResolver = { storageLayout: [], immutables: current }

test('a resolver candidate without trustedETHController is refused', () => {
  assert.deepEqual(artifactFailures(withoutController, immutableNames, [], currentResolver, []), [
    `it has no immutable named trustedETHController, which the current implementation holds as ${word(CONTROLLER)}`,
  ])
})

test('a resolver candidate without trustedETHController, named as an intended change, is accepted', () => {
  assert.deepEqual(artifactFailures(withoutController, immutableNames, [], currentResolver, ['trustedETHController']), [])
})

test('an intended change of an immutable that neither implementation has is refused', () => {
  assert.deepEqual(artifactFailures(resolver, immutableNames, [], currentResolver, ['controller']), [
    'neither it nor the current implementation has an immutable named controller',
  ])
})

test('an immutable of the implementation itself takes its own value, not the current one', () => {
  assert.deepEqual(immutableReview(resolver, immutableNames, replaced, current, { trustedETHController: OTHER }, []).failures, [])
})

test('runtime code that differs outside its immutables is refused', () => {
  const tampered = `${replaced.slice(0, -2)}01`
  assert.deepEqual(immutableReview(resolver, immutableNames, tampered, current, {}, ['trustedETHController']).failures, [
    'its runtime code differs from the artifact outside its immutables',
  ])
})

const deployment = Object.fromEntries(Object.values(UPGRADEABLE)
  .map(({ key }, i) => [key, `0x${(i + 1).toString(16).padStart(40, '0')}`]))
const chain = ({ adminOf = proxyAdminOf, owner = ADMIN_SAFE } = {}) => ({
  getStorageAt: async ({ address, slot }) => pad(slot === ERC1967_ADMIN_SLOT ? adminOf(address) : OTHER),
  readContract: async () => owner,
})

test('an unknown CONTRACT fails', async () => {
  const target = await checkedProxyAdmin(chain(), deployment, 'ProxyAdmin')
  assert.deepEqual(target.refused, [`CONTRACT must be one of ${Object.keys(UPGRADEABLE).join(', ')}, not ProxyAdmin`])
})

test('a proxy whose admin slot is not its CREATE address at nonce 1 is refused', async () => {
  const target = await checkedProxyAdmin(chain({ adminOf: () => OTHER }), deployment, 'SimplexResolver')
  assert.match(target.refused.join('; '), /admin slot of the SimplexResolver proxy/)
})

test('a renounced ProxyAdmin is refused', async () => {
  const target = await checkedProxyAdmin(chain({ owner: zeroAddress }), deployment, 'SimplexResolver')
  assert.match(target.refused.join('; '), /is renounced/)
})

const TIMELOCK = '0x0000000000000000000000000000000000007777'
const TIMELOCK_CODE = '0x6001'
const ADMIN_ROLE = pad('0x00', { size: 32 })
const governance = {
  adminSafe: { kind: 'Safe', address: ADMIN_SAFE, threshold: 2, owners: [OTHER] },
  timelock: {
    kind: 'TimelockController',
    address: TIMELOCK,
    codeHash: keccak256(TIMELOCK_CODE),
    deployBlock: 1,
    minDelay: 604800,
    proposers: [ADMIN_SAFE],
    executors: [ADMIN_SAFE],
    cancellers: [ADMIN_SAFE],
  },
}
const timelockRoles = new Set(['PROPOSER_ROLE', 'EXECUTOR_ROLE', 'CANCELLER_ROLE'].map((role) => keccak256(toHex(role))))
const timelockChain = (code) => {
  const reads = {
    owner: () => ADMIN_SAFE,
    getMinDelay: () => 604800n,
    getRoleAdmin: () => ADMIN_ROLE,
    hasRole: (role, account) => account === ADMIN_SAFE && timelockRoles.has(role),
  }
  return {
    ...chain(),
    getCode: async () => code,
    getBlockNumber: async () => 1n,
    getLogs: async () => [{ args: { role: ADMIN_ROLE, account: TIMELOCK, sender: TIMELOCK } }],
    readContract: async ({ functionName, args = [] }) => reads[functionName](...args),
  }
}

test('a transfer to a Safe entry is refused', async () => {
  const call = await transferCall(timelockChain(TIMELOCK_CODE), deployment, governance, 'SimplexController', 'adminSafe', OTHER)
  assert.deepEqual(call.refused, ['NEXT must name a TimelockController entry of governance.mainnet.json, not adminSafe'])
})

test('a transfer to a timelock that fails its check is refused', async () => {
  const call = await transferCall(timelockChain('0x6002'), deployment, governance, 'SimplexController', 'timelock', OTHER)
  assert.match(call.refused.join('; '), /^timelock 0x0+7777 code hash is 0x[0-9a-f]{64}, expected /)
})

test('a transfer to a timelock that passes its check addresses the ProxyAdmin of the named contract', async () => {
  const call = await transferCall(timelockChain(TIMELOCK_CODE), deployment, governance, 'SimplexController', 'timelock', OTHER)
  assert.deepEqual([call.target.proxyAdmin, call.functionName, call.args],
    [proxyAdminOf(deployment.ETHRegistrarController), 'transferOwnership', [TIMELOCK]])
})

const MIGRATION_ABI = parseAbi(['function migrate(uint256 version)', 'function owner() view returns (address)'])

test('upgrade data is encoded for a function of the candidate', () => {
  assert.deepEqual(upgradeData(MIGRATION_ABI, { signature: 'migrate(uint256)', args: ['42'] }),
    { data: encodeFunctionData({ abi: MIGRATION_ABI, functionName: 'migrate', args: [42n] }) })
})

test('upgrade data for a function the candidate lacks is refused', () => {
  assert.deepEqual(upgradeData(MIGRATION_ABI, { signature: 'migrate(uint8)', args: [1] }),
    { refused: ['it has no function migrate(uint8)'] })
})

const guarded = {
  contractName: 'SimplexNamePolicy',
  abi: [],
  deployedBytecode: `0x${PUSH32}00`,
  immutableReferences: { 21: [{ start: 1, length: 32 }] },
}
const guardedNames = new Map([[21, '_proxyAdmin']])

test("a _proxyAdmin immutable other than the proxy's ProxyAdmin is refused, also when named as an intended change", () => {
  const proxyAdmin = proxyAdminOf(deployment.SimplexNamePolicy)
  const code = placeImmutables(guarded, guardedNames, { _proxyAdmin: OTHER })
  const own = ownImmutables('SimplexNamePolicy', deployment, ADMIN_SAFE, OTHER, proxyAdmin)
  assert.deepEqual(immutableReview(guarded, guardedNames, code, {}, own, ['_proxyAdmin']).failures, [
    `its immutable _proxyAdmin is ${word(OTHER)}, expected ${proxyAdmin}`,
  ])
})

test('an upgradeAndCall whose simulation reverts is refused', async () => {
  const target = { proxy: deployment.SimplexNamePolicy, proxyAdmin: proxyAdminOf(deployment.SimplexNamePolicy), owner: ADMIN_SAFE }
  const client = {
    simulateContract: async () => {
      throw new ContractFunctionRevertedError({ abi: [], functionName: 'upgradeAndCall', message: 'not the ProxyAdmin' })
    },
  }
  assert.deepEqual(await upgradeCallFailures(client, target, OTHER, '0x8fd3ab80'), [
    `upgradeAndCall(${target.proxy}, ${OTHER}, 0x8fd3ab80) from ${ADMIN_SAFE} reverts: ` +
      'The contract function "upgradeAndCall" reverted with the following reason: not the ProxyAdmin',
  ])
})
