import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeFunctionData, pad, parseAbi, zeroAddress } from 'viem'
import { acceptanceBatch, logsFailures, registrarAllowanceBatch, registrarAllowanceReadBack } from './deploy-mainnet.mjs'
import { ERC1967_ADMIN_SLOT, batchChecksum, proxyAdminOf } from './stack.mjs'

const HEAD = 30_000_000n
const SERVED = 1_000n
const REFUSAL = 'Archive requests require a personal token'
const REGISTRAR = '0x000000000000000000000000000000000000bEEF'
const TIMELOCK = '0x0000000000000000000000000000000000007777'

const probed = []
const client = {
  getBlockNumber: async () => HEAD,
  getLogs: async (filter) => {
    probed.push(filter)
    if (filter.fromBlock < HEAD - SERVED) throw new Error(REFUSAL)
    return []
  },
}
const timelock = (deployBlock) => ({ timelock: { kind: 'TimelockController', address: TIMELOCK, deployBlock } })
const journalled = (blockNumber) => [{ step: 'deploy:BaseRegistrarImplementationProxy', address: REGISTRAR, blockNumber: String(blockNumber) }]

test('a fresh run probes the logs 50,400 blocks before the head', async () => {
  probed.length = 0
  assert.deepEqual(await logsFailures(client, {}, []), [
    `MAINNET_RPC_URL serves no eth_getLogs at block ${HEAD - 50_400n}, from which run 1 reads the ControllerAdded logs ` +
      `of the registrar proxy, 50400 blocks after its deployment: ${REFUSAL}`,
  ])
  assert.deepEqual(probed, [{ address: undefined, fromBlock: HEAD - 50_400n, toBlock: HEAD - 50_400n }])
})

test('a resumed run probes the block of the registrar proxy, and passes where it is served', async () => {
  probed.length = 0
  assert.deepEqual(await logsFailures(client, {}, journalled(HEAD - 10n)), [])
  assert.deepEqual(probed, [{ address: REGISTRAR, fromBlock: HEAD - 10n, toBlock: HEAD - 10n }])
})

test('a resumed run fails where the block of the registrar proxy is not served', async () => {
  assert.deepEqual(await logsFailures(client, {}, journalled(HEAD - 7_200n)), [
    `MAINNET_RPC_URL serves no eth_getLogs at block ${HEAD - 7_200n}, from which run 1 reads the ControllerAdded logs ` +
      `of the registrar proxy: ${REFUSAL}`,
  ])
})

test('the deployBlock of a timelock entry is probed', async () => {
  probed.length = 0
  assert.deepEqual(await logsFailures(client, timelock(1), journalled(HEAD - 10n)), [
    `MAINNET_RPC_URL serves no eth_getLogs at block 1, from which run 1 reads the RoleGranted logs of timelock: ${REFUSAL}`,
  ])
  assert.deepEqual(probed.at(-1), { address: TIMELOCK, fromBlock: 1n, toBlock: 1n })
})

const ADMIN_SAFE = '0xf38920389740E46A7f4160DaF1672f3df2754Df4'
const GUARDIAN_SAFE = '0xE6623AA6b8d335367828C2A8b06A714678d22e2c'
const WALLET = '0x0000000000000000000000000000000000005678'
const deployment = {
  ETHRegistrarController: '0x0000000000000000000000000000000000000001',
  SimplexPriceOracle: '0x0000000000000000000000000000000000000002',
  SimplexSponsor: '0x0000000000000000000000000000000000000003',
}
const SAFE_CALLS = parseAbi([
  'function acceptOwnership()',
  'function setRegistrarAllowance(address registrar, uint256 allowanceUSD)',
  'function registrarAllowance(address registrar) view returns (uint256)',
])
const governance = { adminSafe: { kind: 'Safe', address: ADMIN_SAFE }, guardianSafe: { kind: 'Safe', address: GUARDIAN_SAFE } }
const withWallet = { ...governance, registrarWallet: { kind: 'EOA', address: WALLET, allowance: 7n } }
const sponsorChain = ({ code, allowance = 7n, proxied = true, links = {} } = {}) => {
  const reads = {
    [`${deployment.ETHRegistrarController}.sponsor`]: deployment.SimplexSponsor,
    [`${deployment.SimplexSponsor}.controller`]: deployment.ETHRegistrarController,
    [`${deployment.ETHRegistrarController}.beneficiary`]: GUARDIAN_SAFE,
    ...links,
  }
  return {
    getCode: async () => code,
    getStorageAt: async ({ address, slot }) =>
      pad(proxied && address === deployment.SimplexSponsor && slot === ERC1967_ADMIN_SLOT ? proxyAdminOf(address) : zeroAddress),
    readContract: async ({ address, functionName, args }) => (functionName === 'registrarAllowance'
      ? (address === deployment.SimplexSponsor && args[0] === WALLET ? allowance : 0n)
      : reads[`${address}.${functionName}`]),
  }
}
const checksumValid = ({ meta: { checksum, ...meta }, ...batch }) => checksum === batchChecksum({ ...batch, meta })

test("run 1's batch has the admin Safe accept the controller and the oracle", () => {
  const batch = acceptanceBatch(ADMIN_SAFE, deployment)
  const data = encodeFunctionData({ abi: SAFE_CALLS, functionName: 'acceptOwnership' })
  assert.equal(batch.meta.createdFromSafeAddress, ADMIN_SAFE)
  assert.deepEqual(batch.transactions, [
    { to: deployment.ETHRegistrarController, value: '0', data },
    { to: deployment.SimplexPriceOracle, value: '0', data },
  ])
  assert.ok(checksumValid(batch))
})

test('the registrar step without a registrarWallet entry is refused', async () => {
  assert.deepEqual(await registrarAllowanceBatch(sponsorChain(), governance, deployment),
    { refused: true, failures: ['governance.mainnet.json has no registrarWallet entry'] })
  assert.deepEqual(await registrarAllowanceReadBack(sponsorChain(), governance, deployment),
    ['governance.mainnet.json has no registrarWallet entry'])
})

test('the registrar step refuses a registrar wallet with code', async () => {
  assert.deepEqual(await registrarAllowanceBatch(sponsorChain({ code: '0xef0100' }), withWallet, deployment),
    { refused: true, failures: [`registrarWallet ${WALLET} has code 0xef0100…`] })
})

test("the registrar step writes the guardian Safe's setRegistrarAllowance to the sponsor proxy", async () => {
  const prepared = await registrarAllowanceBatch(sponsorChain(), withWallet, deployment)
  assert.equal(prepared.refused, false)
  assert.equal(prepared.batch.meta.createdFromSafeAddress, GUARDIAN_SAFE)
  assert.deepEqual(prepared.batch.transactions, [{
    to: deployment.SimplexSponsor,
    value: '0',
    data: encodeFunctionData({ abi: SAFE_CALLS, functionName: 'setRegistrarAllowance', args: [WALLET, 7n] }),
  }])
  assert.ok(checksumValid(prepared.batch))
})

test('the registrar step refuses a sponsor that is not a v2 proxy, as in the v1 addresses file', async () => {
  assert.deepEqual(await registrarAllowanceBatch(sponsorChain({ proxied: false }), withWallet, deployment), {
    refused: true,
    failures: [`the sponsor ${deployment.SimplexSponsor} is not a v2 proxy: its admin slot holds ${zeroAddress}, ` +
      `not ${proxyAdminOf(deployment.SimplexSponsor)}`],
  })
})

test('the registrar step refuses a sponsor the controller does not name, and a beneficiary other than the guardian Safe', async () => {
  const links = {
    [`${deployment.ETHRegistrarController}.sponsor`]: WALLET,
    [`${deployment.ETHRegistrarController}.beneficiary`]: ADMIN_SAFE,
  }
  assert.deepEqual(await registrarAllowanceBatch(sponsorChain({ links }), withWallet, deployment), {
    refused: true,
    failures: [
      `sponsor() of ${deployment.ETHRegistrarController} is ${WALLET}, not ${deployment.SimplexSponsor}`,
      `beneficiary() of ${deployment.ETHRegistrarController} is ${ADMIN_SAFE}, not ${GUARDIAN_SAFE}`,
    ],
  })
})

test('the registrar read-back passes on the allowance of the entry and fails on another', async () => {
  assert.deepEqual(await registrarAllowanceReadBack(sponsorChain(), withWallet, deployment), [])
  assert.deepEqual(await registrarAllowanceReadBack(sponsorChain({ allowance: 0n }), withWallet, deployment),
    [`sponsor registrarAllowance of the registrar wallet ${WALLET}`])
})
