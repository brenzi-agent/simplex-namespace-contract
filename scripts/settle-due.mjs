#!/usr/bin/env node
import { createPublicClient, createWalletClient, getAddress, http, parseAbi, parseAbiItem, parseGwei } from 'viem'
import { mainnet } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { deploymentBlock, eventLogs } from './gas-tools.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REVERSIBLE = parseAbiItem(
  'event NamePaymentReversible(bytes32 indexed labelhash, uint256 reversibleUntil, uint256 paidExpires, bool renewal)',
)
const settlementAbi = parseAbi([
  'function reversiblePayment(uint256 id) view returns (uint256 reversibleUntil, uint256 paidExpires, bool reversed, bool renewal)',
  'function settle(string label)',
])
const policyAbi = parseAbi(['function settlement() view returns (address)'])
const registrarAbi = parseAbi(['function labelOf(uint256 id) view returns (string)'])

const { RPC_URL, SETTLER_KEY, FROM_BLOCK, MAX_BASE_FEE_GWEI } = process.env
const ADDRESSES = process.env.ADDRESSES || 'deployments.mainnet.simplex.json'
for (const [name, value] of Object.entries({ RPC_URL, SETTLER_KEY })) {
  if (!value) {
    console.error(`${name} is required`)
    process.exit(1)
  }
}
const account = privateKeyToAccount(SETTLER_KEY)
const fees = MAX_BASE_FEE_GWEI ? { maxFeePerGas: parseGwei(MAX_BASE_FEE_GWEI), maxPriorityFeePerGas: 0n } : {}
const addresses = JSON.parse(readFileSync(join(REPO_ROOT, ADDRESSES), 'utf8'))
const registrar = getAddress(addresses.BaseRegistrarImplementation)
const client = createPublicClient({ transport: http(RPC_URL) })

async function main() {
  const wallet = createWalletClient({ chain: { ...mainnet, id: await client.getChainId() }, transport: http(RPC_URL), account })
  const settlement = getAddress(await client.readContract({
    address: getAddress(addresses.SimplexNamePolicy), abi: policyAbi, functionName: 'settlement',
  }))
  const latest = await client.getBlock()
  if (fees.maxFeePerGas !== undefined && latest.baseFeePerGas > fees.maxFeePerGas) {
    console.error(`The base fee is ${latest.baseFeePerGas} wei, above MAX_BASE_FEE_GWEI: run again later.`)
    process.exit(1)
  }
  const fromBlock = FROM_BLOCK ? BigInt(FROM_BLOCK) : await deploymentBlock(client, settlement, REPO_ROOT)
  const logs = await eventLogs(client, { address: settlement, event: REVERSIBLE, fromBlock, toBlock: latest.number })
  const ids = new Set(logs.map((log) => BigInt(log.args.labelhash)))
  console.log(`${ids.size} names with a reversible payment since block ${fromBlock} on ${settlement}`)
  let settled = 0
  for (const id of ids) {
    const [reversibleUntil, , reversed] = await client.readContract({
      address: settlement, abi: settlementAbi, functionName: 'reversiblePayment', args: [id],
    })
    if (reversibleUntil === 0n || reversed || reversibleUntil > latest.timestamp) continue
    const label = await client.readContract({ address: registrar, abi: registrarAbi, functionName: 'labelOf', args: [id] })
    try {
      const { request } = await client.simulateContract({
        account, address: settlement, abi: settlementAbi, functionName: 'settle', args: [label],
      })
      const hash = await wallet.writeContract({ ...request, ...fees })
      const { status } = await client.waitForTransactionReceipt({ hash })
      if (status !== 'success') throw new Error(`${hash} reverted`)
      console.log(`  ✓ ${label}: ${hash}`)
      settled++
    } catch (err) {
      console.error(`  ✗ ${label}: ${err.shortMessage || err.message}`)
      process.exitCode = 1
    }
  }
  console.log(`${settled} settled`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
