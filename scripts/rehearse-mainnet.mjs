#!/usr/bin/env node
import {
  BaseError, HttpRequestError, TimeoutError, createPublicClient, createWalletClient, decodeFunctionData, http, parseAbi,
  parseEther, parseGwei, toHex,
} from 'viem'
import { mainnet } from 'viem/chains'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createDryRunRunner, createWaitForBaseRunner, fundOnFork, loadJournal, spawnHardhatFork, DEFAULTS } from './gas-tools.mjs'
import { assembleVerification } from './build-verification.mjs'
import {
  acceptanceBatch, loadInputs, readBackTwo, registrarAllowanceBatch, registrarAllowanceReadBack, runOne,
} from './deploy-mainnet.mjs'
import { checkedProxyAdmin, prepareUpgrade } from './prepare-upgrade.mjs'
import {
  ENS_CONTRACTS_DIR, PROXY_ADMIN_ABI, UPGRADEABLE, V1_ABI, artifact, assertBuildFresh, causes, proxyAdminOf,
  proxySlots, requireEnv, storageLayout,
} from './stack.mjs'

const SECTION_8_STEPS = 10
const SECTION_8_AND_V1_RETIREMENT = [
  'write:transferOwnership',
  'write:setOwner',
  'write:setSubnodeOwner#6',
  'write:setSubnodeOwner#7',
  'deploy:Root',
  'write:setController',
  'write:transferOwnership#2',
  'write:setOwner#2',
  'write:transferOwnership#3',
  'write:transferOwnership#4',
  'write:removeController',
  'write:removeController#2',
  'write:transferOwnership#5',
  'write:transferOwnership#6',
]
const STRANGER = '0x0000000000000000000000000000000000001234'
const SAFE_CALLS_ABI = parseAbi([
  'function acceptOwnership()',
  'function setRegistrarAllowance(address registrar, uint256 allowanceUSD)',
])
const SAFE_ABI = parseAbi(['function changeThreshold(uint256 threshold)'])
const FORK_TAIL = 6000

class Stopped extends Error {}

const transportFailure = (error) => error instanceof BaseError && Boolean(error.walk(
  (cause) => cause instanceof TimeoutError || (cause instanceof HttpRequestError && cause.status === undefined)))

const outcome = (result, accepted = () => 'accepted') => (result.refused ? result.failures.join('; ') : accepted())

const results = []
function expect(what, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? `: ${detail}` : ''}`)
  results.push(ok)
}

function afterSteps(runner, step, act) {
  let steps = 0
  const counted = (send) => async (...args) => {
    const result = await send(...args)
    steps += 1
    if (steps === step) await act()
    return result
  }
  return { deploy: counted(runner.deploy), write: counted(runner.write) }
}

const stopAfter = (runner, step) => afterSteps(runner, step, () => {
  throw new Stopped(`stopped after step ${step}`)
})

async function main() {
  const rpcUrl = requireEnv('MAINNET_RPC_URL')
  assertBuildFresh()
  const inputs = loadInputs()
  const { governance, v1 } = inputs
  const admin = governance.adminSafe.address
  const account = privateKeyToAccount(generatePrivateKey())

  const fork = await spawnHardhatFork({ mainnetRpcUrl: rpcUrl, port: 18545, ensContractsDir: ENS_CONTRACTS_DIR })
  try {
    const chain = { ...mainnet, id: fork.chainId }
    const transport = http(fork.url, { timeout: 120_000 })
    const client = createPublicClient({ chain, transport })
    const fund = (address) => fundOnFork({ forkUrl: fork.url, address, weiHex: toHex(parseEther('1000')) })
    const landed = async (from, nonce, before) => {
      if (await client.getTransactionCount({ address: from, blockTag: 'pending' }) === nonce) return undefined
      const latest = await client.getBlockNumber({ cacheTime: 0 })
      for (let number = before + 1n; number <= latest; number++) {
        const { transactions } = await client.getBlock({ blockNumber: number, includeTransactions: true })
        const sent = transactions.find((tx) => tx.from.toLowerCase() === from.toLowerCase() && tx.nonce === nonce)
        if (sent) return sent.hash
      }
      throw new Error(`the transaction of ${from} with nonce ${nonce} is missing from blocks ${before + 1n} to ${latest}`)
    }
    const sendAs = async (from, address, abi, functionName, args = []) => {
      await client.request({ method: 'hardhat_impersonateAccount', params: [from] })
      await fund(from)
      await client.simulateContract({ account: from, address, abi, functionName, args })
      const nonce = await client.getTransactionCount({ address: from, blockTag: 'pending' })
      const before = await client.getBlockNumber({ cacheTime: 0 })
      const wallet = createWalletClient({ chain, transport, account: from })
      const send = () => wallet.writeContract({ address, abi, functionName, args })
      const hash = await send().catch(async (error) => {
        if (!transportFailure(error)) throw error
        console.log(`  ↻ ${functionName} from ${from}: ${causes(error).join(' ← ')}`)
        const sent = await landed(from, nonce, before)
        if (sent) return sent
        console.log(`  ↻ ${functionName} from ${from} did not land; sent once more`)
        return send()
      })
      const receipt = await client.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error(`${functionName} from ${from} reverted`)
    }
    const execute = async (batch) => {
      for (const { to, value, data } of batch.transactions) {
        if (value !== '0') throw new Error(`${batch.meta.name}: a transaction to ${to} carries value ${value}`)
        const { functionName, args } = decodeFunctionData({ abi: SAFE_CALLS_ABI, data })
        await sendAs(batch.meta.createdFromSafeAddress, to, SAFE_CALLS_ABI, functionName, args)
      }
    }
    const v1State = async () => {
      const read = (address, functionName, args = []) => client.readContract({ address, abi: V1_ABI, functionName, args })
      return {
        'registrar owner': await read(v1.BaseRegistrarImplementation, 'owner'),
        'registrar controllers(controller)': await read(v1.BaseRegistrarImplementation, 'controllers', [v1.ETHRegistrarController]),
        'registrar controllers(name policy)': await read(v1.BaseRegistrarImplementation, 'controllers', [v1.SimplexNamePolicy]),
        'controller owner': await read(v1.ETHRegistrarController, 'owner'),
        'controller pendingOwner': await read(v1.ETHRegistrarController, 'pendingOwner'),
        'oracle owner': await read(v1.SimplexPriceOracle, 'owner'),
        'oracle pendingOwner': await read(v1.SimplexPriceOracle, 'pendingOwner'),
      }
    }

    console.log(`\n=== The deploy key ${account.address} holds v1 as the v1 deploy key does on mainnet ===`)
    const v1Owner = await client.readContract({ address: v1.BaseRegistrarImplementation, abi: V1_ABI, functionName: 'owner' })
    await sendAs(v1Owner, v1.BaseRegistrarImplementation, V1_ABI, 'transferOwnership', [account.address])
    for (const proposed of [v1.ETHRegistrarController, v1.SimplexPriceOracle]) {
      const pending = await client.readContract({ address: proposed, abi: V1_ABI, functionName: 'pendingOwner' })
      await sendAs(v1Owner, proposed, V1_ABI, 'transferOwnership', [account.address])
      await sendAs(account.address, proposed, V1_ABI, 'acceptOwnership')
      await sendAs(account.address, proposed, V1_ABI, 'transferOwnership', [pending])
    }
    await fund(account.address)
    const v1Before = await v1State()
    console.log(v1Before)
    const clean = await client.request({ method: 'evm_snapshot', params: [] })
    const dryRunner = () => createDryRunRunner({ forkUrl: fork.url, forkChainId: fork.chainId, account })
    const deployKeyNonce = () => client.getTransactionCount({ address: account.address })

    console.log(`\n=== Run 1 with an admin Safe entry of threshold 3 ===`)
    const strict = { ...inputs, governance: { ...governance, adminSafe: { ...governance.adminSafe, threshold: 3 } } }
    const nonceBeforeCheck = await deployKeyNonce()
    const unchecked = await runOne(dryRunner(), client, strict, account.address).then(() => undefined, (e) => e.message)
    expect('run 1 stops on the governance check',
      unchecked === 'governance.mainnet.json does not match the chain: any transaction of this run is not sent', unchecked)
    expect('the deploy key sent no transaction', (await deployKeyNonce()) === nonceBeforeCheck)

    console.log(`\n=== Run 1 with a ProxyAdmin owner other than the admin Safe ===`)
    const dry = dryRunner()
    const deployed = {}
    const tampered = {
      deploy: async (name, abi, bytecode, args) => {
        const contract = await dry.deploy(name, abi, bytecode, args)
        deployed[name] = contract.address
        if (name === 'SimplexNamePolicyProxy') {
          await sendAs(admin, proxyAdminOf(contract.address), PROXY_ADMIN_ABI, 'transferOwnership', [STRANGER])
        }
        return contract
      },
      write: dry.write,
    }
    const stopped = await runOne(tampered, client, inputs, account.address).then(() => undefined, (e) => e.message)
    expect('run 1 stops on the read-back', /run-1 read-back check\(s\) FAILED: .*SimplexNamePolicy ProxyAdmin owner is the admin Safe/.test(stopped ?? ''), stopped)
    const registrarOwner = await client.readContract({
      address: deployed.BaseRegistrarImplementationProxy, abi: artifact(UPGRADEABLE.BaseRegistrarImplementation.artifact).abi,
      functionName: 'owner',
    })
    expect('section 8 was not sent: the deploy key still owns the registrar', registrarOwner === account.address, registrarOwner)
    expect('the v1 retirement was not sent', JSON.stringify(await v1State()) === JSON.stringify(v1Before))
    const wiringSteps = dry.totals().perStep.length
    await client.request({ method: 'evm_revert', params: [clean] })

    const interrupted = async (steps, change) => {
      const snapshot = await client.request({ method: 'evm_snapshot', params: [] })
      const dryRun = dryRunner()
      const created = {}
      let nonceAtChange
      const runner = afterSteps({
        deploy: async (name, ...rest) => {
          const contract = await dryRun.deploy(name, ...rest)
          created[name] = contract.address
          return contract
        },
        write: dryRun.write,
      }, steps, async () => {
        await change(dryRun, created)
        nonceAtChange = await deployKeyNonce()
      })
      const message = await runOne(runner, client, inputs, account.address).then(() => undefined, (e) => e.message)
      const unsent = (await deployKeyNonce()) === nonceAtChange
      await client.request({ method: 'evm_revert', params: [snapshot] })
      return { message, unsent }
    }

    for (const [step, call] of [[0, 'transferOwnership'], [2, 'setSubnodeOwner']]) {
      console.log(`\n=== Run 1 with the admin Safe's threshold changed to 3 after step ${step} of section 8 ===`)
      const { message, unsent } = await interrupted(wiringSteps + step,
        () => sendAs(admin, admin, SAFE_ABI, 'changeThreshold', [3n]))
      expect(`run 1 stops before ${call} to the admin Safe`,
        message === `governance.mainnet.json does not match the chain: ${call} to the admin Safe is not sent`, message)
      expect('the deploy key sent nothing after the change', unsent)
    }

    console.log(`\n=== Run 1 with a registrar owner other than the deploy key and the admin Safe ===`)
    const foreign = await interrupted(wiringSteps, (dryRun, created) => dryRun.write(
      { address: created.BaseRegistrarImplementationProxy, abi: artifact(UPGRADEABLE.BaseRegistrarImplementation.artifact).abi },
      'transferOwnership', [STRANGER]))
    expect('run 1 stops on the read-back', /run-1 read-back check\(s\) FAILED: .*registrar owner is the deploy key/.test(foreign.message ?? ''),
      foreign.message)
    expect('the deploy key sent nothing after the change', foreign.unsent)

    const journalDir = mkdtempSync(join(tmpdir(), 'rehearsal-'))
    const journalPath = join(journalDir, 'journal.jsonl')
    const attemptsLogPath = join(journalDir, 'attempts.log')
    const walletClient = createWalletClient({ chain, transport, account })
    const realRunner = (overrides = {}) => createWaitForBaseRunner({
      publicClient: client, walletClient, account,
      maxBaseFeeWei: parseGwei('1000'), bumpAfterMs: DEFAULTS.BUMP_AFTER_MS, bumpPct: DEFAULTS.BUMP_PCT,
      journalPath, attemptsLogPath, confirmations: 1, pollReceiptMs: 250, ...overrides,
    })
    const nonceBefore = await deployKeyNonce()
    const sentOnce = async (steps) => {
      const journal = loadJournal(journalPath)
      const sent = (await deployKeyNonce()) - nonceBefore
      expect(`the journal holds ${steps} distinct steps, each sent once`,
        journal.length === steps && new Set(journal.map(({ step }) => step)).size === steps && sent === steps,
        `${journal.length} entries, ${sent} transactions`)
    }
    for (let k = 1; k <= SECTION_8_STEPS; k++) {
      console.log(`\n=== Run 1, stopped after step ${k} of section 8 ===`)
      const ending = await runOne(stopAfter(realRunner(), wiringSteps + k), client, inputs, account.address)
        .then(() => undefined, (e) => e)
      expect(`run 1 stops after step ${k} of section 8`, ending instanceof Stopped, ending?.message)
      await sentOnce(wiringSteps + k)
    }
    const pendingStep = SECTION_8_AND_V1_RETIREMENT[SECTION_8_STEPS]
    console.log(`\n=== Run 1 without automining, stopped with ${pendingStep} pending ===`)
    await client.request({ method: 'evm_setAutomine', params: [false] })
    const stalled = await runOne(realRunner({ bumpAfterMs: 2000, absoluteMaxBaseFeeWei: parseGwei('1000') }), client, inputs,
      account.address).then(() => undefined, (e) => e.message)
    const pendingNonce = await client.getTransactionCount({ address: account.address, blockTag: 'pending' })
    expect(`run 1 stops at the fee ceiling with ${pendingStep} pending`,
      /bumping past the absolute ceiling/.test(stalled ?? '') && pendingNonce === (await deployKeyNonce()) + 1, stalled)

    console.log(`\n=== Run 1, resumed while ${pendingStep} is pending, to its end ===`)
    const attemptsOf = () => readFileSync(attemptsLogPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
      .filter(({ step }) => step === pendingStep).map(({ outcome }) => outcome)
    let finished = false
    const resumed = runOne(realRunner(), client, inputs, account.address)
      .then((addresses) => ({ addresses }), (error) => ({ error }))
      .finally(() => { finished = true })
    const decided = () => attemptsOf().includes('adopted-pending') || attemptsOf().filter((o) => o === 'submitted').length > 1
    for (const deadline = Date.now() + 120_000; !finished && !decided() && Date.now() < deadline;) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    await client.request({ method: 'evm_setAutomine', params: [true] })
    await client.request({ method: 'evm_mine', params: [] })
    const { addresses, error } = await resumed
    if (error) throw error
    const outcomes = attemptsOf()
    expect(`the resumed run waits for the pending ${pendingStep} and does not send it again`,
      outcomes.includes('adopted-pending') && outcomes.filter((o) => o === 'submitted').length === 1, outcomes.join(', '))
    await sentOnce(wiringSteps + SECTION_8_AND_V1_RETIREMENT.length)
    const handOverSteps = loadJournal(journalPath).slice(wiringSteps).map(({ step }) => step)
    expect('the journal holds section 8 and the v1 retirement in their order',
      JSON.stringify(handOverSteps) === JSON.stringify(SECTION_8_AND_V1_RETIREMENT), handOverSteps.join(', '))

    console.log(`\n=== The admin Safe executes the batch of run 1 ===`)
    await execute(acceptanceBatch(admin, addresses))

    const runTwo = await readBackTwo(client, addresses, inputs, account.address)
    expect('run 2 read-back passes without a registrar wallet', runTwo.length === 0, runTwo.join(', '))

    const registrarWallet = { kind: 'EOA', address: privateKeyToAccount(generatePrivateKey()).address, allowance: 10n ** 20n }
    const withRegistrar = { ...governance, registrarWallet }
    console.log(`\n=== The registrar step with the registrar wallet ${registrarWallet.address} ===`)
    const unset = await registrarAllowanceReadBack(client, withRegistrar, addresses)
    expect('the registrar read-back fails before the guardian Safe sets the allowance', unset.length === 1, unset.join(', '))
    const allowance = await registrarAllowanceBatch(client, withRegistrar, addresses)
    expect('the registrar step writes a batch of the guardian Safe to the sponsor proxy',
      !allowance.refused && allowance.batch.meta.createdFromSafeAddress === governance.guardianSafe.address &&
        allowance.batch.transactions.every(({ to }) => to === addresses.SimplexSponsor),
      outcome(allowance, () => JSON.stringify(allowance.batch.transactions)))
    if (!allowance.refused) await execute(allowance.batch)
    const set = await registrarAllowanceReadBack(client, withRegistrar, addresses)
    expect('the registrar read-back passes after the guardian Safe executes the batch', set.length === 0, set.join(', '))

    const upgradeKey = privateKeyToAccount(generatePrivateKey())
    await fund(upgradeKey.address)
    const upgrades = createDryRunRunner({ forkUrl: fork.url, forkChainId: fork.chainId, account: upgradeKey })
    console.log(`\n=== prepare-upgrade with the key ${upgradeKey.address}, and a resolver that trusts another controller ===`)
    const verification = await assembleVerification({ client, addresses, deployer: account.address, adminSafe: admin })
    const creations = new Map(loadJournal(journalPath).filter(({ address }) => address)
      .map(({ address, txHash }) => [address.toLowerCase(), txHash]))
    const journalled = Object.entries(verification.contracts).filter(([, { address }]) => creations.has(address.toLowerCase()))
    const unmatched = []
    for (const [label, { address, artifact: path, constructorArgs }] of journalled) {
      const { input } = await client.getTransaction({ hash: creations.get(address.toLowerCase()) })
      if (input !== `${artifact(path).bytecode}${constructorArgs.slice(2)}`) unmatched.push(label)
    }
    expect(`the constructor arguments of the verification file equal the creation inputs of ${journalled.length} journalled deployments`,
      journalled.length === creations.size && unmatched.length === 0, unmatched.join(', '))
    const elsewhere = { ...addresses, ETHRegistrarController: STRANGER }
    const unnamed = await prepareUpgrade(upgrades, client, 'SimplexResolver', elsewhere, verification, upgradeKey.address)
    expect('the change of trustedETHController is refused when it is not named',
      unnamed.refused && unnamed.failures.some((failure) => failure.includes('trustedETHController')), outcome(unnamed))
    const named = await prepareUpgrade(upgrades, client, 'SimplexResolver', elsewhere, verification, upgradeKey.address,
      { intended: ['trustedETHController'] })
    expect('the change of trustedETHController is accepted when it is named, with both values',
      !named.refused && named.changes.length === 1, outcome(named, () => JSON.stringify(named.changes)))

    const upgrade = async (prepared) => {
      verification.contracts[`${prepared.name}@${prepared.candidate}`] = prepared.entry
      await sendAs(admin, prepared.proxyAdmin, PROXY_ADMIN_ABI, 'upgradeAndCall',
        [prepared.proxy, prepared.candidate, prepared.data])
      const { implementation } = await proxySlots(client, prepared.proxy)
      expect(`${prepared.name} proxy upgraded through its ProxyAdmin with data ${prepared.data}`,
        implementation.toLowerCase() === prepared.candidate.toLowerCase(), implementation)
    }

    console.log(`\n=== prepare-upgrade accepts an identical rebuild, and the admin Safe upgrades ===`)
    for (const name of Object.keys(UPGRADEABLE)) {
      const prepared = await prepareUpgrade(upgrades, client, name, addresses, verification, upgradeKey.address)
      expect(`${name} candidate accepted`, !prepared.refused, outcome(prepared, () => prepared.candidate))
      if (!prepared.refused) await upgrade(prepared)
      if (name === 'SubnameRegistrar' && !prepared.refused) {
        expect('the SubnameRegistrar candidate holds the key that deployed it as _deployer',
          BigInt(prepared.entry.immutables._deployer) === BigInt(upgradeKey.address), prepared.entry.immutables._deployer)
      }
    }
    const afterUpgrades = await readBackTwo(client, addresses, inputs, account.address)
    expect('run 2 read-back passes after the upgrades', afterUpgrades.length === 0, afterUpgrades.join(', '))

    console.log(`\n=== prepare-upgrade and a candidate whose _initialized is not 255 ===`)
    const { slot: initializedSlot } = storageLayout(artifact(UPGRADEABLE.SimplexController.artifact))
      .find(({ label }) => label === '_initialized')
    const opened = await prepareUpgrade({
      deploy: async (...args) => {
        const contract = await upgrades.deploy(...args)
        await client.request({
          method: 'hardhat_setStorageAt', params: [contract.address, toHex(BigInt(initializedSlot)), toHex(1n, { size: 32 })],
        })
        return contract
      },
      write: upgrades.write,
    }, client, 'SimplexController', addresses, verification, upgradeKey.address)
    expect('a candidate whose _initialized is 1 is refused',
      opened.refused && opened.failures.includes('its _initialized is 1, not 255'), outcome(opened))

    console.log(`\n=== prepare-upgrade with upgrade data ===`)
    const withData = (signature, args = []) => prepareUpgrade(upgrades, client, 'SimplexController', addresses, verification,
      upgradeKey.address, { call: { signature, args } })
    const missing = await withData('migrate(uint256)', [1])
    expect('data naming a function the candidate lacks is refused',
      missing.refused && missing.failures.includes('it has no function migrate(uint256)'), outcome(missing))
    const unguarded = await withData('owner()')
    expect('data for a candidate without a _proxyAdmin immutable is refused before its deployment',
      unguarded.refused && unguarded.candidate === undefined &&
        unguarded.failures.some((failure) => failure.startsWith('DATA owner() requires an immutable _proxyAdmin')),
      outcome(unguarded))

    console.log(`\n=== Freezes and transfers address the ProxyAdmin of the contract they name ===`)
    for (const [name, { key }] of Object.entries(UPGRADEABLE)) {
      const target = await checkedProxyAdmin(client, addresses, verification, name)
      expect(`${name} names its proxy's ProxyAdmin`, !target.refused && target.proxyAdmin === proxyAdminOf(addresses[key]),
        outcome(target, () => `${target.proxyAdmin}, implementation ${target.implementation}`))
    }
    const unknown = await checkedProxyAdmin(client, addresses, verification, addresses.ETHRegistrarController)
    expect('a proxy address given as CONTRACT is refused', unknown.refused, outcome(unknown))
    const swapped = { ...addresses, PublicResolver: addresses.SubnameRegistrar, SubnameRegistrar: addresses.PublicResolver }
    const redirected = await checkedProxyAdmin(client, swapped, verification, 'SimplexResolver')
    expect('a freeze of the resolver through an addresses file with swapped keys is refused', redirected.refused,
      outcome(redirected))

    console.log(`\n=== The deploy key restores v1 ===`)
    console.log(await v1State())
    await sendAs(account.address, v1.BaseRegistrarImplementation, V1_ABI, 'addController', [v1.ETHRegistrarController])
    await sendAs(account.address, v1.BaseRegistrarImplementation, V1_ABI, 'addController', [v1.SimplexNamePolicy])
    await sendAs(account.address, v1.ETHRegistrarController, V1_ABI, 'transferOwnership', [admin])
    await sendAs(account.address, v1.SimplexPriceOracle, V1_ABI, 'transferOwnership', [admin])
    const v1Restored = await v1State()
    console.log(v1Restored)
    expect('v1 is in its state before the v1 retirement', JSON.stringify(v1Restored) === JSON.stringify(v1Before))
  } catch (error) {
    const { exit, stdout, stderr } = fork.state()
    console.error(`\nThe fork ${exit ? `exited with code ${exit.code} and signal ${exit.signal}` : 'still runs'}.`)
    console.error(`--- fork stderr, last ${FORK_TAIL} characters ---\n${stderr.slice(-FORK_TAIL) || '(empty)'}`)
    console.error(`--- fork stdout, last ${FORK_TAIL} characters ---\n${stdout.slice(-FORK_TAIL) || '(empty)'}`)
    throw error
  } finally {
    fork.stop()
  }
  if (results.some((ok) => !ok)) throw new Error(`${results.filter((ok) => !ok).length} rehearsal check(s) failed`)
  console.log(`\nrehearsal passed`)
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`\nCauses:\n  ${causes(err).join('\n  ')}`)
    process.exit(1)
  },
)
