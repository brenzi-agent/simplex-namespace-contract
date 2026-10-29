#!/usr/bin/env node
/**
 * Deploy SNRC contracts to a local Hardhat node.
 * Run from parent repo:  node scripts/deploy-local.mjs
 *
 * Requires: ens-contracts compiled (npx hardhat compile)
 * Outputs NEXT_PUBLIC_DEPLOYMENT_ADDRESSES JSON for the frontend.
 */
import { createPublicClient, createWalletClient, encodeFunctionData, http, labelhash, namehash, zeroHash, zeroAddress } from 'viem'
import { localhost } from 'viem/chains'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { localTermsLink } from './serve-terms.mjs'
import {
  SIMPLEX_PRICE_BASE,
  SIMPLEX_PRICE_RUNGS,
  SIMPLEX_PRICE_ORACLE_ARTIFACT,
  USD_FEED_DECIMALS,
} from './simplex-price-curve.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ARTIFACTS = join(__dirname, '..', 'ens-contracts', 'artifacts', 'contracts')

function loadArtifact(path) {
  const full = join(ARTIFACTS, path)
  const json = JSON.parse(readFileSync(full, 'utf8'))
  return { abi: json.abi, bytecode: json.bytecode }
}

const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545'
const tld = process.env.SIMPLEX_TLD || 'testing'
const tldNode = namehash(tld)
const nftGateEnabled = tld === 'testing'

const transport = http(rpcUrl)
const publicClient = createPublicClient({ chain: localhost, transport })
const walletClient = createWalletClient({
  chain: localhost,
  transport,
  account: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', // Hardhat account #0
})
const account = walletClient.account

async function deploy(name, artifactPath, args = []) {
  const { abi, bytecode } = loadArtifact(artifactPath)
  const hash = await walletClient.deployContract({ abi, bytecode, args })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  console.log(`${name}: ${receipt.contractAddress}`)
  return { address: receipt.contractAddress, abi }
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

  const ensRegistry = await deploy('ENSRegistry',
    'registry/ENSRegistry.sol/ENSRegistry.json')

  const baseRegistrar = await deploy('BaseRegistrarImplementation',
    'ethregistrar/BaseRegistrarImplementation.sol/BaseRegistrarImplementation.json',
    [ensRegistry.address, tldNode])


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

  const mockNft = await deploy('MockSMPXNFT',
    'mocks/MockSMPXNFT.sol/MockSMPXNFT.json')

  await write(mockNft, 'mint', [account.address])
  console.log(`Minted NFT #0 to deployer`)

  // SimplexController is upgradeable. Deploy the implementation, then an
  // ERC1967 proxy that calls initialize() atomically as constructor data.
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
        smpxNft: nftGateEnabled ? mockNft.address : zeroAddress,
        nftGateEnabled,
      },
      account.address,
    ],
  })

  const controllerProxy = await deploy('SimplexControllerProxy',
    'simplex/SimplexControllerProxy.sol/SimplexControllerProxy.json',
    [controllerImpl.address, initData])

  // Use the proxy address everywhere SimplexController is referenced. ABI
  // is the implementation's; calls reach storage via the proxy.
  const controller = { address: controllerProxy.address, abi: controllerImpl.abi }

  // PublicResolver must trust the controller so it can write records during register().
  // SubnameRegistrar owns + resolves subnames, soulbound to the 2LD NFT. Deployed
  // before the resolver, whose nameWrapper slot points at it.
  const subnameRegistrar = await deploy('SubnameRegistrar',
    'simplex/SubnameRegistrar.sol/SubnameRegistrar.json',
    [ensRegistry.address, baseRegistrar.address])

  // SimplexResolver = PublicResolver + signed record writes. SNRC is wrapper-free
  // for 2LDs (their node is owned directly by the NFT holder via auto-reclaim),
  // but the resolver's NameWrapper slot is repurposed for the SubnameRegistrar so
  // subname records authorise against the live 2LD holder (subnameRegistrar.ownerOf).
  // trustedReverseRegistrar is address(0) and inert: there is no reverse resolution.
  const publicResolver = await deploy('SimplexResolver',
    'simplex/SimplexResolver.sol/SimplexResolver.json',
    [ensRegistry.address, subnameRegistrar.address, controller.address, zeroAddress])

  await write(subnameRegistrar, 'setResolver', [publicResolver.address])
  await write(baseRegistrar, 'setSubnameHook', [subnameRegistrar.address])
  await write(controller, 'setDefaultResolver', [publicResolver.address])

  // The sponsored path: registrar allowances, registerWithCredit/renewWithCredit
  // and the owner's signature check. Only this contract may call the controller's
  // sponsored entry points; `freeze` fixes it. The guardian funds registrars here.
  const sponsor = await deploy('SimplexSponsor',
    'simplex/SimplexSponsor.sol/SimplexSponsor.json',
    [controller.address])
  await write(controller, 'setSponsor', [sponsor.address])

  // local dev: one key plays both roles, and sales are open so the payable path works
  await write(controller, 'setBeneficiary', [account.address])
  await write(controller, 'setPublicSalesOpen', [true])

  // Wire up
  await write(baseRegistrar, 'addController', [controller.address])
  console.log(`Controller wired up`)

  const namePolicyImpl = await deploy('SimplexNamePolicyImpl',
    'simplex/SimplexNamePolicy.sol/SimplexNamePolicy.json',
    [controller.address, baseRegistrar.address])
  const namePolicyProxy = await deploy('SimplexNamePolicyProxy',
    'simplex/SimplexNamePolicyProxy.sol/SimplexNamePolicyProxy.json',
    [namePolicyImpl.address, '0x'])
  const namePolicy = { address: namePolicyProxy.address, abi: namePolicyImpl.abi }
  await write(baseRegistrar, 'addController', [namePolicy.address])
  await write(controller, 'setNamePolicy', [namePolicy.address])
  await write(baseRegistrar, 'setNamePolicy', [namePolicy.address])

  // On-chain NFT metadata: deploy the renderer and point the registrar's tokenURI at it.
  const metadataRenderer = await deploy('MetadataRenderer',
    'simplex/MetadataRenderer.sol/MetadataRenderer.json',
    [`.${tld}`])
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
  const dummyGateway = await deploy('DummyGatewayProvider',
    'mocks/DummyGatewayProvider.sol/DummyGatewayProvider.json')

  const universalResolver = await deploy('UniversalResolver',
    'universalResolver/UniversalResolver.sol/UniversalResolver.json',
    [account.address, ensRegistry.address, dummyGateway.address])

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
