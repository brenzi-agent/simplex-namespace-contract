#!/usr/bin/env node
/**
 * Submit SNRC contracts to Etherscan for source verification.
 * Supports both Sepolia (default) and mainnet via NETWORK + SIMPLEX_TLD.
 *
 * Required env vars:
 *   ETHERSCAN_API_KEY  - V2 multi-chain key (etherscan.io account → API keys)
 *
 * Optional:
 *   NETWORK            - 'sepolia' (default) | 'mainnet'
 *   SIMPLEX_TLD        - 'testing' (default) | 'simplex' (used on mainnet
 *                        to pick verification.mainnet.${tld}.json)
 *   ETHERSCAN_CHAIN_ID - override (computed from NETWORK by default)
 *
 * Reads:
 *   - verification.${network}.${tld}.json   (mainnet)
 *   - verification.sepolia.json             (sepolia, legacy filename)
 *   - ens-contracts/artifacts/build-info/*.json
 *
 * Run after the matching deploy script:
 *   ETHERSCAN_API_KEY=... node scripts/verify-etherscan.mjs
 *   ETHERSCAN_API_KEY=... NETWORK=mainnet SIMPLEX_TLD=testing \
 *     node scripts/verify-etherscan.mjs
 *
 * The verification file is either:
 *   (a) the legacy Sepolia format with flat `SimplexControllerImpl` /
 *       `SimplexControllerProxy` / `proxyInitData` fields + optional
 *       `PriceOracle` + `priceOracleConstructorArgs` (+ `priceOracleContract`,
 *       naming which oracle; absent means the vendored
 *       ExponentialPremiumPriceOracle) → translated into TARGETS inline below, OR
 *   (b) the comprehensive format written by build-verification.mjs /
 *       deploy-mainnet.mjs with a `contracts` dict → consumed directly.
 *
 * Both formats are recognised automatically.
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { encodeAbiParameters } from 'viem'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const ARTIFACTS_ROOT = join(REPO_ROOT, 'ens-contracts', 'artifacts')

const apiKey = process.env.ETHERSCAN_API_KEY
const network = process.env.NETWORK || 'sepolia'
const tld = process.env.SIMPLEX_TLD || 'testing'
const chainId = process.env.ETHERSCAN_CHAIN_ID || (network === 'mainnet' ? '1' : '11155111')

if (!apiKey) {
  console.error('ERROR: ETHERSCAN_API_KEY env var is required.')
  process.exit(1)
}

// Mainnet (and any future networks) use the comprehensive
// `verification.${network}.${tld}.json` format with a `contracts` dict.
// Sepolia still uses the legacy flat file (kept for back-compat with
// existing deploy-testnet.mjs output). The format is auto-detected.
const verificationFile = network === 'sepolia'
  ? join(REPO_ROOT, 'verification.sepolia.json')
  : join(REPO_ROOT, `verification.${network}.${tld}.json`)
const meta = JSON.parse(readFileSync(verificationFile, 'utf8'))
console.log(`Reading ${verificationFile}`)
console.log(`Chain: ${network} (chainId=${chainId})`)

let TARGETS
if (meta.contracts) {
  TARGETS = Object.entries(meta.contracts).map(([name, entry]) => ({
    label: name,
    address: entry.address,
    artifact: entry.artifact,
    constructorArgs: entry.constructorArgs,
    buildInfoId: entry.buildInfoId,
    ensContractsCommit: entry.ensContractsCommit,
  }))
} else {
  // Legacy flat format — translate inline. Adding more contracts here is
  // discouraged; new deploys write the comprehensive format already.
  const proxyConstructorArgs = encodeAbiParameters(
    [{ type: 'address' }, { type: 'bytes' }],
    [meta.SimplexControllerImpl, meta.proxyInitData],
  )
  TARGETS = [
    {
      label: 'SimplexController (implementation)',
      address: meta.SimplexControllerImpl,
      artifact: 'contracts/simplex/SimplexController.sol/SimplexController.json',
      constructorArgs: '0x',
    },
    {
      label: 'SimplexControllerProxy (ERC1967)',
      address: meta.SimplexControllerProxy,
      artifact: 'contracts/simplex/SimplexControllerProxy.sol/SimplexControllerProxy.json',
      constructorArgs: proxyConstructorArgs,
    },
  ]
  if (meta.PriceOracle && meta.priceOracleConstructorArgs) {
    const a = meta.priceOracleConstructorArgs
    // Which oracle is named explicitly by `priceOracleContract`; older files
    // predate SimplexPriceOracle and only ever held the vendored one, so an
    // absent field means ExponentialPremiumPriceOracle.
    const isSimplexOracle = meta.priceOracleContract === 'SimplexPriceOracle'
    TARGETS.push(
      isSimplexOracle
        ? {
            label: 'SimplexPriceOracle',
            address: meta.PriceOracle,
            artifact: 'contracts/simplex/SimplexPriceOracle.sol/SimplexPriceOracle.json',
            constructorArgs: encodeAbiParameters(
              [
                { type: 'address' },
                { type: 'uint8' },
                { type: 'uint256' },
                {
                  type: 'tuple[]',
                  components: [
                    { name: 'labelLength', type: 'uint256' },
                    { name: 'priceCentsPerYear', type: 'uint256' },
                  ],
                },
              ],
              [
                a.usdOracle,
                Number(a.usdOracleDecimals),
                BigInt(a.basePriceCentsPerYear),
                a.prices.map((r) => ({
                  labelLength: BigInt(r.labelLength),
                  priceCentsPerYear: BigInt(r.priceCentsPerYear),
                })),
              ],
            ),
          }
        : {
            label: 'ExponentialPremiumPriceOracle',
            address: meta.PriceOracle,
            artifact: 'contracts/ethregistrar/ExponentialPremiumPriceOracle.sol/ExponentialPremiumPriceOracle.json',
            constructorArgs: encodeAbiParameters(
              [{ type: 'address' }, { type: 'uint256[]' }, { type: 'uint256' }, { type: 'uint256' }],
              [a.usdOracle, a.rentPrices.map((s) => BigInt(s)), BigInt(a.startPremium), BigInt(a.totalDays)],
            ),
          },
    )
  }
}

function loadArtifactAndBuildInfo(artifactRelPath) {
  const art = JSON.parse(readFileSync(join(ARTIFACTS_ROOT, artifactRelPath), 'utf8'))
  const buildInfoPath = join(
    ARTIFACTS_ROOT,
    'build-info',
    `${art.buildInfoId}.json`,
  )
  const buildInfo = JSON.parse(readFileSync(buildInfoPath, 'utf8'))
  return { art, buildInfo }
}

const ETHERSCAN_API = 'https://api.etherscan.io/v2/api'
const ALREADY_VERIFIED = /^(Contract source code already verified|Already Verified)/i

async function verify(target) {
  console.log(`\n--- ${target.label} ---`)
  console.log(`  address: ${target.address}`)

  const { art, buildInfo } = loadArtifactAndBuildInfo(target.artifact)
  const compilerversion = `v${buildInfo.solcLongVersion}`
  console.log(`  compiler: ${compilerversion}`)
  console.log(`  source:   ${art.inputSourceName}:${art.contractName}`)

  const body = new URLSearchParams({
    module: 'contract',
    action: 'verifysourcecode',
    contractaddress: target.address,
    sourceCode: JSON.stringify(buildInfo.input),
    codeformat: 'solidity-standard-json-input',
    contractname: `${art.inputSourceName}:${art.contractName}`,
    compilerversion,
    constructorArguements: target.constructorArgs.replace(/^0x/, ''),
  })

  const url = `${ETHERSCAN_API}?chainid=${chainId}&apikey=${apiKey}`
  const res = await fetch(url, { method: 'POST', body })
  const json = await res.json()
  if (json.status !== '1' && ALREADY_VERIFIED.test(json.result ?? '')) {
    console.log(`  OK: ${json.result}`)
    return { verified: true }
  }
  if (json.status !== '1') {
    console.error(`  FAILED: ${json.result || json.message}`)
    return null
  }
  const guid = json.result
  console.log(`  submitted, guid=${guid}`)
  return { guid }
}

async function pollStatus(guid) {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 6000))
    const url = `${ETHERSCAN_API}?chainid=${chainId}&apikey=${apiKey}&module=contract&action=checkverifystatus&guid=${guid}`
    const res = await fetch(url)
    const json = await res.json()
    if (json.result === 'Pending in queue') {
      process.stdout.write('.')
      continue
    }
    process.stdout.write('\n')
    if (json.status === '1' || ALREADY_VERIFIED.test(json.result ?? '')) return { ok: true, msg: json.result }
    return { ok: false, msg: json.result }
  }
  return { ok: false, msg: 'timed out after 2 minutes' }
}

let failures = 0
let verified = 0
const skipped = []
for (const t of TARGETS) {
  // Wrapper-free v3 leaves removed contracts (NameWrapper, DefaultReverseRegistrar,
  // legacy controllers) at the zero address — nothing is deployed there to verify,
  // and some of their artifacts no longer exist in ens-contracts. Skip them.
  if (!t.address || /^0x0+$/i.test(t.address)) {
    console.log(`\n--- ${t.label} ---\n  address: ${t.address}\n  skipped (not deployed)`)
    continue
  }
  const localBuild = JSON.parse(readFileSync(join(ARTIFACTS_ROOT, t.artifact), 'utf8')).buildInfoId
  if (t.buildInfoId && t.buildInfoId !== localBuild) {
    console.log(`\n--- ${t.label} ---\n  address: ${t.address}\n  skipped: built as ${t.buildInfoId} from ens-contracts ` +
      `${t.ensContractsCommit}, and the local artifact is ${localBuild}; check out and compile that commit to verify it`)
    skipped.push(t)
    continue
  }
  const submission = await verify(t)
  if (!submission) {
    failures++
    continue
  }
  if (submission.verified) {
    verified++
    continue
  }
  const status = await pollStatus(submission.guid)
  console.log(`  ${status.ok ? 'OK' : 'FAIL'}: ${status.msg}`)
  if (status.ok) verified++
  else failures++
}

const skippedCommits = [...new Set(skipped.map(({ ensContractsCommit }) => ensContractsCommit))]
console.log(`\n${verified} verified, ${skipped.length} skipped` +
  `${skippedCommits.length ? ` (built from ens-contracts ${skippedCommits.join(', ')})` : ''}.`)
if (failures > 0) {
  console.error(`${failures} contract(s) failed verification.`)
  process.exit(1)
}
console.log(skipped.length
  ? 'Not all contracts verified: run this again from a compiled checkout of each commit above.'
  : 'All contracts verified.')
