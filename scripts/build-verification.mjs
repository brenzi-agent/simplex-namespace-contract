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
import { pathToFileURL } from 'url'
import { loadJournal } from './gas-tools.mjs'
import { loadGovernance } from './governance-check.mjs'
import {
  ADDRESSES_PATH, IMMUTABLE, JOURNAL_PATH, PROXY_ADMIN_ARTIFACT, SOURCE_TAG, TLD, TRANSPARENT_PROXY, UPGRADEABLE,
  VERIFICATION_PATH, accepted, artifact, assertBuildFresh, assertCommitted, assertTaggedSource, causes, constructorArgs,
  ensContractsHead, immutableNames, immutablesIn, initializerData, interfaceOf, mainnetClient, parentHead,
  placeImmutables, proxySlots, refusal, requireEnv, storageLayout,
} from './stack.mjs'

export async function assembleVerification({ client, addresses, deployer, adminSafe }) {
  const ensContractsCommit = ensContractsHead()
  const parentCommit = parentHead()
  const target = (path, address, args) => {
    const { abi, buildInfoId } = artifact(path)
    return { address, artifact: path, constructorArgs: constructorArgs(abi, args), buildInfoId, ensContractsCommit, parentCommit }
  }
  const setup = { tld: TLD, deployer, chainlinkEthUsd: addresses.DummyOracle }
  const contracts = {}
  for (const [name, definition] of Object.entries(UPGRADEABLE)) {
    const proxy = addresses[definition.key]
    const { implementation, admin } = await proxySlots(client, proxy)
    const compiled = artifact(definition.artifact)
    const names = immutableNames(compiled)
    const code = await client.getCode({ address: implementation })
    const immutables = immutablesIn(compiled, names, code)
    if (code !== placeImmutables(compiled, names, immutables)) {
      throw new Error(`the code at ${implementation}, the implementation of the ${name} proxy, differs from ` +
        `${definition.artifact} outside its immutables: build the verification file from the ens-contracts commit that deployed it`)
    }
    contracts[`${name}@${implementation}`] = {
      ...target(definition.artifact, implementation, definition.args(addresses, setup)),
      storageLayout: storageLayout(compiled),
      immutables,
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

export async function verificationFile(client, { addresses, exists, journal, deployer, adminSafe }) {
  if (!addresses) return refusal([`${ADDRESSES_PATH} not found.`])
  if (exists) return refusal([`${VERIFICATION_PATH} exists, and it records every implementation since run 1; it is not rebuilt.`])
  const deployedByRunOne = new Map(journal.map(({ step, address }) => [step, address]))
  const replaced = []
  for (const [name, { key }] of Object.entries(UPGRADEABLE)) {
    const { implementation } = await proxySlots(client, addresses[key])
    if (implementation.toLowerCase() !== deployedByRunOne.get(`deploy:${name}`)?.toLowerCase()) {
      replaced.push(`the ${name} proxy runs ${implementation}, not the implementation run 1 deployed.`)
    }
  }
  if (replaced.length) return refusal(replaced)
  if (!deployer) {
    return refusal(['deployer address not provided and no journal available to look it up. ' +
      'Set DEPLOYER=0x… (the EOA that ran deploy-mainnet.mjs).'])
  }
  return accepted({ meta: await assembleVerification({ client, addresses, deployer, adminSafe }) })
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
  assertTaggedSource(SOURCE_TAG)
  assertCommitted(['scripts', 'governance.mainnet.json'])
  assertBuildFresh()
  const client = await mainnetClient(rpcUrl)
  const built = await verificationFile(client, {
    addresses: existsSync(ADDRESSES_PATH) ? JSON.parse(readFileSync(ADDRESSES_PATH, 'utf8')) : undefined,
    exists: existsSync(VERIFICATION_PATH),
    journal: loadJournal(JOURNAL_PATH),
    deployer: process.env.DEPLOYER || (await lookupDeployerFromJournal(rpcUrl)),
    adminSafe: loadGovernance().adminSafe.address,
  })
  if (built.refused) {
    for (const failure of built.failures) console.error(`ERROR: ${failure}`)
    process.exit(1)
  }
  const { meta } = built

  writeFileSync(VERIFICATION_PATH, JSON.stringify(meta, null, 2))
  console.log(`Wrote ${VERIFICATION_PATH}`)
  console.log(`Targets:`)
  for (const [name, t] of Object.entries(meta.contracts)) {
    console.log(`  ${name.padEnd(64)} ${t.address}`)
  }
}

// Run as CLI when invoked directly.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch((e) => { console.error(causes(e).join('\n  ← ')); process.exit(1) })
}
