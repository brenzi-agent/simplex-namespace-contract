#!/usr/bin/env node
/**
 * Deploy SNRC contracts to Ethereum mainnet — wait-for-cheap-base strategy.
 *
 * Each TLD (.testing, .simplex) is an independent deployment — run this
 * script once per TLD. Strategy / contracts otherwise mirror Sepolia.
 *
 * Workflow:
 *   1. Spawns a local Hardhat fork of mainnet and runs the full deploy
 *      sequence against it as a dry-run to capture per-step gasUsed.
 *   2. Computes ceiling cost = total gas × MAX_BASE_FEE_GWEI, prints a
 *      summary, prompts Y/N.
 *   3. Stops the fork. Runs the real deploy against mainnet, sending every
 *      tx with `maxFeePerGas = MAX_BASE_FEE_GWEI` and zero priority. Each
 *      tx waits for `baseFeePerGas ≤ cap` before submission.
 *   4. If a submitted tx stalls (base climbed back above cap, mempool
 *      eviction, etc.) for `BUMP_AFTER_HOURS`, the cap bumps by
 *      `BUMP_PCT%` and resubmits at the same nonce.
 *   5. Every successful tx appends to a JSONL journal; re-running the
 *      script picks up where it left off.
 *   6. The first complete run stops before the single-step handovers and
 *      prints the admin's acceptOwnership calls. Running it again after the
 *      admin has accepted hands over the registrar and the registry root.
 *
 * Required env vars:
 *   DEPLOYER_KEY       hex private key (0x...) of the ephemeral deployer
 *   MAINNET_RPC_URL    JSON-RPC URL for mainnet (used by both fork + real)
 *   MAX_BASE_FEE_GWEI  cap on per-gas price (e.g. "0.078")
 *   OWNER_ADDRESS      admin key; must differ from the deployer
 *
 * Optional env vars:
 *   SIMPLEX_TLD        'testing' (default) | 'simplex'
 *   ETHUSD_FEED        Chainlink AggregatorV3 (default: mainnet feed)
 *   SMPXNFT_ADDR       SMPXNFT contract  (default: 0x3AF6D9Ee…7291)
 *   BUMP_AFTER_HOURS   stall threshold before cap bump (default: 24)
 *   BUMP_PCT           cap multiplier on stall (default: 20)
 *   ABSOLUTE_MAX_BASE_FEE_GWEI  ceiling the bumps stop at (default: 4× MAX_BASE_FEE_GWEI)
 *   FORK_PORT          local port for the dry-run fork (default: 18545 — picked
 *                      to avoid Reth/Geth's stock 8545/8546 ports)
 *   CONFIRM=yes        skip the interactive confirmation prompt
 *
 * Reads reserved-names.${tld}.csv (name,reason,category), required for .simplex.
 * Reads terms.${tld}.json ({ "generalTerms": link, "communityTerms": link }), required,
 * each link checked by terms-check.mjs before any transaction,
 * and community-names.${tld}.csv (name,community), optional.
 *
 * Files written next to the addresses file:
 *   deployments.mainnet.${tld}.json            ← final addresses (on success)
 *   deployments.mainnet.${tld}.journal.jsonl   ← per-tx journal (resume source)
 *   deployments.mainnet.${tld}.attempts.log    ← every attempt + reason
 *
 * Commit the addresses file AND the journal to the repo.
 * See docs/deployment.md → Mainnet.
 */
import { createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, keccak256, labelhash, namehash, parseGwei, parseEther, toBytes, zeroHash, zeroAddress } from 'viem'
import { mainnet } from 'viem/chains'
import { normalize } from 'viem/ens'
import { privateKeyToAccount } from 'viem/accounts'
import { execFileSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  analyzeAndConfirm, createDryRunRunner, createWaitForBaseRunner,
  fundOnFork, loadJournal, spawnHardhatFork, DEFAULTS,
} from './gas-tools.mjs'
import { assembleVerification } from './build-verification.mjs'
import {
  SIMPLEX_PRICE_BASE,
  SIMPLEX_PRICE_RUNGS,
  SIMPLEX_PRICE_ORACLE_ARTIFACT,
  USD_FEED_DECIMALS,
} from './simplex-price-curve.mjs'
import { checkTermsLink } from './terms-check.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const ARTIFACTS = join(REPO_ROOT, 'ens-contracts', 'artifacts', 'contracts')
const ENS_CONTRACTS_DIR = join(REPO_ROOT, 'ens-contracts')

const rpcUrl = process.env.MAINNET_RPC_URL
const deployerKey = process.env.DEPLOYER_KEY
// No default. An unset or typo'd SIMPLEX_TLD silently re-targets the whole run —
// gate logic, price array, journal, addresses file and verification metadata all
// follow it, and a `.testing`-defaulted run would resume against the committed
// `.testing` journal and then overwrite it with a mismatched schema.
const KNOWN_TLDS = ['testing', 'simplex']
const tld = process.env.SIMPLEX_TLD
if (!tld || !KNOWN_TLDS.includes(tld)) {
  console.error(
    `SIMPLEX_TLD must be set explicitly to one of: ${KNOWN_TLDS.join(', ')} (got ${JSON.stringify(tld)})`,
  )
  process.exit(1)
}
const nftGateEnabled = tld === 'testing'
const maxBaseFeeGwei = process.env.MAX_BASE_FEE_GWEI

// EIP-55 checksums every address the run will bake in permanently. `getAddress`
// rejects a wrong-length or mistyped address and a bad checksum, which is the
// only automatic protection against a transposed character in an env var that
// ends up owning the namespace.
function requireAddress(label, value) {
  try {
    return getAddress(value)
  } catch {
    console.error(`${label} is not a valid checksummed address: ${JSON.stringify(value)}`)
    process.exit(1)
  }
}
const chainlinkEthUsd = requireAddress('ETHUSD_FEED', process.env.ETHUSD_FEED || '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419')
const smpxNftAddr = requireAddress('SMPXNFT_ADDR', process.env.SMPXNFT_ADDR || '0x3AF6D9Ee862376A8DFC0a78847Eb20A153557291')
const ownerAddress = process.env.OWNER_ADDRESS
  ? requireAddress('OWNER_ADDRESS', process.env.OWNER_ADDRESS)
  : undefined
if (!ownerAddress) {
  console.error(
    'OWNER_ADDRESS must be set to the admin key.\n' +
      '  It receives the registrar and the registry root for good, so no default\n' +
      '  may pick the key for the operator.',
  )
  process.exit(1)
}
// The guardian holds the restrictive, no-delay powers: setRegistrarAllowance (the
// money kill switch), setPublicSalesOpen (the pause), addReservedNames, and it is
// `withdraw`'s payee. It must differ from the admin owner — that separation is the
// point. See docs/plans/names-v2-launch-to-freeze-plan.md.
const guardianAddress = process.env.GUARDIAN_ADDRESS
  ? requireAddress('GUARDIAN_ADDRESS', process.env.GUARDIAN_ADDRESS)
  : undefined
if (!guardianAddress || guardianAddress.toLowerCase() === ownerAddress.toLowerCase()) {
  console.error(
    'GUARDIAN_ADDRESS must be set and must differ from OWNER_ADDRESS.\n' +
      '  `setBeneficiary` is owner-callable only while the beneficiary is unset, so a\n' +
      '  guardian equal to the admin owner is burned in permanently at deploy time and\n' +
      '  collapses the two-key split the admin model is built on.',
  )
  process.exit(1)
}

// SimplexNamePolicy.Reason — the on-chain enum. Append-only once names are
// reserved, so these integers are fixed by the contract, not by this script.
const REASONS = { Internal: 1, Trademark: 2, Community: 3 }
// About 5.2M gas each, well under the per-transaction cap of 16,777,216 (EIP-7825).
const RESERVE_BATCH = 200
// The labels users can register: simplex-app src/hooks/useValidate.ts ALLOWED_LABEL_REGEX.
const ALLOWED_LABEL_REGEX = /^(?!.{2}--)[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
const reservedNamesPath = join(REPO_ROOT, `reserved-names.${tld}.csv`)
const reservedByReason = loadReservedNames(reservedNamesPath)
const terms = loadTerms(join(REPO_ROOT, `terms.${tld}.json`))
const communityNames = loadCommunityNames(join(REPO_ROOT, `community-names.${tld}.csv`))

/// RFC 4180: a quoted field may hold commas, line breaks and doubled quotes.
function parseCsv(text) {
  const rows = [[]]
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { rows.at(-1).push(field); field = '' }
    else if (c === '\n') { rows.at(-1).push(field.replace(/\r$/, '')); field = ''; rows.push([]) }
    else field += c
  }
  if (field || rows.at(-1).length) rows.at(-1).push(field)
  return rows.filter((r) => r.length > 1 || r[0])
}

/// `name,reason,category` rows, as labels grouped by Reason. Only the category
/// goes on chain; the reason is for whoever reads the file.
function loadReservedNames(path) {
  const [header, ...rows] = existsSync(path) ? parseCsv(readFileSync(path, 'utf8')) : []
  const errors = []
  if (header && header.join(',') !== 'name,reason,category') {
    errors.push(`header must be "name,reason,category", got "${header.join(',')}"`)
  }
  const byReason = new Map(Object.values(REASONS).map((r) => [r, []]))
  const seen = new Set()
  rows.forEach(([name, , category, ...extra], i) => {
    const where = `row ${i + 2} (${JSON.stringify(name)})`
    let normalized
    try { normalized = normalize(name) } catch {}
    if (extra.length || category === undefined) errors.push(`${where}: expected 3 fields`)
    else if (!name || name.includes('.')) errors.push(`${where}: not a single label`)
    else if (!ALLOWED_LABEL_REGEX.test(name)) {
      const fix = ALLOWED_LABEL_REGEX.test(normalized ?? '') ? `use ${JSON.stringify(normalized)}` : 'transliterate to a-z, 0-9 and hyphens'
      errors.push(`${where}: users cannot register this label; ${fix}`)
    }
    else if (!(category in REASONS)) errors.push(`${where}: category must be one of ${Object.keys(REASONS).join(', ')}`)
    else if (seen.has(name)) errors.push(`${where}: duplicate`)
    else { seen.add(name); byReason.get(REASONS[category]).push(name) }
  })
  if (tld !== 'testing' && rows.length === 0) {
    errors.push(`no names: .${tld} is not deployed without its reserved set`)
  }
  if (errors.length) {
    console.error(`${path}:\n  ${errors.join('\n  ')}`)
    process.exit(1)
  }
  const own = ['simplex', 'simplex-chat'].filter((name) => !seen.has(name))
  byReason.get(REASONS.Internal).unshift(...own)
  return byReason
}

function loadTerms(path) {
  const { generalTerms, communityTerms } = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  if (!generalTerms || !communityTerms) {
    console.error(`${path} must hold "generalTerms" and "communityTerms": every registration accepts terms`)
    process.exit(1)
  }
  const withHash = (link) => ({ link, hash: keccak256(toBytes(link)) })
  return { generalTerms: withHash(generalTerms), communityTerms: withHash(communityTerms) }
}

/// `name,community` rows. Only the name goes on chain.
function loadCommunityNames(path) {
  const [header, ...rows] = existsSync(path) ? parseCsv(readFileSync(path, 'utf8')) : []
  const errors = []
  if (header && header.join(',') !== 'name,community') {
    errors.push(`header must be "name,community", got "${header.join(',')}"`)
  }
  const seen = new Set()
  rows.forEach(([name, community, ...extra], i) => {
    const where = `row ${i + 2} (${JSON.stringify(name)})`
    let normalized
    try { normalized = normalize(name) } catch {}
    if (extra.length || community === undefined) errors.push(`${where}: expected 2 fields`)
    else if (!name || name.includes('.')) errors.push(`${where}: not a single label`)
    else if (!ALLOWED_LABEL_REGEX.test(name)) {
      const fix = ALLOWED_LABEL_REGEX.test(normalized ?? '') ? `use ${JSON.stringify(normalized)}` : 'transliterate to a-z, 0-9 and hyphens'
      errors.push(`${where}: users cannot register this label; ${fix}`)
    }
    else if (seen.has(name)) errors.push(`${where}: duplicate`)
    else seen.add(name)
  })
  if (errors.length) {
    console.error(`${path}:\n  ${errors.join('\n  ')}`)
    process.exit(1)
  }
  return [...seen]
}

const bumpAfterMs = (parseFloat(process.env.BUMP_AFTER_HOURS) || (DEFAULTS.BUMP_AFTER_MS / 3600000)) * 3600 * 1000
const bumpPct = BigInt(process.env.BUMP_PCT || DEFAULTS.BUMP_PCT)
// Default 18545 (not 8546): Reth/Geth use 8546 for the WebSocket JSON-RPC
// and 8545 for HTTP, so a stock node setup conflicts with the standard
// 8546 default. Pick a port that's unlikely to overlap with anything.
const forkPort = parseInt(process.env.FORK_PORT || '18545', 10)

if (!deployerKey) { console.error('ERROR: DEPLOYER_KEY env var is required.'); process.exit(1) }
if (!rpcUrl) { console.error('ERROR: MAINNET_RPC_URL env var is required.'); process.exit(1) }
if (!maxBaseFeeGwei) {
  console.error('ERROR: MAX_BASE_FEE_GWEI env var is required (e.g. "0.078").')
  console.error('       Pick this from Dune (e.g. the 5th-percentile recent base fee).')
  process.exit(1)
}
const maxBaseFeeWei = parseGwei(maxBaseFeeGwei)
const absoluteMaxBaseFeeWei = process.env.ABSOLUTE_MAX_BASE_FEE_GWEI
  ? parseGwei(process.env.ABSOLUTE_MAX_BASE_FEE_GWEI)
  : undefined

const account = privateKeyToAccount(deployerKey)
if (ownerAddress.toLowerCase() === account.address.toLowerCase()) {
  console.error('OWNER_ADDRESS must differ from the deploy key, which is destroyed after the handover.')
  process.exit(1)
}
const addressesPath = join(REPO_ROOT, `deployments.mainnet.${tld}.json`)
const journalPath = join(REPO_ROOT, `deployments.mainnet.${tld}.journal.jsonl`)
const attemptsLogPath = join(REPO_ROOT, `deployments.mainnet.${tld}.attempts.log`)

function loadArtifact(path) {
  const full = join(ARTIFACTS, path)
  const json = JSON.parse(readFileSync(full, 'utf8'))
  return { abi: json.abi, bytecode: json.bytecode }
}

/**
 * The actual SNRC deploy sequence, parameterised by a runner. Called
 * once with a dry-run runner (forked node) to capture gas, then again
 * with the real wait-for-base runner against mainnet.
 *
 * Returns the addresses object suitable for deployments.mainnet.${tld}.json.
 */
async function runDeploySequence({ deploy: deployRaw, write, adminAccepted }) {
  const tldNode = namehash(tld)

  const deploy = async (name, artifactPath, args = []) => {
    const { abi, bytecode } = loadArtifact(artifactPath)
    return deployRaw(name, abi, bytecode, args)
  }

  const ensRegistry = await deploy('ENSRegistry',
    'registry/ENSRegistry.sol/ENSRegistry.json')

  const baseRegistrar = await deploy('BaseRegistrarImplementation',
    'ethregistrar/BaseRegistrarImplementation.sol/BaseRegistrarImplementation.json',
    [ensRegistry.address, tldNode])

  // No reverse registrar: SNRC maps names to SimpleX links in one direction and
  // nothing resolves an address back to a name. PublicResolver no longer inherits
  // ReverseClaimer, so nothing needs to own addr.reverse for the resolver to deploy.
  await write(ensRegistry, 'setSubnodeOwner', [zeroHash, labelhash(tld), account.address])

  // `.testing` is live on the vendored ExponentialPremiumPriceOracle with an
  // all-zero curve (gas-only registration) and keeps it: swapping a deployed
  // TLD's oracle is a separate change. `.simplex` gets SimplexPriceOracle,
  // whose curve and feed are both settable by call afterwards, so it
  // never has to be redeployed to change what a name costs. Its rungs run down
  // to one character, so lowering minCharLength never hands out free names.
  const isTesting = tld === 'testing'
  const priceOracle = isTesting
    ? await deploy('ExponentialPremiumPriceOracle',
        'ethregistrar/ExponentialPremiumPriceOracle.sol/ExponentialPremiumPriceOracle.json',
        [chainlinkEthUsd, [0n, 0n, 0n, 0n, 0n, 0n], 100000000000000000000000000n, 21n])
    : await deploy('SimplexPriceOracle', SIMPLEX_PRICE_ORACLE_ARTIFACT,
        [chainlinkEthUsd, USD_FEED_DECIMALS, SIMPLEX_PRICE_BASE, SIMPLEX_PRICE_RUNGS])

  const smpxNft = { address: smpxNftAddr }

  const controllerImpl = await deploy('SimplexControllerImpl',
    'simplex/SimplexController.sol/SimplexController.json')

  const initData = encodeFunctionData({
    abi: controllerImpl.abi,
    functionName: 'initialize',
    args: [
      baseRegistrar.address,
      priceOracle.address,
      60n,
      86400n,
      ensRegistry.address,
      {
        tldNode,
        tldSuffix: `.${tld}`,
        minCharLength: 6,
        smpxNft: nftGateEnabled ? smpxNft.address : zeroAddress,
        nftGateEnabled,
      },
      account.address,
    ],
  })

  const controllerProxy = await deploy('SimplexControllerProxy',
    'simplex/SimplexControllerProxy.sol/SimplexControllerProxy.json',
    [controllerImpl.address, initData])

  const controller = { address: controllerProxy.address, abi: controllerImpl.abi }

  await write(baseRegistrar, 'addController', [controller.address])

  const namePolicyImpl = await deploy('SimplexNamePolicyImpl',
    'simplex/SimplexNamePolicy.sol/SimplexNamePolicy.json',
    [controller.address, baseRegistrar.address])
  const namePolicyProxy = await deploy('SimplexNamePolicyProxy',
    'simplex/SimplexNamePolicyProxy.sol/SimplexNamePolicyProxy.json',
    [namePolicyImpl.address, '0x'])
  const namePolicy = { address: namePolicyProxy.address, abi: namePolicyImpl.abi }
  await write(baseRegistrar, 'addController', [namePolicy.address])
  await write(controller, 'setNamePolicy', [namePolicy.address])

  for (const [reason, names] of reservedByReason) {
    for (let i = 0; i < names.length; i += RESERVE_BATCH) {
      await write(namePolicy, 'addReservedNames', [names.slice(i, i + RESERVE_BATCH), reason])
    }
  }

  // SubnameRegistrar owns + resolves subnames, soulbound to the 2LD NFT. It is
  // deployed before the resolver because the resolver's nameWrapper slot points
  // at it (subname records authorise via subnameRegistrar.ownerOf).
  const subnameRegistrar = await deploy('SubnameRegistrar',
    'simplex/SubnameRegistrar.sol/SubnameRegistrar.json',
    [ensRegistry.address, baseRegistrar.address])

  // SimplexResolver = PublicResolver + signed record writes (setTextWithSig,
  // clearRecordsWithSig), so a user with no ETH can have records relayed.
  // wrapper-free v3: the NameWrapper slot is repurposed for the SubnameRegistrar
  // (the 2LD itself is never wrapped — its node is owned directly by the NFT
  // holder via auto-reclaim). trustedReverseRegistrar is address(0) and inert.
  const publicResolver = await deploy('SimplexResolver',
    'simplex/SimplexResolver.sol/SimplexResolver.json',
    [ensRegistry.address, subnameRegistrar.address, controller.address, zeroAddress])

  // One-time wiring now that the resolver exists, while the deployer still owns
  // the registrar (before the ownership handover below).
  await write(subnameRegistrar, 'setResolver', [publicResolver.address])
  await write(baseRegistrar, 'setSubnameHook', [subnameRegistrar.address])
  // registerReserved points a brand's name here, so it resolves without the brand
  // ever holding ETH.
  await write(controller, 'setDefaultResolver', [publicResolver.address])

  // The sponsored path: registrar allowances, registerWithCredit/renewWithCredit
  // and the owner's signature check. Only this contract may call the controller's
  // sponsored entry points; `freeze` fixes it. The guardian funds registrars here.
  const sponsor = await deploy('SimplexSponsor',
    'simplex/SimplexSponsor.sol/SimplexSponsor.json',
    [controller.address])
  await write(controller, 'setSponsor', [sponsor.address])

  await write(namePolicy, 'setGeneralTerms', [terms.generalTerms.link])
  await write(namePolicy, 'setCommunityTerms', [terms.communityTerms.link])
  for (let i = 0; i < communityNames.length; i += RESERVE_BATCH) {
    await write(namePolicy, 'addCommunityNames', [communityNames.slice(i, i + RESERVE_BATCH)])
  }
  await write(baseRegistrar, 'setNamePolicy', [namePolicy.address])

  const dummyGateway = await deploy('DummyGatewayProvider',
    'mocks/DummyGatewayProvider.sol/DummyGatewayProvider.json')
  const universalResolver = await deploy('UniversalResolver',
    'universalResolver/UniversalResolver.sol/UniversalResolver.json',
    [account.address, ensRegistry.address, dummyGateway.address])

  await write(ensRegistry, 'setResolver', [tldNode, publicResolver.address])
  // The registry assigns a node to someone other than the caller only under the
  // root or a TLD, so the TLD is assigned to the registrar from the root.
  await write(ensRegistry, 'setSubnodeOwner', [zeroHash, labelhash(tld), baseRegistrar.address])

  await write(ensRegistry, 'setSubnodeOwner', [zeroHash, labelhash('eth'), account.address])
  await write(ensRegistry, 'setResolver', [namehash('eth'), publicResolver.address])
  await write(ensRegistry, 'setSubnodeOwner', [namehash('eth'), labelhash('data'), account.address])
  await write(ensRegistry, 'setResolver', [namehash('data.eth'), publicResolver.address])
  await write(ensRegistry, 'setSubnodeOwner', [namehash('data.eth'), labelhash('eth-usd'), account.address])
  await write(ensRegistry, 'setResolver', [namehash('eth-usd.data.eth'), publicResolver.address])
  await write(publicResolver, 'setAddr', [namehash('eth-usd.data.eth'), chainlinkEthUsd])

  // On-chain NFT metadata + subname index. setMetadataRenderer must run while the
  // deployer still owns the registrar (before the ownership handover below).
  const metadataRenderer = await deploy('MetadataRenderer',
    'simplex/MetadataRenderer.sol/MetadataRenderer.json',
    [`.${tld}`])
  await write(baseRegistrar, 'setMetadataRenderer', [metadataRenderer.address])
  // Cap label length at the DNS octet limit (63 bytes). Bounds labelOf storage
  // and on-chain SVG/JSON render size. (security.md L4)
  await write(baseRegistrar, 'setMaxLabelLength', [63n])

  // Set the beneficiary BEFORE handing ownership over. `setBeneficiary` is
  // owner-callable only while it is unset and beneficiary-callable thereafter, so
  // doing it here is what makes revenue and the registrar kill switch independent
  // of the admin key from the first block. Skipping it leaves `withdraw` reverting.
  await write(controller, 'setBeneficiary', [guardianAddress])

  // Ownable2Step only proposes the admin, and a wrong proposal can be replaced.
  // SimplexPriceOracle carries its own Ownable2Step owner, separate from the
  // controller's. Forgetting it would leave the whole price curve and the feed
  // pointer on the deploy key, which is destroyed after the handover. The
  // vendored oracle `.testing` runs has no owner at all.
  await write(controller, 'transferOwnership', [ownerAddress])
  if (!isTesting) await write(priceOracle, 'transferOwnership', [ownerAddress])

  // The rest takes effect at once and for good, so it waits until the admin has
  // proven it can sign by accepting both proposals (launch plan A2).
  if (await adminAccepted([controller, ...(isTesting ? [] : [priceOracle])])) {
    await write(baseRegistrar, 'transferOwnership', [ownerAddress])
    // The registry assigns a node to someone other than the caller only under
    // the root or a TLD. data.eth is neither, so the deploy key sets the owner
    // of eth-usd.data.eth to zero; data.eth's new owner can take it back.
    await write(ensRegistry, 'setOwner', [namehash('eth-usd.data.eth'), zeroAddress])
    await write(ensRegistry, 'setSubnodeOwner', [namehash('eth'), labelhash('data'), ownerAddress])
    await write(ensRegistry, 'setSubnodeOwner', [zeroHash, labelhash('eth'), ownerAddress])
    await write(ensRegistry, 'setOwner', [zeroHash, ownerAddress])
  }

  return {
    ENSRegistry: ensRegistry.address,
    BaseRegistrarImplementation: baseRegistrar.address,
    ReverseRegistrar: zeroAddress,
    DefaultReverseRegistrar: zeroAddress,
    NameWrapper: zeroAddress, // wrapper-free v3
    MetadataRenderer: metadataRenderer.address,
    SubnameRegistrar: subnameRegistrar.address,
    PublicResolver: publicResolver.address,
    ETHRegistrarController: controller.address,
    // Implementation address for the SimplexController behind the
    // ETHRegistrarController proxy. Surfaced so Etherscan source
    // verification can target both impl + proxy.
    SimplexControllerImpl: controllerImpl.address,
    SimplexSponsor: sponsor.address,
    SimplexNamePolicy: namePolicy.address,
    SimplexNamePolicyImpl: namePolicyImpl.address,
    [isTesting ? 'ExponentialPremiumPriceOracle' : 'SimplexPriceOracle']:
      priceOracle.address,
    // 3rd constructor arg of UniversalResolver — kept so verification
    // can reconstruct that contract's calldata.
    DummyGatewayProvider: dummyGateway.address,
    DummyOracle: chainlinkEthUsd,
    SMPXNFT: smpxNftAddr,
    NameWrapperPublicResolver: publicResolver.address,
    UniversalResolver: universalResolver.address,
    Multicall: '0xcA11bde05977b3631167028862bE2a173976CA11',
    DNSRegistrar: '0x0000000000000000000000000000000000000000',
    DNSSECImpl: '0x0000000000000000000000000000000000000000',
    LegacyETHRegistrarController: '0x0000000000000000000000000000000000000000',
    LegacyPublicResolver: '0x0000000000000000000000000000000000000000',
    WrappedEthRegistrarController: '0x0000000000000000000000000000000000000000',
    WrappedStaticBulkRenewal: '0x0000000000000000000000000000000000000000',
    UniversalRegistrarRenewalWithReferrer: '0x0000000000000000000000000000000000000000',
    OffchainDNSResolver: '0x0000000000000000000000000000000000000000',
    ExtendedDNSResolver: '0x0000000000000000000000000000000000000000',
    OutdatedResolver: '0x0000000000000000000000000000000000000000',
  }
}

// keccak256('eip1967.proxy.implementation') - 1
const ERC1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'

/// L29: the journal proves each transaction was mined, not that the stack is
/// wired the way the script intended — a mis-ordered or silently-reverted step
/// leaves a deployment that looks complete and is not. Read the important state
/// back off-chain and fail loudly while the deploy key can still fix it.
async function verifyWiring(publicClient, addresses, handedOver) {
  console.log(`\n--- Post-deploy read-back ---`)
  const failures = []
  const check = async (what, expected, read) => {
    try {
      const got = await read()
      const ok = String(got).toLowerCase() === String(expected).toLowerCase()
      console.log(`  ${ok ? '✓' : '✗'} ${what}: ${got}${ok ? '' : `  (expected ${expected})`}`)
      if (!ok) failures.push(what)
    } catch (e) {
      console.log(`  ✗ ${what}: read failed — ${e.shortMessage || e.message}`)
      failures.push(what)
    }
  }
  const read = (address, sig, outputs, functionName, args = []) =>
    publicClient.readContract({
      address,
      abi: [{ type: 'function', name: functionName, inputs: sig, outputs, stateMutability: 'view' }],
      functionName,
      args,
    })
  const ADDR = [{ type: 'address' }]
  const registry = addresses.ENSRegistry
  const controller = addresses.ETHRegistrarController
  const registrar = addresses.BaseRegistrarImplementation

  await check('registry owner of the TLD node is the base registrar', registrar,
    () => read(registry, [{ type: 'bytes32' }], ADDR, 'owner', [namehash(tld)]))
  await check('controller is a controller on the registrar', 'true',
    () => read(registrar, ADDR, [{ type: 'bool' }], 'controllers', [controller]))
  await check('registrar maxLabelLength', '63',
    () => read(registrar, [], [{ type: 'uint256' }], 'maxLabelLength'))
  await check('registrar subnameHook', addresses.SubnameRegistrar,
    () => read(registrar, [], ADDR, 'subnameHook'))
  await check('registrar metadataRenderer', addresses.MetadataRenderer,
    () => read(registrar, [], ADDR, 'metadataRenderer'))
  await check('controller defaultResolver', addresses.PublicResolver,
    () => read(controller, [], ADDR, 'defaultResolver'))
  await check('controller beneficiary is the guardian', guardianAddress,
    () => read(controller, [], ADDR, 'beneficiary'))
  await check('controller sponsor', addresses.SimplexSponsor,
    () => read(controller, [], ADDR, 'sponsor'))
  await check('sponsor controller', controller,
    () => read(addresses.SimplexSponsor, [], ADDR, 'controller'))
  await check('controller namePolicy', addresses.SimplexNamePolicy,
    () => read(controller, [], ADDR, 'namePolicy'))
  await check('registrar namePolicy', addresses.SimplexNamePolicy,
    () => read(registrar, [], ADDR, 'namePolicy'))
  await check('name policy is a controller on the registrar', 'true',
    () => read(registrar, ADDR, [{ type: 'bool' }], 'controllers', [addresses.SimplexNamePolicy]))
  for (const [kind, { link, hash }] of Object.entries(terms)) {
    await check(`${kind} link`, link,
      () => read(addresses.SimplexNamePolicy, [], [{ type: 'string' }], `${kind}Link`))
    await check(`${kind} hash`, hash,
      () => read(addresses.SimplexNamePolicy, [], [{ type: 'bytes32' }], `${kind}Hash`))
  }
  await check('controller nftGateEnabled', String(nftGateEnabled),
    () => read(controller, [], [{ type: 'bool' }], 'nftGateEnabled'))
  await check('controller minCharLength', '6',
    () => read(controller, [], [{ type: 'uint8' }], 'minCharLength'))
  await check('controller is not frozen', 'false',
    () => read(controller, [], [{ type: 'bool' }], 'frozen'))
  await check('public sales are still closed', 'false',
    () => read(controller, [], [{ type: 'bool' }], 'publicSalesOpen'))
  await check('subname registrar resolver', addresses.PublicResolver,
    () => read(addresses.SubnameRegistrar, [], ADDR, 'resolver'))
  // The sales switch does not gate the sponsored path, so a label missing here is
  // registrable as soon as the guardian funds a registrar.
  const reserved = [...reservedByReason].flatMap(([reason, names]) => names.map((name) => ({ name, reason })))
  const reasons = await publicClient.multicall({
    batchSize: 65_536,
    contracts: reserved.map(({ name }) => ({
      address: addresses.SimplexNamePolicy,
      abi: [{ type: 'function', name: 'reservedNames', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint8' }], stateMutability: 'view' }],
      functionName: 'reservedNames',
      args: [labelhash(name)],
    })),
  })
  const released = reserved.filter((r, i) => reasons[i].result === 0)
  const expiries = await publicClient.multicall({
    batchSize: 65_536,
    contracts: released.map(({ name }) => ({
      address: registrar,
      abi: [{ type: 'function', name: 'nameExpires', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
      functionName: 'nameExpires',
      args: [BigInt(labelhash(name))],
    })),
  })
  const handedOut = new Set(released.filter((r, i) => expiries[i].result > 0n))
  const unreserved = reserved.filter((r, i) => reasons[i].result !== r.reason && !handedOut.has(r))
  console.log(`  ${unreserved.length ? '✗' : '✓'} reserved names read back: ${reserved.length - unreserved.length - handedOut.size} of ${reserved.length}, ${handedOut.size} handed out`)
  if (unreserved.length) {
    failures.push(`reserved names (${unreserved.slice(0, 5).map((r) => r.name).join(', ')}${unreserved.length > 5 ? ', …' : ''})`)
  }
  const listed = await publicClient.multicall({
    batchSize: 65_536,
    contracts: communityNames.map((name) => ({
      address: addresses.SimplexNamePolicy,
      abi: [{ type: 'function', name: 'communityNames', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'bool' }], stateMutability: 'view' }],
      functionName: 'communityNames',
      args: [labelhash(name)],
    })),
  })
  const unlisted = communityNames.filter((name, i) => listed[i].result !== true)
  console.log(`  ${unlisted.length ? '✗' : '✓'} community names read back: ${communityNames.length - unlisted.length} of ${communityNames.length}`)
  if (unlisted.length) {
    failures.push(`community names (${unlisted.slice(0, 5).join(', ')}${unlisted.length > 5 ? ', …' : ''})`)
  }
  // A six-character name must quote the cheapest rung. `.testing` is priced at
  // zero on purpose, so only a paid TLD can assert non-zero — for that one, zero
  // means the oracle is misconfigured and every name would be free.
  const expectPaid = tld !== 'testing'
  try {
    const p = await publicClient.readContract({
      address: controller,
      abi: [{ type: 'function', name: 'rentPrice', inputs: [{ type: 'string' }, { type: 'uint256' }],
        outputs: [{ type: 'tuple', components: [{ name: 'base', type: 'uint256' }, { name: 'premium', type: 'uint256' }] }],
        stateMutability: 'view' }],
      functionName: 'rentPrice', args: ['abcdef', 63072000n],
    })
    const ok = !expectPaid || p.base > 0n
    console.log(`  ${ok ? '✓' : '✗'} two-year price for a 6-char name: ${Number(p.base) / 1e18} ETH${expectPaid ? '' : '  (.testing is free by design)'}`)
    if (!ok) failures.push('rentPrice is zero on a paid TLD')
  } catch (e) {
    console.log(`  ✗ rentPrice read failed — ${e.shortMessage || e.message}`)
    failures.push('rentPrice')
  }

  // The curve itself, rung by rung, and the feed scale. `rentPrice` above only
  // proves a 6-char name is not free; a curve off by a factor (per-second args
  // pasted into a per-year contract, say) would sail past it.
  if (addresses.SimplexPriceOracle) {
    const oracle = addresses.SimplexPriceOracle
    const U256 = [{ type: 'uint256' }]
    await check('controller prices from this oracle', oracle,
      () => read(controller, [], ADDR, 'prices'))
    await check('oracle reads the Chainlink ETH/USD feed', chainlinkEthUsd,
      () => read(oracle, [], ADDR, 'usdOracle'))
    await check('oracle feed scale matches the Chainlink feed decimals', String(10 ** USD_FEED_DECIMALS),
      () => read(oracle, [], U256, 'usdOracleScale'))
    await check('oracle base price per year', String(SIMPLEX_PRICE_BASE),
      () => read(oracle, [], U256, 'basePriceCentsPerYear'))
    for (const { labelLength, priceCentsPerYear } of SIMPLEX_PRICE_RUNGS) {
      await check(`oracle price at ${labelLength} char(s)`, String(priceCentsPerYear),
        () => read(oracle, U256, U256, 'priceCentsPerYear', [labelLength]))
    }
  }

  await check('eth-usd.data.eth resolves to the ETH/USD feed', chainlinkEthUsd,
    () => read(addresses.PublicResolver, [{ type: 'bytes32' }], ADDR, 'addr', [namehash('eth-usd.data.eth')]))
  await check('controller implementation (ERC-1967 slot)', addresses.SimplexControllerImpl,
    async () => getAddress(`0x${(await publicClient.getStorageAt({ address: controller, slot: ERC1967_IMPLEMENTATION_SLOT })).slice(-40)}`))
  await check('name policy implementation (ERC-1967 slot)', addresses.SimplexNamePolicyImpl,
    async () => getAddress(`0x${(await publicClient.getStorageAt({ address: addresses.SimplexNamePolicy, slot: ERC1967_IMPLEMENTATION_SLOT })).slice(-40)}`))

  // Ownership. Until the admin accepts, the deploy key holds everything and the
  // admin is only proposed on the two Ownable2Step contracts; after the handover
  // the admin holds everything and nothing is pending.
  const holder = handedOver ? ownerAddress : account.address
  await check('registrar owner', holder, () => read(registrar, [], ADDR, 'owner'))
  for (const name of ['', 'eth', 'data.eth']) {
    await check(`registry owner of ${name || 'the root'}`, holder,
      () => read(registry, [{ type: 'bytes32' }], ADDR, 'owner', [namehash(name)]))
  }
  await check('registry owner of eth-usd.data.eth', handedOver ? zeroAddress : account.address,
    () => read(registry, [{ type: 'bytes32' }], ADDR, 'owner', [namehash('eth-usd.data.eth')]))
  for (const [what, at] of [['controller', controller], ['oracle', addresses.SimplexPriceOracle]]) {
    if (!at) continue
    const owner = await read(at, [], ADDR, 'owner').catch(() => undefined)
    // Before the second run the admin may already have accepted this one.
    const accepted = handedOver || owner?.toLowerCase() === ownerAddress.toLowerCase()
    await check(`${what} owner`, accepted ? ownerAddress : account.address, async () => owner)
    await check(`${what} pendingOwner`, accepted ? zeroAddress : ownerAddress,
      () => read(at, [], ADDR, 'pendingOwner'))
  }

  if (failures.length) {
    console.error(`\n  ${failures.length} read-back check(s) FAILED: ${failures.join(', ')}`)
    console.error(handedOver
      ? `  The handover is done: only the admin ${ownerAddress} can fix this now.`
      : `  The deploy key still holds every role — fix the wiring before the admin accepts.`)
    process.exitCode = 1
  } else {
    console.log(`  all read-back checks passed`)
  }
}

/// L33: the deploy reads compiled artifacts, never sources, so an edit made
/// after the last compile would deploy the previous bytecode and the journal
/// would record it as a success. Rather than guess freshness from mtimes —
/// Hardhat caches on content, so a touched-but-unchanged file would block the
/// run forever — just compile. It is idempotent, it is the only thing that
/// actually guarantees the artifacts match the sources, and it fails the run on
/// a branch that does not build at all.
function assertBuildFresh() {
  console.log('Compiling contracts (artifacts must match sources) …')
  try {
    execFileSync('npx', ['hardhat', 'compile'], {
      cwd: ENS_CONTRACTS_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    })
  } catch (e) {
    console.error('`npx hardhat compile` failed — refusing to deploy.\n')
    console.error(e.stdout || '')
    console.error(e.stderr || '')
    process.exit(1)
  }
  console.log('  build is current')
}

// Track the spawned fork at module scope so cleanup handlers can reach it.
let activeFork = null
function cleanupFork() {
  if (activeFork) {
    try { activeFork.stop() } catch {}
    activeFork = null
  }
}
process.on('SIGINT',  () => { cleanupFork(); process.exit(130) })
process.on('SIGTERM', () => { cleanupFork(); process.exit(143) })
process.on('exit',    () => { cleanupFork() })

async function main() {
  // Cheap and first: a stale build must not cost a fork spawn, let alone a
  // transaction.
  assertBuildFresh()

  // A populated addresses file with no journal beside it means a previous
  // deployment completed and its journal was moved or lost. Overwriting it
  // would erase the only record of what is live.
  if (existsSync(addressesPath) && loadJournal(journalPath).length === 0) {
    console.error(
      `${addressesPath} already exists but ${journalPath} is empty or missing.\n` +
        `  That pairing means a completed deployment whose journal is gone — this run would\n` +
        `  overwrite the record of live addresses. Move it and ${attemptsLogPath} aside deliberately if you\n` +
        `  really are starting over.`,
    )
    process.exit(1)
  }

  for (const [role, kind] of [['general', 'generalTerms'], ['community', 'communityTerms']]) {
    await checkTermsLink(role, terms[kind].link).catch((err) => {
      console.error(`terms.${tld}.json ${kind}: ${err.message}`)
      process.exit(1)
    })
  }

  console.log(`SNRC mainnet deploy for .${tld} (chainId ${mainnet.id})`)
  console.log(`  Deployer:          ${account.address}`)
  console.log(`  Cold owner:        ${ownerAddress}`)
  console.log(`  Chainlink ETH/USD: ${chainlinkEthUsd}`)
  console.log(`  SMPXNFT:           ${smpxNftAddr}`)
  console.log(`  Cap (gwei):        ${maxBaseFeeGwei}`)
  console.log(`  Bump rule:         after ${bumpAfterMs / 3600000}h stall, cap × ${Number(100n + bumpPct) / 100}`)
  console.log(`  Journal:           ${journalPath}`)
  console.log(`  Attempts log:      ${attemptsLogPath}`)

  // ----- 1. Dry run against a forked mainnet -----
  activeFork = await spawnHardhatFork({
    mainnetRpcUrl: rpcUrl,
    port: forkPort,
    ensContractsDir: ENS_CONTRACTS_DIR,
  })
  let dryTotals
  try {
    await fundOnFork({
      forkUrl: activeFork.url,
      address: account.address,
      weiHex: '0x56bc75e2d63100000',  // 100 ETH
    })
    const dry = createDryRunRunner({ forkUrl: activeFork.url, forkChainId: activeFork.chainId, account })
    console.log(`\n--- Dry-run on fork ---`)
    // The deploy key sends the single-step handovers itself, so the fork can
    // price them without the admin.
    await runDeploySequence({
      deploy: dry.deploy,
      write: dry.write,
      adminAccepted: async () => true,
    })
    dryTotals = dry.totals()
    console.log(`Dry-run captured ${dryTotals.perStep.length} steps, ${dryTotals.totalGas.toLocaleString()} gas total`)
  } finally {
    cleanupFork()
  }

  // ----- 2. Preflight + confirm -----
  const transport = http(rpcUrl)
  const publicClient = createPublicClient({ chain: mainnet, transport })
  const walletClient = createWalletClient({ chain: mainnet, transport, account })

  // MAINNET_RPC_URL pointing at a testnet would deploy the whole stack to the
  // wrong chain and journal it as a success. viem only asserts the chain id on
  // some paths, so assert it here, once, before any spend.
  const liveChainId = await publicClient.getChainId()
  if (liveChainId !== mainnet.id) {
    console.error(`MAINNET_RPC_URL is chainId ${liveChainId}, expected ${mainnet.id}. Refusing to deploy.`)
    process.exit(1)
  }

  // A dead or misconfigured feed makes every price quote revert
  // (InvalidPriceFeed) and the payable path unusable from the first block.
  // Cheaper to find out now than after the oracle is wired in.
  try {
    const answer = await publicClient.readContract({
      address: chainlinkEthUsd,
      abi: [{ type: 'function', name: 'latestAnswer', inputs: [], outputs: [{ type: 'int256' }], stateMutability: 'view' }],
      functionName: 'latestAnswer',
    })
    if (answer <= 0n) throw new Error(`latestAnswer() = ${answer}`)
    console.log(`  ETH/USD feed:      ${(Number(answer) / 1e8).toFixed(2)} USD  (live)`)
  } catch (e) {
    console.error(`ETH/USD feed ${chainlinkEthUsd} is not answering usably: ${e.shortMessage || e.message}`)
    process.exit(1)
  }

  await analyzeAndConfirm({
    publicClient, account,
    maxBaseFeeWei, dryRunTotals: dryTotals,
    journalPath,
    bumpAfterMs, bumpPct,
    label: `.${tld} mainnet deploy preflight`,
  })

  // ----- 3. Real deploy against mainnet -----
  console.log(`\n--- Real deploy ---`)
  const real = createWaitForBaseRunner({
    publicClient, walletClient, account,
    maxBaseFeeWei, bumpAfterMs, bumpPct,
    journalPath, attemptsLogPath, absoluteMaxBaseFeeWei,
  })

  let handedOver = false
  const awaitingAcceptance = new Set()
  const addresses = await runDeploySequence({
    deploy: real.deploy,
    write: real.write,
    adminAccepted: async (contracts) => {
      for (const { address } of contracts) {
        const owner = await publicClient.readContract({
          address,
          abi: [{ type: 'function', name: 'owner', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' }],
          functionName: 'owner',
        })
        if (owner.toLowerCase() !== ownerAddress.toLowerCase()) awaitingAcceptance.add(address.toLowerCase())
      }
      handedOver = awaitingAcceptance.size === 0
      return handedOver
    },
  })

  console.log(`\nDeployer remaining balance: ${(Number(await publicClient.getBalance({ address: account.address })) / 1e18).toFixed(6)} ETH`)
  console.log(`Total spent this run+prior: ${(Number(real.spent()) / 1e18).toFixed(6)} ETH`)

  writeFileSync(addressesPath, JSON.stringify(addresses, null, 2))
  console.log(`Wrote ${addressesPath}`)

  // Emit verification metadata so `verify-etherscan.mjs` (with NETWORK=mainnet)
  // can pick this deploy up without a separate reconstruction pass.
  const verificationPath = join(REPO_ROOT, `verification.mainnet.${tld}.json`)
  const verificationMeta = assembleVerification({
    network: 'mainnet', tld, addresses,
    deployer: account.address, chainlinkEthUsd, smpxNftAddr,
  })
  writeFileSync(verificationPath, JSON.stringify(verificationMeta, null, 2))
  console.log(`Wrote ${verificationPath}`)

  await verifyWiring(publicClient, addresses, handedOver)

  if (handedOver) {
    console.log(`\n--- Handover complete ---`)
    console.log(`  ${ownerAddress} owns every contract and the registry root, eth and data.eth.`)
  } else {
    console.log(`\n--- Handover waits for the admin ---`)
    console.log(`  Nothing irreversible has been handed over yet. From ${ownerAddress}, call:`)
    for (const c of ['ETHRegistrarController', 'SimplexPriceOracle']) {
      if (awaitingAcceptance.has(addresses[c]?.toLowerCase())) {
        console.log(`    acceptOwnership()   on ${c}  ${addresses[c]}`)
      }
    }
    console.log(`  Then run this command again: it checks both owners and hands over the registrar`)
    console.log(`  and the registry root, eth and data.eth, which take effect at once.`)
    console.log(`  Until then the deploy key ${account.address} controls everything — treat it as hot.`)
  }
  console.log(`  Guardian ${guardianAddress} is already the beneficiary and needs no acceptance.`)

  console.log(`\nCommit ${addressesPath} AND ${journalPath} AND ${verificationPath} to the repo.`)
  console.log(`See docs/deployment.md → Mainnet → Step 3.`)
}

main().catch((err) => {
  cleanupFork()
  console.error(err)
  process.exit(1)
})
