import { test } from 'node:test'
import assert from 'node:assert/strict'
import { logsFailures } from './deploy-mainnet.mjs'

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
