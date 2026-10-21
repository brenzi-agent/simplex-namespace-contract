#!/usr/bin/env node
/**
 * Partial mainnet redeploy for the SNRC `.testing` TLD — same wait-for-cheap-base
 * strategy as scripts/deploy-mainnet.mjs (shared gas-tools.mjs).
 *
 * Replaces the `.eth`-hardcoded NameWrapper (`0x9be8…`, which mis-wraps
 * `.testing` names) with the TLD-parameterised one, plus a matching
 * PublicResolver bound to it. Nothing is wrapped on the old wrapper (verified:
 * 0 names) so there is no migration. The registry, registrar, controller and
 * every existing name are untouched — this only deploys new contracts and hands
 * the new wrapper's ownership to the cold owner.
 *
 * Gas-frugal flow:
 *   1. PREFLIGHT — per-step gas via real-mainnet `eth_estimateGas`, then a
 *      ceiling-cost summary + Y/N confirm. (deploy-mainnet.mjs measures gas on a
 *      Hardhat fork instead, but a fork CANNOT execute these deploys: their
 *      constructors call into the *real* ENS registry via ReverseClaimer, which
 *      the fork rejects with "internal error". Real estimateGas works and also
 *      proves the deploys won't revert.)
 *   2. REAL DEPLOY — identical to deploy-mainnet.mjs: every tx sent with
 *      `maxFeePerGas = MAX_BASE_FEE_GWEI`, zero priority, waiting for
 *      `baseFee ≤ cap`, bumping the cap after a long stall, journalling each tx
 *      so a re-run resumes.
 *
 * Required env vars:
 *   DEPLOYER_KEY       hex private key (0x...) of the ephemeral deployer
 *   MAINNET_RPC_URL    JSON-RPC URL for mainnet
 *   MAX_BASE_FEE_GWEI  cap on per-gas price (e.g. "0.1")
 *
 * Optional env vars (same as deploy-mainnet.mjs where shared):
 *   METADATA_URI       ERC-1155 metadata URI for the new wrapper's
 *                      StaticMetadataService (swappable later via
 *                      NameWrapper.setMetadataService).
 *   OWNER_ADDRESS      cold owner to receive NameWrapper ownership
 *                      (default 0xDa064C…0340; set to the deployer to skip).
 *   BUMP_AFTER_HOURS / BUMP_PCT / CONFIRM=yes — as in deploy-mainnet.mjs.
 *
 * Files written (next to the addresses file):
 *   deployments.mainnet.testing.json                   ← updated addresses (on success)
 *   redeploy-wrapper.mainnet.testing.journal.jsonl     ← per-tx journal (resume source)
 *   redeploy-wrapper.mainnet.testing.attempts.log      ← every attempt + reason
 */
import { createPublicClient, createWalletClient, encodeDeployData, http, namehash, parseGwei } from 'viem'
import { mainnet } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { analyzeAndConfirm, createWaitForBaseRunner, loadJournal, DEFAULTS } from './gas-tools.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const ARTIFACTS = join(REPO_ROOT, 'ens-contracts', 'artifacts', 'contracts')

const tld = 'testing'
// DNS-encoded ".testing": 0x07 'testing' 0x00.
const TLD_DNS_NAME = '0x0774657374696e6700'
const tldNode = namehash(tld)

const rpcUrl = process.env.MAINNET_RPC_URL
const deployerKey = process.env.DEPLOYER_KEY
const maxBaseFeeGwei = process.env.MAX_BASE_FEE_GWEI
const metadataUri = process.env.METADATA_URI || 'https://metadata.simplex.chat/mainnet/{id}'
const ownerAddress = process.env.OWNER_ADDRESS || '0xDa064C4567fAD2c9Da7b6DD08b5C2B2607960340'

const bumpAfterMs = (parseFloat(process.env.BUMP_AFTER_HOURS) || (DEFAULTS.BUMP_AFTER_MS / 3600000)) * 3600 * 1000
const bumpPct = BigInt(process.env.BUMP_PCT || DEFAULTS.BUMP_PCT)

if (!deployerKey) { console.error('ERROR: DEPLOYER_KEY env var is required.'); process.exit(1) }
if (!rpcUrl) { console.error('ERROR: MAINNET_RPC_URL env var is required.'); process.exit(1) }
if (!maxBaseFeeGwei) {
  console.error('ERROR: MAX_BASE_FEE_GWEI env var is required (e.g. "0.1").')
  console.error('       Pick this from Dune (e.g. the 5th-percentile recent base fee).')
  process.exit(1)
}
const maxBaseFeeWei = parseGwei(maxBaseFeeGwei)

const account = privateKeyToAccount(deployerKey)
const addressesPath = join(REPO_ROOT, `deployments.mainnet.${tld}.json`)
const journalPath = join(REPO_ROOT, `redeploy-wrapper.mainnet.${tld}.journal.jsonl`)
const attemptsLogPath = join(REPO_ROOT, `redeploy-wrapper.mainnet.${tld}.attempts.log`)

if (!existsSync(addressesPath)) {
  console.error(`ERROR: ${addressesPath} not found — need the existing deployment addresses.`)
  process.exit(1)
}
const existing = JSON.parse(readFileSync(addressesPath, 'utf8'))
for (const k of ['ENSRegistry', 'BaseRegistrarImplementation', 'ReverseRegistrar', 'ETHRegistrarController']) {
  if (!existing[k]) { console.error(`ERROR: ${addressesPath} missing ${k}`); process.exit(1) }
}

function loadArtifact(path) {
  const json = JSON.parse(readFileSync(join(ARTIFACTS, path), 'utf8'))
  return { abi: json.abi, bytecode: json.bytecode }
}

/**
 * Preflight runner: measures per-step gas via real-mainnet estimateGas, shaped
 * like gas-tools' dry runner (returns {totals, deploy, write}) so it drops into
 * runDeploySequence. Deploys return a placeholder address — the constructors
 * here only *store* their address args (never call them), so the estimate is
 * independent of the real downstream addresses.
 */
function createEstimateRunner({ publicClient, account }) {
  let totalGas = 0n
  const perStep = []
  let step = 0
  const nextLabel = () => `step:${String(++step).padStart(3, '0')}`
  return {
    totals: () => ({ totalGas, perStep }),
    deploy: async (name, abi, bytecode, args = []) => {
      const label = nextLabel()
      const g = await publicClient.estimateGas({ account: account.address, data: encodeDeployData({ abi, bytecode, args }) })
      totalGas += g
      perStep.push({ step: label, name, gasUsed: g })
      return { address: account.address, abi }
    },
    write: async (_contract, fn) => {
      const label = nextLabel()
      // Target is a placeholder during estimation, so estimateGas would revert;
      // transferOwnership is a cheap setter — use a safe nominal ceiling.
      const g = 60_000n
      totalGas += g
      perStep.push({ step: label, name: fn, gasUsed: g })
    },
  }
}

/**
 * The partial-redeploy sequence, parameterised by a runner — called once with
 * the estimate runner for the preview, then with the real wait-for-base runner.
 * Reuses the existing registry/registrar/controller/reverse-registrar. Returns
 * the merged addresses object for deployments.mainnet.testing.json.
 */
async function runDeploySequence({ deploy: deployRaw, write }) {
  const deploy = async (name, artifactPath, args = []) => {
    const { abi, bytecode } = loadArtifact(artifactPath)
    return deployRaw(name, abi, bytecode, args)
  }

  // 1) Metadata service for the new wrapper (swappable later).
  const metadata = await deploy('StaticMetadataService',
    'wrapper/StaticMetadataService.sol/StaticMetadataService.json',
    [metadataUri])

  // 2) Fixed, TLD-parameterised NameWrapper.
  const nameWrapper = await deploy('NameWrapper',
    'wrapper/NameWrapper.sol/NameWrapper.json',
    [existing.ENSRegistry, existing.BaseRegistrarImplementation, metadata.address, tldNode, TLD_DNS_NAME])

  // 3) New PublicResolver bound to the new wrapper. trustedETHController =
  //    SimplexController (ETHRegistrarController key); trustedReverse =
  //    ReverseRegistrar — per the PublicResolver gotcha in CLAUDE.md.
  const publicResolver = await deploy('PublicResolver',
    'resolvers/PublicResolver.sol/PublicResolver.json',
    [existing.ENSRegistry, nameWrapper.address, existing.ETHRegistrarController, existing.ReverseRegistrar])

  // 4) Hand NameWrapper ownership to the cold owner (PublicResolver is ownerless).
  if (ownerAddress.toLowerCase() !== account.address.toLowerCase()) {
    await write(nameWrapper, 'transferOwnership', [ownerAddress])
  }

  return {
    ...existing,
    NameWrapper: nameWrapper.address,
    PublicResolver: publicResolver.address,
    NameWrapperPublicResolver: publicResolver.address,
    StaticMetadataService: metadata.address,
  }
}

async function main() {
  console.log(`SNRC mainnet wrapper redeploy for .${tld} (chainId ${mainnet.id})`)
  console.log(`  Deployer:      ${account.address}`)
  console.log(`  Cold owner:    ${ownerAddress}`)
  console.log(`  Metadata URI:  ${metadataUri}`)
  console.log(`  Cap (gwei):    ${maxBaseFeeGwei}`)
  console.log(`  Bump rule:     after ${bumpAfterMs / 3600000}h stall, cap × ${Number(100n + bumpPct) / 100}`)
  console.log(`  Reusing:       registry ${existing.ENSRegistry}, registrar ${existing.BaseRegistrarImplementation},`)
  console.log(`                 controller ${existing.ETHRegistrarController}, reverse ${existing.ReverseRegistrar}`)
  console.log(`  Journal:       ${journalPath}`)

  const transport = http(rpcUrl)
  const publicClient = createPublicClient({ chain: mainnet, transport })
  const walletClient = createWalletClient({ chain: mainnet, transport, account })

  // ----- 1. Preflight: real-mainnet estimateGas (also proves no revert) -----
  console.log(`\n--- Gas preflight (real-mainnet estimateGas) ---`)
  const est = createEstimateRunner({ publicClient, account })
  await runDeploySequence({ deploy: est.deploy, write: est.write })
  const dryTotals = est.totals()
  console.log(`Estimated ${dryTotals.perStep.length} steps, ${dryTotals.totalGas.toLocaleString()} gas total`)

  // ----- 2. Confirm -----
  await analyzeAndConfirm({
    publicClient, account,
    maxBaseFeeWei, dryRunTotals: dryTotals,
    journalPath, bumpAfterMs, bumpPct,
    label: `.${tld} mainnet wrapper-redeploy preflight`,
  })

  // ----- 3. Real deploy against mainnet (identical to deploy-mainnet.mjs) -----
  console.log(`\n--- Real deploy ---`)
  const real = createWaitForBaseRunner({
    publicClient, walletClient, account,
    maxBaseFeeWei, bumpAfterMs, bumpPct,
    journalPath, attemptsLogPath,
  })

  const addresses = await runDeploySequence({ deploy: real.deploy, write: real.write })

  console.log(`\nDeployer remaining balance: ${(Number(await publicClient.getBalance({ address: account.address })) / 1e18).toFixed(6)} ETH`)
  console.log(`Total spent this run+prior: ${(Number(real.spent()) / 1e18).toFixed(6)} ETH`)

  writeFileSync(addressesPath, JSON.stringify(addresses, null, 2))
  console.log(`\nUpdated ${addressesPath}:`)
  console.log(`  NameWrapper               = ${addresses.NameWrapper}`)
  console.log(`  PublicResolver            = ${addresses.PublicResolver}`)
  console.log(`  NameWrapperPublicResolver = ${addresses.NameWrapperPublicResolver}`)
  console.log(`  StaticMetadataService     = ${addresses.StaticMetadataService}`)

  // Resolve deploy blocks (for subgraph startBlock) from the journal tx hashes.
  const journal = loadJournal(journalPath)
  const blockOf = async (addr) => {
    const e = journal.find((j) => j.address && j.address.toLowerCase() === addr.toLowerCase())
    if (!e) return '<lookup tx in journal>'
    const r = await publicClient.getTransactionReceipt({ hash: e.txHash }).catch(() => null)
    return r ? Number(r.blockNumber) : '<lookup tx in journal>'
  }
  console.log(`\nSubgraph startBlocks:`)
  console.log(`  NameWrapper:    ${await blockOf(addresses.NameWrapper)}`)
  console.log(`  PublicResolver: ${await blockOf(addresses.PublicResolver)}`)

  console.log(`\nConstructor args for Etherscan verification:`)
  console.log(`  StaticMetadataService(${JSON.stringify(metadataUri)})`)
  console.log(`  NameWrapper(${existing.ENSRegistry}, ${existing.BaseRegistrarImplementation}, ${addresses.StaticMetadataService}, ${tldNode}, ${TLD_DNS_NAME})`)
  console.log(`  PublicResolver(${existing.ENSRegistry}, ${addresses.NameWrapper}, ${existing.ETHRegistrarController}, ${existing.ReverseRegistrar})`)

  console.log(`\nNext (docs/redeploy-wrapper-testing.md):`)
  console.log(`  - commit ${addressesPath} AND ${journalPath}; copy the json to testing-app/`)
  console.log(`  - subgraph.yaml: NameWrapper datasource address+startBlock; add a ResolverV2 datasource`)
  console.log(`  - ens-metadata-service: ADDRESS_NAME_WRAPPER=${addresses.NameWrapper}`)
  console.log(`  - tag simplex-mainnet-${tld}-v2`)
}

main().catch((err) => { console.error(err); process.exit(1) })
