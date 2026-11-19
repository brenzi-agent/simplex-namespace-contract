import { encodeAbiParameters, encodeFunctionData, getAddress, getContractAddress, namehash, pad, parseAbi, toHex, zeroAddress } from 'viem'
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import {
  SIMPLEX_PRICE_BASE,
  SIMPLEX_PRICE_RUNGS,
  SIMPLEX_PRICE_ORACLE_ARTIFACT,
  USD_FEED_DECIMALS,
} from './simplex-price-curve.mjs'

export const ENS_CONTRACTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'ens-contracts')
const ARTIFACTS = join(ENS_CONTRACTS_DIR, 'artifacts')

export const ERC1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
export const ERC1967_ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103'
export const TRANSPARENT_PROXY = '@openzeppelin/contracts-v5/proxy/transparent/TransparentUpgradeableProxy.sol/TransparentUpgradeableProxy.json'
export const PROXY_ADMIN = '@openzeppelin/contracts-v5/proxy/transparent/ProxyAdmin.sol/ProxyAdmin.json'
export const OWNABLE_ABI = parseAbi([
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
])

const controllerConfig = (tld, smpxNft) => ({
  tldNode: namehash(tld),
  tldSuffix: `.${tld}`,
  minCharLength: 6,
  smpxNft: tld === 'testing' ? smpxNft : zeroAddress,
  nftGateEnabled: tld === 'testing',
})

export const UPGRADEABLE = {
  ENSRegistry: {
    key: 'ENSRegistry',
    artifact: 'contracts/registry/ENSRegistry.sol/ENSRegistry.json',
    args: () => [],
    initialize: (a, { deployer }) => [deployer],
    immutables: () => ({}),
  },
  BaseRegistrarImplementation: {
    key: 'BaseRegistrarImplementation',
    artifact: 'contracts/ethregistrar/BaseRegistrarImplementation.sol/BaseRegistrarImplementation.json',
    args: (a, { tld }) => [a.ENSRegistry, namehash(tld)],
    initialize: (a, { tld, deployer }) => [a.ENSRegistry, namehash(tld), deployer],
    immutables: () => ({}),
  },
  SimplexController: {
    key: 'ETHRegistrarController',
    artifact: 'contracts/simplex/SimplexController.sol/SimplexController.json',
    args: () => [],
    initialize: (a, { tld, deployer, smpxNft }) => [
      a.BaseRegistrarImplementation,
      a.SimplexPriceOracle ?? a.ExponentialPremiumPriceOracle,
      60n,
      86400n,
      a.ENSRegistry,
      controllerConfig(tld, smpxNft),
      deployer,
    ],
    immutables: () => ({}),
  },
  SimplexNamePolicy: {
    key: 'SimplexNamePolicy',
    artifact: 'contracts/simplex/SimplexNamePolicy.sol/SimplexNamePolicy.json',
    args: (a) => [a.ETHRegistrarController, a.BaseRegistrarImplementation],
    immutables: (a, { tld, self }) => ({
      controller: a.ETHRegistrarController,
      registrar: a.BaseRegistrarImplementation,
      _ens: a.ENSRegistry,
      _tldNode: namehash(tld),
      _self: self,
    }),
  },
  SubnameRegistrar: {
    key: 'SubnameRegistrar',
    artifact: 'contracts/simplex/SubnameRegistrar.sol/SubnameRegistrar.json',
    args: (a) => [a.ENSRegistry, a.BaseRegistrarImplementation],
    immutables: (a, { deployer }) => ({
      ens: a.ENSRegistry,
      baseRegistrar: a.BaseRegistrarImplementation,
      _deployer: deployer,
    }),
  },
  SimplexResolver: {
    key: 'PublicResolver',
    artifact: 'contracts/simplex/SimplexResolver.sol/SimplexResolver.json',
    args: (a) => [a.ENSRegistry, a.SubnameRegistrar, a.ETHRegistrarController, zeroAddress],
    immutables: (a) => ({
      ens: a.ENSRegistry,
      nameWrapper: a.SubnameRegistrar,
      trustedETHController: a.ETHRegistrarController,
      trustedReverseRegistrar: zeroAddress,
    }),
  },
}

export const IMMUTABLE = {
  SimplexPriceOracle: {
    artifact: `contracts/${SIMPLEX_PRICE_ORACLE_ARTIFACT}`,
    args: (a, { chainlinkEthUsd }) => [chainlinkEthUsd, USD_FEED_DECIMALS, SIMPLEX_PRICE_BASE, SIMPLEX_PRICE_RUNGS],
  },
  SimplexSponsor: {
    artifact: 'contracts/simplex/SimplexSponsor.sol/SimplexSponsor.json',
    args: (a) => [a.ETHRegistrarController],
  },
  DummyGatewayProvider: {
    artifact: 'contracts/mocks/DummyGatewayProvider.sol/DummyGatewayProvider.json',
    args: () => [],
  },
  UniversalResolver: {
    artifact: 'contracts/universalResolver/UniversalResolver.sol/UniversalResolver.json',
    args: (a, { deployer }) => [deployer, a.ENSRegistry, a.DummyGatewayProvider],
  },
  MetadataRenderer: {
    artifact: 'contracts/simplex/MetadataRenderer.sol/MetadataRenderer.json',
    args: (a, { tld }) => [`.${tld}`],
  },
  Root: {
    artifact: 'contracts/root/Root.sol/Root.json',
    args: (a) => [a.ENSRegistry],
  },
}

/// L33: the deploy reads compiled artifacts, never sources, so an edit made
/// after the last compile would deploy the previous bytecode and the journal
/// would record it as a success. Rather than guess freshness from mtimes —
/// Hardhat caches on content, so a touched-but-unchanged file would block the
/// run forever — just compile. It is idempotent, it is the only thing that
/// actually guarantees the artifacts match the sources, and it fails the run on
/// a branch that does not build at all.
export function assertBuildFresh() {
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

export const artifact = (path) => JSON.parse(readFileSync(join(ARTIFACTS, path), 'utf8'))

export function constructorArgs(abi, args) {
  const inputs = abi.find(({ type }) => type === 'constructor')?.inputs ?? []
  return encodeAbiParameters(inputs, args)
}

export function initializerData(name, addresses, setup) {
  const { artifact: path, initialize } = UPGRADEABLE[name]
  return initialize
    ? encodeFunctionData({ abi: artifact(path).abi, functionName: 'initialize', args: initialize(addresses, setup) })
    : '0x'
}

export async function deployImmutable(deploy, name, addresses, setup) {
  const { abi, bytecode } = artifact(IMMUTABLE[name].artifact)
  return deploy(name, abi, bytecode, IMMUTABLE[name].args(addresses, setup))
}

export async function deployBehindProxy(deploy, name, addresses, setup, initialOwner) {
  const { abi, bytecode } = artifact(UPGRADEABLE[name].artifact)
  const implementation = await deploy(name, abi, bytecode, UPGRADEABLE[name].args(addresses, setup))
  const proxy = artifact(TRANSPARENT_PROXY)
  const deployed = await deploy(`${name}Proxy`, proxy.abi, proxy.bytecode, [
    implementation.address,
    initialOwner,
    initializerData(name, addresses, setup),
  ])
  return { ...deployed, abi, implementation: implementation.address }
}

export const proxyAdminOf = (proxy) => getContractAddress({ from: proxy, nonce: 1n })

export async function proxySlots(client, proxy) {
  const read = async (slot) => getAddress(`0x${(await client.getStorageAt({ address: proxy, slot })).slice(-40)}`)
  const [implementation, admin] = await Promise.all([read(ERC1967_IMPLEMENTATION_SLOT), read(ERC1967_ADMIN_SLOT)])
  return { implementation, admin }
}

const builds = new Map()

function build(buildInfoId) {
  if (!builds.has(buildInfoId)) {
    const { sources, contracts } = JSON.parse(
      readFileSync(join(ARTIFACTS, 'build-info', `${buildInfoId}.output.json`), 'utf8'),
    ).output
    const immutables = new Map()
    const visit = (node) => {
      if (Array.isArray(node)) node.forEach(visit)
      else if (node && typeof node === 'object') {
        if (node.nodeType === 'VariableDeclaration' && node.mutability === 'immutable') immutables.set(node.id, node.name)
        Object.values(node).forEach(visit)
      }
    }
    Object.values(sources).forEach(({ ast }) => visit(ast))
    const layouts = new Map(Object.entries(contracts).flatMap(([source, byName]) =>
      Object.entries(byName).map(([contractName, { storageLayout }]) => [`${source}:${contractName}`, storageLayout])))
    builds.set(buildInfoId, { immutables, layouts })
  }
  return builds.get(buildInfoId)
}

export function placeImmutables({ contractName, deployedBytecode, immutableReferences }, names, values) {
  const code = Buffer.from(deployedBytecode.slice(2), 'hex')
  const placed = Object.entries(immutableReferences).map(([id, references]) => {
    const name = names.get(Number(id))
    if (!Object.hasOwn(values, name)) throw new Error(`${contractName}: no expected value for its immutable ${name}`)
    const word = Buffer.from(pad(values[name]).slice(2), 'hex')
    for (const { start } of references) word.copy(code, start)
    return name
  })
  const unplaced = Object.keys(values).filter((name) => !placed.includes(name))
  if (unplaced.length) throw new Error(`${contractName}: no immutable named ${unplaced.join(', ')}`)
  return `0x${code.toString('hex')}`
}

export const runtimeCode = (compiled, values) => placeImmutables(compiled, build(compiled.buildInfoId).immutables, values)

export function canonicalLayout({ storage, types }) {
  const type = (id) => {
    const { label, encoding, numberOfBytes, members, key, value, base } = types[id]
    return {
      label,
      encoding,
      numberOfBytes,
      ...(members && { members: members.map(variable) }),
      ...(key && { key: type(key) }),
      ...(value && { value: type(value) }),
      ...(base && { base: type(base) }),
    }
  }
  const variable = ({ contract, label, slot, offset, type: id }) =>
    ({ contract: contract.split(':').at(-1), label, slot, offset, type: type(id) })
  return storage.map(variable)
}

export function storageLayout({ buildInfoId, inputSourceName, contractName }) {
  const layout = build(buildInfoId).layouts.get(`${inputSourceName}:${contractName}`)
  if (!layout) throw new Error(`${contractName}: the build output has no storageLayout; ens-contracts must request it from solc`)
  return canonicalLayout(layout)
}

export async function initializedVersion(client, address, compiled) {
  const { slot, offset } = storageLayout(compiled).find(({ label }) => label === '_initialized')
  const word = BigInt(await client.getStorageAt({ address, slot: toHex(BigInt(slot), { size: 32 }) }))
  return (word >> BigInt(8 * offset)) & 0xffn
}
