#!/usr/bin/env node
/**
 * Deploy SNRC contracts to a local Hardhat node.
 * Run from parent repo:  node scripts/deploy-local.mjs
 *
 * Requires: ens-contracts compiled (npx hardhat compile)
 * Outputs NEXT_PUBLIC_DEPLOYMENT_ADDRESSES JSON for the frontend.
 */
import { createPublicClient, createWalletClient, http, labelhash, namehash, zeroHash, zeroAddress } from 'viem'
import { localhost } from 'viem/chains'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { localTermsLink } from './serve-terms.mjs'
import {
  SIMPLEX_PRICE_BASE,
  SIMPLEX_PRICE_RUNGS,
  SIMPLEX_PRICE_ORACLE_ARTIFACT,
  USD_FEED_DECIMALS,
} from './simplex-price-curve.mjs'
import { UPGRADEABLE, artifact, deployBehindProxy, deployImmutable } from './stack.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545'
const tld = process.env.SIMPLEX_TLD || 'testing'
const tldNode = namehash(tld)

const transport = http(rpcUrl)
const publicClient = createPublicClient({ chain: localhost, transport })
const walletClient = createWalletClient({
  chain: localhost,
  transport,
  account: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', // Hardhat account #0
})
const account = walletClient.account

async function deployRaw(name, abi, bytecode, args = []) {
  const hash = await walletClient.deployContract({ abi, bytecode, args })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  console.log(`${name}: ${receipt.contractAddress}`)
  return { address: receipt.contractAddress, abi }
}

async function deploy(name, artifactPath, args = []) {
  const { abi, bytecode } = artifact(`contracts/${artifactPath}`)
  return deployRaw(name, abi, bytecode, args)
}

async function write(contract, functionName, args) {
  const hash = await walletClient.writeContract({
    address: contract.address,
    abi: contract.abi,
    functionName,
    args,
  })
  await publicClient.waitForTransactionReceipt({ hash })
}

async function main() {
  console.log(`Deploying SNRC for .${tld} TLD...`)
  console.log(`Deployer: ${account.address}`)
  console.log(`RPC: ${rpcUrl}\n`)

  const deployed = {}
  const setup = { tld, deployer: account.address }
  const proxied = async (name) => {
    const contract = await deployBehindProxy(deployRaw, name, deployed, setup, account.address)
    deployed[UPGRADEABLE[name].key] = contract.address
    return contract
  }
  const immutable = async (name) => {
    const contract = await deployImmutable(deployRaw, name, deployed, setup)
    deployed[name] = contract.address
    return contract
  }

  const ensRegistry = await proxied('ENSRegistry')

  const baseRegistrar = await proxied('BaseRegistrarImplementation')


  // No reverse registrar and no addr.reverse node: PublicResolver no longer
  // inherits ReverseClaimer, so nothing needs to own it for the resolver to deploy.

  // Set TLD owner to deployer (need to set resolver before transferring)
  await write(ensRegistry, 'setSubnodeOwner', [zeroHash, labelhash(tld), account.address])

  const dummyOracle = await deploy('DummyOracle',
    'ethregistrar/DummyOracle.sol/DummyOracle.json',
    [100000000n])

  // `.testing` is live on the vendored ExponentialPremiumPriceOracle with an
  // all-zero curve (gas-only registration) and keeps it: swapping a deployed
  // TLD's oracle is a separate change. `.simplex` gets SimplexPriceOracle,
  // whose curve and feed are both settable by call afterwards, so it
  // never has to be redeployed to change what a name costs.
  const priceOracle = tld === 'testing'
    ? await deploy('ExponentialPremiumPriceOracle',
        'ethregistrar/ExponentialPremiumPriceOracle.sol/ExponentialPremiumPriceOracle.json',
        [dummyOracle.address, [0n, 0n, 0n, 0n, 0n, 0n], 100000000000000000000000000n, 21n])
    : await deploy('SimplexPriceOracle', SIMPLEX_PRICE_ORACLE_ARTIFACT,
        [dummyOracle.address, USD_FEED_DECIMALS, SIMPLEX_PRICE_BASE, SIMPLEX_PRICE_RUNGS])
  deployed[tld === 'testing' ? 'ExponentialPremiumPriceOracle' : 'SimplexPriceOracle'] = priceOracle.address

  const mockNft = await deploy('MockSMPXNFT',
    'mocks/MockSMPXNFT.sol/MockSMPXNFT.json')
  setup.smpxNft = mockNft.address

  await write(mockNft, 'mint', [account.address])
  console.log(`Minted NFT #0 to deployer`)

  // SimplexController is upgradeable. Deploy the implementation, then an
  // ERC1967 proxy that calls initialize() atomically as constructor data.
  // Use the proxy address everywhere SimplexController is referenced. ABI
  // is the implementation's; calls reach storage via the proxy.
  const controller = await proxied('SimplexController')

  // PublicResolver must trust the controller so it can write records during register().
  // SubnameRegistrar owns + resolves subnames, soulbound to the 2LD NFT. Deployed
  // before the resolver, whose nameWrapper slot points at it.
  const subnameRegistrar = await proxied('SubnameRegistrar')

  // SimplexResolver = PublicResolver + signed record writes. SNRC is wrapper-free
  // for 2LDs (their node is owned directly by the NFT holder via auto-reclaim),
  // but the resolver's NameWrapper slot is repurposed for the SubnameRegistrar so
  // subname records authorise against the live 2LD holder (subnameRegistrar.ownerOf).
  // trustedReverseRegistrar is address(0) and inert: there is no reverse resolution.
  const publicResolver = await proxied('SimplexResolver')

  await write(subnameRegistrar, 'setResolver', [publicResolver.address])
  await write(baseRegistrar, 'setSubnameHook', [subnameRegistrar.address])
  await write(controller, 'setDefaultResolver', [publicResolver.address])

  const sponsor = await proxied('SimplexSponsor')
  await write(controller, 'setSponsor', [sponsor.address])

  // local dev: one key plays both roles, and sales are open so the payable path works
  await write(controller, 'setBeneficiary', [account.address])
  await write(controller, 'setPublicSalesOpen', [true])

  // Wire up
  await write(baseRegistrar, 'addController', [controller.address])
  console.log(`Controller wired up`)

  const namePolicy = await proxied('SimplexNamePolicy')
  await write(baseRegistrar, 'addController', [namePolicy.address])
  await write(controller, 'setNamePolicy', [namePolicy.address])
  await write(baseRegistrar, 'setNamePolicy', [namePolicy.address])

  // On-chain NFT metadata: deploy the renderer and point the registrar's tokenURI at it.
  const metadataRenderer = await immutable('MetadataRenderer')
  await write(baseRegistrar, 'setMetadataRenderer', [metadataRenderer.address])
  // Cap label length at the DNS octet limit (63 bytes). Bounds labelOf storage
  // and on-chain SVG/JSON render size. (security.md L4)
  await write(baseRegistrar, 'setMaxLabelLength', [63n])

  // Genesis reserved-names list — these labels cannot be registered by the public.
  // Extend as needed before deploying to testnet / mainnet. Bulk in one tx.
  // SimplexNamePolicy.Reason — the on-chain enum. Append-only once names are
  // reserved, so these integers are fixed by the contract, not by this script.
  const REASON_INTERNAL = 1
  const reservedAtDeploy = ['simplex', 'simplex-chat']
  await write(namePolicy, 'addReservedNames', [reservedAtDeploy, REASON_INTERNAL])
  for (const label of reservedAtDeploy) {
    console.log(`Reserved: ${label}.${tld}`)
  }

  if (tld === 'simplex') {
    await write(namePolicy, 'setGeneralTerms', [localTermsLink('general-terms.md')])
    await write(namePolicy, 'setCommunityTerms', [localTermsLink('community-terms.md')])
    const communityAtDeploy = ['communityname', 'communityclaim']
    await write(namePolicy, 'addCommunityNames', [communityAtDeploy])
    console.log(`Terms links set; listed: ${communityAtDeploy.join(', ')}`)
  }

  // UniversalResolver (needed by the frontend for name lookups)
  await immutable('DummyGatewayProvider')

  const universalResolver = await proxied('UniversalResolver')

  const multicall3 = await deploy('Multicall3',
    'mocks/Multicall3.sol/Multicall3.json')
  const multicall3Address = multicall3.address

  // Set resolver then transfer TLD to BaseRegistrar
  await write(ensRegistry, 'setResolver', [tldNode, publicResolver.address])
  // The registry assigns a node to someone other than the caller only under the
  // root or a TLD, so the TLD is assigned to the registrar from the root.
  await write(ensRegistry, 'setSubnodeOwner', [zeroHash, labelhash(tld), baseRegistrar.address])
  console.log(`.${tld} node transferred to BaseRegistrar`)

  // Frontend's useEthPrice resolves eth-usd.data.eth -> ChainLink-like oracle.
  // Register the path under root and point its addr record at DummyOracle (has latestAnswer()).
  await write(ensRegistry, 'setSubnodeOwner', [zeroHash, labelhash('eth'), account.address])
  await write(ensRegistry, 'setResolver', [namehash('eth'), publicResolver.address])
  await write(ensRegistry, 'setSubnodeOwner', [namehash('eth'), labelhash('data'), account.address])
  await write(ensRegistry, 'setResolver', [namehash('data.eth'), publicResolver.address])
  await write(ensRegistry, 'setSubnodeOwner', [namehash('data.eth'), labelhash('eth-usd'), account.address])
  await write(ensRegistry, 'setResolver', [namehash('eth-usd.data.eth'), publicResolver.address])
  await write(publicResolver, 'setAddr', [namehash('eth-usd.data.eth'), dummyOracle.address])
  console.log(`eth-usd.data.eth -> DummyOracle\n`)

  const addresses = {
    ENSRegistry: ensRegistry.address,
    BaseRegistrarImplementation: baseRegistrar.address,
    ReverseRegistrar: zeroAddress,
    DefaultReverseRegistrar: zeroAddress,
    NameWrapper: zeroAddress, // wrapper-free v3
    MetadataRenderer: metadataRenderer.address,
    SubnameRegistrar: subnameRegistrar.address,
    PublicResolver: publicResolver.address,
    ETHRegistrarController: controller.address,
    SimplexSponsor: sponsor.address,
    SimplexNamePolicy: namePolicy.address,
    [tld === 'testing' ? 'ExponentialPremiumPriceOracle' : 'SimplexPriceOracle']:
      priceOracle.address,
    DummyOracle: dummyOracle.address,
    MockSMPXNFT: mockNft.address,
    NameWrapperPublicResolver: publicResolver.address,
    UniversalResolver: universalResolver.address,
    Multicall: multicall3Address,
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
  }

  console.log('\n=== DEPLOYMENT ADDRESSES ===')
  console.log(JSON.stringify(addresses, null, 2))
  console.log(`\nNEXT_PUBLIC_DEPLOYMENT_ADDRESSES=${JSON.stringify(addresses)}`)

  // Persist for tests that need to reach the contracts directly.
  const { writeFileSync } = await import('fs')
  writeFileSync(join(__dirname, '..', 'deployments.local.json'), JSON.stringify(addresses, null, 2))
}

main().catch((err) => { console.error(err); process.exit(1) })
