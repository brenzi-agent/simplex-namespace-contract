#!/usr/bin/env node
/**
 * Deploy a fresh SimplexController **implementation** contract for a UUPS
 * upgrade of the existing proxy on Sepolia.
 *
 * After this script prints the new implementation address, the cold owner
 * submits:
 *
 *   SimplexController.upgradeTo(<new impl address>)
 *
 * at the proxy address. The proxy keeps its state (commitments, NFT gate
 * flag, ownership) but starts dispatching calls to the new logic. A proxy
 * from before `SimplexNamePolicy` keeps its reserved names only in an
 * unused slot, and registration and renewal revert until the owner calls
 * `setNamePolicy` with a policy that lists them.
 *
 * Required env vars:
 *   DEPLOYER_KEY    - hex private key of the (ephemeral) deployer EOA
 *   SEPOLIA_RPC_URL - JSON-RPC URL for Sepolia
 *
 * Outputs the new impl address to stdout and appends a record to
 * `impls.sepolia.json` (a running log of every implementation deployed).
 *
 * Run from the parent repo:
 *   DEPLOYER_KEY=0x... SEPOLIA_RPC_URL=https://... \
 *     node scripts/deploy-controller-impl.mjs
 */
import { createPublicClient, createWalletClient, http } from 'viem'
import { sepolia } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ARTIFACTS = join(__dirname, '..', 'ens-contracts', 'artifacts', 'contracts')

const rpcUrl = process.env.SEPOLIA_RPC_URL
const deployerKey = process.env.DEPLOYER_KEY

if (!deployerKey) {
  console.error('ERROR: DEPLOYER_KEY env var is required.')
  process.exit(1)
}
if (!rpcUrl) {
  console.error('ERROR: SEPOLIA_RPC_URL env var is required.')
  process.exit(1)
}

const account = privateKeyToAccount(deployerKey)
const transport = http(rpcUrl)
const publicClient = createPublicClient({ chain: sepolia, transport })
const walletClient = createWalletClient({ chain: sepolia, transport, account })

function loadArtifact(path) {
  const full = join(ARTIFACTS, path)
  const json = JSON.parse(readFileSync(full, 'utf8'))
  return { abi: json.abi, bytecode: json.bytecode }
}

async function main() {
  console.log(`Deploying SimplexController implementation to Sepolia`)
  console.log(`  Deployer: ${account.address}`)
  const balance = await publicClient.getBalance({ address: account.address })
  console.log(`  Balance:  ${balance} wei\n`)

  const { abi, bytecode } = loadArtifact(
    'simplex/SimplexController.sol/SimplexController.json',
  )
  // Implementation has a no-arg constructor that just calls _disableInitializers().
  const hash = await walletClient.deployContract({ abi, bytecode, args: [] })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  const implAddress = receipt.contractAddress
  console.log(`Deployed: ${implAddress}`)
  console.log(`Tx:       ${hash}\n`)

  // Append a record to impls.sepolia.json so we keep a history of every
  // implementation ever deployed — useful for rollback / audit trail.
  const logPath = join(__dirname, '..', 'impls.sepolia.json')
  const log = existsSync(logPath) ? JSON.parse(readFileSync(logPath, 'utf8')) : []
  log.push({
    address: implAddress,
    txHash: hash,
    blockNumber: Number(receipt.blockNumber),
  })
  writeFileSync(logPath, JSON.stringify(log, null, 2))
  console.log(`Recorded in ${logPath}`)

  // Read current proxy + cold owner from verification.sepolia.json for the
  // next-step reminder.
  let proxy = '<SimplexControllerProxy>'
  let coldOwner = '<cold owner>'
  try {
    const ver = JSON.parse(
      readFileSync(join(__dirname, '..', 'verification.sepolia.json'), 'utf8'),
    )
    proxy = ver.SimplexControllerProxy || proxy
    coldOwner = ver.coldOwner || coldOwner
  } catch {}

  console.log(`\nTo activate, the cold owner (${coldOwner}) submits:`)
  console.log(`  SimplexController.upgradeTo(${implAddress})`)
  console.log(`at the proxy ${proxy}.`)
  console.log(`\nAfter the tx lands, update verification.sepolia.json's`)
  console.log(`SimplexControllerImpl field to the new impl address and re-run`)
  console.log(`scripts/verify-etherscan.mjs to get the new bytecode verified.`)
}

main().catch((err) => { console.error(err); process.exit(1) })
