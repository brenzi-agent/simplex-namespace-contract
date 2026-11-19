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
  parseEventLogs,
  parseGwei,
  toHex,
  zeroAddress,
  zeroHash,
} from 'viem'
import { mainnet } from 'viem/chains'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { execFileSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import {
  analyzeAndConfirm, createDryRunRunner, createWaitForBaseRunner,
  DEFAULTS, fundOnFork, loadJournal, spawnHardhatFork,
} from './gas-tools.mjs'
import { assembleVerification } from './build-verification.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENS_CONTRACTS_DIR = join(REPO_ROOT, 'ens-contracts')
const addressesPath = join(REPO_ROOT, 'deployments.mainnet.simplex.json')
const verificationPath = join(REPO_ROOT, 'verification.mainnet.simplex.json')
const journalPath = join(REPO_ROOT, 'deployments.mainnet.simplex.payment-reversal.journal.jsonl')
const attemptsLogPath = join(REPO_ROOT, 'deployments.mainnet.simplex.payment-reversal.attempts.log')
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const DAY = 86400n
const YEAR = 365n * DAY
const REVERSIBLE_DAYS = 180n
const SETTLEMENT_WINDOW = 30n * DAY
const [REVERSED_LABEL, SETTLED_LABEL] = ['reversed', 'settled'].map((use) => `card${use}${Date.now().toString(36)}`)
const REHEARSAL_HOLDER = privateKeyToAccount(generatePrivateKey())
const REHEARSAL_REGISTRAR = getAddress('0x000000000000000000000000000000000000c0de')
const REHEARSAL_RECIPIENT = getAddress('0x000000000000000000000000000000000000beef')
const VERIFIED = ['SimplexSettlementImpl', 'SimplexSettlementProxy', 'SimplexControllerImpl', 'SimplexNamePolicyImpl', 'SimplexSponsor']
const CALLERS = { registrarOwner: 'registrar owner', controllerOwner: 'controller owner' }
const INTENTS = {
  RegisterName: [
    { name: 'label', type: 'string' },
    { name: 'owner', type: 'address' },
    { name: 'duration', type: 'uint256' },
    { name: 'resolver', type: 'address' },
    { name: 'data', type: 'bytes[]' },
    { name: 'reversibleDays', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  RenewName: [
    { name: 'label', type: 'string' },
    { name: 'holder', type: 'address' },
    { name: 'duration', type: 'uint256' },
    { name: 'reversibleDays', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
}

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
const verification = JSON.parse(readFileSync(verificationPath, 'utf8'))
const controller = getAddress(addresses.ETHRegistrarController)
const registrar = getAddress(addresses.BaseRegistrarImplementation)
const namePolicy = getAddress(addresses.SimplexNamePolicy)

execFileSync('npx', ['hardhat', 'compile'], { cwd: ENS_CONTRACTS_DIR, stdio: 'inherit' })
const build = (...path) => JSON.parse(readFileSync(join(ENS_CONTRACTS_DIR, ...path), 'utf8'))
const artifact = (dir, name) => build('artifacts', 'contracts', dir, `${name}.sol`, `${name}.json`)
const CONTROLLER = artifact('simplex', 'SimplexController')
const POLICY = artifact('simplex', 'SimplexNamePolicy')
const SPONSOR = artifact('simplex', 'SimplexSponsor')
const SETTLEMENT = artifact('simplex', 'SimplexSettlement')
const SETTLEMENT_PROXY = artifact('simplex', 'SimplexSettlementProxy')
const REGISTRAR = artifact('ethregistrar', 'BaseRegistrarImplementation')
const PREVIOUS_CONTROLLER = build('test', 'simplex', 'fixtures', 'builds', '7ff8c37', 'SimplexController.json')
const ERRORS = [CONTROLLER, POLICY, SPONSOR, SETTLEMENT, REGISTRAR]
  .flatMap(({ abi }) => abi.filter((item) => item.type === 'error'))
const withErrors = (address, { abi }) => ({ address, abi: [...abi, ...ERRORS] })
const controllerContract = withErrors(controller, CONTROLLER)
const policyContract = withErrors(namePolicy, POLICY)
const registrarContract = withErrors(registrar, REGISTRAR)
const registryContract = {
  address: getAddress(addresses.ENSRegistry),
  abi: parseAbi(['function owner(bytes32) view returns (address)']),
}

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

const runtimeOf = async (client, address) =>
  (await client.getCode({ address })).toLowerCase().replaceAll(address.slice(2).toLowerCase(), '')

const read = (client, contract, functionName, args) => client.readContract({ ...contract, functionName, args })

const ownersOf = async (client) => ({
  registrarOwner: await read(client, registrarContract, 'owner'),
  controllerOwner: await read(client, controllerContract, 'owner'),
  guardian: await read(client, controllerContract, 'beneficiary'),
})

async function deployedRollback(client, previousRuntime) {
  const candidates = [
    await implementationOf(client, controller),
    addresses.SimplexControllerImpl,
    addresses.SimplexControllerRollbackImpl,
  ]
  for (const candidate of candidates.filter(Boolean).map((address) => getAddress(address)))
    if ((await runtimeOf(client, candidate)) === previousRuntime) return candidate
}

async function deployContracts(deploy, rollbackImpl) {
  const settlementImpl = await deploy('SimplexSettlementImpl', SETTLEMENT.abi, SETTLEMENT.bytecode, [controller, registrar])
  const settlementProxy = await deploy('SimplexSettlementProxy', SETTLEMENT_PROXY.abi, SETTLEMENT_PROXY.bytecode, [settlementImpl.address, '0x'])
  const controllerImpl = await deploy('SimplexControllerImpl', CONTROLLER.abi, CONTROLLER.bytecode)
  const policyImpl = await deploy('SimplexNamePolicyImpl', POLICY.abi, POLICY.bytecode, [controller, registrar, settlementProxy.address])
  const sponsor = await deploy('SimplexSponsor', SPONSOR.abi, SPONSOR.bytecode, [controller])
  const rollback = rollbackImpl ??
    (await deploy('SimplexControllerRollbackImpl', PREVIOUS_CONTROLLER.abi, PREVIOUS_CONTROLLER.bytecode)).address
  return {
    settlementImpl: getAddress(settlementImpl.address),
    settlementProxy: getAddress(settlementProxy.address),
    controllerImpl: getAddress(controllerImpl.address),
    policyImpl: getAddress(policyImpl.address),
    sponsor: getAddress(sponsor.address),
    rollbackImpl: getAddress(rollback),
  }
}

const resumed = (deploy, journal) => (name, abi, bytecode, args) =>
  journal.get(`deploy:${name}`) ?? deploy(name, abi, bytecode, args)

const ownerCalls = ({ settlementProxy, policyImpl, controllerImpl, sponsor }) => [
  { step: 2, caller: 'registrarOwner', contract: registrarContract, functionName: 'addController', args: [settlementProxy] },
  { step: 3, caller: 'controllerOwner', contract: policyContract, functionName: 'upgradeTo', args: [policyImpl] },
  {
    step: 7,
    caller: 'controllerOwner',
    contract: controllerContract,
    functionName: 'upgradeToAndCall',
    args: [controllerImpl, encodeFunctionData({ abi: CONTROLLER.abi, functionName: 'setSponsor', args: [sponsor] })],
  },
]

async function pendingOwnerCalls(client, deployed) {
  const done = [
    await read(client, registrarContract, 'controllers', [deployed.settlementProxy]),
    (await implementationOf(client, namePolicy)) === deployed.policyImpl,
    (await implementationOf(client, controller)) === deployed.controllerImpl &&
      (await read(client, controllerContract, 'sponsor')) === deployed.sponsor,
  ]
  return ownerCalls(deployed).filter((_, i) => !done[i])
}

async function checkUpgrade(client, deployed, previousRuntime, more = {}) {
  const sponsorContract = withErrors(deployed.sponsor, SPONSOR)
  const settlementContract = withErrors(deployed.settlementProxy, SETTLEMENT)
  return report({
    'the three owner calls are in effect': (await pendingOwnerCalls(client, deployed)).length === 0,
    'controller.sponsor() is the new sponsor, whose controller() is the controller proxy':
      (await read(client, controllerContract, 'sponsor')) === deployed.sponsor &&
      (await read(client, sponsorContract, 'controller')) === controller,
    'namePolicy.settlement() is the settlement proxy, whose controller() and registrar() are the controller proxy and the registrar':
      (await read(client, policyContract, 'settlement')) === deployed.settlementProxy &&
      (await read(client, settlementContract, 'controller')) === controller &&
      (await read(client, settlementContract, 'registrar')) === registrar,
    "the settlement proxy's implementation slot holds the deployed SimplexSettlement":
      (await implementationOf(client, deployed.settlementProxy)) === deployed.settlementImpl,
    'registrar.controllers(settlement proxy) is true':
      await read(client, registrarContract, 'controllers', [deployed.settlementProxy]),
    'MAX_REVERSIBLE_DAYS() is 180 and SETTLEMENT_WINDOW() 2,592,000':
      (await read(client, settlementContract, 'MAX_REVERSIBLE_DAYS')) === REVERSIBLE_DAYS &&
      (await read(client, settlementContract, 'SETTLEMENT_WINDOW')) === SETTLEMENT_WINDOW,
    [`the rollback implementation ${deployed.rollbackImpl} is the #49 controller build`]:
      (await runtimeOf(client, deployed.rollbackImpl)) === previousRuntime,
    ...more,
  })
}

function report(results) {
  for (const [what, ok] of Object.entries(results)) console.log(`  ${ok ? '✓' : '✗'} ${what}`)
  return Object.values(results).every(Boolean)
}

function forkActions(fork, client) {
  const walletOf = async (from) => {
    await client.request({ method: 'hardhat_impersonateAccount', params: [from] })
    return createWalletClient({ chain: client.chain, transport: http(fork.url), account: from })
  }
  const included = async (hash, what) => {
    const receipt = await client.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`fork: ${what} reverted`)
    return receipt
  }
  return {
    send: async (from, contract, functionName, args, value) => {
      const wallet = await walletOf(from)
      return included(await wallet.writeContract({ ...contract, functionName, args, value }), `${functionName} from ${from}`)
    },
    deploy: async (from, { abi, bytecode }) => {
      const wallet = await walletOf(from)
      const receipt = await included(await wallet.deployContract({ abi, bytecode }), `a deployment from ${from}`)
      return getAddress(receipt.contractAddress)
    },
  }
}

async function outcome(client, from, contract, functionName, args, value = 0n) {
  const trace = await client.request({
    method: 'debug_traceCall',
    params: [
      { from, to: contract.address, value: toHex(value), data: encodeFunctionData({ abi: contract.abi, functionName, args }) },
      'latest',
      { disableStack: true, disableMemory: true, disableStorage: true },
    ],
  })
  if (!trace.failed) return 'succeeds'
  const data = `0x${trace.returnValue.replace(/^0x/, '')}`
  try {
    return `reverts ${decodeErrorResult({ abi: ERRORS, data }).errorName}`
  } catch {
    return `reverts with undecoded data ${data}`
  }
}

async function rehearse(fork, client, send, { sponsor, settlementProxy }, { controllerOwner, guardian }) {
  const holder = REHEARSAL_HOLDER.address
  const sponsorContract = withErrors(sponsor, SPONSOR)
  const settlementContract = withErrors(settlementProxy, SETTLEMENT)
  const terms = await read(client, policyContract, 'generalTermsHash')
  const id = (label) => BigInt(labelhash(label))
  const expiry = (label) => read(client, registrarContract, 'nameExpires', [id(label)])
  const payment = (label) => read(client, settlementContract, 'reversiblePayment', [id(label)])
  const skipped = (receipt, eventName) => parseEventLogs({ abi: SETTLEMENT.abi, eventName, logs: receipt.logs })
    .filter((log) => getAddress(log.address) === settlementProxy)
    .map((log) => log.args.label)
  const now = async () => (await client.getBlock()).timestamp
  const mineAt = (timestamp) => client.request({ method: 'evm_mine', params: [toHex(timestamp)] })
  const signed = async (primaryType, message) => {
    const nonce = await read(client, sponsorContract, 'nonces', [holder])
    const deadline = (await now()) + DAY
    const sig = await REHEARSAL_HOLDER.signTypedData({
      domain: { name: 'SimplexSponsor', version: '1', chainId: fork.chainId, verifyingContract: sponsor },
      types: INTENTS,
      primaryType,
      message: { ...message, nonce, deadline },
    })
    return [nonce, deadline, sig]
  }
  const acceptRenewal = async (label) =>
    send(holder, policyContract, 'acceptGeneralTermsForRenewal', [id(label), await expiry(label), YEAR, terms])
  const renewArgs = [REVERSED_LABEL, YEAR, zeroHash]

  const registrations = [REVERSED_LABEL, SETTLED_LABEL].map((label) => ({
    label, owner: holder, duration: 2n * YEAR, secret: zeroHash, resolver: zeroAddress, data: [], reverseRecord: 0, referrer: zeroHash,
  }))
  for (const registration of registrations)
    await send(holder, policyContract, 'commitUnderGeneralTerms',
      [await read(client, controllerContract, 'makeCommitment', [registration]), terms])
  await mineAt((await now()) + (await read(client, controllerContract, 'minCommitmentAge')))
  await send(guardian, sponsorContract, 'setRegistrarAllowance', [REHEARSAL_REGISTRAR, parseEther('1000')])
  for (const registration of registrations) {
    const { label, owner, duration, resolver, data } = registration
    await send(REHEARSAL_REGISTRAR, sponsorContract, 'registerWithCredit', [
      registration,
      REVERSIBLE_DAYS,
      ...await signed('RegisterName', { label, owner, duration, resolver, data, reversibleDays: REVERSIBLE_DAYS }),
    ])
  }
  const [until, paid] = await payment(REVERSED_LABEL)
  const firstTerm = (await expiry(REVERSED_LABEL)) === until + SETTLEMENT_WINDOW &&
    paid === until - REVERSIBLE_DAYS * DAY + 2n * YEAR

  const { base } = await read(client, controllerContract, 'rentPrice', [REVERSED_LABEL, YEAR])
  await acceptRenewal(REVERSED_LABEL)
  const unsettledRenewal = await outcome(client, holder, controllerContract, 'renew', renewArgs, base)

  const reversal = await send(guardian, settlementContract, 'reversePayments', [[REVERSED_LABEL]])
  const reversed = (await payment(REVERSED_LABEL))[2] && skipped(reversal, 'NamePaymentReversalSkipped').length === 0
  await send(holder, registrarContract, 'approve', [REHEARSAL_RECIPIENT, id(REVERSED_LABEL)])
  await send(REHEARSAL_RECIPIENT, policyContract, 'acceptGeneralTermsForClaim',
    [id(REVERSED_LABEL), holder, await read(client, registrarContract, 'offers', [id(REVERSED_LABEL)]), terms])
  const reversedClaim = await outcome(client, REHEARSAL_RECIPIENT, registrarContract, 'transferFrom',
    [holder, REHEARSAL_RECIPIENT, id(REVERSED_LABEL)])

  const [settleFrom, settledPaid] = await payment(SETTLED_LABEL)
  const reinstatement = await send(controllerOwner, settlementContract, 'reinstatePayments', [[REVERSED_LABEL, SETTLED_LABEL]])
  const reinstated = (await expiry(REVERSED_LABEL)) === paid && (await payment(REVERSED_LABEL))[0] === 0n
  const reinstatementSkipped = skipped(reinstatement, 'NamePaymentReinstatementSkipped')
  const unreversedKept = (await payment(SETTLED_LABEL))[0] === settleFrom

  await mineAt(settleFrom)
  await send(REHEARSAL_RECIPIENT, settlementContract, 'settle', [SETTLED_LABEL])
  const settled = (await expiry(SETTLED_LABEL)) === settledPaid

  const previousExpiry = await expiry(REVERSED_LABEL)
  await acceptRenewal(REVERSED_LABEL)
  await send(REHEARSAL_REGISTRAR, sponsorContract, 'renewWithCredit', [
    ...renewArgs,
    holder,
    REVERSIBLE_DAYS,
    ...await signed('RenewName', { label: REVERSED_LABEL, holder, duration: YEAR, reversibleDays: REVERSIBLE_DAYS }),
  ])
  const [renewalUntil, renewalPaid, , renewal] = await payment(REVERSED_LABEL)
  const firstExpiry = renewalUntil + SETTLEMENT_WINDOW > previousExpiry ? renewalUntil + SETTLEMENT_WINDOW : previousExpiry
  const deferred = renewal && renewalPaid === previousExpiry + YEAR && (await expiry(REVERSED_LABEL)) === firstExpiry

  const renewalReversal = await send(guardian, settlementContract, 'reversePayments', [[REVERSED_LABEL]])
  const withheld = (await payment(REVERSED_LABEL))[0] === 0n && (await expiry(REVERSED_LABEL)) === firstExpiry &&
    skipped(renewalReversal, 'NamePaymentReversalSkipped').length === 0
  await acceptRenewal(REVERSED_LABEL)
  const renewedAfter = await outcome(client, holder, controllerContract, 'renew', renewArgs, base)
  await send(holder, controllerContract, 'renew', renewArgs, base)

  return report({
    'a sponsored registration with 180 reversible days expires 30 days after reversibleUntil, and its paid expiry is its duration after it':
      firstTerm,
    [`its holder renews it before settlement: ${unsettledRenewal}`]: unsettledRenewal === 'reverts PaymentNotSettled',
    'the guardian reverses its payment, and no label is skipped': reversed,
    [`a claim after the reversal: ${reversedClaim}`]: reversedClaim === 'reverts PaymentReversed',
    'the admin reinstates it, which extends it to its paid expiry and ends the entry': reinstated,
    [`the same batch skips the unreversed registration: NamePaymentReinstatementSkipped(${reinstatementSkipped.join(', ')}), and its entry stays`]:
      reinstatementSkipped.length === 1 && reinstatementSkipped[0] === SETTLED_LABEL && unreversedKept,
    'anyone settles the other registration at its reversibleUntil, which extends it to its paid expiry': settled,
    'a sponsored renewal with 180 reversible days keeps the expiry at E and defers its year': deferred,
    "the guardian reverses the renewal's payment: the name keeps E, and reversiblePayment answers zeros": withheld,
    [`the holder renews after that reversal: ${renewedAfter}`]:
      renewedAfter === 'succeeds' && (await expiry(REVERSED_LABEL)) === firstExpiry + YEAR,
  })
}

function record(path, update) {
  const file = JSON.parse(readFileSync(path, 'utf8'))
  update(file)
  writeFileSync(path, JSON.stringify(file, null, 2))
  console.log(`Wrote ${path}`)
}

const recorded = (deployed) => Object.fromEntries(Object.entries({
  SimplexControllerImpl: deployed.controllerImpl,
  SimplexSponsor: deployed.sponsor,
  SimplexNamePolicyImpl: deployed.policyImpl,
  SimplexSettlement: deployed.settlementProxy,
  SimplexSettlementImpl: deployed.settlementImpl,
  SimplexControllerRollbackImpl: deployed.rollbackImpl,
}).map(([name, address]) => [name, address.toLowerCase()]))

const recordVerification = (deployed) => record(verificationPath, (file) => {
  const upgraded = recorded(deployed)
  const { contracts } = assembleVerification({
    network: 'mainnet',
    tld: 'simplex',
    addresses: { ...addresses, ...upgraded },
    deployer: verification.deployer,
    chainlinkEthUsd: verification.chainlinkEthUsd,
    smpxNftAddr: verification.smpxNftAddr,
  })
  for (const name of VERIFIED) file.contracts[name] = contracts[name]
  file.contracts.SimplexControllerRollbackImpl = {
    ...contracts.SimplexControllerImpl,
    address: upgraded.SimplexControllerRollbackImpl,
  }
})

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
  const journal = new Map(loadJournal(journalPath).map((entry) => [entry.step, entry]))
  let dryTotals, previousRuntime, rollbackImpl
  try {
    const client = createPublicClient({ chain: { ...mainnet, id: fork.chainId }, transport: http(fork.url) })
    const { send, deploy } = forkActions(fork, client)
    const owners = await ownersOf(client)
    for (const address of [account.address, ...Object.values(owners), REHEARSAL_HOLDER.address, REHEARSAL_REGISTRAR, REHEARSAL_RECIPIENT])
      await fundOnFork({ forkUrl: fork.url, address, weiHex: toHex(parseEther('1000')) })
    console.log('\n--- Rehearsal on a fork of mainnet ---')
    previousRuntime = await runtimeOf(client, await deploy(REHEARSAL_REGISTRAR, PREVIOUS_CONTROLLER))
    rollbackImpl = await deployedRollback(client, previousRuntime)
    const dry = createDryRunRunner({ forkUrl: fork.url, forkChainId: fork.chainId, account })
    const before = await snapshot(client)
    const deployed = await deployContracts(resumed(dry.deploy, journal), rollbackImpl)
    for (const { caller, contract, functionName, args } of await pendingOwnerCalls(client, deployed)) {
      if (owners[caller] === account.address) await dry.write(contract, functionName, args)
      else await send(owners[caller], contract, functionName, args)
    }
    dryTotals = dry.totals()
    const after = await snapshot(client)
    const upgraded = await checkUpgrade(client, deployed, previousRuntime, Object.fromEntries(PRESERVED.map(
      ([contract, functionName], i) => [`${functionName} on ${contract.address} is unchanged: ${after[i]}`, after[i] === before[i]],
    )))
    const rehearsed = await rehearse(fork, client, send, deployed, owners)
    if (!upgraded || !rehearsed) throw new Error('rehearsal failed: nothing was sent to mainnet')
    console.log(`  rehearsal passed; the transactions of the deploy key use ${dryTotals.totalGas} gas`)
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
  const pendingOwner = await read(publicClient, controllerContract, 'pendingOwner')
  const root = await read(publicClient, registryContract, 'owner', [zeroHash])
  const handedOver = pendingOwner === zeroAddress && root !== getAddress(verification.deployer)
  if (!handedOver && process.env.BEFORE_HANDOVER !== 'yes') {
    console.error('The controller has a pending owner, or the deploy key still owns the registry root: complete the ownership handover first.')
    process.exit(1)
  }
  await analyzeAndConfirm({
    publicClient, account, maxBaseFeeWei, dryRunTotals: dryTotals, journalPath,
    label: '.simplex payment-reversal upgrade', bumpAfterMs: DEFAULTS.BUMP_AFTER_MS, bumpPct: DEFAULTS.BUMP_PCT,
  })
  const real = createWaitForBaseRunner({
    publicClient, walletClient, account, maxBaseFeeWei,
    bumpAfterMs: DEFAULTS.BUMP_AFTER_MS, bumpPct: DEFAULTS.BUMP_PCT, journalPath, attemptsLogPath,
  })
  const deployed = await deployContracts(real.deploy, rollbackImpl)
  const owners = await ownersOf(publicClient)
  for (const { caller, contract, functionName, args } of await pendingOwnerCalls(publicClient, deployed))
    if (owners[caller] === account.address) await real.write(contract, functionName, args)
  const pending = await pendingOwnerCalls(publicClient, deployed)
  if (pending.length) {
    recordVerification(deployed)
    console.log('Commit the journal and the verification file, and verify the new contracts on Etherscan before the owners sign:')
    console.log(`  ONLY=${VERIFIED.join(',')} ETHERSCAN_API_KEY=… NETWORK=mainnet SIMPLEX_TLD=simplex node scripts/verify-etherscan.mjs`)
    console.log(`and SimplexControllerRollbackImpl ${deployed.rollbackImpl} from ens-contracts 7ff8c37, as docs/deployment.md states.`)
    console.log('\nIn this order, the steps of docs/plans/payment-reversal.md, section 8:')
    for (const { step, caller, contract, functionName, args } of pending) {
      if (step === 7) {
        console.log(`  4. the guardian ${owners.guardian} submits to ${deployed.sponsor}: setRegistrarAllowance(<the store's hot wallet>, <its limit in attoUSD>)`)
        console.log('  5, 6. the operators and the controller owner, as docs/deployment.md states')
      }
      console.log(`  ${step}. the ${CALLERS[caller]} ${owners[caller]} submits to ${contract.address}: ${functionName}(${args.join(', ')})`)
      console.log(`       calldata ${encodeFunctionData({ abi: contract.abi, functionName, args })}`)
    }
    console.log('Then run this script again: it checks the upgrade and records the addresses.')
    return
  }
  console.log('\n--- Mainnet read-back ---')
  if (!(await checkUpgrade(publicClient, deployed, previousRuntime))) {
    process.exitCode = 1
    return
  }
  recordVerification(deployed)
  record(addressesPath, (file) => Object.assign(file, recorded(deployed)))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
