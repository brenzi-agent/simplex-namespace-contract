#!/usr/bin/env node
/**
 * Build verification.mainnet.simplex.json from deployments.mainnet.simplex.json.
 * Used as:
 *
 *   - Imported by deploy-mainnet.mjs to write the file at the end of run 1.
 *   - Run standalone when run 1 did not write it, before any upgrade, from a
 *     checkout of the ens-contracts commit that run 1 deployed.
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
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { loadJournal } from './gas-tools.mjs'
import { loadGovernance } from './governance-check.mjs'
import {
  ADDRESSES_PATH, IMMUTABLE, JOURNAL_PATH, PROXY_ADMIN_ARTIFACT, TLD, TRANSPARENT_PROXY, UPGRADEABLE, VERIFICATION_PATH,
  artifact, constructorArgs, immutableNames, immutablesIn, initializerData, interfaceOf, mainnetClient, proxySlots,
  requireEnv, storageLayout,
} from './stack.mjs'

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
    const compiled = artifact(definition.artifact)
    contracts[`${name}@${implementation}`] = {
      ...target(definition.artifact, implementation, definition.args(addresses, setup)),
      storageLayout: storageLayout(compiled),
      immutables: immutablesIn(compiled, immutableNames(compiled), await client.getCode({ address: implementation })),
      ...interfaceOf(compiled.abi),
    }
    contracts[`${name}Proxy`] = target(TRANSPARENT_PROXY, proxy,
      [implementation, adminSafe, initializerData(name, addresses, setup)])
    contracts[`${name}ProxyAdmin`] = target(PROXY_ADMIN_ARTIFACT, admin, [adminSafe])
  }
  for (const [name, { artifact: path, args }] of Object.entries(IMMUTABLE)) {
    contracts[name] = target(path, addresses[name], args(addresses, setup))
  }
  return { network: 'mainnet', chainId: '1', tld: TLD, deployer, contracts }
}

// ----- CLI -----

async function lookupDeployerFromJournal(rpcUrl) {
  const [first] = loadJournal(JOURNAL_PATH)
  const txHash = first?.txHash
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
  const rpcUrl = requireEnv('MAINNET_RPC_URL')
  if (!existsSync(ADDRESSES_PATH)) {
    console.error(`ERROR: ${ADDRESSES_PATH} not found.`)
    process.exit(1)
  }
  if (existsSync(VERIFICATION_PATH)) {
    console.error(`ERROR: ${VERIFICATION_PATH} exists, and it records every implementation since run 1; it is not rebuilt.`)
    process.exit(1)
  }
  const addresses = JSON.parse(readFileSync(ADDRESSES_PATH, 'utf8'))
  const client = await mainnetClient(rpcUrl)
  const deployedByRunOne = new Map(loadJournal(JOURNAL_PATH).map(({ step, address }) => [step, address]))
  for (const [name, { key }] of Object.entries(UPGRADEABLE)) {
    const { implementation } = await proxySlots(client, addresses[key])
    if (implementation.toLowerCase() !== deployedByRunOne.get(`deploy:${name}`)?.toLowerCase()) {
      console.error(`ERROR: the ${name} proxy runs ${implementation}, not the implementation run 1 deployed.`)
      process.exit(1)
    }
  }

  const deployer = process.env.DEPLOYER || (await lookupDeployerFromJournal(rpcUrl))
  if (!deployer) {
    console.error(
      'ERROR: deployer address not provided and no journal available to look it up. ' +
        'Set DEPLOYER=0x… (the EOA that ran deploy-mainnet.mjs).',
    )
    process.exit(1)
  }

  const meta = await assembleVerification({
    client,
    addresses,
    deployer,
    adminSafe: loadGovernance().adminSafe.address,
  })

  writeFileSync(VERIFICATION_PATH, JSON.stringify(meta, null, 2))
  console.log(`Wrote ${VERIFICATION_PATH}`)
  console.log(`Targets:`)
  for (const [name, t] of Object.entries(meta.contracts)) {
    console.log(`  ${name.padEnd(64)} ${t.address}`)
  }
}

// Run as CLI when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  cli().catch((e) => { console.error(e); process.exit(1) })
}
