#!/usr/bin/env node
import {
  BaseError, HttpRequestError, TimeoutError, createPublicClient, createWalletClient, http, parseAbi, parseEther, parseGwei, toHex,
} from 'viem'
import { mainnet } from 'viem/chains'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createDryRunRunner, createWaitForBaseRunner, fundOnFork, loadJournal, spawnHardhatFork, DEFAULTS } from './gas-tools.mjs'
import { assembleVerification } from './build-verification.mjs'
import { loadInputs, readBackTwo, runOne } from './deploy-mainnet.mjs'
import { checkedProxyAdmin, prepareUpgrade } from './prepare-upgrade.mjs'
import {
  ENS_CONTRACTS_DIR, PROXY_ADMIN_ARTIFACT, UPGRADEABLE, V1_ABI, artifact, assertBuildFresh, proxyAdminOf, proxySlots,
  requireEnv,
} from './stack.mjs'

const SECTION_8_STEPS = 10
const V1_RETIREMENT_STEPS = 4
const STRANGER = '0x0000000000000000000000000000000000001234'
const SPONSOR_ABI = parseAbi(['function setRegistrarAllowance(address registrar, uint256 allowanceUSD)'])
const FORK_TAIL = 6000

class Stopped extends Error {}

function causes(error) {
  if (!(error instanceof Error)) return []
  const code = error.code === undefined ? '' : ` ${error.code}`
  return [`${error.name}${code}: ${error.shortMessage ?? error.message}`, ...causes(error.cause)]
}

const transportFailure = (error) => error instanceof BaseError && Boolean(error.walk(
  (cause) => cause instanceof TimeoutError || (cause instanceof HttpRequestError && cause.status === undefined)))

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
  const committed = loadInputs()
  const { placeholder, ...registrarWallet } = committed.governance.registrarWallet
  console.log(`The rehearsal uses the registrar wallet ${registrarWallet.address} (${placeholder ?? 'as committed'}).`)
  const inputs = { ...committed, governance: { ...committed.governance, registrarWallet } }
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
          await sendAs(admin, proxyAdminOf(contract.address), artifact(PROXY_ADMIN_ARTIFACT).abi, 'transferOwnership', [STRANGER])
        }
        return contract
      },
      write: dry.write,
    }
    const stopped = await runOne(tampered, client, inputs, account.address).then(() => undefined, (e) => e.message)
    expect('run 1 stops on the read-back', /run-1 read-back check\(s\) FAILED: .*SimplexNamePolicy ProxyAdmin owner is the admin Safe/.test(stopped ?? ''), stopped)
    const registrarOwner = await client.readContract({
      address: deployed.BaseRegistrarImplementationProxy, abi: V1_ABI, functionName: 'owner',
    })
    expect('section 8 was not sent: the deploy key still owns the registrar', registrarOwner === account.address, registrarOwner)
    expect('the v1 retirement was not sent', JSON.stringify(await v1State()) === JSON.stringify(v1Before))
    const wiringSteps = dry.totals().perStep.length
    await client.request({ method: 'evm_revert', params: [clean] })
    const unwired = await client.request({ method: 'evm_snapshot', params: [] })

    console.log(`\n=== Run 1 with the admin Safe entry changed to threshold 3 after the last wiring step ===`)
    const changing = { ...inputs, governance: { ...governance } }
    let nonceAfterWiring
    const changed = afterSteps(dryRunner(), wiringSteps, async () => {
      nonceAfterWiring = await deployKeyNonce()
      changing.governance.adminSafe = { ...governance.adminSafe, threshold: 3 }
    })
    const handOverRefused = await runOne(changed, client, changing, account.address).then(() => undefined, (e) => e.message)
    expect('run 1 stops before its first transfer to the admin Safe',
      handOverRefused === 'governance.mainnet.json does not match the chain: transferOwnership to the admin Safe is not sent',
      handOverRefused)
    expect('the deploy key sent no transaction of section 8', (await deployKeyNonce()) === nonceAfterWiring,
      `${nonceAfterWiring} after the wiring`)
    await client.request({ method: 'evm_revert', params: [unwired] })

    const journalDir = mkdtempSync(join(tmpdir(), 'rehearsal-'))
    const journalPath = join(journalDir, 'journal.jsonl')
    const walletClient = createWalletClient({ chain, transport, account })
    const realRunner = () => createWaitForBaseRunner({
      publicClient: client, walletClient, account,
      maxBaseFeeWei: parseGwei('1000'), bumpAfterMs: DEFAULTS.BUMP_AFTER_MS, bumpPct: DEFAULTS.BUMP_PCT,
      journalPath, attemptsLogPath: join(journalDir, 'attempts.log'), confirmations: 1, pollReceiptMs: 250,
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
      const outcome = await runOne(stopAfter(realRunner(), wiringSteps + k), client, inputs, account.address)
        .then(() => undefined, (e) => e)
      expect(`run 1 stops after step ${k} of section 8`, outcome instanceof Stopped, outcome?.message)
      await sentOnce(wiringSteps + k)
    }
    console.log(`\n=== Run 1, resumed to its end ===`)
    const addresses = await runOne(realRunner(), client, inputs, account.address)
    await sentOnce(wiringSteps + SECTION_8_STEPS + V1_RETIREMENT_STEPS)

    console.log(`\n=== The guardian Safe sets the allowance, the admin Safe accepts ===`)
    await sendAs(governance.guardianSafe.address, addresses.SimplexSponsor, SPONSOR_ABI, 'setRegistrarAllowance',
      [registrarWallet.address, registrarWallet.allowance])
    await sendAs(admin, addresses.ETHRegistrarController, V1_ABI, 'acceptOwnership')
    await sendAs(admin, addresses.SimplexPriceOracle, V1_ABI, 'acceptOwnership')

    const runTwo = await readBackTwo(client, addresses, inputs, account.address)
    expect('run 2 read-back passes', runTwo.length === 0, runTwo.join(', '))

    console.log(`\n=== prepare-upgrade and a resolver that trusts another controller ===`)
    const verification = await assembleVerification({ client, addresses, deployer: account.address, adminSafe: admin })
    const elsewhere = { ...addresses, ETHRegistrarController: STRANGER }
    const unnamed = await prepareUpgrade(dry, client, 'SimplexResolver', elsewhere, verification, account.address)
    expect('the change of trustedETHController is refused when it is not named',
      Boolean(unnamed.refused?.some((failure) => failure.includes('trustedETHController'))), unnamed.refused?.join('; '))
    const named = await prepareUpgrade(dry, client, 'SimplexResolver', elsewhere, verification, account.address,
      { intended: ['trustedETHController'] })
    expect('the change of trustedETHController is accepted when it is named, with both values',
      !named.refused && named.changes.length === 1, named.refused?.join('; ') ?? JSON.stringify(named.changes))

    const upgrade = async (prepared) => {
      verification.contracts[`${prepared.name}@${prepared.candidate}`] = prepared.entry
      await sendAs(admin, prepared.proxyAdmin, artifact(PROXY_ADMIN_ARTIFACT).abi, 'upgradeAndCall',
        [prepared.proxy, prepared.candidate, prepared.data])
      const { implementation } = await proxySlots(client, prepared.proxy)
      expect(`${prepared.name} proxy upgraded through its ProxyAdmin with data ${prepared.data}`,
        implementation.toLowerCase() === prepared.candidate.toLowerCase(), implementation)
    }

    console.log(`\n=== prepare-upgrade accepts an identical rebuild, and the admin Safe upgrades ===`)
    for (const name of Object.keys(UPGRADEABLE)) {
      const prepared = await prepareUpgrade(dry, client, name, addresses, verification, account.address)
      expect(`${name} candidate accepted`, !prepared.refused, prepared.refused?.join('; ') ?? prepared.candidate)
      if (!prepared.refused) await upgrade(prepared)
    }
    const afterUpgrades = await readBackTwo(client, addresses, inputs, account.address)
    expect('run 2 read-back passes after the upgrades', afterUpgrades.length === 0, afterUpgrades.join(', '))

    console.log(`\n=== prepare-upgrade with upgrade data ===`)
    const withData = (signature, args = []) => prepareUpgrade(dry, client, 'SimplexController', addresses, verification,
      account.address, { call: { signature, args } })
    const missing = await withData('migrate(uint256)', [1])
    expect('data naming a function the candidate lacks is refused',
      Boolean(missing.refused?.includes('it has no function migrate(uint256)')), missing.refused?.join('; '))
    const unguarded = await withData('owner()')
    expect('data for a candidate without a _proxyAdmin immutable is refused before its deployment',
      Boolean(unguarded.refused?.some((failure) => failure.startsWith('DATA owner() requires an immutable _proxyAdmin')))
        && unguarded.candidate === undefined,
      unguarded.refused?.join('; '))

    console.log(`\n=== Freezes and transfers address the ProxyAdmin of the contract they name ===`)
    for (const [name, { key }] of Object.entries(UPGRADEABLE)) {
      const target = await checkedProxyAdmin(client, addresses, name)
      expect(`${name} names its proxy's ProxyAdmin`, target.proxyAdmin === proxyAdminOf(addresses[key]),
        target.refused?.join('; ') ?? `${target.proxyAdmin}, implementation ${target.implementation}`)
    }
    const unknown = await checkedProxyAdmin(client, addresses, addresses.ETHRegistrarController)
    expect('a proxy address given as CONTRACT is refused', Boolean(unknown.refused), unknown.refused?.join('; '))

    console.log(`\n=== The deploy key restores v1 ===`)
    console.log(await v1State())
    await sendAs(account.address, v1.BaseRegistrarImplementation, V1_ABI, 'addController', [v1.ETHRegistrarController])
    await sendAs(account.address, v1.BaseRegistrarImplementation, V1_ABI, 'addController', [v1.SimplexNamePolicy])
    await sendAs(account.address, v1.ETHRegistrarController, V1_ABI, 'transferOwnership', [admin])
    await sendAs(account.address, v1.SimplexPriceOracle, V1_ABI, 'transferOwnership', [admin])
    const v1Restored = await v1State()
    console.log(v1Restored)
    expect('v1 is in its state before step 7', JSON.stringify(v1Restored) === JSON.stringify(v1Before))
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
    console.error(err)
    console.error(`\nCauses:\n  ${causes(err).join('\n  ')}`)
    process.exit(1)
  },
)
