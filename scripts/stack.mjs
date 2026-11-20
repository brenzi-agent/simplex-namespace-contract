import {
  createPublicClient, encodeAbiParameters, encodeFunctionData, getAddress, getContractAddress, http, keccak256, namehash,
  pad, parseAbi, toBytes, toEventSelector, toFunctionSelector, toHex, zeroAddress,
} from 'viem'
import { formatAbiItem, formatAbiParams } from 'viem/utils'
import { mainnet } from 'viem/chains'
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

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const ENS_CONTRACTS_DIR = join(REPO_ROOT, 'ens-contracts')
const ARTIFACTS = join(ENS_CONTRACTS_DIR, 'artifacts')

export const TLD = 'simplex'
export const SOURCE_TAG = 'simplex-mainnet-v2'
export const ADDRESSES_PATH = join(REPO_ROOT, `deployments.mainnet.${TLD}.json`)
export const JOURNAL_PATH = join(REPO_ROOT, `deployments.mainnet.${TLD}.journal.jsonl`)
export const VERIFICATION_PATH = join(REPO_ROOT, `verification.mainnet.${TLD}.json`)

export const ERC1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
export const ERC1967_ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103'
export const TRANSPARENT_PROXY = '@openzeppelin/contracts-v5/proxy/transparent/TransparentUpgradeableProxy.sol/TransparentUpgradeableProxy.json'
export const PROXY_ADMIN_ARTIFACT = '@openzeppelin/contracts-v5/proxy/transparent/ProxyAdmin.sol/ProxyAdmin.json'
export const PROXY_ADMIN_ABI = parseAbi([
  'function owner() view returns (address)',
  'function renounceOwnership()',
  'function transferOwnership(address newOwner)',
  'function upgradeAndCall(address proxy, address implementation, bytes data) payable',
])
export const V1_ABI = parseAbi([
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function controllers(address) view returns (bool)',
  'function addController(address)',
  'function removeController(address)',
  'function transferOwnership(address)',
  'function acceptOwnership()',
])

export function requireEnv(name, hint = '') {
  const value = process.env[name]
  if (!value) {
    console.error(`ERROR: ${name} env var is required.${hint}`)
    process.exit(1)
  }
  return value
}

export const sortedAddresses = (list) => list.map((address) => getAddress(address)).sort()

export const childEnv = (variables = {}) => ({ PATH: process.env.PATH, HOME: process.env.HOME, ...variables })

export function causes(error) {
  if (error === undefined) return []
  if (!(error instanceof Error)) return [String(error)]
  const code = error.code === undefined ? '' : ` ${error.code}`
  return [`${error.name}${code}: ${error.shortMessage ?? error.message}`, ...causes(error.cause)]
}

export const refusal = (failures, fields = {}) => ({ refused: true, failures, ...fields })
export const accepted = (fields) => ({ refused: false, ...fields })

function checksumInput(json) {
  if (Array.isArray(json)) return `[${json.map(checksumInput).join(',')}]`
  if (typeof json === 'object' && json !== null) {
    const keys = Object.keys(json).sort()
    return `{${JSON.stringify(keys)}${keys.map((key) => `${checksumInput(json[key])},`).join('')}}`
  }
  return JSON.stringify(json === undefined ? null : json)
}

export const batchChecksum = (batch) => keccak256(toBytes(checksumInput({ ...batch, meta: { ...batch.meta, name: null } })))

export function safeBatch({ safe, transactions, name, description, createdAt = Date.now() }) {
  const batch = {
    version: '1.0',
    chainId: '1',
    createdAt,
    meta: { name, description, createdFromSafeAddress: safe, createdFromOwnerAddress: '' },
    transactions: transactions.map(({ to, data }) => ({ to, value: '0', data })),
  }
  return { ...batch, meta: { ...batch.meta, checksum: batchChecksum(batch) } }
}

export const addressAt = async (client, address, slot) =>
  getAddress(`0x${(await client.getStorageAt({ address, slot })).slice(-40)}`)

const LOG_RANGE = 10_000n

export async function logsSince(client, filter, fromBlock) {
  const head = await client.getBlockNumber()
  const logs = []
  for (let from = fromBlock; from <= head; from += LOG_RANGE) {
    const to = from + LOG_RANGE - 1n < head ? from + LOG_RANGE - 1n : head
    logs.push(...(await client.getLogs({ ...filter, fromBlock: from, toBlock: to })))
  }
  return logs
}

export async function mainnetClient(rpcUrl) {
  const client = createPublicClient({ chain: mainnet, transport: http(rpcUrl) })
  const liveChainId = await client.getChainId()
  if (liveChainId !== mainnet.id) {
    console.error(`MAINNET_RPC_URL is chainId ${liveChainId}, expected ${mainnet.id}. Refusing to run.`)
    process.exit(1)
  }
  return client
}

const UNSAFE_CALL_GAS = 50_000n

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
    ownImmutables: ['_self'],
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
    ownImmutables: ['_deployer'],
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
  SimplexSponsor: {
    key: 'SimplexSponsor',
    artifact: 'contracts/simplex/SimplexSponsor.sol/SimplexSponsor.json',
    args: (a) => [a.ETHRegistrarController],
    immutables: (a) => ({ controller: a.ETHRegistrarController }),
  },
  UniversalResolver: {
    key: 'UniversalResolver',
    artifact: 'contracts/universalResolver/UniversalResolver.sol/UniversalResolver.json',
    args: (a, { deployer }) => [deployer, a.ENSRegistry, a.DummyGatewayProvider],
    immutables: (a) => ({
      registry: a.ENSRegistry,
      batchGatewayProvider: a.DummyGatewayProvider,
      unsafeCallGas: toHex(UNSAFE_CALL_GAS),
    }),
  },
}

export const IMMUTABLE = {
  SimplexPriceOracle: {
    artifact: `contracts/${SIMPLEX_PRICE_ORACLE_ARTIFACT}`,
    args: (a, { chainlinkEthUsd }) => [chainlinkEthUsd, USD_FEED_DECIMALS, SIMPLEX_PRICE_BASE, SIMPLEX_PRICE_RUNGS],
  },
  DummyGatewayProvider: {
    artifact: 'contracts/mocks/DummyGatewayProvider.sol/DummyGatewayProvider.json',
    args: () => [],
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

export function assertBuildFresh() {
  console.log('Compiling contracts (artifacts must match sources) …')
  try {
    execFileSync('npx', ['hardhat', 'compile'], {
      cwd: ENS_CONTRACTS_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      env: childEnv(),
    })
  } catch (e) {
    console.error('`npx hardhat compile` failed — refusing to deploy.\n')
    console.error(e.stdout || '')
    console.error(e.stderr || '')
    process.exit(1)
  }
  console.log('  build is current')
}

export const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: childEnv() }).trim()

export const ensContractsHead = () => git(ENS_CONTRACTS_DIR, 'rev-parse', 'HEAD')

export function assertTaggedSource(tag) {
  const commit = ensContractsHead()
  const tags = git(ENS_CONTRACTS_DIR, 'tag', '--points-at', 'HEAD').split('\n').filter(Boolean)
  if (tag ? !tags.includes(tag) : tags.length === 0) {
    console.error(`ens-contracts is at ${commit}, which ${tag ? `the tag ${tag} does not name` : 'no tag names'}: check out the tagged commit to deploy, and fetch its tag.`)
    process.exit(1)
  }
  const pinned = tag && git(REPO_ROOT, 'ls-tree', 'HEAD', 'ens-contracts').split(/\s+/)[2]
  if (pinned && commit !== pinned) {
    console.error(`ens-contracts is at ${commit}, but the parent repository pins ${pinned}: deploy the pinned commit.`)
    process.exit(1)
  }
  const changes = git(ENS_CONTRACTS_DIR, 'status', '--porcelain')
  if (changes) {
    console.error(`ens-contracts has changes outside the commit ${commit}:\n${changes}`)
    process.exit(1)
  }
  return { commit, tags }
}

export const parentHead = () => git(REPO_ROOT, 'rev-parse', 'HEAD')

export const uncommitted = (paths) => git(REPO_ROOT, 'status', '--porcelain', '--', ...paths)

export function assertCommitted(paths) {
  const changes = uncommitted(paths)
  if (changes) {
    console.error(`the parent repository has changes outside the commit ${parentHead()} in ${paths.join(', ')}:\n${changes}`)
    process.exit(1)
  }
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

const functionShape = ({ name, inputs, outputs, stateMutability }) =>
  `${name}(${formatAbiParams(inputs)}) ${stateMutability} returns (${formatAbiParams(outputs)})`
const eventShape = ({ name, inputs, anonymous }) =>
  `${name}(${inputs.map((input) => `${formatAbiParams([input])}${input.indexed ? ' indexed' : ''}`).join(',')})${anonymous ? ' anonymous' : ''}`

export function interfaceOf(abi) {
  const shapes = (type, selector, shape) =>
    Object.fromEntries(abi.filter((item) => item.type === type).map((item) => [selector(item), shape(item)]))
  return {
    functions: shapes('function', toFunctionSelector, functionShape),
    events: shapes('event', toEventSelector, eventShape),
    errors: shapes('error', (item) => toFunctionSelector(formatAbiItem(item)), formatAbiItem),
  }
}

export async function proxySlots(client, proxy) {
  const [implementation, admin] = await Promise.all([
    addressAt(client, proxy, ERC1967_IMPLEMENTATION_SLOT),
    addressAt(client, proxy, ERC1967_ADMIN_SLOT),
  ])
  return { implementation, admin }
}

const builds = new Map()

function build(buildInfoId) {
  if (!builds.has(buildInfoId)) {
    const { sources, contracts } = JSON.parse(
      readFileSync(join(ARTIFACTS, 'build-info', `${buildInfoId}.output.json`), 'utf8'),
    ).output
    const immutables = new Map()
    const contractNames = new Map()
    const scopes = new Map()
    const enumDefinitions = new Map()
    const visit = (node) => {
      if (Array.isArray(node)) node.forEach(visit)
      else if (node && typeof node === 'object') {
        if (node.nodeType === 'ContractDefinition') contractNames.set(node.id, node.name)
        if (node.nodeType === 'EnumDefinition') enumDefinitions.set(node.id, node.members.map(({ name }) => name))
        if (node.nodeType === 'VariableDeclaration' && node.mutability === 'immutable') immutables.set(node.id, node.name)
        if (node.nodeType === 'VariableDeclaration' && node.stateVariable) scopes.set(node.id, node.scope)
        Object.values(node).forEach(visit)
      }
    }
    Object.values(sources).forEach(({ ast }) => visit(ast))
    const layouts = new Map(Object.entries(contracts).flatMap(([source, byName]) =>
      Object.entries(byName).map(([contractName, { storageLayout }]) => [`${source}:${contractName}`, storageLayout])))
    const declaringContract = (astId) => {
      const name = contractNames.get(scopes.get(astId))
      if (!name) throw new Error(`build ${buildInfoId}: no contract declares the state variable ${astId}`)
      return name
    }
    const enumValues = (typeId) => {
      const enumId = /^t_enum\(.*\)(\d+)$/.exec(typeId)?.[1]
      if (enumId === undefined) return undefined
      const values = enumDefinitions.get(Number(enumId))
      if (!values) throw new Error(`build ${buildInfoId}: no enum definition for the type ${typeId}`)
      return values
    }
    builds.set(buildInfoId, { immutables, layouts, declaringContract, enumValues })
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

export const immutableNames = ({ buildInfoId }) => build(buildInfoId).immutables

export const runtimeCode = (compiled, values) => placeImmutables(compiled, immutableNames(compiled), values)

export function immutablesIn({ immutableReferences }, names, code) {
  const bytes = Buffer.from(code.slice(2), 'hex')
  return Object.fromEntries(Object.entries(immutableReferences).map(([id, [{ start, length }]]) =>
    [names.get(Number(id)), `0x${bytes.subarray(start, start + length).toString('hex')}`]))
}

function canonicalLayout({ storage, types }, { declaringContract, enumValues }) {
  const type = (id) => {
    const { label, encoding, numberOfBytes, members, key, value, base } = types[id]
    const values = enumValues(id)
    return {
      label,
      encoding,
      numberOfBytes,
      ...(values && { enumValues: values }),
      ...(members && { members: members.map(member) }),
      ...(key && { key: type(key) }),
      ...(value && { value: type(value) }),
      ...(base && { base: type(base) }),
    }
  }
  const member = ({ label, slot, offset, type: id }) => ({ label, slot, offset, type: type(id) })
  return storage.map(({ astId, label, slot, offset, type: id }) =>
    ({ contract: declaringContract(astId), label, slot, offset, type: type(id) }))
}

export function storageLayout({ buildInfoId, inputSourceName, contractName }) {
  const { layouts, declaringContract, enumValues } = build(buildInfoId)
  const layout = layouts.get(`${inputSourceName}:${contractName}`)
  if (!layout) throw new Error(`${contractName}: the build output has no storageLayout; ens-contracts must request it from solc`)
  return canonicalLayout(layout, { declaringContract, enumValues })
}

export async function storedValue(client, address, compiled, label) {
  const { slot, offset, type } = storageLayout(compiled).find((variable) => variable.label === label)
  const word = BigInt(await client.getStorageAt({ address, slot: toHex(BigInt(slot), { size: 32 }) }))
  return (word >> BigInt(8 * offset)) & ((1n << BigInt(8 * Number(type.numberOfBytes))) - 1n)
}
