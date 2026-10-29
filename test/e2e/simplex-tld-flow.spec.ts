/**
 * End-to-end tests for the `.simplex` TLD: paid registration, no NFT gate,
 * recipient-consent transfers.
 *
 * Requires: SIMPLEX_TLD=simplex ./scripts/run-local.sh running (Hardhat node + contracts + frontend)
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  injectHeadlessWeb3Provider,
  Web3RequestKind,
} from '@ensdomains/headless-web3-provider'
import { localhost } from 'viem/chains'
import { localTermsLink } from '../../scripts/serve-terms.mjs'

const TLD = 'simplex'
const DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const ACCOUNT1_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const MIN_REGISTRATION_DURATION = 730n * 86400n
const REASON_TRADEMARK = 2

const hardhatChain = {
  ...localhost,
  id: 1337,
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
}

async function advanceTime(seconds: number) {
  await fetch('http://127.0.0.1:8545', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'evm_increaseTime', params: [seconds], id: 1 }),
  })
  await fetch('http://127.0.0.1:8545', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'evm_mine', params: [], id: 2 }),
  })
}

async function getBlockTimestamp(): Promise<number> {
  const res = await fetch('http://127.0.0.1:8545', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getBlockByNumber', params: ['latest', false], id: 1 }),
  })
  const { result } = await res.json()
  return parseInt(result.timestamp, 16)
}

async function syncBrowserClockToChain(page: any, offset: number = 0) {
  const blockTs = await getBlockTimestamp()
  await page.clock.install({ time: new Date((blockTs + offset) * 1000) })
}

async function connectWallet(page: any, wallet: any) {
  const connectButton = page.locator('[data-testid="connect-button"]').first()
  await connectButton.waitFor({ timeout: 10_000 })
  await connectButton.click()
  await page.waitForTimeout(1000)

  await page.getByText('Headless Web3 Provider').click()
  await page.waitForTimeout(500)

  const hasPerm = async () => wallet.getPendingRequestCount(Web3RequestKind.RequestPermissions) >= 1
  const hasAcct = async () => wallet.getPendingRequestCount(Web3RequestKind.RequestAccounts) >= 1

  for (let i = 0; i < 20; i++) { if (await hasPerm()) break; await page.waitForTimeout(250) }
  if (await hasPerm()) await wallet.authorize(Web3RequestKind.RequestPermissions)

  for (let i = 0; i < 20; i++) { if (await hasAcct()) break; await page.waitForTimeout(250) }
  if (await hasAcct()) await wallet.authorize(Web3RequestKind.RequestAccounts)

  await page.waitForTimeout(2000)
}

async function dismissOverlay(page: any) {
  const overlay = page.locator('[data-nextjs-dialog]')
  if (await overlay.isVisible({ timeout: 2000 }).catch(() => false)) {
    await page.locator('button[aria-label="Close"]').first().click().catch(() => {})
    await page.waitForTimeout(500)
  }
}

async function confirmTransaction(page: any, wallet: any) {
  const confirmBtn = page.getByTestId('transaction-modal-confirm-button')
  await confirmBtn.waitFor({ timeout: 10_000 })
  await confirmBtn.click()
  await wallet.authorize(Web3RequestKind.SendTransaction)
  await page.waitForTimeout(2000)
}

// Steps through a transaction dialog of one or more transactions until it closes.
async function completeTransactions(page: any, wallet: any) {
  const modal = page.getByTestId('transaction-modal-inner')
  await modal.waitFor({ timeout: 15_000 })
  for (let i = 0; i < 40 && (await modal.isVisible()); i++) {
    const intro = page.getByTestId('transaction-dialog-intro-trailing-btn')
    const confirm = page.getByTestId('transaction-modal-confirm-button')
    const complete = page.getByTestId('transaction-modal-complete-button')
    if (await intro.isVisible()) await intro.click()
    if (await confirm.isVisible()) {
      await confirm.click()
      await wallet.authorize(Web3RequestKind.SendTransaction)
    }
    if (await complete.isVisible()) await complete.click()
    await page.waitForTimeout(750)
  }
  await expect(modal).toBeHidden({ timeout: 15_000 })
}

// The text, address and contenthash records a resolver holds for `node` right now:
// each text key and coin type ever set for it (from the resolver's logs), with its
// current, non-empty value. These are the record kinds the journey test writes.
async function currentRecords(pub: any, resolver: `0x${string}`, node: `0x${string}`) {
  const { parseAbi, parseAbiItem } = await import('viem')
  const logs = (event: string) =>
    pub.getLogs({ address: resolver, event: parseAbiItem(event), args: { node }, fromBlock: 'earliest' })
  const keys = new Set<string>(
    (await logs('event TextChanged(bytes32 indexed node, string indexed indexedKey, string key, string value)')).map(
      (l: any) => l.args.key,
    ),
  )
  const coins = new Set<bigint>(
    (await logs('event AddressChanged(bytes32 indexed node, uint256 coinType, bytes newAddress)')).map(
      (l: any) => l.args.coinType,
    ),
  )
  const abi = parseAbi([
    'function text(bytes32, string) view returns (string)',
    'function addr(bytes32, uint256) view returns (bytes)',
    'function contenthash(bytes32) view returns (bytes)',
  ])
  const records: string[] = []
  for (const key of keys) {
    const value = await pub.readContract({ address: resolver, abi, functionName: 'text', args: [node, key] })
    if (value) records.push(`text ${key}=${value}`)
  }
  for (const coin of coins) {
    const value = await pub.readContract({ address: resolver, abi, functionName: 'addr', args: [node, coin] })
    if (value && value !== '0x') records.push(`addr ${coin}=${value}`)
  }
  const hash = await pub.readContract({ address: resolver, abi, functionName: 'contenthash', args: [node] })
  if (hash && hash !== '0x') records.push(`contenthash=${hash}`)
  return records
}

// Add a single record (key=value) via the add-records modal.
// If `key` matches a predefined option (e.g. com.twitter), uses it;
// otherwise falls back to the "custom" option.
// Must be called from a Profile step (registration, new subname) or the Edit Profile modal (post-registration).
async function addProfileRecord(page: any, key: string, value: string) {
  // The SimpleX link rows (simplex.contact, simplex.channel) are already on the form.
  const linkRow = page.getByTestId(`multi-url-field-${key}-input-0`)
  if (await linkRow.waitFor({ timeout: 1000 }).then(() => true, () => false)) {
    await linkRow.fill(value)
    await page.waitForTimeout(300)
    return
  }
  await page.getByTestId('show-add-profile-records-modal-button').click()
  await page.waitForTimeout(500)
  const confirmDlg = page.getByTestId('confirmation-dialog-confirm-button')
  if (await confirmDlg.isVisible({ timeout: 1500 }).catch(() => false)) {
    await confirmDlg.click()
    await page.waitForTimeout(300)
  }
  const predefined = page.getByTestId(`profile-record-option-${key}`)
  const isPredefined = await predefined.isVisible({ timeout: 1000 }).catch(() => false)
  if (isPredefined) {
    await predefined.click()
    await page.getByTestId('add-profile-records-button').click()
    await page.waitForTimeout(500)
    await page.getByTestId(`profile-record-input-input-${key}`).fill(value)
  } else {
    await page.getByTestId('profile-record-option-custom').click()
    await page.getByTestId('add-profile-records-button').click()
    await page.waitForTimeout(500)
    await page.getByTestId('custom-profile-record-input-key').fill(key)
    await page.getByTestId('custom-profile-record-input-value').fill(value)
  }
  await page.waitForTimeout(300)
}

function loadDeployments(): Record<string, `0x${string}`> {
  const path = join(process.cwd(), 'deployments.local.json')
  return JSON.parse(readFileSync(path, 'utf8'))
}

async function termsOf(label: string) {
  const { createPublicClient, http, labelhash, parseAbi } = await import('viem')
  const pub = createPublicClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545') })
  const address = loadDeployments().SimplexNamePolicy
  const abi = parseAbi([
    'function communityNames(bytes32) view returns (bool)',
    'function generalTermsHash() view returns (bytes32)',
    'function communityTermsHash() view returns (bytes32)',
  ])
  const listed = await pub.readContract({ address, abi, functionName: 'communityNames', args: [labelhash(label)] })
  return listed
    ? {
        commit: 'commitUnderCommunityTerms',
        acceptForClaim: 'acceptCommunityTermsForClaim',
        hash: await pub.readContract({ address, abi, functionName: 'communityTermsHash' }),
      }
    : {
        commit: 'commitUnderGeneralTerms',
        acceptForClaim: 'acceptGeneralTermsForClaim',
        hash: await pub.readContract({ address, abi, functionName: 'generalTermsHash' }),
      }
}

// Register a name end-to-end via direct contract calls (no UI), accepting its
// terms at commit and paying 20% over the quoted price; the controller refunds
// the excess.
async function registerNameOnChain(label: string, withResolver: boolean = false, privateKey: string = DEPLOYER_KEY) {
  const { createPublicClient, createWalletClient, http, parseAbi } = await import('viem')
  const { privateKeyToAccount } = await import('viem/accounts')
  const account = privateKeyToAccount(privateKey as `0x${string}`)
  const wallet = createWalletClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545'), account })
  const pub = createPublicClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545') })
  const deps = loadDeployments()
  const controller = deps.ETHRegistrarController
  const resolverAddr = withResolver ? deps.PublicResolver : ('0x0000000000000000000000000000000000000000' as `0x${string}`)
  const abi = parseAbi([
    'function register((string label, address owner, uint256 duration, bytes32 secret, address resolver, bytes[] data, uint8 reverseRecord, bytes32 referrer)) external payable',
    'function makeCommitment((string label, address owner, uint256 duration, bytes32 secret, address resolver, bytes[] data, uint8 reverseRecord, bytes32 referrer)) external pure returns (bytes32)',
    'function rentPrice(string,uint256) external view returns ((uint256 base, uint256 premium))',
    'function commitUnderGeneralTerms(bytes32, bytes32) external',
    'function commitUnderCommunityTerms(bytes32, bytes32) external',
  ])
  const randHex = () =>
    Array.from({ length: 32 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('')
  const reg = {
    label,
    owner: account.address,
    duration: MIN_REGISTRATION_DURATION,
    secret: (`0x${randHex()}`) as `0x${string}`,
    resolver: resolverAddr,
    data: [] as `0x${string}`[],
    reverseRecord: 0,
    referrer: ('0x' + '00'.repeat(32)) as `0x${string}`,
  }
  const commitment = await pub.readContract({ address: controller, abi, functionName: 'makeCommitment', args: [reg] })
  const terms = await termsOf(label)
  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: deps.SimplexNamePolicy, abi, functionName: terms.commit as any, args: [commitment, terms.hash] }) })
  await advanceTime(65)
  const price = await pub.readContract({ address: controller, abi, functionName: 'rentPrice', args: [label, MIN_REGISTRATION_DURATION] })
  const value = ((price as any).base + (price as any).premium) * 12n / 10n
  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: controller, abi, functionName: 'register', args: [reg], value }) })
}

async function readTextRecord(name: string, key: string): Promise<string | null> {
  const { createPublicClient, http, namehash, parseAbi } = await import('viem')
  const client = createPublicClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545') })
  const node = namehash(name)
  const registry = loadDeployments().ENSRegistry
  const registryAbi = parseAbi(['function resolver(bytes32) view returns (address)'])
  const resolver = await client.readContract({ address: registry, abi: registryAbi, functionName: 'resolver', args: [node] })
  if (!resolver || resolver === '0x0000000000000000000000000000000000000000') return null
  const resolverAbi = parseAbi(['function text(bytes32, string) view returns (string)'])
  return await client.readContract({ address: resolver, abi: resolverAbi, functionName: 'text', args: [node, key] })
}

// Drives the registration flow from a connected wallet on the search page.
// If recordsToSet is supplied, adds them via the Profile step before continuing.
async function registerNameOnUI(
  page: any,
  wallet: any,
  uniqueName: string,
  recordsToSet?: Array<{ key: string; value: string }>,
) {
  await openRegistrationOnUI(page, uniqueName)
  await commitNameOnUI(page, wallet, recordsToSet)
  await waitOutCommitmentOnUI(page)
  await finishRegistrationOnUI(page, wallet)
}

async function openRegistrationOnUI(page: any, uniqueName: string) {
  const searchInput = page.locator('input[placeholder]').first()
  await searchInput.fill(uniqueName)
  await page.waitForTimeout(3000)
  await dismissOverlay(page)

  const result = page.locator('[data-testid="search-result-name"]').first()
  await result.click()
  await page.waitForTimeout(3000)
  await dismissOverlay(page)

  await expect(page.getByRole('heading', { name: /Register/ })).toBeVisible({ timeout: 15_000 })
}

async function commitNameOnUI(page: any, wallet: any, recordsToSet?: Array<{ key: string; value: string }>) {
  // Step 1: Pricing → accept the name's terms → Next
  await page.getByTestId('terms-accept').check({ timeout: 15_000 })
  await page.getByTestId('next-button').click()
  await page.waitForTimeout(1000)

  // Step 2: Profile — add records if requested, then submit
  const profileSubmit = page.getByTestId('profile-submit-button')
  if (await profileSubmit.isVisible({ timeout: 3000 }).catch(() => false)) {
    if (recordsToSet?.length) {
      for (const r of recordsToSet) await addProfileRecord(page, r.key, r.value)
    }
    await profileSubmit.click()
    await page.waitForTimeout(1000)
  }

  // Step 3: Info → Begin
  const beginButton = page.getByTestId('next-button')
  if (await beginButton.isVisible({ timeout: 3000 }).catch(() => false)) {
    await beginButton.click()
    await page.waitForTimeout(1000)
  }

  const closeIcon = page.getByTestId('close-icon')
  if (await closeIcon.isVisible({ timeout: 2000 }).catch(() => false)) {
    await closeIcon.click()
    await page.waitForTimeout(500)
  }

  // Start timer → commit
  await page.getByTestId('start-timer-button').click()
  await page.waitForTimeout(1000)
  await confirmTransaction(page, wallet)

  await expect(page.getByTestId('countdown-circle')).toBeVisible({ timeout: 10_000 })
}

async function waitOutCommitmentOnUI(page: any) {
  await advanceTime(70)
  await syncBrowserClockToChain(page, 70)
  await page.clock.runFor(1000)
}

async function finishRegistrationOnUI(page: any, wallet: any) {
  await page.waitForTimeout(1000)

  await expect(page.getByTestId('finish-button')).toBeEnabled({ timeout: 30_000 })
  await page.getByTestId('finish-button').click()
  await page.waitForTimeout(1000)
  await confirmTransaction(page, wallet)

  await expect(page.getByTestId('view-name')).toBeVisible({ timeout: 30_000 })
}

async function writeAsDeployer(address: `0x${string}`, signature: string, args: unknown[]) {
  const { createPublicClient, createWalletClient, http, parseAbiItem } = await import('viem')
  const { privateKeyToAccount } = await import('viem/accounts')
  const pub = createPublicClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545') })
  const wallet = createWalletClient({
    chain: hardhatChain as any,
    transport: http('http://127.0.0.1:8545'),
    account: privateKeyToAccount(DEPLOYER_KEY as `0x${string}`),
  })
  const item = parseAbiItem(signature) as any
  await pub.waitForTransactionReceipt({
    hash: await wallet.writeContract({
      address,
      abi: [item],
      functionName: item.name,
      args,
    } as any),
  })
}

test.describe('SimpleX Namespace (.simplex)', () => {
  test('search appends .simplex TLD', async ({ page }) => {
    await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })
    await page.goto('/')
    await page.waitForTimeout(2000)

    await page.locator('input[placeholder]').first().fill('myname')
    await page.waitForTimeout(1000)

    await expect(page.locator('[data-testid="search-result-name"]').first())
      .toContainText(`.${TLD}`, { timeout: 10_000 })
  })

  test('search marks too-short names with the controller minimum', async ({ page }) => {
    await page.goto('/')
    await page.waitForTimeout(2000)
    await page.locator('input[placeholder]').first().fill('abcde')
    await page.waitForTimeout(3000)
    await expect(page.locator('[data-testid="search-result-name"]').first()).toContainText(/Min \d+ chars/)
  })

  test('register page shows the USD price of the label length and no credit-card option', async ({ page }) => {
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })
    await page.goto(`/pricing${Date.now().toString(36)}.${TLD}/register`)
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)
    await page.waitForTimeout(3000)
    await dismissOverlay(page)

    const tier = page.getByTestId('simplex-tier-6')
    await expect(tier).toBeVisible({ timeout: 15_000 })
    await expect(tier).toContainText('6+ chars')
    await expect(tier).toContainText('$10')
    await expect(tier).toHaveAttribute('data-active', 'true')
    await expect(page.getByTestId('simplex-tier-5')).toHaveCount(0)
    await expect(page.locator('text=/Credit card/i')).toHaveCount(0)
  })

  test('full registration flow charges the list price for the minimum term', async ({ page }) => {
    const { createPublicClient, http, parseAbi, keccak256, toBytes } = await import('viem')
    const pub = createPublicClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545') })
    const deps = loadDeployments()
    const label = `reg${Date.now().toString(36)}`
    const [price, before] = await Promise.all([
      pub.readContract({
        address: deps.ETHRegistrarController,
        abi: parseAbi(['function rentPrice(string,uint256) view returns ((uint256 base, uint256 premium))']),
        functionName: 'rentPrice',
        args: [label, MIN_REGISTRATION_DURATION],
      }),
      pub.getBalance({ address: deps.ETHRegistrarController }),
    ])
    expect((price as any).base).toBeGreaterThan(0n)

    await syncBrowserClockToChain(page)
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })
    await page.goto('/')
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)
    await registerNameOnUI(page, wallet, label)

    const owner = await pub.readContract({
      address: deps.BaseRegistrarImplementation,
      abi: parseAbi(['function ownerOf(uint256) view returns (address)']),
      functionName: 'ownerOf',
      args: [BigInt(keccak256(toBytes(label)))],
    })
    expect((owner as string).toLowerCase()).toBe('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266')
    const after = await pub.getBalance({ address: deps.ETHRegistrarController })
    expect(after - before).toBe((price as any).base + (price as any).premium)
  })

  test('set simplex.contact during registration profile step', async ({ page }) => {
    await syncBrowserClockToChain(page)
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })
    await page.goto('/')
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)

    const label = `regp${Date.now().toString(36)}`
    const contactLink = `https://simplex.chat/contact#/?v=2-7&smp=smp%3A%2F%2Fexample-${label}`
    await registerNameOnUI(page, wallet, label, [{ key: 'simplex.contact', value: contactLink }])

    expect(await readTextRecord(`${label}.${TLD}`, 'simplex.contact')).toBe(contactLink)
  })

  test('a wallet without the SMPX NFT can register (no NFT gate)', async () => {
    const { createPublicClient, http, parseAbi, keccak256, toBytes } = await import('viem')
    const { privateKeyToAccount } = await import('viem/accounts')
    const pub = createPublicClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545') })
    const deps = loadDeployments()
    const gate = await pub.readContract({
      address: deps.ETHRegistrarController,
      abi: parseAbi(['function nftGateEnabled() view returns (bool)']),
      functionName: 'nftGateEnabled',
    })
    expect(gate).toBe(false)

    const nonHolder = privateKeyToAccount(ACCOUNT1_KEY as `0x${string}`)
    const balance = await pub.readContract({
      address: deps.MockSMPXNFT,
      abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
      functionName: 'balanceOf',
      args: [nonHolder.address],
    })
    expect(balance).toBe(0n)

    const label = `ng${Date.now().toString(36)}`
    await registerNameOnChain(label, false, ACCOUNT1_KEY)
    const owner = await pub.readContract({
      address: deps.BaseRegistrarImplementation,
      abi: parseAbi(['function ownerOf(uint256) view returns (address)']),
      functionName: 'ownerOf',
      args: [BigInt(keccak256(toBytes(label)))],
    })
    expect((owner as string).toLowerCase()).toBe(nonHolder.address.toLowerCase())
  })

  test('a reserved name shows the reserved banner and cannot be registered', async ({ page }) => {
    const { createPublicClient, createWalletClient, http, parseAbi } = await import('viem')
    const { privateKeyToAccount } = await import('viem/accounts')
    const pub = createPublicClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545') })
    const adminWallet = createWalletClient({
      chain: hardhatChain as any,
      transport: http('http://127.0.0.1:8545'),
      account: privateKeyToAccount(DEPLOYER_KEY as `0x${string}`),
    })
    const label = `rsv${Date.now().toString(36)}`
    await pub.waitForTransactionReceipt({
      hash: await adminWallet.writeContract({
        address: loadDeployments().SimplexNamePolicy,
        abi: parseAbi(['function addReservedNames(string[], uint8) external']),
        functionName: 'addReservedNames',
        args: [[label], REASON_TRADEMARK],
      }),
    })

    let err: any
    try {
      await registerNameOnChain(label)
    } catch (e) {
      err = e
    }
    expect(err?.message).toMatch(/reverted|Internal error/i)

    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })
    await page.goto('/')
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)
    await page.locator('input[placeholder]').first().fill(label)
    await page.waitForTimeout(3000)
    await dismissOverlay(page)
    await expect(page.locator('[data-testid="search-result-name"]').first()).toContainText(/Reserved/, { timeout: 10_000 })

    await page.goto(`/${label}.${TLD}/register`)
    await page.waitForTimeout(3000)
    await dismissOverlay(page)
    await expect(page.getByTestId('simplex-reserved-helper')).toBeVisible({ timeout: 15_000 })
    const nextBtn = page.getByTestId('next-button')
    await expect(nextBtn).toBeDisabled({ timeout: 15_000 })
    await expect(nextBtn).toContainText(/Reserved name/i)
  })

  test('admin page refuses labels users cannot register and reserves the ones they can', async ({ page }) => {
    const { createPublicClient, http, parseAbi, keccak256, toBytes } = await import('viem')
    const pub = createPublicClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545') })
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })
    await page.goto('/')
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)
    await page.goto('/admin')
    await page.waitForTimeout(5000)
    await dismissOverlay(page)
    await expect(page.locator('text=You are the owner')).toBeVisible({ timeout: 15_000 })

    const reserveInput = page.getByLabel('Reserve name(s)', { exact: true })
    const reserveButton = page.getByRole('button', { name: 'Reserve', exact: true })
    await reserveInput.fill('Nike, nestl\u{E9}')
    await expect(page.getByText('Users cannot register: Nike, nestl\u{E9}')).toBeVisible()
    await expect(reserveButton).toBeDisabled()

    const checkInput = page.getByLabel('Check name', { exact: true })
    await checkInput.fill('Nike')
    await expect(page.getByText('Users cannot register: Nike', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Check', exact: true })).toBeDisabled()

    const label = `brand${Date.now().toString(36)}`
    await reserveInput.fill(label)
    await expect(reserveButton).toBeEnabled()
    await reserveButton.click()
    await wallet.authorize(Web3RequestKind.SendTransaction)
    await expect(page.locator('text=addReservedNames confirmed')).toBeVisible({ timeout: 15_000 })
    const reason = await pub.readContract({
      address: loadDeployments().SimplexNamePolicy,
      abi: parseAbi(['function reservedNames(bytes32) view returns (uint8)']),
      functionName: 'reservedNames',
      args: [keccak256(toBytes(label))],
    })
    expect(reason).toBe(REASON_TRADEMARK)
  })

  test('my names lists a name registered by the connected wallet', async ({ page }) => {
    const { keccak256, toBytes } = await import('viem')
    const label = `mn${Date.now().toString(36)}`
    await registerNameOnChain(label)

    await syncBrowserClockToChain(page)
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })
    await page.goto('/')
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)
    await page.evaluate(({ label, hash }) => {
      const cache = JSON.parse(window.localStorage.getItem('ensjs:labels') || '{}')
      cache[hash] = label
      window.localStorage.setItem('ensjs:labels', JSON.stringify(cache))
    }, { label, hash: keccak256(toBytes(label)) })
    await page.goto('/my/names')
    await page.waitForTimeout(8000)
    await dismissOverlay(page)
    expect(await page.textContent('body')).toContain(label)
  })

  test('direct nav to a too-short name\'s register page shows a disabled "Name too short" button', async ({ page }) => {
    const { createPublicClient, http, parseAbi } = await import('viem')
    const pub = createPublicClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545') })
    const minChar = (await pub.readContract({
      address: loadDeployments().ETHRegistrarController,
      abi: parseAbi(['function minCharLength() view returns (uint8)']),
      functionName: 'minCharLength',
    })) as number
    const tooShort = 'a'.repeat(minChar - 1)

    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })
    await page.goto(`/${tooShort}.${TLD}/register`)
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)
    await page.waitForTimeout(2000)
    await dismissOverlay(page)

    expect(page.url()).toMatch(/\/register/)
    await expect(page.getByTestId('simplex-min-chars-helper')).toContainText(new RegExp(`Minimum ${minChar} characters`, 'i'), { timeout: 15_000 })
    const nextBtn = page.getByTestId('next-button')
    await expect(nextBtn).toBeDisabled({ timeout: 15_000 })
    await expect(nextBtn).toContainText(/Name too short/i)
  })

  test('journey: name + subname, offered and claimed, then the recipient clears everything', async ({ browser }) => {
    test.setTimeout(10 * 60_000)
    const { createPublicClient, http, parseAbi, namehash, keccak256, toBytes, zeroAddress } = await import('viem')
    const { privateKeyToAccount } = await import('viem/accounts')
    const pub = createPublicClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545') })
    const deps = loadDeployments()
    const holder = privateKeyToAccount(DEPLOYER_KEY as `0x${string}`).address
    const recipient = privateKeyToAccount(ACCOUNT1_KEY as `0x${string}`).address
    const label = `journey${Date.now().toString(36)}`
    const name = `${label}.${TLD}`
    const subname = `mobile.${name}`
    const node = namehash(name)
    const subnode = namehash(subname)
    const tokenId = BigInt(keccak256(toBytes(label)))
    const nameLink = `https://simplex.chat/contact#/?v=2-7&smp=smp%3A%2F%2Fname-${label}`
    const subLink = `https://simplex.chat/contact#/?v=2-7&smp=smp%3A%2F%2Fsub-${label}`
    const ownerOfAbi = parseAbi(['function ownerOf(uint256) view returns (address)'])
    const registryAbi = parseAbi([
      'function owner(bytes32) view returns (address)',
      'function resolver(bytes32) view returns (address)',
    ])
    const ownerOf = () =>
      pub.readContract({ address: deps.BaseRegistrarImplementation, abi: ownerOfAbi, functionName: 'ownerOf', args: [tokenId] })
    const subnameOwner = () =>
      pub.readContract({ address: deps.SubnameRegistrar, abi: ownerOfAbi, functionName: 'ownerOf', args: [BigInt(subnode)] })
    const registry = (functionName: 'owner' | 'resolver', at: `0x${string}`) =>
      pub.readContract({ address: deps.ENSRegistry, abi: registryAbi, functionName, args: [at] })

    // 1. The holder registers the name with a contact link, through the UI.
    const holderContext = await browser.newContext()
    const holderPage = await holderContext.newPage()
    await syncBrowserClockToChain(holderPage)
    const holderWallet = await injectHeadlessWeb3Provider({ page: holderPage, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })
    await holderPage.goto('/')
    await holderPage.waitForTimeout(2000)
    await connectWallet(holderPage, holderWallet)
    await registerNameOnUI(holderPage, holderWallet, label, [{ key: 'simplex.contact', value: nameLink }])
    expect(await ownerOf()).toBe(holder)
    expect(await readTextRecord(name, 'simplex.contact')).toBe(nameLink)

    // 2. ... and a subname with a contact link of its own.
    await holderPage.goto(`/${name}?tab=subnames`)
    await holderPage.waitForTimeout(3000)
    await dismissOverlay(holderPage)
    await holderPage.getByTestId('add-subname-action').click({ timeout: 30_000 })
    await holderPage.getByTestId('add-subname-input').fill('mobile')
    await holderPage.getByTestId('create-subname-next').click({ timeout: 15_000 })
    await addProfileRecord(holderPage, 'simplex.contact', subLink)
    await holderPage.getByTestId('create-subname-profile-next').click({ timeout: 15_000 })
    await completeTransactions(holderPage, holderWallet)
    await expect.poll(subnameOwner, { timeout: 30_000 }).toBe(holder)
    expect(await readTextRecord(subname, 'simplex.contact')).toBe(subLink)

    // 3. The holder offers the name to the recipient: nothing moves yet.
    await holderPage.goto(`/${name}?tab=ownership`)
    await holderPage.waitForTimeout(3000)
    await dismissOverlay(holderPage)
    await holderPage.getByTestId('role-action-offer-name').click({ timeout: 30_000 })
    await holderPage.getByTestId('send-name-search-input').fill(recipient)
    await holderPage.locator('[data-testid^="search-result-"]').first().click({ timeout: 15_000 })
    await holderPage.getByTestId('offer-name-confirm').click()
    await completeTransactions(holderPage, holderWallet)
    expect(await ownerOf()).toBe(holder)

    // 4. The recipient sees the subname and the record before claiming, and claims.
    const recipientContext = await browser.newContext()
    const recipientPage = await recipientContext.newPage()
    await syncBrowserClockToChain(recipientPage)
    const recipientWallet = await injectHeadlessWeb3Provider({ page: recipientPage, privateKeys: [ACCOUNT1_KEY], chains: [hardhatChain] })
    await recipientPage.goto(`/${name}`)
    await recipientPage.waitForTimeout(2000)
    await connectWallet(recipientPage, recipientWallet)
    await dismissOverlay(recipientPage)
    await recipientPage.getByRole('button', { name: 'Review and claim' }).click({ timeout: 30_000 })
    await expect(recipientPage.getByTestId('claim-name-subnodes')).toContainText(subname, { timeout: 30_000 })
    await expect(recipientPage.getByTestId('claim-name-records')).toContainText('simplex.contact')
    await expect(recipientPage.getByTestId('claim-name-confirm')).toBeDisabled()
    await recipientPage.getByTestId('claim-name-acknowledge').check()
    await expect(recipientPage.getByTestId('claim-name-confirm')).toBeDisabled()
    await recipientPage.getByTestId('terms-accept').check()
    await recipientPage.getByTestId('claim-name-confirm').click()
    await completeTransactions(recipientPage, recipientWallet)

    // 5. The name, its registry node and the subname now belong to the recipient, records intact.
    await expect.poll(ownerOf, { timeout: 30_000 }).toBe(recipient)
    expect(await registry('owner', node)).toBe(recipient)
    expect(await subnameOwner()).toBe(recipient)
    expect(await readTextRecord(subname, 'simplex.contact')).toBe(subLink)
    expect(await readTextRecord(name, 'simplex.contact')).toBe(nameLink)

    // 6. The recipient deletes the subname ...
    await recipientPage.goto(`/${subname}`)
    await recipientPage.waitForTimeout(3000)
    await dismissOverlay(recipientPage)
    await recipientPage.locator('text="Delete subname"').click({ timeout: 30_000 })
    await completeTransactions(recipientPage, recipientWallet)
    await expect.poll(subnameOwner, { timeout: 30_000 }).toBe(zeroAddress)

    // ... and removes every record on the name.
    await recipientPage.goto(`/${name}`)
    await recipientPage.waitForTimeout(3000)
    await dismissOverlay(recipientPage)
    await recipientPage.getByTestId('profile-action-Edit profile').click({ timeout: 30_000 })
    const editor = recipientPage.getByTestId('profile-editor')
    await editor.waitFor({ timeout: 15_000 })
    for (const remove of await editor.locator('[data-testid^="multi-url-field-"][data-testid*="-remove-"]').all()) {
      await remove.click()
      await recipientPage.waitForTimeout(300)
    }
    for (let i = 0; i < 20; i++) {
      const remove = editor.locator('[data-testid$="-delete-button"]').first()
      if (!(await remove.isVisible().catch(() => false))) break
      await remove.click()
      await recipientPage.waitForTimeout(300)
    }
    await recipientPage.getByTestId('profile-submit-button').click()
    await completeTransactions(recipientPage, recipientWallet)

    // 7. Nothing is left: no record on the name, no subname, nothing under it in the registry.
    const resolver = (await registry('resolver', node)) as `0x${string}`
    await expect.poll(() => currentRecords(pub, resolver, node), { timeout: 30_000 }).toEqual([])
    expect(await currentRecords(pub, resolver, subnode)).toEqual([])
    expect(await registry('owner', subnode)).toBe(zeroAddress)
    expect(await registry('resolver', subnode)).toBe(zeroAddress)
    expect(await subnameOwner()).toBe(zeroAddress)

    // ... and the app shows neither.
    await recipientPage.goto(`/${name}?tab=subnames`)
    await expect(recipientPage.locator('text=No subnames have been added')).toBeVisible({ timeout: 30_000 })
    await expect(recipientPage.getByTestId(`name-item-${subname}`)).toHaveCount(0)
    await recipientPage.goto(`/${name}?tab=records`)
    await expect(recipientPage.getByTestId('text-amount')).toHaveText(/^0 /, { timeout: 30_000 })
    await expect(recipientPage.locator(`text=${nameLink}`)).toHaveCount(0)
    await holderContext.close()
    await recipientContext.close()
  })

  test('the holder can withdraw a pending offer', async ({ page }) => {
    const { createPublicClient, createWalletClient, http, parseAbi, keccak256, toBytes, zeroAddress } = await import('viem')
    const { privateKeyToAccount } = await import('viem/accounts')
    const pub = createPublicClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545') })
    const account = privateKeyToAccount(DEPLOYER_KEY as `0x${string}`)
    const wallet = createWalletClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545'), account })
    const registrar = loadDeployments().BaseRegistrarImplementation
    const recipient = privateKeyToAccount(ACCOUNT1_KEY as `0x${string}`).address
    const label = `keep${Date.now().toString(36)}`
    const tokenId = BigInt(keccak256(toBytes(label)))
    await registerNameOnChain(label, true)
    const registrarAbi = parseAbi([
      'function approve(address,uint256)',
      'function getApproved(uint256) view returns (address)',
    ])
    await pub.waitForTransactionReceipt({
      hash: await wallet.writeContract({ address: registrar, abi: registrarAbi, functionName: 'approve', args: [recipient, tokenId] }),
    })

    const holderWallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })
    await page.goto(`/${label}.${TLD}`)
    await page.waitForTimeout(2000)
    await connectWallet(page, holderWallet)
    await dismissOverlay(page)
    await page.getByRole('button', { name: 'Withdraw offer' }).click({ timeout: 15_000 })
    await confirmTransaction(page, holderWallet)
    await expect
      .poll(() => pub.readContract({ address: registrar, abi: registrarAbi, functionName: 'getApproved', args: [tokenId] }), { timeout: 15_000 })
      .toBe(zeroAddress)
  })

  test('a community name can be registered only for two years and only after its terms are accepted', async ({ page }) => {
    const { createPublicClient, http, keccak256, parseAbi, parseAbiItem, toBytes } = await import('viem')
    const { privateKeyToAccount } = await import('viem/accounts')
    const pub = createPublicClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545') })
    const deps = loadDeployments()
    const holder = privateKeyToAccount(DEPLOYER_KEY as `0x${string}`).address
    const label = `community${Date.now().toString(36)}`
    await writeAsDeployer(deps.SimplexNamePolicy, 'function addCommunityNames(string[])', [[label]])
    await syncBrowserClockToChain(page)
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })
    await page.goto('/')
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)
    await openRegistrationOnUI(page, label)
    await expect(page.getByTestId('terms-text')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('next-button')).toBeDisabled()
    await expect(page.getByTestId('next-button')).toContainText(/Accept the terms/)
    await expect(page.getByTestId('plus-minus-control-plus')).toBeDisabled()
    await page.getByTestId('terms-accept').check()
    await commitNameOnUI(page, wallet)
    await waitOutCommitmentOnUI(page)
    await finishRegistrationOnUI(page, wallet)

    const owner = await pub.readContract({
      address: deps.BaseRegistrarImplementation,
      abi: parseAbi(['function ownerOf(uint256) view returns (address)']),
      functionName: 'ownerOf',
      args: [BigInt(keccak256(toBytes(label)))],
    })
    expect(owner).toBe(holder)
    const accepted = await pub.getLogs({
      address: deps.SimplexNamePolicy,
      event: parseAbiItem('event CommunityTermsAccepted(string name, address indexed holder, bytes32 termsHash)'),
      fromBlock: 'earliest',
    })
    expect(accepted.map(({ args }) => [args.name, args.holder, args.termsHash])).toContainEqual([label, holder, (await termsOf(label)).hash])
  })

  test('a name listed after its commit requires accepting the terms before registration', async ({ page }) => {
    const label = `late${Date.now().toString(36)}`
    await syncBrowserClockToChain(page)
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })
    await page.goto('/')
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)
    await openRegistrationOnUI(page, label)
    await commitNameOnUI(page, wallet)

    await writeAsDeployer(loadDeployments().SimplexNamePolicy, 'function addCommunityNames(string[])', [[label]])
    await waitOutCommitmentOnUI(page)
    await page.reload()
    await page.waitForTimeout(3000)
    await dismissOverlay(page)
    await expect(page.getByTestId('accept-terms-button')).toBeDisabled({ timeout: 30_000 })
    await expect(page.getByTestId('finish-button')).toBeDisabled()
    await page.getByTestId('terms-accept').check()
    await page.getByTestId('accept-terms-button').click()
    await confirmTransaction(page, wallet)
    await expect(page.getByTestId('accept-terms-button')).toBeHidden({ timeout: 30_000 })
    await finishRegistrationOnUI(page, wallet)
  })

  for (const { kind, listed, setter, file } of [
    { kind: 'general terms', listed: false, setter: 'setGeneralTerms', file: 'general-terms' },
    { kind: 'community terms', listed: true, setter: 'setCommunityTerms', file: 'community-terms' },
  ]) {
    test(`the ${kind} prompt returns with the new terms when they change after Finish was opened and closed`, async ({ page }) => {
      const deps = loadDeployments()
      const label = `newterms${Date.now().toString(36)}`
      if (listed) await writeAsDeployer(deps.SimplexNamePolicy, 'function addCommunityNames(string[])', [[label]])
      await syncBrowserClockToChain(page)
      const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })
      await page.goto('/')
      await page.waitForTimeout(2000)
      await connectWallet(page, wallet)
      await openRegistrationOnUI(page, label)
      await commitNameOnUI(page, wallet)
      await waitOutCommitmentOnUI(page)
      await page.getByTestId('finish-button').click({ timeout: 30_000 })
      await page.getByTestId('close-icon').click({ timeout: 15_000 })

      try {
        await writeAsDeployer(deps.SimplexNamePolicy, `function ${setter}(string)`, [localTermsLink(`${file}-v2.md`)])
        await page.reload()
        await page.waitForTimeout(3000)
        await dismissOverlay(page)
        const title = readFileSync(join(process.cwd(), 'test', 'fixtures', 'terms', `${file}-v2.md`), 'utf8').split('\n')[0].replace(/^# /, '')
        await expect(page.getByTestId('terms-text')).toContainText(title, { timeout: 30_000 })
        await expect(page.getByTestId('finish-button')).toBeDisabled()
      } finally {
        await writeAsDeployer(deps.SimplexNamePolicy, `function ${setter}(string)`, [localTermsLink(`${file}.md`)])
      }
    })
  }

  test('a community name can be claimed only after the recipient accepts its terms', async ({ page }) => {
    const { createPublicClient, http, keccak256, parseAbi, toBytes } = await import('viem')
    const { privateKeyToAccount } = await import('viem/accounts')
    const pub = createPublicClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545') })
    const deps = loadDeployments()
    const recipient = privateKeyToAccount(ACCOUNT1_KEY as `0x${string}`).address
    const label = `community${Date.now().toString(36)}`
    const tokenId = BigInt(keccak256(toBytes(label)))
    await writeAsDeployer(deps.SimplexNamePolicy, 'function addCommunityNames(string[])', [[label]])
    await registerNameOnChain(label)
    await writeAsDeployer(deps.BaseRegistrarImplementation, 'function approve(address,uint256)', [recipient, tokenId])

    await syncBrowserClockToChain(page)
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [ACCOUNT1_KEY], chains: [hardhatChain] })
    await page.goto(`/${label}.${TLD}`)
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)
    await dismissOverlay(page)
    await page.getByRole('button', { name: 'Review and claim' }).click({ timeout: 30_000 })
    await expect(page.getByTestId('terms-text')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('claim-name-confirm')).toBeDisabled()
    await page.getByTestId('terms-accept').check()
    await page.getByTestId('claim-name-confirm').click()
    await completeTransactions(page, wallet)
    const ownerOf = () =>
      pub.readContract({
        address: deps.BaseRegistrarImplementation,
        abi: parseAbi(['function ownerOf(uint256) view returns (address)']),
        functionName: 'ownerOf',
        args: [tokenId],
      })
    await expect.poll(ownerOf, { timeout: 30_000 }).toBe(recipient)
  })

  test('a plain name is refused at registration and at claim without the general terms', async () => {
    const { createPublicClient, createWalletClient, http, keccak256, parseAbi, toBytes, zeroAddress, zeroHash } = await import('viem')
    const { privateKeyToAccount } = await import('viem/accounts')
    const pub = createPublicClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545') })
    const walletOf = (key: string) =>
      createWalletClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545'), account: privateKeyToAccount(key as `0x${string}`) })
    const holder = walletOf(DEPLOYER_KEY)
    const recipient = walletOf(ACCOUNT1_KEY)
    const deps = loadDeployments()
    const abi = parseAbi([
      'function register((string label, address owner, uint256 duration, bytes32 secret, address resolver, bytes[] data, uint8 reverseRecord, bytes32 referrer)) external payable',
      'function makeCommitment((string label, address owner, uint256 duration, bytes32 secret, address resolver, bytes[] data, uint8 reverseRecord, bytes32 referrer)) external pure returns (bytes32)',
      'function commit(bytes32) external',
      'function rentPrice(string,uint256) external view returns ((uint256 base, uint256 premium))',
      'function approve(address,uint256)',
      'function offers(uint256) view returns (uint256)',
      'function transferFrom(address,address,uint256)',
      'function ownerOf(uint256) view returns (address)',
      'function acceptGeneralTermsForClaim(uint256,address,uint256,bytes32)',
      'function commitUnderGeneralTerms(bytes32,bytes32)',
    ])
    const send = async (wallet: any, address: `0x${string}`, functionName: string, args: unknown[], value?: bigint) =>
      pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address, abi, functionName, args, value } as any) })
    const simulate = (wallet: any, address: `0x${string}`, functionName: string, args: unknown[], value?: bigint) =>
      pub.simulateContract({ account: wallet.account, address, abi, functionName, args, value } as any)

    const refused = `plain${Date.now().toString(36)}`
    const reg = {
      label: refused,
      owner: holder.account.address,
      duration: MIN_REGISTRATION_DURATION,
      secret: zeroHash,
      resolver: zeroAddress,
      data: [] as `0x${string}`[],
      reverseRecord: 0,
      referrer: zeroHash,
    }
    const commitment = await pub.readContract({ address: deps.ETHRegistrarController, abi, functionName: 'makeCommitment', args: [reg] })
    await send(holder, deps.ETHRegistrarController, 'commit', [commitment])
    await advanceTime(65)
    const price = await pub.readContract({ address: deps.ETHRegistrarController, abi, functionName: 'rentPrice', args: [refused, MIN_REGISTRATION_DURATION] })
    const value = (price.base + price.premium) * 2n
    await expect(simulate(holder, deps.ETHRegistrarController, 'register', [reg], value)).rejects.toThrow(/reverted|Internal error/i)
    await send(holder, deps.SimplexNamePolicy, 'commitUnderGeneralTerms', [commitment, (await termsOf(refused)).hash])
    await send(holder, deps.ETHRegistrarController, 'register', [reg], value)

    const claimed = `claimed${Date.now().toString(36)}`
    const tokenId = BigInt(keccak256(toBytes(claimed)))
    await registerNameOnChain(claimed)
    await send(holder, deps.BaseRegistrarImplementation, 'approve', [recipient.account.address, tokenId])
    const take = [holder.account.address, recipient.account.address, tokenId]
    await expect(simulate(recipient, deps.BaseRegistrarImplementation, 'transferFrom', take)).rejects.toThrow(/reverted|Internal error/i)
    const offer = await pub.readContract({ address: deps.BaseRegistrarImplementation, abi, functionName: 'offers', args: [tokenId] })
    await send(recipient, deps.SimplexNamePolicy, 'acceptGeneralTermsForClaim', [tokenId, holder.account.address, offer, (await termsOf(claimed)).hash])
    await send(recipient, deps.BaseRegistrarImplementation, 'transferFrom', take)
    expect(await pub.readContract({ address: deps.BaseRegistrarImplementation, abi, functionName: 'ownerOf', args: [tokenId] })).toBe(recipient.account.address)
  })

  test('while the general terms link is not a terms link, the pricing step says names cannot be registered now', async ({ page }) => {
    const deps = loadDeployments()
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })
    await page.goto('/')
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)
    try {
      await writeAsDeployer(deps.SimplexNamePolicy, 'function setGeneralTerms(string)', ['not a terms link'])
      await openRegistrationOnUI(page, `noterms${Date.now().toString(36)}`)
      await expect(page.getByTestId('terms-unset')).toContainText("names can't be registered", { timeout: 15_000 })
      await expect(page.getByTestId('next-button')).toBeDisabled()
    } finally {
      await writeAsDeployer(deps.SimplexNamePolicy, 'function setGeneralTerms(string)', [localTermsLink('general-terms.md')])
    }
  })

  test('a held name, once reserved, cannot be extended', async ({ page }) => {
    const label = `held${Date.now().toString(36)}`
    await registerNameOnChain(label)
    await writeAsDeployer(loadDeployments().SimplexNamePolicy, 'function addReservedNames(string[], uint8)', [[label], REASON_TRADEMARK])

    await syncBrowserClockToChain(page)
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })
    await page.goto(`/${label}.${TLD}?tab=ownership`)
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)
    await dismissOverlay(page)
    await page.getByTestId('expiry-action-extend').click({ timeout: 30_000 })
    await expect(page.getByTestId('extend-names-reserved')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('extend-names-confirm')).toBeDisabled()
  })

  test('admin page shows both terms from their links, lists a community name and caps its reserved registration at 1095 days', async ({ page }) => {
    const { createPublicClient, http, keccak256, parseAbi, toBytes } = await import('viem')
    const pub = createPublicClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545') })
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })
    await page.goto('/')
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)
    await page.goto('/admin')
    await page.waitForTimeout(5000)
    await dismissOverlay(page)
    await expect(page.locator('text=You are the owner')).toBeVisible({ timeout: 15_000 })
    for (const [prefix, file] of [
      ['admin-community-terms', 'community-terms.md'],
      ['admin-general-terms', 'general-terms.md'],
    ]) {
      const title = readFileSync(join(process.cwd(), 'test', 'fixtures', 'terms', file), 'utf8').split('\n')[0].replace(/^# /, '')
      await expect(page.getByTestId(`${prefix}-hash`)).toContainText(keccak256(toBytes(localTermsLink(file))), { timeout: 15_000 })
      await expect(page.getByTestId(`${prefix}-text`)).toContainText(title, { timeout: 15_000 })
    }

    const label = `community${Date.now().toString(36)}`
    await page.getByLabel('List name(s)', { exact: true }).fill(label)
    await page.getByTestId('admin-list-community').click()
    await wallet.authorize(Web3RequestKind.SendTransaction)
    await expect(page.locator('text=addCommunityNames confirmed')).toBeVisible({ timeout: 15_000 })
    const listed = await pub.readContract({
      address: loadDeployments().SimplexNamePolicy,
      abi: parseAbi(['function communityNames(bytes32) view returns (bool)']),
      functionName: 'communityNames',
      args: [keccak256(toBytes(label))],
    })
    expect(listed).toBe(true)
    await expect(page.getByText('730–4015 days')).toBeVisible()
    await page.getByLabel('Label', { exact: true }).fill(label)
    await expect(page.getByText('730–1095 days')).toBeVisible({ timeout: 15_000 })
  })
})
