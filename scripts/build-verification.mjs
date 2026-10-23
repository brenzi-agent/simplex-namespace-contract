#!/usr/bin/env node
/**
 * Build a verification.${network}.${tld}.json file from an existing
 * deployments.${network}.${tld}.json. Used as:
 *
 *   - Run standalone after a past deploy that didn't write verification
 *     metadata itself (e.g. the first mainnet .testing deploy).
 *   - Imported by deploy-mainnet.mjs to write the file automatically at
 *     the end of every new deploy.
 *
 * Constructor arguments are reconstructed from the addresses in the
 * deployments JSON + a handful of env vars / fixed deploy-time params:
 *
 *   - TLD root (`SIMPLEX_TLD`, default 'testing')
 *   - Deployer EOA address (`DEPLOYER` env, or `--deployer 0x…`, or
 *     looked up from the first journal tx's `from` field)
 *   - SMPXNFT contract address (default mainnet 0x3AF6D9Ee…7291)
 *   - Chainlink ETH/USD feed (default mainnet 0x5f4e…8419)
 *   - SimplexController init params (minCharLength=6, commit windows
 *     = 60s / 86400s, smpxNft gate enabled on `.testing`)
 *
 * Required env vars:
 *   NETWORK            'mainnet' or 'sepolia'
 *
 * Optional env vars:
 *   SIMPLEX_TLD        'testing' (default) | 'simplex'
 *   DEPLOYER           0x-prefixed deployer EOA. If unset, the script
 *                      reads the first line of the deploy journal and
 *                      asks the RPC for the from-address.
 *   MAINNET_RPC_URL    needed only when DEPLOYER must be looked up via tx
 *
 *   ETHUSD_FEED        Chainlink AggregatorV3
 *   SMPXNFT_ADDR       SMPXNFT contract
 *
 * Writes:
 *   verification.${network}.${tld}.json
 *
 * Run:
 *   NETWORK=mainnet SIMPLEX_TLD=testing DEPLOYER=0x… node scripts/build-verification.mjs
 */
import { encodeAbiParameters, encodeFunctionData, namehash, zeroAddress } from 'viem'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  SIMPLEX_PRICE_BASE,
  SIMPLEX_PRICE_RUNGS,
  USD_FEED_DECIMALS,
} from './simplex-price-curve.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const ARTIFACTS_ROOT = join(REPO_ROOT, 'ens-contracts', 'artifacts')

function loadArtifact(rel) {
  return JSON.parse(readFileSync(join(ARTIFACTS_ROOT, 'contracts', rel), 'utf8'))
}

const MAINNET_DEFAULTS = {
  chainlinkEthUsd: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
  smpxNftAddr: '0x3AF6D9Ee862376A8DFC0a78847Eb20A153557291',
}

/**
 * Pure assembler: given deployment addresses + the deploy-time params,
 * return the verification metadata object. Used by deploy-mainnet.mjs
 * at the end of a fresh deploy, where every input is already in scope.
 */
export function assembleVerification({
  network, tld, addresses,
  deployer, chainlinkEthUsd, smpxNftAddr,
  minCharLength = 6, minCommitmentAge = 60n, maxCommitmentAge = 86400n,
}) {
  const tldNode = namehash(tld)
  const nftGateEnabled = tld === 'testing'

  // SimplexController.initialize calldata — re-encoded so the proxy's
  // constructor args can be reconstructed deterministically.
  const controllerImplArtifact = loadArtifact('simplex/SimplexController.sol/SimplexController.json')
  const proxyInitData = encodeFunctionData({
    abi: controllerImplArtifact.abi,
    functionName: 'initialize',
    args: [
      addresses.BaseRegistrarImplementation,
      addresses.ExponentialPremiumPriceOracle ?? addresses.SimplexPriceOracle,
      minCommitmentAge,
      maxCommitmentAge,
      addresses.ENSRegistry,
      {
        tldNode,
        tldSuffix: `.${tld}`,
        minCharLength,
        smpxNft: nftGateEnabled ? smpxNftAddr : zeroAddress,
        nftGateEnabled,
      },
      deployer,
    ],
  })

  // MUST stay byte-identical to deploy-mainnet.mjs — a mismatch here does not
  // fail loudly, it produces constructorArgs Etherscan rejects. `.simplex` reads
  // its curve from the shared module the deploy scripts use, so the two cannot
  // drift; `.testing` is the vendored oracle with an all-zero per-second array.
  const isTesting = tld === 'testing'

  // The dummy gateway provider address from the deploy: we don't have it
  // directly (the deployments JSON doesn't include mock-only contracts).
  // UniversalResolver's constructor needs it. Skip the entry rather than
  // emit a verification target with a placeholder.
  const targets = {
    ENSRegistry: {
      address: addresses.ENSRegistry,
      artifact: 'contracts/registry/ENSRegistry.sol/ENSRegistry.json',
      constructorArgs: '0x',
    },
    BaseRegistrarImplementation: {
      address: addresses.BaseRegistrarImplementation,
      artifact: 'contracts/ethregistrar/BaseRegistrarImplementation.sol/BaseRegistrarImplementation.json',
      constructorArgs: encodeAbiParameters(
        [{ type: 'address' }, { type: 'bytes32' }],
        [addresses.ENSRegistry, tldNode],
      ),
    },
    // No ReverseRegistrar, DefaultReverseRegistrar or NameWrapper: none of the
    // three is deployed. Their keys in the addresses file are address(0).
    ...(isTesting
      ? {
          ExponentialPremiumPriceOracle: {
            address: addresses.ExponentialPremiumPriceOracle,
            artifact: 'contracts/ethregistrar/ExponentialPremiumPriceOracle.sol/ExponentialPremiumPriceOracle.json',
            constructorArgs: encodeAbiParameters(
              [{ type: 'address' }, { type: 'uint256[]' }, { type: 'uint256' }, { type: 'uint256' }],
              [chainlinkEthUsd, [0n, 0n, 0n, 0n, 0n, 0n], 100000000000000000000000000n, 21n],
            ),
          },
        }
      : {
          SimplexPriceOracle: {
            address: addresses.SimplexPriceOracle,
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
                chainlinkEthUsd,
                USD_FEED_DECIMALS,
                SIMPLEX_PRICE_BASE,
                SIMPLEX_PRICE_RUNGS,
              ],
            ),
          },
        }),
    SimplexControllerImpl: {
      // Implementation has no constructor args; init runs via the proxy.
      address: getImplAddress(addresses),
      artifact: 'contracts/simplex/SimplexController.sol/SimplexController.json',
      constructorArgs: '0x',
    },
    SimplexControllerProxy: {
      address: addresses.ETHRegistrarController, // proxy is what the dApp talks to
      artifact: 'contracts/simplex/SimplexControllerProxy.sol/SimplexControllerProxy.json',
      constructorArgs: encodeAbiParameters(
        [{ type: 'address' }, { type: 'bytes' }],
        [getImplAddress(addresses), proxyInitData],
      ),
    },
    SimplexSponsor: {
      address: addresses.SimplexSponsor,
      artifact: 'contracts/simplex/SimplexSponsor.sol/SimplexSponsor.json',
      constructorArgs: encodeAbiParameters(
        [{ type: 'address' }],
        [addresses.ETHRegistrarController],
      ),
    },
    SimplexNamePolicyImpl: {
      address: addresses.SimplexNamePolicyImpl,
      artifact: 'contracts/simplex/SimplexNamePolicy.sol/SimplexNamePolicy.json',
      constructorArgs: encodeAbiParameters(
        [{ type: 'address' }, { type: 'address' }],
        [addresses.ETHRegistrarController, addresses.BaseRegistrarImplementation],
      ),
    },
    SimplexNamePolicyProxy: {
      address: addresses.SimplexNamePolicy,
      artifact: 'contracts/simplex/SimplexNamePolicyProxy.sol/SimplexNamePolicyProxy.json',
      constructorArgs: encodeAbiParameters(
        [{ type: 'address' }, { type: 'bytes' }],
        [addresses.SimplexNamePolicyImpl, '0x'],
      ),
    },
    // The deployment resolver is SimplexResolver (PublicResolver + signed record
    // writes). It is recorded under the `PublicResolver` key for dApp
    // compatibility, but it is a different artifact and different bytecode.
    SimplexResolver: {
      address: addresses.PublicResolver,
      artifact: 'contracts/simplex/SimplexResolver.sol/SimplexResolver.json',
      constructorArgs: encodeAbiParameters(
        [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }],
        [
          addresses.ENSRegistry,
          addresses.SubnameRegistrar, // nameWrapper slot: subname authorisation
          addresses.ETHRegistrarController,
          zeroAddress, // trustedReverseRegistrar: unused and inert
        ],
      ),
    },
    SubnameRegistrar: {
      address: addresses.SubnameRegistrar,
      artifact: 'contracts/simplex/SubnameRegistrar.sol/SubnameRegistrar.json',
      constructorArgs: encodeAbiParameters(
        [{ type: 'address' }, { type: 'address' }],
        [addresses.ENSRegistry, addresses.BaseRegistrarImplementation],
      ),
    },
    MetadataRenderer: {
      address: addresses.MetadataRenderer,
      artifact: 'contracts/simplex/MetadataRenderer.sol/MetadataRenderer.json',
      constructorArgs: encodeAbiParameters([{ type: 'string' }], [`.${tld}`]),
    },
  }

  if (addresses.DummyGatewayProvider) {
    targets.DummyGatewayProvider = {
      address: addresses.DummyGatewayProvider,
      artifact: 'contracts/mocks/DummyGatewayProvider.sol/DummyGatewayProvider.json',
      constructorArgs: '0x',
    }
  }

  if (addresses.UniversalResolver && addresses.DummyGatewayProvider) {
    targets.UniversalResolver = {
      address: addresses.UniversalResolver,
      artifact: 'contracts/universalResolver/UniversalResolver.sol/UniversalResolver.json',
      constructorArgs: encodeAbiParameters(
        [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
        [deployer, addresses.ENSRegistry, addresses.DummyGatewayProvider],
      ),
    }
  }

  return {
    network,
    chainId: network === 'mainnet' ? '1' : '11155111',
    tld,
    deployer,
    chainlinkEthUsd,
    smpxNftAddr,
    contracts: targets,
  }
}

// Implementation address isn't in deployments.json (the dApp only needs the
// proxy). For now require it via env, OR derive it from the journal: it's
// the contract created at step:008 in our current sequence.
function getImplAddress(addresses) {
  if (process.env.CONTROLLER_IMPL_ADDR) return process.env.CONTROLLER_IMPL_ADDR
  if (addresses.SimplexControllerImpl) return addresses.SimplexControllerImpl
  throw new Error(
    'Need controller implementation address. Either set CONTROLLER_IMPL_ADDR ' +
      'env or add `SimplexControllerImpl` to deployments.json. The proxy is at ' +
      `${addresses.ETHRegistrarController}; the impl is whatever address the proxy points at.`,
  )
}

// ----- CLI -----

async function lookupDeployerFromJournal(network, tld) {
  const journalPath = join(REPO_ROOT, `deployments.${network}.${tld}.journal.jsonl`)
  if (!existsSync(journalPath)) return null
  const first = readFileSync(journalPath, 'utf8').split('\n').filter(Boolean)[0]
  if (!first) return null
  const { txHash } = JSON.parse(first)
  if (!txHash) return null
  const rpcUrl = process.env.MAINNET_RPC_URL || process.env.SEPOLIA_RPC_URL
  if (!rpcUrl) {
    throw new Error(
      `Need MAINNET_RPC_URL (or SEPOLIA_RPC_URL) to look up deployer from tx ${txHash}. ` +
        `Or pass DEPLOYER=0x… explicitly.`,
    )
  }
  const r = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getTransactionByHash', params: [txHash], id: 1 }),
  })
  const { result } = await r.json()
  return result?.from || null
}

async function cli() {
  const network = process.env.NETWORK
  if (!network) {
    console.error('ERROR: NETWORK env var is required (mainnet | sepolia).')
    process.exit(1)
  }
  const tld = process.env.SIMPLEX_TLD || 'testing'
  const deploymentsPath = join(REPO_ROOT, `deployments.${network}.${tld}.json`)
  if (!existsSync(deploymentsPath)) {
    console.error(`ERROR: ${deploymentsPath} not found.`)
    process.exit(1)
  }
  const addresses = JSON.parse(readFileSync(deploymentsPath, 'utf8'))

  const deployer = process.env.DEPLOYER || (await lookupDeployerFromJournal(network, tld))
  if (!deployer) {
    console.error(
      'ERROR: deployer address not provided and no journal available to look it up. ' +
        'Set DEPLOYER=0x… (the EOA that ran deploy-mainnet.mjs).',
    )
    process.exit(1)
  }

  const chainlinkEthUsd = process.env.ETHUSD_FEED || MAINNET_DEFAULTS.chainlinkEthUsd
  const smpxNftAddr = process.env.SMPXNFT_ADDR || MAINNET_DEFAULTS.smpxNftAddr

  const meta = assembleVerification({
    network, tld, addresses, deployer, chainlinkEthUsd, smpxNftAddr,
  })

  const outPath = join(REPO_ROOT, `verification.${network}.${tld}.json`)
  writeFileSync(outPath, JSON.stringify(meta, null, 2))
  console.log(`Wrote ${outPath}`)
  console.log(`Targets:`)
  for (const [name, t] of Object.entries(meta.contracts)) {
    console.log(`  ${name.padEnd(32)} ${t.address}`)
  }
}

// Run as CLI when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  cli().catch((e) => { console.error(e); process.exit(1) })
}
