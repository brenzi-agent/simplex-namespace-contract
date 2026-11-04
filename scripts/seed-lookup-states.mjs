/**
 * Seed a local SNRC deployment with one on-chain state per name-lookup answer the app can show.
 * Run from parent repo, after `SIMPLEX_TLD=simplex node scripts/deploy-local.mjs`:  node scripts/seed-lookup-states.mjs
 *
 * Requires: a hardhat node started with HARDHAT_INITIAL_DATE ~900 days in the past, so that
 * each name's expiry lands where its row needs it; chain time is then set to the wall clock.
 * Registers in .simplex under the general terms: bakery (live, with a contact record),
 * expiring (past expiry, in grace), lapsed (past grace), nolink (live, no records), the
 * subnames menu.bakery (held) and menu.expiring (not held once its 2LD expired),
 * privacy (reserved, community), brandname (reserved, trademark), sunflower (left unregistered).
 */
import { createPublicClient, createWalletClient, http, encodeFunctionData, namehash, keccak256, toHex, stringToBytes } from 'viem'
import { localhost } from 'viem/chains'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ARTIFACTS = join(__dirname, '..', 'ens-contracts', 'artifacts', 'contracts')
const abiOf = (p) => JSON.parse(readFileSync(join(ARTIFACTS, p), 'utf8')).abi

const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545'
const tld = process.env.SIMPLEX_TLD || 'simplex'
const addrs = JSON.parse(process.env.ADDRS)

const transport = http(rpcUrl)
const pub = createPublicClient({ chain: localhost, transport })
const wallet = createWalletClient({
  chain: localhost,
  transport,
  account: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', // hardhat account #0
})
const account = wallet.account
const OWNER = account.address

const controllerAbi = abiOf('simplex/SimplexController.sol/SimplexController.json')
const namePolicyAbi = abiOf('simplex/SimplexNamePolicy.sol/SimplexNamePolicy.json')
const resolverAbi = abiOf('simplex/SimplexResolver.sol/SimplexResolver.json')
const subnameRegistrarAbi = abiOf('simplex/SubnameRegistrar.sol/SubnameRegistrar.json')
const registryAbi = abiOf('registry/ENSRegistry.sol/ENSRegistry.json')

const controller = addrs.ETHRegistrarController
const namePolicy = addrs.SimplexNamePolicy
const resolver = addrs.PublicResolver
const subnameRegistrar = addrs.SubnameRegistrar

async function send(address, abi, functionName, args, value = 0n) {
  const hash = await wallet.writeContract({ address, abi, functionName, args, value })
  return pub.waitForTransactionReceipt({ hash })
}

async function rpc(method, params = []) {
  const r = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return (await r.json()).result
}

const DAY = 24n * 60n * 60n
const MIN_DURATION = 730n * DAY
// against a chain started 900 days ago: 1095d (the controller's maximum) is live for
// ~195 more days, 850d is ~50 days expired with ~40 of grace left
const LIVE = 1095n * DAY
const IN_GRACE = 850n * DAY

async function register(label, { contactLink, duration = MIN_DURATION } = {}) {
  const node = namehash(`${label}.${tld}`)
  const data = contactLink
    ? [encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [node, 'simplex.contact', contactLink] })]
    : []
  const registration = {
    label,
    owner: OWNER,
    duration,
    secret: keccak256(stringToBytes(`secret-${label}`)),
    resolver,
    data,
    reverseRecord: 0,
    referrer: '0x0000000000000000000000000000000000000000000000000000000000000000',
  }
  const commitment = await pub.readContract({ address: controller, abi: controllerAbi, functionName: 'makeCommitment', args: [registration] })
  const terms = await pub.readContract({ address: namePolicy, abi: namePolicyAbi, functionName: 'generalTermsHash' })
  await send(namePolicy, namePolicyAbi, 'commitUnderGeneralTerms', [commitment, terms])

  const minAge = await pub.readContract({ address: controller, abi: controllerAbi, functionName: 'minCommitmentAge' })
  await rpc('evm_increaseTime', [Number(minAge) + 5])
  await rpc('evm_mine')

  const price = await pub.readContract({ address: controller, abi: controllerAbi, functionName: 'rentPrice', args: [label, duration] })
  const total = price.base + price.premium
  await send(controller, controllerAbi, 'register', [registration], total)
  console.log(`registered ${label}.${tld}${contactLink ? ' with a contact link' : ' with no records'}`)
}

async function main() {
  const open = await pub.readContract({ address: controller, abi: controllerAbi, functionName: 'publicSalesOpen' })
  if (!open) await send(controller, controllerAbi, 'setPublicSalesOpen', [true])

  const link = process.env.CONTACT_LINK || 'https://localhost/a#seeded-placeholder-link'

  // a live name that leads somewhere, and a live name that leads nowhere
  await register('bakery', { contactLink: link, duration: LIVE })
  await register('nolink', { duration: LIVE })

  // registered before the client's today, and inside its grace period now
  await register('expiring', { contactLink: link, duration: IN_GRACE })
  await register('lapsed', { contactLink: link })

  await send(addrs.ENSRegistry, registryAbi, 'setApprovalForAll', [subnameRegistrar, true])
  for (const parent of ['bakery', 'expiring']) {
    await send(subnameRegistrar, subnameRegistrarAbi, 'createSubname', [namehash(`${parent}.${tld}`), 'menu'])
    console.log(`created menu.${parent}.${tld}`)
  }

  // held back by the registry
  const REASON_TRADEMARK = 2
  const REASON_COMMUNITY = 3
  await send(namePolicy, namePolicyAbi, 'addReservedNames', [['privacy'], REASON_COMMUNITY])
  console.log(`reserved privacy.${tld} (community)`)
  await send(namePolicy, namePolicyAbi, 'addReservedNames', [['brandname'], REASON_TRADEMARK])
  console.log(`reserved brandname.${tld} (trademark)`)

  const now = Math.floor(Date.now() / 1000)
  await rpc('evm_setNextBlockTimestamp', [now])
  await rpc('evm_mine')
  for (const label of ['bakery', 'nolink', 'expiring', 'lapsed']) {
    const id = BigInt(keccak256(stringToBytes(label)))
    const expires = await pub.readContract({ address: addrs.BaseRegistrarImplementation, abi: abiOf('ethregistrar/BaseRegistrarImplementation.sol/BaseRegistrarImplementation.json'), functionName: 'nameExpires', args: [id] })
    const days = Math.round((Number(expires) - now) / 86400)
    console.log(
      days >= 0
        ? `${label}.${tld} expires in ${days} days`
        : `${label}.${tld} expired ${-days} days ago, ${90 + days} days of grace left`,
    )
  }

  console.log('\nseeded. sunflower.%s was never registered (available).', tld)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
