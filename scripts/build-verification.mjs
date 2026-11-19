#!/usr/bin/env node
/**
 * Build verification.mainnet.simplex.json from deployments.mainnet.simplex.json.
 * Used as:
 *
 *   - Imported by deploy-mainnet.mjs to write the file at the end of run 1.
 *   - Run standalone to rebuild it, from a checkout of the ens-contracts commit
 *     that run 1 deployed.
 *
 * The implementation and the ProxyAdmin of each proxy are read from its ERC-1967
 * slots. Constructor arguments are reconstructed from the addresses in the
 * deployments JSON, the deploy key and the admin Safe of governance.mainnet.json.
 *
 * Required env vars:
 *   MAINNET_RPC_URL    reads the proxies' ERC-1967 slots
 *
 * Optional env vars:
 *   DEPLOYER           0x-prefixed deployer EOA. If unset, the script
 *                      reads the first line of the deploy journal and
 *                      asks the RPC for the from-address.
 *
 * Writes:
 *   verification.mainnet.simplex.json
 *
 * Run:
 *   MAINNET_RPC_URL=… DEPLOYER=0x… node scripts/build-verification.mjs
 */
import { createPublicClient, http } from 'viem'
import { mainnet } from 'viem/chains'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { loadGovernance } from './governance-check.mjs'
import {
  IMMUTABLE, PROXY_ADMIN, TRANSPARENT_PROXY, UPGRADEABLE,
  artifact, constructorArgs, initializerData, proxySlots, storageLayout,
} from './stack.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const TLD = 'simplex'

const target = (path, address, args) => ({
  address,
  artifact: path,
  constructorArgs: constructorArgs(artifact(path).abi, args),
})

/**
 * Given the deployment addresses, the deploy key and the admin Safe, return the
 * verification metadata object. Used by deploy-mainnet.mjs at the end of run 1,
 * where every input is already in scope.
 */
export async function assembleVerification({ client, addresses, deployer, adminSafe }) {
  const setup = { tld: TLD, deployer, chainlinkEthUsd: addresses.DummyOracle }
  const contracts = {}
  for (const [name, definition] of Object.entries(UPGRADEABLE)) {
    const proxy = addresses[definition.key]
    const { implementation, admin } = await proxySlots(client, proxy)
    contracts[`${name}@${implementation}`] = {
      ...target(definition.artifact, implementation, definition.args(addresses, setup)),
      storageLayout: storageLayout(artifact(definition.artifact)),
    }
    contracts[`${name}Proxy`] = target(TRANSPARENT_PROXY, proxy,
      [implementation, adminSafe, initializerData(name, addresses, setup)])
    contracts[`${name}ProxyAdmin`] = target(PROXY_ADMIN, admin, [adminSafe])
  }
  for (const [name, { artifact: path, args }] of Object.entries(IMMUTABLE)) {
    contracts[name] = target(path, addresses[name], args(addresses, setup))
  }
  return { network: 'mainnet', chainId: '1', tld: TLD, deployer, contracts }
}

// ----- CLI -----

async function lookupDeployerFromJournal(rpcUrl) {
  const journalPath = join(REPO_ROOT, `deployments.mainnet.${TLD}.journal.jsonl`)
  if (!existsSync(journalPath)) return null
  const first = readFileSync(journalPath, 'utf8').split('\n').filter(Boolean)[0]
  if (!first) return null
  const { txHash } = JSON.parse(first)
  if (!txHash) return null
  const r = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getTransactionByHash', params: [txHash], id: 1 }),
  })
  const { result } = await r.json()
  return result?.from || null
}

async function cli() {
  const rpcUrl = process.env.MAINNET_RPC_URL
  if (!rpcUrl) {
    console.error('ERROR: MAINNET_RPC_URL env var is required.')
    process.exit(1)
  }
  const deploymentsPath = join(REPO_ROOT, `deployments.mainnet.${TLD}.json`)
  if (!existsSync(deploymentsPath)) {
    console.error(`ERROR: ${deploymentsPath} not found.`)
    process.exit(1)
  }
  const addresses = JSON.parse(readFileSync(deploymentsPath, 'utf8'))

  const deployer = process.env.DEPLOYER || (await lookupDeployerFromJournal(rpcUrl))
  if (!deployer) {
    console.error(
      'ERROR: deployer address not provided and no journal available to look it up. ' +
        'Set DEPLOYER=0x… (the EOA that ran deploy-mainnet.mjs).',
    )
    process.exit(1)
  }

  const meta = await assembleVerification({
    client: createPublicClient({ chain: mainnet, transport: http(rpcUrl) }),
    addresses,
    deployer,
    adminSafe: loadGovernance().adminSafe.address,
  })

  const outPath = join(REPO_ROOT, `verification.mainnet.${TLD}.json`)
  writeFileSync(outPath, JSON.stringify(meta, null, 2))
  console.log(`Wrote ${outPath}`)
  console.log(`Targets:`)
  for (const [name, t] of Object.entries(meta.contracts)) {
    console.log(`  ${name.padEnd(64)} ${t.address}`)
  }
}

// Run as CLI when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  cli().catch((e) => { console.error(e); process.exit(1) })
}
