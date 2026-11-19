#!/usr/bin/env node
import { createPublicClient, createWalletClient, http, parseAbi, parseEther, parseGwei, toHex } from 'viem'
import { mainnet } from 'viem/chains'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createDryRunRunner, createWaitForBaseRunner, fundOnFork, loadJournal, spawnHardhatFork, DEFAULTS } from './gas-tools.mjs'
import { assembleVerification } from './build-verification.mjs'
import { loadInputs, readBackTwo, runOne } from './deploy-mainnet.mjs'
import { prepareUpgrade, proxyAdminTarget } from './prepare-upgrade.mjs'
import { ENS_CONTRACTS_DIR, PROXY_ADMIN, UPGRADEABLE, artifact, assertBuildFresh, proxyAdminOf, proxySlots } from './stack.mjs'

const SECTION_8_STEPS = 10
const V1_RETIREMENT_STEPS = 4
const STRANGER = '0x0000000000000000000000000000000000001234'
const V1_ABI = parseAbi([
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function controllers(address) view returns (bool)',
  'function addController(address)',
  'function transferOwnership(address)',
  'function acceptOwnership()',
])
const SPONSOR_ABI = parseAbi(['function setRegistrarAllowance(address registrar, uint256 allowanceUSD)'])

class Stopped extends Error {}

const results = []
function expect(what, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? `: ${detail}` : ''}`)
  results.push(ok)
}

function stopAfter(runner, step) {
  let steps = 0
  const counted = (send) => async (...args) => {
    const result = await send(...args)
    steps += 1
    if (steps === step) throw new Stopped(`stopped after step ${step}`)
    return result
  }
  return { deploy: counted(runner.deploy), write: counted(runner.write) }
}

async function main() {
  const rpcUrl = process.env.MAINNET_RPC_URL
  if (!rpcUrl) throw new Error('MAINNET_RPC_URL is required')
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
    const sendAs = async (from, address, abi, functionName, args = []) => {
      await client.request({ method: 'hardhat_impersonateAccount', params: [from] })
      await fund(from)
      const wallet = createWalletClient({ chain, transport, account: from })
      const receipt = await client.waitForTransactionReceipt({
        hash: await wallet.writeContract({ address, abi, functionName, args }),
      })
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

    console.log(`\n=== Run 1 with a ProxyAdmin owner other than the admin Safe ===`)
    const dry = createDryRunRunner({ forkUrl: fork.url, forkChainId: fork.chainId, account })
    const deployed = {}
    const tampered = {
      deploy: async (name, abi, bytecode, args) => {
        const contract = await dry.deploy(name, abi, bytecode, args)
        deployed[name] = contract.address
        if (name === 'SimplexNamePolicyProxy') {
          await sendAs(admin, proxyAdminOf(contract.address), artifact(PROXY_ADMIN).abi, 'transferOwnership', [STRANGER])
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

    const journalDir = mkdtempSync(join(tmpdir(), 'rehearsal-'))
    const journalPath = join(journalDir, 'journal.jsonl')
    const walletClient = createWalletClient({ chain, transport, account })
    const realRunner = () => createWaitForBaseRunner({
      publicClient: client, walletClient, account,
      maxBaseFeeWei: parseGwei('1000'), bumpAfterMs: DEFAULTS.BUMP_AFTER_MS, bumpPct: DEFAULTS.BUMP_PCT,
      journalPath, attemptsLogPath: join(journalDir, 'attempts.log'), confirmations: 1,
    })
    const nonceBefore = await client.getTransactionCount({ address: account.address })
    const sentOnce = async (steps) => {
      const journal = loadJournal(journalPath)
      const sent = (await client.getTransactionCount({ address: account.address })) - nonceBefore
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
    const unnamed = await prepareUpgrade(dry, client, 'SimplexResolver', elsewhere, verification, account.address, [])
    expect('the change of trustedETHController is refused when it is not named',
      Boolean(unnamed.refused?.some((failure) => failure.includes('trustedETHController'))), unnamed.refused?.join('; '))
    const named = await prepareUpgrade(dry, client, 'SimplexResolver', elsewhere, verification, account.address,
      ['trustedETHController'])
    expect('the change of trustedETHController is accepted when it is named, with both values',
      !named.refused && named.changes.length === 1, named.refused?.join('; ') ?? JSON.stringify(named.changes))

    console.log(`\n=== prepare-upgrade accepts an identical rebuild, and the admin Safe upgrades ===`)
    for (const name of Object.keys(UPGRADEABLE)) {
      const prepared = await prepareUpgrade(dry, client, name, addresses, verification, account.address, [])
      expect(`${name} candidate accepted`, !prepared.refused, prepared.refused?.join('; ') ?? prepared.candidate)
      if (prepared.refused) continue
      await sendAs(admin, prepared.proxyAdmin, artifact(PROXY_ADMIN).abi, 'upgradeAndCall', [prepared.proxy, prepared.candidate, '0x'])
      const { implementation } = await proxySlots(client, prepared.proxy)
      expect(`${name} proxy upgraded through its ProxyAdmin`,
        implementation.toLowerCase() === prepared.candidate.toLowerCase(), implementation)
    }
    const afterUpgrades = await readBackTwo(client, addresses, inputs, account.address)
    expect('run 2 read-back passes after the upgrades', afterUpgrades.length === 0, afterUpgrades.join(', '))

    console.log(`\n=== Freezes and transfers address the six ProxyAdmins only ===`)
    for (const [name, { key }] of Object.entries(UPGRADEABLE)) {
      const accepted = await proxyAdminTarget(client, addresses, proxyAdminOf(addresses[key]))
      expect(`the ProxyAdmin of ${name} is a target`, accepted.name === name, accepted.refused?.join('; ') ?? accepted.proxyAdmin)
      const refused = await proxyAdminTarget(client, addresses, addresses[key])
      expect(`the ${name} proxy is refused as a target`, Boolean(refused.refused), refused.refused?.join('; '))
    }

    console.log(`\n=== The deploy key restores v1 ===`)
    console.log(await v1State())
    await sendAs(account.address, v1.BaseRegistrarImplementation, V1_ABI, 'addController', [v1.ETHRegistrarController])
    await sendAs(account.address, v1.BaseRegistrarImplementation, V1_ABI, 'addController', [v1.SimplexNamePolicy])
    await sendAs(account.address, v1.ETHRegistrarController, V1_ABI, 'transferOwnership', [admin])
    await sendAs(account.address, v1.SimplexPriceOracle, V1_ABI, 'transferOwnership', [admin])
    const v1Restored = await v1State()
    console.log(v1Restored)
    expect('v1 is in its state before step 7', JSON.stringify(v1Restored) === JSON.stringify(v1Before))
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
    process.exit(1)
  },
)
