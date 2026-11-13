#!/usr/bin/env node
import {
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  labelhash,
  parseAbi,
  parseEther,
  parseGwei,
  toHex,
  zeroHash,
} from 'viem'
import { mainnet } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { execFileSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import {
  analyzeAndConfirm, createDryRunRunner, createWaitForBaseRunner,
  DEFAULTS, fundOnFork, spawnHardhatFork,
} from './gas-tools.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENS_CONTRACTS_DIR = join(REPO_ROOT, 'ens-contracts')
const addressesPath = join(REPO_ROOT, 'deployments.mainnet.simplex.json')
const verificationPath = join(REPO_ROOT, 'verification.mainnet.simplex.json')
const journalPath = join(REPO_ROOT, 'deployments.mainnet.simplex.holder-renewal.journal.jsonl')
const attemptsLogPath = join(REPO_ROOT, 'deployments.mainnet.simplex.holder-renewal.attempts.log')
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const YEAR = 365n * 86400n
const REHEARSAL_LABEL = 'holderrenewalrehearsal'
const REHEARSAL_HOLDER = getAddress('0x000000000000000000000000000000000000c0de')

const { DEPLOYER_KEY, MAINNET_RPC_URL, MAX_BASE_FEE_GWEI } = process.env
for (const [name, value] of Object.entries({ DEPLOYER_KEY, MAINNET_RPC_URL, MAX_BASE_FEE_GWEI })) {
  if (!value) {
    console.error(`${name} is required`)
    process.exit(1)
  }
}
const account = privateKeyToAccount(DEPLOYER_KEY)
const maxBaseFeeWei = parseGwei(MAX_BASE_FEE_GWEI)
const addresses = JSON.parse(readFileSync(addressesPath, 'utf8'))
const controller = getAddress(addresses.ETHRegistrarController)
const registrar = getAddress(addresses.BaseRegistrarImplementation)
const namePolicy = getAddress(addresses.SimplexNamePolicy)

execFileSync('npx', ['hardhat', 'compile'], { cwd: ENS_CONTRACTS_DIR, stdio: 'inherit' })
const artifact = (name) => JSON.parse(readFileSync(
  join(ENS_CONTRACTS_DIR, 'artifacts', 'contracts', 'simplex', `${name}.sol`, `${name}.json`),
  'utf8',
))
const CONTROLLER = artifact('SimplexController')
const POLICY = artifact('SimplexNamePolicy')
const SPONSOR = artifact('SimplexSponsor')
const controllerContract = {
  address: controller,
  abi: [...CONTROLLER.abi, ...POLICY.abi.filter((item) => item.type === 'error')],
}
const policyContract = { address: namePolicy, abi: POLICY.abi }
const registrarAbi = parseAbi(['function nameExpires(uint256) view returns (uint256)'])

const PRESERVED = [
  [controllerContract, 'owner'],
  [controllerContract, 'pendingOwner'],
  [controllerContract, 'beneficiary'],
  [controllerContract, 'frozen'],
  [controllerContract, 'publicSalesOpen'],
  [controllerContract, 'namePolicy'],
  [controllerContract, 'defaultResolver'],
  [controllerContract, 'prices'],
  [controllerContract, 'minCharLength'],
  [policyContract, 'generalTermsLink'],
  [policyContract, 'generalTermsHash'],
  [policyContract, 'communityTermsLink'],
  [policyContract, 'communityTermsHash'],
  [policyContract, 'reservedNames', [labelhash('simplex')]],
]

const snapshot = (client) => Promise.all(PRESERVED.map(([contract, functionName, args]) =>
  client.readContract({ ...contract, functionName, args }).then(String)))

const implementationOf = async (client, proxy) =>
  getAddress(`0x${(await client.getStorageAt({ address: proxy, slot: IMPLEMENTATION_SLOT })).slice(-40)}`)

async function deployContracts(deploy) {
  const policyImpl = await deploy('SimplexNamePolicyImpl', POLICY.abi, POLICY.bytecode, [controller, registrar])
  const controllerImpl = await deploy('SimplexControllerImpl', CONTROLLER.abi, CONTROLLER.bytecode)
  const sponsor = await deploy('SimplexSponsor', SPONSOR.abi, SPONSOR.bytecode, [controller])
  return {
    policyImpl: getAddress(policyImpl.address),
    controllerImpl: getAddress(controllerImpl.address),
    sponsor: getAddress(sponsor.address),
  }
}

const ownerCalls = ({ policyImpl, controllerImpl, sponsor }) => [
  [policyContract, 'upgradeTo', [policyImpl]],
  [controllerContract, 'upgradeTo', [controllerImpl]],
  [controllerContract, 'setSponsor', [sponsor]],
]

async function pendingOwnerCalls(client, deployed) {
  const current = [
    await implementationOf(client, namePolicy),
    await implementationOf(client, controller),
    getAddress(await client.readContract({ ...controllerContract, functionName: 'sponsor' })),
  ]
  return ownerCalls(deployed).filter(([, , [target]], i) => current[i] !== target)
}

async function check(client, before, deployed) {
  const after = await snapshot(client)
  const sponsorController = await client.readContract({
    address: deployed.sponsor, abi: SPONSOR.abi, functionName: 'controller',
  })
  const results = {
    'the three owner calls are in effect': (await pendingOwnerCalls(client, deployed)).length === 0,
    'the new sponsor serves the controller proxy': getAddress(sponsorController) === controller,
    ...Object.fromEntries(PRESERVED.map(([contract, functionName], i) => [
      `${functionName} on ${contract.address} is unchanged: ${after[i]}`,
      after[i] === before[i],
    ])),
  }
  return report(results)
}

function report(results) {
  for (const [what, ok] of Object.entries(results)) console.log(`  ${ok ? '✓' : '✗'} ${what}`)
  return Object.values(results).every(Boolean)
}

function forkSender(fork, client) {
  return async (from, contract, functionName, args, value) => {
    await client.request({ method: 'hardhat_impersonateAccount', params: [from] })
    const wallet = createWalletClient({ chain: client.chain, transport: http(fork.url), account: from })
    const hash = await wallet.writeContract({ ...contract, functionName, args, value })
    const receipt = await client.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`fork: ${functionName} from ${from} reverted`)
  }
}

async function rehearse(fork, client, send, { sponsor }) {
  const owner = await client.readContract({ ...controllerContract, functionName: 'owner' })
  const guardian = await client.readContract({ ...controllerContract, functionName: 'beneficiary' })
  for (const address of [owner, guardian, REHEARSAL_HOLDER])
    await fundOnFork({ forkUrl: fork.url, address, weiHex: toHex(parseEther('1000')) })
  const sponsorContract = { address: sponsor, abi: SPONSOR.abi }
  const id = BigInt(labelhash(REHEARSAL_LABEL))
  const renewal = [REHEARSAL_LABEL, YEAR, zeroHash]
  const terms = await client.readContract({ ...policyContract, functionName: 'generalTermsHash' })
  const expiry = () => client.readContract({
    address: registrar, abi: registrarAbi, functionName: 'nameExpires', args: [id],
  })
  const outcome = (from, value) => client
    .simulateContract({ ...controllerContract, functionName: 'renew', args: renewal, account: from, value })
    .then(() => 'succeeds', (e) => `reverts: ${
      e.walk((cause) => cause instanceof ContractFunctionRevertedError)?.data?.errorName ?? e.shortMessage}`)

  await send(owner, policyContract, 'addReservedNames', [[REHEARSAL_LABEL], 1])
  await send(owner, policyContract, 'registerReserved', [REHEARSAL_LABEL, REHEARSAL_HOLDER, 2n * YEAR])
  const registered = await expiry()
  const { base } = await client.readContract({
    ...controllerContract, functionName: 'rentPrice', args: [REHEARSAL_LABEL, YEAR],
  })
  await send(guardian, policyContract, 'acceptGeneralTermsForRenewal', [id, YEAR, terms])
  const nonHolder = await outcome(guardian, base)
  const unaccepted = await outcome(REHEARSAL_HOLDER, base)
  const results = {
    [`a renewal by a non-holder who accepted the terms ${nonHolder}`]: nonHolder.startsWith('reverts'),
    [`a renewal by the holder before an acceptance ${unaccepted}`]: unaccepted.startsWith('reverts'),
  }
  await send(REHEARSAL_HOLDER, policyContract, 'acceptGeneralTermsForRenewal', [id, YEAR, terms])
  await send(REHEARSAL_HOLDER, controllerContract, 'renew', renewal, base)
  await send(guardian, sponsorContract, 'setRegistrarAllowance', [guardian, parseEther('1000')])
  await send(REHEARSAL_HOLDER, policyContract, 'acceptGeneralTermsForRenewal', [id, YEAR, terms])
  await send(guardian, sponsorContract, 'renewWithCredit', [...renewal, REHEARSAL_HOLDER])
  results['the holder renews a year on the payable path and a year on the sponsored path'] =
    (await expiry()) - registered === 2n * YEAR
  return report(results)
}

function record({ policyImpl, controllerImpl, sponsor }) {
  const updated = {
    SimplexControllerImpl: controllerImpl.toLowerCase(),
    SimplexNamePolicyImpl: policyImpl.toLowerCase(),
    SimplexSponsor: sponsor.toLowerCase(),
  }
  writeFileSync(addressesPath, JSON.stringify({ ...addresses, ...updated }, null, 2))
  const verification = JSON.parse(readFileSync(verificationPath, 'utf8'))
  for (const [name, address] of Object.entries(updated)) verification.contracts[name].address = address
  writeFileSync(verificationPath, JSON.stringify(verification, null, 2))
  console.log(`Wrote ${addressesPath} and ${verificationPath}`)
}

async function main() {
  const fork = await spawnHardhatFork({
    mainnetRpcUrl: MAINNET_RPC_URL,
    port: parseInt(process.env.FORK_PORT || '18545', 10),
    ensContractsDir: ENS_CONTRACTS_DIR,
  })
  let dryTotals
  try {
    const client = createPublicClient({ chain: { ...mainnet, id: fork.chainId }, transport: http(fork.url) })
    const send = forkSender(fork, client)
    await fundOnFork({ forkUrl: fork.url, address: account.address, weiHex: toHex(parseEther('100')) })
    const dry = createDryRunRunner({ forkUrl: fork.url, forkChainId: fork.chainId, account })
    console.log('\n--- Rehearsal on a fork of mainnet ---')
    const before = await snapshot(client)
    const deployed = await deployContracts(dry.deploy)
    const owner = getAddress(await client.readContract({ ...controllerContract, functionName: 'owner' }))
    for (const [contract, functionName, args] of ownerCalls(deployed)) {
      if (owner === account.address) await dry.write(contract, functionName, args)
      else await send(owner, contract, functionName, args)
    }
    dryTotals = dry.totals()
    const upgraded = await check(client, before, deployed)
    const renewed = await rehearse(fork, client, send, deployed)
    if (!upgraded || !renewed) throw new Error('rehearsal failed: nothing was sent to mainnet')
    console.log('  rehearsal passed')
  } finally {
    fork.stop()
  }

  const transport = http(MAINNET_RPC_URL)
  const publicClient = createPublicClient({ chain: mainnet, transport })
  const walletClient = createWalletClient({ chain: mainnet, transport, account })
  if ((await publicClient.getChainId()) !== mainnet.id) {
    console.error('MAINNET_RPC_URL is not mainnet')
    process.exit(1)
  }
  await analyzeAndConfirm({
    publicClient, account, maxBaseFeeWei, dryRunTotals: dryTotals, journalPath,
    label: '.simplex holder-renewal upgrade', bumpAfterMs: DEFAULTS.BUMP_AFTER_MS, bumpPct: DEFAULTS.BUMP_PCT,
  })
  const real = createWaitForBaseRunner({
    publicClient, walletClient, account, maxBaseFeeWei,
    bumpAfterMs: DEFAULTS.BUMP_AFTER_MS, bumpPct: DEFAULTS.BUMP_PCT, journalPath, attemptsLogPath,
  })
  const before = await snapshot(publicClient)
  const deployed = await deployContracts(real.deploy)
  const owner = getAddress(await publicClient.readContract({ ...controllerContract, functionName: 'owner' }))
  if (owner === account.address) for (const call of ownerCalls(deployed)) await real.write(...call)
  const pending = await pendingOwnerCalls(publicClient, deployed)
  if (pending.length) {
    console.log(`\nThe controller owner ${owner} submits, in this order:`)
    for (const [contract, functionName, [target]] of pending)
      console.log(`  ${functionName}(${target}) on ${contract.address}`)
    console.log('Then run this script again: it checks the upgrade and records the addresses.')
    return
  }
  console.log('\n--- Mainnet read-back ---')
  if (!(await check(publicClient, before, deployed))) {
    process.exitCode = 1
    return
  }
  record(deployed)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
