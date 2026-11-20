#!/usr/bin/env node
/**
 * Deploy the `.simplex` v2 contracts to Ethereum mainnet — wait-for-cheap-base
 * strategy. The registry, the registrar, the resolver, the subname registrar,
 * the controller, the name policy, the sponsor and the universal resolver sit
 * behind TransparentUpgradeableProxy instances whose ProxyAdmins the admin Safe
 * owns from creation. See
 * docs/plans/upgradeable-stack.md, sections 6 to 9.
 *
 * Run 1, with the deploy key:
 *   1. Spawns a local Hardhat fork of mainnet and runs all of run 1 against it
 *      as a dry run to capture per-step gasUsed.
 *   2. Computes ceiling cost = total gas × MAX_BASE_FEE_GWEI, prints a
 *      summary, prompts Y/N.
 *   3. Stops the fork. Runs run 1 against mainnet: the governance check, the
 *      deployment and wiring, the read-back, the single-step transfers and
 *      proposals, and the retirement of v1. Every tx is sent with
 *      `maxFeePerGas = MAX_BASE_FEE_GWEI` and zero priority, and waits for
 *      `baseFeePerGas ≤ cap` before submission.
 *   4. If a submitted tx stalls (base climbed back above cap, mempool
 *      eviction, etc.) for `BUMP_AFTER_HOURS`, the cap bumps by
 *      `BUMP_PCT%` and resubmits at the same nonce.
 *   5. Every successful tx appends to a JSONL journal; re-running the
 *      script picks up where it left off and reads its state back again.
 *
 * Run 2, without a key, after the admin Safe has accepted the controller and the
 * oracle: the read-back of the handover.
 *
 * The registrar step, without a key, once governance.mainnet.json holds a
 * registrarWallet entry: RUN=registrar checks that entry and writes the guardian
 * Safe's batch for SimplexSponsor.setRegistrarAllowance; RUN=registrar-read-back
 * reads the allowance back.
 *
 * Required env vars:
 *   RUN                1 | 2 | registrar | registrar-read-back
 *   MAINNET_RPC_URL    JSON-RPC URL for mainnet (used by both fork + real), serving
 *                      eth_getLogs from old blocks
 *   DEPLOYER_KEY       run 1: hex private key (0x...) of the deploy key
 *   MAX_BASE_FEE_GWEI  run 1: cap on per-gas price (e.g. "0.078")
 *
 * Optional env vars, run 1:
 *   BUMP_AFTER_HOURS   stall threshold before cap bump (default: 24)
 *   BUMP_PCT           cap multiplier on stall (default: 20)
 *   ABSOLUTE_MAX_BASE_FEE_GWEI  ceiling the bumps stop at (default: 4× MAX_BASE_FEE_GWEI)
 *   FORK_PORT          local port for the dry-run fork (default: 18545 — picked
 *                      to avoid Reth/Geth's stock 8545/8546 ports)
 *   CONFIRM=yes        skip the interactive confirmation prompt
 *
 * Reads governance.mainnet.json, deployments.mainnet.simplex-v1.json,
 * reserved-names.simplex.csv (name,reason,category), terms.simplex.json
 * ({ "generalTerms": link, "communityTerms": link }), each link checked by
 * terms-check.mjs before any transaction, and community-names.simplex.csv
 * (name,community), optional. Run 1 compiles the ens-contracts commit tagged
 * simplex-mainnet-v2.
 *
 * Files written by run 1, next to the addresses file:
 *   deployments.mainnet.simplex.json            ← final addresses
 *   deployments.mainnet.simplex.journal.jsonl   ← per-tx journal (resume source)
 *   deployments.mainnet.simplex.attempts.log    ← every attempt + reason
 *   verification.mainnet.simplex.json           ← Etherscan targets
 *   safe-transaction.mainnet.simplex.run-1.json ← the admin Safe's batch
 * by the registrar step:
 *   safe-transaction.mainnet.simplex.registrar.json ← the guardian Safe's batch
 *
 * Commit the addresses file, the journal and the verification file to the repo.
 * See docs/deployment.md → Mainnet.
 */
import {
  createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, keccak256, labelhash, namehash,
  parseAbi, parseAbiItem, parseGwei, toBytes, toHex, zeroHash, zeroAddress,
} from 'viem'
import { mainnet } from 'viem/chains'
import { normalize } from 'viem/ens'
import { privateKeyToAccount } from 'viem/accounts'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import {
  analyzeAndConfirm, createDryRunRunner, createWaitForBaseRunner,
  fundOnFork, loadJournal, spawnHardhatFork, DEFAULTS,
} from './gas-tools.mjs'
import { assembleVerification } from './build-verification.mjs'
import { checkGovernance, entryFailures, loadGovernance } from './governance-check.mjs'
import {
  SIMPLEX_PRICE_BASE,
  SIMPLEX_PRICE_RUNGS,
  USD_FEED_DECIMALS,
} from './simplex-price-curve.mjs'
import {
  ADDRESSES_PATH, ENS_CONTRACTS_DIR, IMMUTABLE, JOURNAL_PATH, PROXY_ADMIN_ABI, PROXY_ADMIN_ARTIFACT, REPO_ROOT, SOURCE_TAG, TLD,
  TRANSPARENT_PROXY,
  UPGRADEABLE, V1_ABI, VERIFICATION_PATH, accepted, artifact, assertBuildFresh, assertCommitted, assertTaggedSource, causes,
  deployBehindProxy, deployImmutable, logsSince, mainnetClient, proxyAdminOf, proxySlots, refusal, requireEnv, runtimeCode,
  safeBatch, sortedAddresses, storedValue,
} from './stack.mjs'
import { checkTermsLink } from './terms-check.mjs'

const TLD_NODE = namehash(TLD)
const chainlinkEthUsd = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419'
const SMPXNFT = '0x3AF6D9Ee862376A8DFC0a78847Eb20A153557291'
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'

// SimplexNamePolicy.Reason — the on-chain enum. Append-only once names are
// reserved, so these integers are fixed by the contract, not by this script.
const REASONS = { Internal: 1, Trademark: 2, Community: 3 }
// About 5.2M gas each, well under the per-transaction cap of 16,777,216 (EIP-7825).
const RESERVE_BATCH = 200
const COMMUNITY_BATCH = 100
// The labels users can register: simplex-app src/hooks/useValidate.ts ALLOWED_LABEL_REGEX.
const ALLOWED_LABEL_REGEX = /^(?!.{2}--)[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
const CONTROLLER_ADDED = parseAbiItem('event ControllerAdded(address indexed controller)')
const FRESH_RUN_LOG_DEPTH = 50_400n
const RUN_ONE_INPUTS = ['scripts', 'governance.mainnet.json', `reserved-names.${TLD}.csv`, `terms.${TLD}.json`, `community-names.${TLD}.csv`]
const REGISTRAR_STEP_INPUTS = ['scripts', 'governance.mainnet.json', `deployments.mainnet.${TLD}.json`]
const ACCEPT_OWNERSHIP_ABI = parseAbi(['function acceptOwnership()'])
const SPONSOR_ABI = parseAbi([
  'function setRegistrarAllowance(address registrar, uint256 allowanceUSD)',
  'function registrarAllowance(address registrar) view returns (uint256)',
])
const LINKS_ABI = parseAbi([
  'function sponsor() view returns (address)',
  'function controller() view returns (address)',
  'function beneficiary() view returns (address)',
])

const attemptsLogPath = join(REPO_ROOT, `deployments.mainnet.${TLD}.attempts.log`)
const v1AddressesPath = join(REPO_ROOT, `deployments.mainnet.${TLD}-v1.json`)
const v1Files = [
  v1AddressesPath,
  join(REPO_ROOT, `deployments.mainnet.${TLD}-v1.journal.jsonl`),
  join(REPO_ROOT, `verification.mainnet.${TLD}-v1.json`),
]

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
  if (rows.length === 0) {
    errors.push(`no names: .${TLD} is not deployed without its reserved set`)
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

function loadV1Addresses() {
  const missing = v1Files.filter((path) => !existsSync(path))
  if (missing.length) {
    console.error(
      `${missing.join(', ')} missing. Rename the v1 addresses file, journal and verification file\n` +
        `  to *.${TLD}-v1.* first: step 2 of docs/plans/upgradeable-stack.md, section 6.`,
    )
    process.exit(1)
  }
  return JSON.parse(readFileSync(v1AddressesPath, 'utf8'))
}

export function loadInputs() {
  const { registrarWallet, ...governance } = loadGovernance()
  return {
    governance,
    reservedByReason: loadReservedNames(join(REPO_ROOT, `reserved-names.${TLD}.csv`)),
    terms: loadTerms(join(REPO_ROOT, `terms.${TLD}.json`)),
    communityNames: loadCommunityNames(join(REPO_ROOT, `community-names.${TLD}.csv`)),
    v1: loadV1Addresses(),
  }
}

async function deployAndWire({ deploy, write }, { governance, reservedByReason, terms, communityNames }, deployer, client) {
  const setup = { tld: TLD, deployer, chainlinkEthUsd }
  const addresses = {}
  const upgradeable = {}
  const proxied = async (name) => {
    await requireGovernance(client, { adminSafe: governance.adminSafe }, deployer, `the ${name} proxy, its ProxyAdmin owned by the admin Safe,`)
    const contract = await deployBehindProxy(deploy, name, addresses, setup, governance.adminSafe.address)
    addresses[UPGRADEABLE[name].key] = contract.address
    upgradeable[name] = contract
    return contract
  }
  const immutable = async (name) => {
    const contract = await deployImmutable(deploy, name, addresses, setup)
    addresses[name] = contract.address
    return contract
  }

  const ensRegistry = await proxied('ENSRegistry')
  const baseRegistrar = await proxied('BaseRegistrarImplementation')

  // No reverse registrar: SNRC maps names to SimpleX links in one direction and
  // nothing resolves an address back to a name. PublicResolver no longer inherits
  // ReverseClaimer, so nothing needs to own addr.reverse for the resolver to deploy.
  await write(ensRegistry, 'setSubnodeOwner', [zeroHash, labelhash(TLD), deployer])

  const priceOracle = await immutable('SimplexPriceOracle')

  const controller = await proxied('SimplexController')
  await write(baseRegistrar, 'addController', [controller.address])

  const namePolicy = await proxied('SimplexNamePolicy')
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
  const subnameRegistrar = await proxied('SubnameRegistrar')

  // SimplexResolver = PublicResolver + signed record writes (setTextWithSig,
  // clearRecordsWithSig), so a user with no ETH can have records relayed.
  // wrapper-free v3: the NameWrapper slot is repurposed for the SubnameRegistrar
  // (the 2LD itself is never wrapped — its node is owned directly by the NFT
  // holder via auto-reclaim). trustedReverseRegistrar is address(0) and inert.
  const publicResolver = await proxied('SimplexResolver')

  // One-time wiring now that the resolver exists, while the deployer still owns
  // the registrar (before the ownership handover below).
  await write(subnameRegistrar, 'setResolver', [publicResolver.address])
  await write(baseRegistrar, 'setSubnameHook', [subnameRegistrar.address])
  // registerReserved points a brand's name here, so it resolves without the brand
  // ever holding ETH.
  await write(controller, 'setDefaultResolver', [publicResolver.address])

  const sponsor = await proxied('SimplexSponsor')
  await write(controller, 'setSponsor', [sponsor.address])

  await write(namePolicy, 'setGeneralTerms', [terms.generalTerms.link])
  await write(namePolicy, 'setCommunityTerms', [terms.communityTerms.link])
  for (let i = 0; i < communityNames.length; i += COMMUNITY_BATCH) {
    await write(namePolicy, 'addCommunityNames', [communityNames.slice(i, i + COMMUNITY_BATCH)])
  }
  await write(baseRegistrar, 'setNamePolicy', [namePolicy.address])

  await immutable('DummyGatewayProvider')
  await proxied('UniversalResolver')

  await write(ensRegistry, 'setResolver', [TLD_NODE, publicResolver.address])
  // The registry assigns a node to someone other than the caller only under the
  // root or a TLD, so the TLD is assigned to the registrar from the root.
  await write(ensRegistry, 'setSubnodeOwner', [zeroHash, labelhash(TLD), baseRegistrar.address])

  await write(ensRegistry, 'setSubnodeOwner', [zeroHash, labelhash('eth'), deployer])
  await write(ensRegistry, 'setResolver', [namehash('eth'), publicResolver.address])
  await write(ensRegistry, 'setSubnodeOwner', [namehash('eth'), labelhash('data'), deployer])
  await write(ensRegistry, 'setResolver', [namehash('data.eth'), publicResolver.address])
  await write(ensRegistry, 'setSubnodeOwner', [namehash('data.eth'), labelhash('eth-usd'), deployer])
  await write(ensRegistry, 'setResolver', [namehash('eth-usd.data.eth'), publicResolver.address])
  await write(publicResolver, 'setAddr', [namehash('eth-usd.data.eth'), chainlinkEthUsd])

  // On-chain NFT metadata + subname index. setMetadataRenderer must run while the
  // deployer still owns the registrar (before the ownership handover below).
  const metadataRenderer = await immutable('MetadataRenderer')
  await write(baseRegistrar, 'setMetadataRenderer', [metadataRenderer.address])
  // Cap label length at the DNS octet limit (63 bytes). Bounds labelOf storage
  // and on-chain SVG/JSON render size. (security.md L4)
  await write(baseRegistrar, 'setMaxLabelLength', [63n])

  // Set the beneficiary BEFORE handing ownership over. `setBeneficiary` is
  // owner-callable only while it is unset and beneficiary-callable thereafter, so
  // doing it here is what makes revenue and the registrar kill switch independent
  // of the admin key from the first block. Skipping it leaves `withdraw` reverting.
  await requireGovernance(client, { guardianSafe: governance.guardianSafe }, deployer, 'setBeneficiary to the guardian Safe')
  await write(controller, 'setBeneficiary', [governance.guardianSafe.address])

  return { addresses, upgradeable, priceOracle }
}

async function handOver({ deploy, write }, { addresses, upgradeable, priceOracle }, client, adminSafe, deployer) {
  const { ENSRegistry: ensRegistry, BaseRegistrarImplementation: baseRegistrar, SimplexController: controller } = upgradeable
  const admin = adminSafe.address
  const transferToAdminSafe = async (contract, functionName, args) => {
    await requireGovernance(client, { adminSafe }, deployer, `${functionName} to the admin Safe`)
    await write(contract, functionName, args)
  }
  await transferToAdminSafe(baseRegistrar, 'transferOwnership', [admin])
  // The registry assigns a node to someone other than the caller only under
  // the root or a TLD. data.eth is neither, so the deploy key sets the owner
  // of eth-usd.data.eth to zero; data.eth's new owner can take it back.
  await write(ensRegistry, 'setOwner', [namehash('eth-usd.data.eth'), zeroAddress])
  await transferToAdminSafe(ensRegistry, 'setSubnodeOwner', [namehash('eth'), labelhash('data'), admin])
  await transferToAdminSafe(ensRegistry, 'setSubnodeOwner', [zeroHash, labelhash('eth'), admin])
  const root = await deployImmutable(deploy, 'Root', addresses, {})
  if ((await client.getCode({ address: root.address })) !== runtimeCode(artifact(IMMUTABLE.Root.artifact), {})) {
    throw new Error(`the code at ${root.address} is not the Root artifact's: Root is not called, and ens.setOwner(0x0, root) is not sent`)
  }
  await transferToAdminSafe(root, 'setController', [admin, true])
  await transferToAdminSafe(root, 'transferOwnership', [admin])
  await write(ensRegistry, 'setOwner', [zeroHash, root.address])
  await write(controller, 'transferOwnership', [admin])
  await write(priceOracle, 'transferOwnership', [admin])
  return root.address
}

async function retireV1(write, v1) {
  const registrar = { address: v1.BaseRegistrarImplementation, abi: V1_ABI }
  await write(registrar, 'removeController', [v1.ETHRegistrarController])
  await write(registrar, 'removeController', [v1.SimplexNamePolicy])
  await write({ address: v1.ETHRegistrarController, abi: V1_ABI }, 'transferOwnership', [zeroAddress])
  await write({ address: v1.SimplexPriceOracle, abi: V1_ABI }, 'transferOwnership', [zeroAddress])
}

function addressesFile(addresses) {
  return {
    ENSRegistry: addresses.ENSRegistry,
    BaseRegistrarImplementation: addresses.BaseRegistrarImplementation,
    ReverseRegistrar: zeroAddress,
    DefaultReverseRegistrar: zeroAddress,
    NameWrapper: zeroAddress, // wrapper-free v3
    MetadataRenderer: addresses.MetadataRenderer,
    SubnameRegistrar: addresses.SubnameRegistrar,
    PublicResolver: addresses.PublicResolver,
    ETHRegistrarController: addresses.ETHRegistrarController,
    SimplexSponsor: addresses.SimplexSponsor,
    SimplexNamePolicy: addresses.SimplexNamePolicy,
    SimplexPriceOracle: addresses.SimplexPriceOracle,
    // 3rd constructor arg of UniversalResolver — kept so verification
    // can reconstruct that contract's calldata.
    DummyGatewayProvider: addresses.DummyGatewayProvider,
    DummyOracle: chainlinkEthUsd,
    SMPXNFT,
    NameWrapperPublicResolver: addresses.PublicResolver,
    UniversalResolver: addresses.UniversalResolver,
    Multicall: MULTICALL3,
    DNSRegistrar: zeroAddress,
    DNSSECImpl: zeroAddress,
    LegacyETHRegistrarController: zeroAddress,
    LegacyPublicResolver: zeroAddress,
    WrappedEthRegistrarController: zeroAddress,
    WrappedStaticBulkRenewal: zeroAddress,
    UniversalRegistrarRenewalWithReferrer: zeroAddress,
    OffchainDNSResolver: zeroAddress,
    ExtendedDNSResolver: zeroAddress,
    OutdatedResolver: zeroAddress,
    Root: addresses.Root,
  }
}

function readBack(client) {
  const failures = []
  const report = (what, ok, detail) => {
    console.log(`  ${ok ? '✓' : '✗'} ${what}: ${detail}`)
    if (!ok) failures.push(what)
  }
  const check = async (what, expected, read) => {
    try {
      const got = await read()
      const ok = String(got).toLowerCase() === String(expected).toLowerCase()
      report(what, ok, `${got}${ok ? '' : `  (expected ${expected})`}`)
      return got
    } catch (e) {
      report(what, false, `read failed — ${e.shortMessage || e.message}`)
    }
  }
  const read = (address, sig, outputs, functionName, args = []) =>
    client.readContract({
      address,
      abi: [{ type: 'function', name: functionName, inputs: sig, outputs, stateMutability: 'view' }],
      functionName,
      args,
    })
  return { failures, report, check, read }
}

const ADDR = [{ type: 'address' }]
const BYTES32 = [{ type: 'bytes32' }]
const BOOL = [{ type: 'bool' }]

export async function logsFailures(client, governance, journal) {
  const registrar = journal.find(({ step }) => step === 'deploy:BaseRegistrarImplementationProxy')
  const head = await client.getBlockNumber()
  const needed = [
    registrar
      ? { block: BigInt(registrar.blockNumber), address: registrar.address, logs: `the ControllerAdded logs of the registrar proxy` }
      : { block: head - FRESH_RUN_LOG_DEPTH, logs: `the ControllerAdded logs of the registrar proxy, ${FRESH_RUN_LOG_DEPTH} blocks after its deployment` },
    ...Object.entries(governance).filter(([, { kind }]) => kind === 'TimelockController')
      .map(([name, { address, deployBlock }]) => ({ block: BigInt(deployBlock), address, logs: `the RoleGranted logs of ${name}` })),
  ]
  const failures = []
  for (const { block, address, logs } of needed) {
    try {
      await client.getLogs({ address, fromBlock: block, toBlock: block })
    } catch (error) {
      failures.push(`MAINNET_RPC_URL serves no eth_getLogs at block ${block}, from which run 1 reads ${logs}: ${error.shortMessage ?? error.message}`)
    }
  }
  return failures
}

async function controllersAdded(client, registrar, fromBlock) {
  const logs = await logsSince(client, { address: registrar, event: CONTROLLER_ADDED }, fromBlock)
  return logs.map(({ args }) => args.controller)
}

/// L29: the journal proves each transaction was mined, not that the stack is
/// wired the way the script intended — a mis-ordered or silently-reverted step
/// leaves a deployment that looks complete and is not. Read the important state
/// back off-chain and fail loudly while the deploy key can still fix it.
async function readBackOne(client, deployed, { governance, terms, reservedByReason, communityNames }, deployer) {
  console.log(`\n--- Run-1 read-back ---`)
  const { failures, report, check, read } = readBack(client)
  const { addresses } = deployed
  const registry = addresses.ENSRegistry
  const controller = addresses.ETHRegistrarController
  const registrar = addresses.BaseRegistrarImplementation

  await check('registry owner of the TLD node is the base registrar', registrar,
    () => read(registry, BYTES32, ADDR, 'owner', [TLD_NODE]))
  await check('controller is a controller on the registrar', 'true',
    () => read(registrar, ADDR, BOOL, 'controllers', [controller]))
  await check('registrar maxLabelLength', '63',
    () => read(registrar, [], [{ type: 'uint256' }], 'maxLabelLength'))
  await check('registrar subnameHook', addresses.SubnameRegistrar,
    () => read(registrar, [], ADDR, 'subnameHook'))
  await check('registrar metadataRenderer', addresses.MetadataRenderer,
    () => read(registrar, [], ADDR, 'metadataRenderer'))
  await check('controller defaultResolver', addresses.PublicResolver,
    () => read(controller, [], ADDR, 'defaultResolver'))
  await check('controller beneficiary is the guardian', governance.guardianSafe.address,
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
    () => read(registrar, ADDR, BOOL, 'controllers', [addresses.SimplexNamePolicy]))
  for (const [kind, { link, hash }] of Object.entries(terms)) {
    await check(`${kind} link`, link,
      () => read(addresses.SimplexNamePolicy, [], [{ type: 'string' }], `${kind}Link`))
    await check(`${kind} hash`, hash,
      () => read(addresses.SimplexNamePolicy, [], BYTES32, `${kind}Hash`))
  }
  await check('controller nftGateEnabled', 'false',
    () => read(controller, [], BOOL, 'nftGateEnabled'))
  await check('controller minCharLength', '6',
    () => read(controller, [], [{ type: 'uint8' }], 'minCharLength'))
  await check('public sales are still closed', 'false',
    () => read(controller, [], BOOL, 'publicSalesOpen'))
  await check('subname registrar resolver', addresses.PublicResolver,
    () => read(addresses.SubnameRegistrar, [], ADDR, 'resolver'))
  // The sales switch does not gate the sponsored path, so a label missing here is
  // registrable as soon as the guardian funds a registrar.
  const reserved = [...reservedByReason].flatMap(([reason, names]) => names.map((name) => ({ name, reason })))
  const reasons = await client.multicall({
    batchSize: 65_536,
    contracts: reserved.map(({ name }) => ({
      address: addresses.SimplexNamePolicy,
      abi: [{ type: 'function', name: 'reservedNames', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint8' }], stateMutability: 'view' }],
      functionName: 'reservedNames',
      args: [labelhash(name)],
    })),
  })
  const released = reserved.filter((r, i) => reasons[i].result === 0)
  const expiries = await client.multicall({
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
  report(`reserved names read back`, unreserved.length === 0,
    `${reserved.length - unreserved.length - handedOut.size} of ${reserved.length}, ${handedOut.size} handed out` +
      (unreserved.length ? `; missing ${unreserved.slice(0, 5).map((r) => r.name).join(', ')}${unreserved.length > 5 ? ', …' : ''}` : ''))
  const listed = await client.multicall({
    batchSize: 65_536,
    contracts: communityNames.map((name) => ({
      address: addresses.SimplexNamePolicy,
      abi: [{ type: 'function', name: 'communityNames', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'bool' }], stateMutability: 'view' }],
      functionName: 'communityNames',
      args: [labelhash(name)],
    })),
  })
  const unlisted = communityNames.filter((name, i) => listed[i].result !== true)
  report(`community names read back`, unlisted.length === 0,
    `${communityNames.length - unlisted.length} of ${communityNames.length}` +
      (unlisted.length ? `; missing ${unlisted.slice(0, 5).join(', ')}${unlisted.length > 5 ? ', …' : ''}` : ''))
  try {
    const p = await client.readContract({
      address: controller,
      abi: [{ type: 'function', name: 'rentPrice', inputs: [{ type: 'string' }, { type: 'uint256' }],
        outputs: [{ type: 'tuple', components: [{ name: 'base', type: 'uint256' }, { name: 'premium', type: 'uint256' }] }],
        stateMutability: 'view' }],
      functionName: 'rentPrice', args: ['abcdef', 63072000n],
    })
    report('two-year price for a 6-char name', p.base > 0n, `${Number(p.base) / 1e18} ETH`)
  } catch (e) {
    report('rentPrice', false, `read failed — ${e.shortMessage || e.message}`)
  }

  // The curve itself, rung by rung, and the feed scale. `rentPrice` above only
  // proves a 6-char name is not free; a curve off by a factor (per-second args
  // pasted into a per-year contract, say) would sail past it.
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

  await check('eth-usd.data.eth resolves to the ETH/USD feed', chainlinkEthUsd,
    () => read(addresses.PublicResolver, BYTES32, ADDR, 'addr', [namehash('eth-usd.data.eth')]))

  const proxyCode = artifact(TRANSPARENT_PROXY)
  const matchesCode = (what, address, expected) => check(what, 'the artifact', async () => {
    const code = await client.getCode({ address })
    return code === expected() ? 'the artifact' : `code hash ${code && keccak256(code)}`
  })
  for (const [name, definition] of Object.entries(UPGRADEABLE)) {
    const { address: proxy, implementation } = deployed.upgradeable[name]
    const compiled = artifact(definition.artifact)
    const proxyAdmin = proxyAdminOf(proxy)
    await matchesCode(`${name} implementation code, with its immutables`, implementation,
      () => runtimeCode(compiled, definition.immutables(addresses, { tld: TLD, deployer, self: implementation })))
    if (definition.initialize) {
      await check(`${name} implementation _initialized`, '255',
        () => storedValue(client, implementation, compiled, '_initialized'))
    }
    await matchesCode(`${name} proxy code, with its ProxyAdmin`, proxy,
      () => runtimeCode(proxyCode, { _admin: proxyAdmin }))
    await check(`${name} proxy implementation slot`, implementation,
      async () => (await proxySlots(client, proxy)).implementation)
    await check(`${name} proxy admin slot`, proxyAdmin,
      async () => (await proxySlots(client, proxy)).admin)
    await check(`${name} ProxyAdmin owner is the admin Safe`, governance.adminSafe.address,
      () => client.readContract({ address: proxyAdmin, abi: PROXY_ADMIN_ABI, functionName: 'owner' }))
    await matchesCode(`${name} ProxyAdmin code`, proxyAdmin, () => runtimeCode(artifact(PROXY_ADMIN_ARTIFACT), {}))
  }
  for (const name of Object.keys(IMMUTABLE).filter((name) => Object.hasOwn(addresses, name))) {
    await matchesCode(`${name} code`, addresses[name], () => runtimeCode(artifact(IMMUTABLE[name].artifact), {}))
  }
  await check('registrar ens', registry, () => read(registrar, [], ADDR, 'ens'))
  await check('registrar baseNode', TLD_NODE, () => read(registrar, [], BYTES32, 'baseNode'))
  await check('controller ens', registry, () => read(controller, [], ADDR, 'ens'))
  await check('controller tldNode', TLD_NODE, () => read(controller, [], BYTES32, 'tldNode'))
  const [base, , minCommitmentAge, maxCommitmentAge, , { tldSuffix }] =
    UPGRADEABLE.SimplexController.initialize(addresses, { tld: TLD, deployer })
  await check('controller base registrar', base, async () => getAddress(toHex(
    await storedValue(client, controller, artifact(UPGRADEABLE.SimplexController.artifact), 'base'), { size: 20 })))
  await check('controller minCommitmentAge', minCommitmentAge,
    () => read(controller, [], [{ type: 'uint256' }], 'minCommitmentAge'))
  await check('controller maxCommitmentAge', maxCommitmentAge,
    () => read(controller, [], [{ type: 'uint256' }], 'maxCommitmentAge'))
  await check('controller tldSuffix', tldSuffix, () => read(controller, [], [{ type: 'string' }], 'tldSuffix'))
  await check('subname registrar ens', registry, () => read(addresses.SubnameRegistrar, [], ADDR, 'ens'))
  await check('subname registrar baseRegistrar', registrar,
    () => read(addresses.SubnameRegistrar, [], ADDR, 'baseRegistrar'))
  await check('universal resolver registry', registry, () => read(addresses.UniversalResolver, [], ADDR, 'registry'))
  await check('registry resolver of the TLD node', addresses.PublicResolver,
    () => read(registry, BYTES32, ADDR, 'resolver', [TLD_NODE]))
  await check('controllers added on the registrar', sortedAddresses([controller, addresses.SimplexNamePolicy]).join(', '),
    async () => [...new Set(sortedAddresses(await controllersAdded(client, registrar, deployed.upgradeable.BaseRegistrarImplementation.blockNumber)))].join(', '))

  const handedOver = await read(registrar, [], ADDR, 'owner')
    .then((owner) => owner.toLowerCase() === governance.adminSafe.address.toLowerCase(), () => false)
  if (handedOver) {
    console.log(`  · the admin Safe owns the registrar: section 8 began after a passing read-back, so the deploy key's roles are not read`)
  } else {
    await check('registrar owner is the deploy key', deployer, () => read(registrar, [], ADDR, 'owner'))
    for (const name of ['', 'eth', 'data.eth', 'eth-usd.data.eth']) {
      await check(`registry owner of ${name || 'the root node'} is the deploy key`, deployer,
        () => read(registry, BYTES32, ADDR, 'owner', [namehash(name)]))
    }
    for (const [what, at] of [['controller', controller], ['oracle', addresses.SimplexPriceOracle]]) {
      await check(`${what} owner is the deploy key`, deployer, () => read(at, [], ADDR, 'owner'))
      await check(`${what} pendingOwner`, zeroAddress, () => read(at, [], ADDR, 'pendingOwner'))
    }
  }

  return failures
}

async function requireGovernance(client, governance, deployer, withheld) {
  console.log(`\n--- Governance check ---`)
  if (!(await checkGovernance(client, governance, deployer))) {
    throw new Error(`governance.mainnet.json does not match the chain: ${withheld} is not sent`)
  }
}

export async function runOne(runner, client, inputs, deployer) {
  await requireGovernance(client, inputs.governance, deployer, 'any transaction of this run')
  const deployed = await deployAndWire(runner, inputs, deployer, client)
  const failures = await readBackOne(client, deployed, inputs, deployer)
  if (failures.length) {
    throw new Error(
      `${failures.length} run-1 read-back check(s) FAILED: ${failures.join(', ')}.\n` +
        `  This run sends nothing further: the handover and the v1 retirement wait for a passing read-back.`,
    )
  }
  console.log(`  all run-1 read-back checks passed`)
  const root = await handOver(runner, deployed, client, inputs.governance.adminSafe, deployer)
  await retireV1(runner.write, inputs.v1)
  return addressesFile({ ...deployed.addresses, Root: root })
}

export async function readBackTwo(client, addresses, { governance, v1 }, deployer) {
  console.log(`\n--- Run-2 read-back ---`)
  const { failures, report, check, read } = readBack(client)
  const admin = governance.adminSafe.address
  const registry = addresses.ENSRegistry
  const owners = []
  const owner = async (what, expected, readOwner) => owners.push([what, await check(what, expected, readOwner)])

  for (const [name, { key }] of Object.entries(UPGRADEABLE)) {
    await owner(`${name} ProxyAdmin owner`, admin, async () => client.readContract({
      address: (await proxySlots(client, addresses[key])).admin, abi: PROXY_ADMIN_ABI, functionName: 'owner',
    }))
  }
  await owner('controller owner', admin, () => read(addresses.ETHRegistrarController, [], ADDR, 'owner'))
  await owner('controller pendingOwner', zeroAddress, () => read(addresses.ETHRegistrarController, [], ADDR, 'pendingOwner'))
  await check('controller beneficiary', governance.guardianSafe.address,
    () => read(addresses.ETHRegistrarController, [], ADDR, 'beneficiary'))
  await owner('registrar owner', admin, () => read(addresses.BaseRegistrarImplementation, [], ADDR, 'owner'))
  await owner('oracle owner', admin, () => read(addresses.SimplexPriceOracle, [], ADDR, 'owner'))
  await owner('oracle pendingOwner', zeroAddress, () => read(addresses.SimplexPriceOracle, [], ADDR, 'pendingOwner'))
  await owner('registry owner of the root node', addresses.Root, () => read(registry, BYTES32, ADDR, 'owner', [zeroHash]))
  await owner('registry owner of eth', admin, () => read(registry, BYTES32, ADDR, 'owner', [namehash('eth')]))
  await owner('registry owner of data.eth', admin, () => read(registry, BYTES32, ADDR, 'owner', [namehash('data.eth')]))
  await check('registry owner of eth-usd.data.eth', zeroAddress,
    () => read(registry, BYTES32, ADDR, 'owner', [namehash('eth-usd.data.eth')]))
  await check('Root ens', registry, () => read(addresses.Root, [], ADDR, 'ens'))
  await owner('Root owner', admin, () => read(addresses.Root, [], ADDR, 'owner'))
  await check('Root controllers(admin Safe)', 'true', () => read(addresses.Root, ADDR, BOOL, 'controllers', [admin]))
  await check('Root controllers(deploy key)', 'false', () => read(addresses.Root, ADDR, BOOL, 'controllers', [deployer]))
  await check(`Root locked(labelhash("${TLD}"))`, 'false', () => read(addresses.Root, BYTES32, BOOL, 'locked', [labelhash(TLD)]))
  await check('v1 registrar controllers(v1 controller)', 'false', () => client.readContract({
    address: v1.BaseRegistrarImplementation, abi: V1_ABI, functionName: 'controllers', args: [v1.ETHRegistrarController],
  }))
  await check('v1 registrar controllers(v1 name policy)', 'false', () => client.readContract({
    address: v1.BaseRegistrarImplementation, abi: V1_ABI, functionName: 'controllers', args: [v1.SimplexNamePolicy],
  }))
  await owner('v1 controller pendingOwner', zeroAddress,
    () => client.readContract({ address: v1.ETHRegistrarController, abi: V1_ABI, functionName: 'pendingOwner' }))
  await owner('v1 oracle pendingOwner', zeroAddress,
    () => client.readContract({ address: v1.SimplexPriceOracle, abi: V1_ABI, functionName: 'pendingOwner' }))
  for (const [what, got] of owners) {
    report(`${what} is not the deploy key`, got !== undefined && got.toLowerCase() !== deployer.toLowerCase(), got)
  }
  return failures
}

export const acceptanceBatch = (adminSafe, addresses) => safeBatch({
  safe: adminSafe,
  transactions: [addresses.ETHRegistrarController, addresses.SimplexPriceOracle]
    .map((to) => ({ to, data: encodeFunctionData({ abi: ACCEPT_OWNERSHIP_ABI, functionName: 'acceptOwnership' }) })),
  name: 'run 1: accept the controller and the oracle',
  description: `acceptOwnership() on the controller proxy ${addresses.ETHRegistrarController} and on SimplexPriceOracle ${addresses.SimplexPriceOracle}`,
})

export async function registrarAllowanceBatch(client, { registrarWallet: wallet, guardianSafe }, addresses) {
  if (!wallet) return refusal(['governance.mainnet.json has no registrarWallet entry'])
  const failures = await entryFailures(client, wallet)
  if (failures.length) return refusal(failures.map((failure) => `registrarWallet ${wallet.address} ${failure}`))
  const { SimplexSponsor: sponsor, ETHRegistrarController: controller } = addresses
  const { admin } = await proxySlots(client, sponsor)
  const unlinked = admin === proxyAdminOf(sponsor)
    ? []
    : [`the sponsor ${sponsor} is not a v2 proxy: its admin slot holds ${admin}, not ${proxyAdminOf(sponsor)}`]
  for (const [address, functionName, expected] of [
    [controller, 'sponsor', sponsor],
    [sponsor, 'controller', controller],
    [controller, 'beneficiary', guardianSafe.address],
  ]) {
    const got = await client.readContract({ address, abi: LINKS_ABI, functionName })
    if (got.toLowerCase() !== expected.toLowerCase()) unlinked.push(`${functionName}() of ${address} is ${got}, not ${expected}`)
  }
  if (unlinked.length) return refusal(unlinked)
  const args = [wallet.address, wallet.allowance]
  return accepted({
    wallet,
    batch: safeBatch({
      safe: guardianSafe.address,
      transactions: [{ to: addresses.SimplexSponsor, data: encodeFunctionData({ abi: SPONSOR_ABI, functionName: 'setRegistrarAllowance', args }) }],
      name: 'registrar allowance',
      description: `setRegistrarAllowance(${args.join(', ')}) on the sponsor proxy ${addresses.SimplexSponsor}`,
    }),
  })
}

export async function registrarAllowanceReadBack(client, { registrarWallet: wallet }, addresses) {
  if (!wallet) return ['governance.mainnet.json has no registrarWallet entry']
  console.log(`\n--- Registrar allowance read-back ---`)
  const { failures, check } = readBack(client)
  await check(`sponsor registrarAllowance of the registrar wallet ${wallet.address}`, wallet.allowance,
    () => client.readContract({ address: addresses.SimplexSponsor, abi: SPONSOR_ABI, functionName: 'registrarAllowance', args: [wallet.address] }))
  return failures
}

function printCall(to, signature, args) {
  const abi = parseAbi([`function ${signature}`])
  console.log(`    to ${to}: ${signature.replace(/\(.*/, '')}(${args.join(', ')})`)
  console.log(`      calldata ${encodeFunctionData({ abi, args })}`)
}

// Track the spawned fork at module scope so cleanup handlers can reach it.
let activeFork = null
function cleanupFork() {
  if (activeFork) {
    try { activeFork.stop() } catch {}
    activeFork = null
  }
}

async function runOneOnMainnet(rpcUrl, inputs) {
  const deployerKey = requireEnv('DEPLOYER_KEY')
  const maxBaseFeeGwei = requireEnv('MAX_BASE_FEE_GWEI',
    ' (e.g. "0.078")\n       Pick this from Dune (e.g. the 5th-percentile recent base fee).')
  const maxBaseFeeWei = parseGwei(maxBaseFeeGwei)
  const absoluteMaxBaseFeeWei = process.env.ABSOLUTE_MAX_BASE_FEE_GWEI
    ? parseGwei(process.env.ABSOLUTE_MAX_BASE_FEE_GWEI)
    : undefined
  const bumpAfterMs = (parseFloat(process.env.BUMP_AFTER_HOURS) || (DEFAULTS.BUMP_AFTER_MS / 3600000)) * 3600 * 1000
  const bumpPct = BigInt(process.env.BUMP_PCT || DEFAULTS.BUMP_PCT)
  // Default 18545 (not 8546): Reth/Geth use 8546 for the WebSocket JSON-RPC
  // and 8545 for HTTP, so a stock node setup conflicts with the standard
  // 8546 default. Pick a port that's unlikely to overlap with anything.
  const forkPort = parseInt(process.env.FORK_PORT || '18545', 10)
  const account = privateKeyToAccount(deployerKey)
  const { governance } = inputs

  // Cheap and first: a stale build must not cost a fork spawn, let alone a
  // transaction.
  assertTaggedSource(SOURCE_TAG)
  assertCommitted(RUN_ONE_INPUTS)
  assertBuildFresh()

  // A populated addresses file with no journal beside it means a previous
  // deployment completed and its journal was moved or lost. Overwriting it
  // would erase the only record of what is live.
  if (existsSync(ADDRESSES_PATH) && loadJournal(JOURNAL_PATH).length === 0) {
    console.error(
      `${ADDRESSES_PATH} already exists but ${JOURNAL_PATH} is empty or missing.\n` +
        `  That pairing means a completed deployment whose journal is gone — this run would\n` +
        `  overwrite the record of live addresses. Move it and ${attemptsLogPath} aside deliberately if you\n` +
        `  really are starting over.`,
    )
    process.exit(1)
  }
  if (existsSync(VERIFICATION_PATH)) {
    console.error(
      `${VERIFICATION_PATH} exists. Run 1 writes it last, so run 1 is complete, and the file may record\n` +
        `  upgrade candidates since; run 1 does not rewrite it. RUN=2 reads the handover back.`,
    )
    process.exit(1)
  }

  for (const [role, kind] of [['general', 'generalTerms'], ['community', 'communityTerms']]) {
    await checkTermsLink(role, inputs.terms[kind].link).catch((err) => {
      console.error(`terms.${TLD}.json ${kind}: ${err.message}`)
      process.exit(1)
    })
  }

  console.log(`SNRC v2 mainnet deploy for .${TLD} (chainId ${mainnet.id}), run 1`)
  console.log(`  Deployer:          ${account.address}`)
  console.log(`  Admin Safe:        ${governance.adminSafe.address}`)
  console.log(`  Guardian Safe:     ${governance.guardianSafe.address}`)
  console.log(`  Chainlink ETH/USD: ${chainlinkEthUsd}`)
  console.log(`  Cap (gwei):        ${maxBaseFeeGwei}`)
  console.log(`  Bump rule:         after ${bumpAfterMs / 3600000}h stall, cap × ${Number(100n + bumpPct) / 100}`)
  console.log(`  Journal:           ${JOURNAL_PATH}`)
  console.log(`  Attempts log:      ${attemptsLogPath}`)

  const publicClient = await mainnetClient(rpcUrl)
  const unserved = await logsFailures(publicClient, governance, loadJournal(JOURNAL_PATH))
  if (unserved.length) {
    console.error(unserved.join('\n'))
    process.exit(1)
  }

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
    const forkClient = createPublicClient({ chain: { ...mainnet, id: activeFork.chainId }, transport: http(activeFork.url, { timeout: 120_000 }) })
    console.log(`\n--- Dry-run on fork ---`)
    await runOne(dry, forkClient, inputs, account.address)
    dryTotals = dry.totals()
    console.log(`Dry-run captured ${dryTotals.perStep.length} steps, ${dryTotals.totalGas.toLocaleString()} gas total`)
  } finally {
    cleanupFork()
  }

  // ----- 2. Preflight + confirm -----
  const walletClient = createWalletClient({ chain: mainnet, transport: http(rpcUrl), account })

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
    journalPath: JOURNAL_PATH,
    bumpAfterMs, bumpPct,
    label: `.${TLD} v2 mainnet deploy preflight, run 1`,
  })

  // ----- 3. Real deploy against mainnet -----
  console.log(`\n--- Real deploy ---`)
  const real = createWaitForBaseRunner({
    publicClient, walletClient, account,
    maxBaseFeeWei, bumpAfterMs, bumpPct,
    journalPath: JOURNAL_PATH, attemptsLogPath, absoluteMaxBaseFeeWei,
  })
  const addresses = await runOne(real, publicClient, inputs, account.address)

  console.log(`\nDeployer remaining balance: ${(Number(await publicClient.getBalance({ address: account.address })) / 1e18).toFixed(6)} ETH`)
  console.log(`Total spent this run+prior: ${(Number(real.spent()) / 1e18).toFixed(6)} ETH`)

  writeFileSync(ADDRESSES_PATH, JSON.stringify(addresses, null, 2))
  console.log(`Wrote ${ADDRESSES_PATH}`)

  // Emit verification metadata so `verify-etherscan.mjs` (with NETWORK=mainnet)
  // can pick this deploy up without a separate reconstruction pass.
  const verificationMeta = await assembleVerification({
    client: publicClient, addresses, deployer: account.address, adminSafe: governance.adminSafe.address,
  })
  writeFileSync(VERIFICATION_PATH, JSON.stringify(verificationMeta, null, 2))
  console.log(`Wrote ${VERIFICATION_PATH}`)

  console.log(`\n--- Run 1 complete; the admin Safe acts next ---`)
  console.log(`  The admin Safe ${governance.adminSafe.address} accepts both proposals in one batch:`)
  printCall(addresses.ETHRegistrarController, 'acceptOwnership()', [])
  printCall(addresses.SimplexPriceOracle, 'acceptOwnership()', [])
  const batchPath = join(REPO_ROOT, `safe-transaction.mainnet.${TLD}.run-1.json`)
  writeFileSync(batchPath, JSON.stringify(acceptanceBatch(governance.adminSafe.address, addresses), null, 2))
  console.log(`  Wrote ${batchPath}: load it into the Transaction Builder of the admin Safe.`)
  console.log(`  Then run this command again with RUN=2: it reads the handover back.`)
  console.log(`  Until the switch, the deploy key ${account.address} restores v1 if needed — treat it as hot.`)
  console.log(`\nCommit ${ADDRESSES_PATH}, ${JOURNAL_PATH} and ${VERIFICATION_PATH} to the repo at the switch.`)
  console.log(`See docs/deployment.md → Mainnet.`)
}

async function runTwoOnMainnet(rpcUrl, inputs) {
  const addresses = JSON.parse(readFileSync(ADDRESSES_PATH, 'utf8'))
  const { deployer } = JSON.parse(readFileSync(VERIFICATION_PATH, 'utf8'))
  const publicClient = await mainnetClient(rpcUrl)
  const failures = await readBackTwo(publicClient, addresses, inputs, deployer)
  if (failures.length) {
    console.error(`\n  ${failures.length} run-2 read-back check(s) FAILED: ${failures.join(', ')}`)
    process.exitCode = 1
  } else {
    console.log(`  all run-2 read-back checks passed`)
  }
}

async function registrarStepInputs(rpcUrl) {
  assertCommitted(REGISTRAR_STEP_INPUTS)
  return {
    governance: loadGovernance(),
    addresses: JSON.parse(readFileSync(ADDRESSES_PATH, 'utf8')),
    client: await mainnetClient(rpcUrl),
  }
}

async function registrarReadBackOnMainnet(rpcUrl) {
  const { governance, addresses, client } = await registrarStepInputs(rpcUrl)
  const failures = await registrarAllowanceReadBack(client, governance, addresses)
  if (failures.length) {
    console.error(`\n  ${failures.length} registrar read-back check(s) FAILED: ${failures.join(', ')}`)
    process.exitCode = 1
  } else {
    console.log(`  the registrar allowance reads back`)
  }
}

async function registrarBatchOnMainnet(rpcUrl) {
  const { governance, addresses, client } = await registrarStepInputs(rpcUrl)
  const prepared = await registrarAllowanceBatch(client, governance, addresses)
  if (prepared.refused) {
    for (const failure of prepared.failures) console.error(`  ✗ ${failure}`)
    process.exit(1)
  }
  const { wallet, batch } = prepared
  console.log(`  ✓ registrarWallet ${wallet.address}`)
  console.log(`  The guardian Safe ${governance.guardianSafe.address} sets the registrar allowance:`)
  printCall(addresses.SimplexSponsor, 'setRegistrarAllowance(address,uint256)', [wallet.address, wallet.allowance])
  const batchPath = join(REPO_ROOT, `safe-transaction.mainnet.${TLD}.registrar.json`)
  writeFileSync(batchPath, JSON.stringify(batch, null, 2))
  console.log(`  Wrote ${batchPath}: load it into the Transaction Builder of the guardian Safe.`)
  console.log(`  Then run this command again with RUN=registrar-read-back: it reads the allowance back.`)
}

const RUNS = {
  1: (rpcUrl) => runOneOnMainnet(rpcUrl, loadInputs()),
  2: (rpcUrl) => runTwoOnMainnet(rpcUrl, loadInputs()),
  registrar: registrarBatchOnMainnet,
  'registrar-read-back': registrarReadBackOnMainnet,
}

async function main() {
  const run = process.env.RUN
  if (!Object.hasOwn(RUNS, run)) {
    console.error(`RUN must be one of ${Object.keys(RUNS).join(', ')} (got ${JSON.stringify(run)})`)
    process.exit(1)
  }
  await RUNS[run](requireEnv('MAINNET_RPC_URL'))
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.on('SIGINT',  () => { cleanupFork(); process.exit(130) })
  process.on('SIGTERM', () => { cleanupFork(); process.exit(143) })
  process.on('exit',    () => { cleanupFork() })
  main().catch((err) => {
    cleanupFork()
    console.error(causes(err).join('\n  ← '))
    process.exit(1)
  })
}
