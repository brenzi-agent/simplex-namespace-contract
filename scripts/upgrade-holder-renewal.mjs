#!/usr/bin/env node
import {
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  encodeFunctionData,
  getAddress,
  http,
  labelhash,
  parseAbi,
  parseEther,
  parseGwei,
  toHex,
  zeroAddress,
  zeroHash,
} from 'viem'
import { mainnet } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { execFileSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
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
const beforePath = join(REPO_ROOT, 'deployments.mainnet.simplex.holder-renewal.before.json')
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
const registrarAbi = parseAbi([
  'function nameExpires(uint256) view returns (uint256)',
  'function owner() view returns (address)',
])

const PRESERVED = [
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

const read = (client, contract, functionName) => client.readContract({ ...contract, functionName })

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
  [controllerContract, 'upgradeToAndCall', [
    controllerImpl,
    encodeFunctionData({ abi: CONTROLLER.abi, functionName: 'setSponsor', args: [sponsor] }),
  ]],
]

async function pendingOwnerCalls(client, deployed) {
  const done = [
    (await implementationOf(client, namePolicy)) === deployed.policyImpl,
    (await implementationOf(client, controller)) === deployed.controllerImpl &&
      getAddress(await read(client, controllerContract, 'sponsor')) === deployed.sponsor,
  ]
  return ownerCalls(deployed).filter((_, i) => !done[i])
}

async function check(client, before, deployed) {
  const after = await snapshot(client)
  const sponsorController = await read(client, { address: deployed.sponsor, abi: SPONSOR.abi }, 'controller')
  return report({
    'both owner calls are in effect': (await pendingOwnerCalls(client, deployed)).length === 0,
    'the new sponsor serves the controller proxy': getAddress(sponsorController) === controller,
    ...Object.fromEntries(PRESERVED.map(([contract, functionName], i) => [
      `${functionName} on ${contract.address} is unchanged: ${after[i]}`,
      after[i] === before[i],
    ])),
  })
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

async function rehearse(fork, client, send, { sponsor }, { owner, guardian }) {
  await fundOnFork({ forkUrl: fork.url, address: REHEARSAL_HOLDER, weiHex: toHex(parseEther('1000')) })
  const sponsorContract = { address: sponsor, abi: SPONSOR.abi }
  const id = BigInt(labelhash(REHEARSAL_LABEL))
  const renewal = [REHEARSAL_LABEL, YEAR, zeroHash]
  const terms = await read(client, policyContract, 'generalTermsHash')
  const expiry = () => client.readContract({
    address: registrar, abi: registrarAbi, functionName: 'nameExpires', args: [id],
  })
  const renewOutcome = async (from, value) => {
    const trace = await client.request({
      method: 'debug_traceCall',
      params: [
        {
          from,
          to: controller,
          value: toHex(value),
          data: encodeFunctionData({ abi: CONTROLLER.abi, functionName: 'renew', args: renewal }),
        },
        'latest',
        { disableStack: true, disableMemory: true, disableStorage: true },
      ],
    })
    if (!trace.failed) return 'succeeds'
    const data = `0x${trace.returnValue.replace(/^0x/, '')}`
    try {
      return `reverts ${decodeErrorResult({ abi: controllerContract.abi, data }).errorName}`
    } catch {
      return `reverts with undecoded data ${data}`
    }
  }

  await send(owner, policyContract, 'addReservedNames', [[REHEARSAL_LABEL], 1])
  await send(owner, policyContract, 'registerReserved', [REHEARSAL_LABEL, REHEARSAL_HOLDER, 2n * YEAR])
  const registered = await expiry()
  const { base } = await client.readContract({
    ...controllerContract, functionName: 'rentPrice', args: [REHEARSAL_LABEL, YEAR],
  })
  await send(guardian, policyContract, 'acceptGeneralTermsForRenewal', [id, YEAR, terms])
  const nonHolder = await renewOutcome(guardian, base)
  const unaccepted = await renewOutcome(REHEARSAL_HOLDER, base)
  await send(REHEARSAL_HOLDER, policyContract, 'acceptGeneralTermsForRenewal', [id, YEAR, terms])
  const accepted = await renewOutcome(REHEARSAL_HOLDER, base)
  await send(REHEARSAL_HOLDER, controllerContract, 'renew', renewal, base)
  await send(guardian, sponsorContract, 'setRegistrarAllowance', [guardian, parseEther('1000')])
  await send(REHEARSAL_HOLDER, policyContract, 'acceptGeneralTermsForRenewal', [id, YEAR, terms])
  await send(guardian, sponsorContract, 'renewWithCredit', [...renewal, REHEARSAL_HOLDER])
  return report({
    [`a non-holder who accepted the terms renews: ${nonHolder}`]: nonHolder === 'reverts NotHolder',
    [`the holder renews before an acceptance: ${unaccepted}`]: unaccepted === 'reverts TermsNotAccepted',
    [`the holder renews after an acceptance: ${accepted}`]: accepted === 'succeeds',
    'the holder renews a year on the payable path and a year on the sponsored path':
      (await expiry()) - registered === 2n * YEAR,
  })
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
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    fork.stop()
    process.exit(1)
  })
  let dryTotals
  try {
    const client = createPublicClient({ chain: { ...mainnet, id: fork.chainId }, transport: http(fork.url) })
    const send = forkSender(fork, client)
    const keys = {
      owner: await read(client, controllerContract, 'owner'),
      guardian: await read(client, controllerContract, 'beneficiary'),
    }
    for (const address of [account.address, keys.owner, keys.guardian])
      await fundOnFork({ forkUrl: fork.url, address, weiHex: toHex(parseEther('1000')) })
    const dry = createDryRunRunner({ forkUrl: fork.url, forkChainId: fork.chainId, account })
    console.log('\n--- Rehearsal on a fork of mainnet ---')
    const before = await snapshot(client)
    const deployed = await deployContracts(dry.deploy)
    dryTotals = dry.totals()
    for (const [contract, functionName, args] of ownerCalls(deployed))
      await send(keys.owner, contract, functionName, args)
    const upgraded = await check(client, before, deployed)
    const renewed = await rehearse(fork, client, send, deployed, keys)
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
  const owner = await read(publicClient, controllerContract, 'owner')
  const registrarOwner = await read(publicClient, { address: registrar, abi: registrarAbi }, 'owner')
  if ((await read(publicClient, controllerContract, 'pendingOwner')) !== zeroAddress || registrarOwner !== owner) {
    console.error('The ownership handover is not complete: run deploy-mainnet.mjs again from tag simplex-mainnet-v1 first.')
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
  const deployed = await deployContracts(real.deploy)
  const pending = await pendingOwnerCalls(publicClient, deployed)
  if (pending.length) {
    if (!existsSync(beforePath)) writeFileSync(beforePath, JSON.stringify(await snapshot(publicClient), null, 2))
    console.log(`\nThe controller owner ${owner} submits, in this order:`)
    for (const [contract, functionName, args] of pending) {
      console.log(`  to ${contract.address}: ${functionName}(${args.join(', ')})`)
      console.log(`    calldata ${encodeFunctionData({ abi: contract.abi, functionName, args })}`)
    }
    console.log(`Then run this script again: it compares the result with ${beforePath} and records the addresses.`)
    return
  }
  if (!existsSync(beforePath)) {
    console.error(`${beforePath} is missing: the run that printed the owner's calls saves it.`)
    process.exit(1)
  }
  console.log('\n--- Mainnet read-back ---')
  if (!(await check(publicClient, JSON.parse(readFileSync(beforePath, 'utf8')), deployed))) {
    process.exitCode = 1
    return
  }
  record(deployed)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
