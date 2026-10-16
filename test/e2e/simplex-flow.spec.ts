/**
 * End-to-end tests for SimpleX Namespace.
 *
 * Requires: ./scripts/run-local.sh running (Hardhat node + contracts + frontend)
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  injectHeadlessWeb3Provider,
  Web3RequestKind,
} from '@ensdomains/headless-web3-provider'
import { localhost } from 'viem/chains'

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

// Register a name end-to-end via direct contract calls (no UI). Used to set up
// state for tests that exercise post-registration flows without dragging in the
// frontend's registration-flow localStorage / cache quirks.
function loadDeployments(): Record<string, `0x${string}`> {
  // Resolve from the test file's location regardless of how the runner sets cwd.
  const path = join(process.cwd(), 'deployments.local.json')
  return JSON.parse(readFileSync(path, 'utf8'))
}

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
    'function commit(bytes32) external',
    'function rentPrice(string,uint256) external view returns ((uint256 base, uint256 premium))',
  ])
  // Random secret per call so that a second attempt at the same label (e.g. after a
  // first attempt reverted) doesn't collide with the still-active commitment.
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
  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: controller, abi, functionName: 'commit', args: [commitment] }) })
  await advanceTime(65)
  const price = await pub.readContract({ address: controller, abi, functionName: 'rentPrice', args: [label, MIN_REGISTRATION_DURATION] })
  const value = ((price as any).base + (price as any).premium) * 12n / 10n
  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: controller, abi, functionName: 'register', args: [reg], value }) })
}

async function readTextRecord(name: string, key: string): Promise<string | null> {
  const { createPublicClient, http, namehash, encodeFunctionData, decodeFunctionResult, parseAbi } = await import('viem')
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
  const searchInput = page.locator('input[placeholder]').first()
  await searchInput.fill(uniqueName)
  await page.waitForTimeout(3000)
  await dismissOverlay(page)

  const result = page.locator('[data-testid="search-result-name"]').first()
  await result.click()
  await page.waitForTimeout(3000)
  await dismissOverlay(page)

  await expect(page.getByRole('heading', { name: /Register/ })).toBeVisible({ timeout: 15_000 })

  // Step 1: Pricing → Next
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
  await advanceTime(70)
  await syncBrowserClockToChain(page, 70)
  await page.clock.runFor(1000)
  await page.waitForTimeout(1000)

  await expect(page.getByTestId('finish-button')).toBeEnabled({ timeout: 30_000 })
  await page.getByTestId('finish-button').click()
  await page.waitForTimeout(1000)
  await confirmTransaction(page, wallet)

  await expect(page.getByTestId('view-name')).toBeVisible({ timeout: 30_000 })
}

test.describe('SimpleX Namespace', () => {
  test('homepage loads and shows search', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('input[placeholder]').first()).toBeVisible({ timeout: 15_000 })
  })

  test('search appends .testing TLD', async ({ page }) => {
    await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })
    await page.goto('/')
    await page.waitForTimeout(2000)

    const searchInput = page.locator('input[placeholder]').first()
    await searchInput.fill('myname')
    await page.waitForTimeout(1000)

    await expect(page.locator('[data-testid="search-result-name"]').first())
      .toContainText('.testing', { timeout: 10_000 })
  })

  test('search with connected wallet does not crash', async ({ page }) => {
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })

    await page.goto('/')
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)

    const searchInput = page.locator('input[placeholder]').first()
    await searchInput.fill('testname')
    await page.waitForTimeout(3000)
    await dismissOverlay(page)

    await expect(page.locator('[data-testid="search-result-name"]').first())
      .toContainText('.testing', { timeout: 10_000 })
  })

  test('search shows name as available', async ({ page }) => {
    page.on('console', (msg) => {
      const text = msg.text()
      if (text.includes('[simplex')) console.log('BROWSER:', text)
    })
    page.on('request', async (request) => {
      if (request.url() === 'http://127.0.0.1:8545/' && request.method() === 'POST') {
        try {
          const body = JSON.parse(request.postData() || '{}')
          if (body.method === 'eth_call' && body.params?.[0]?.to === '0x99bba657f2bbc93c02d617f8ba121cb8fc104acf') {
            console.log('REQ MULTICALL:', JSON.stringify(body.params[0]).slice(0, 500))
          }
        } catch {}
      }
    })
    page.on('response', async (response) => {
      if (response.url() === 'http://127.0.0.1:8545/' && response.request().method() === 'POST') {
        try {
          const body = JSON.parse(response.request().postData() || '{}')
          if (body.method === 'eth_call' && body.params?.[0]?.to === '0x99bba657f2bbc93c02d617f8ba121cb8fc104acf') {
            const respBody = await response.text()
            if (respBody.includes('error')) console.log('RESP MULTICALL ERR:', respBody.slice(0, 300))
          }
        } catch {}
      }
    })
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })

    await page.goto('/')
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)

    const searchInput = page.locator('input[placeholder]').first()
    await searchInput.fill('available')
    await page.waitForTimeout(5000)
    await dismissOverlay(page)

    await expect(page.locator('[data-testid="search-result-name"]').first())
      .toContainText('Available', { timeout: 10_000 })
  })

  test('clicking available name navigates to registration', async ({ page }) => {
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })

    await page.goto('/')
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)

    const searchInput = page.locator('input[placeholder]').first()
    await searchInput.fill('register')
    await page.waitForTimeout(3000)
    await dismissOverlay(page)

    const result = page.locator('[data-testid="search-result-name"]').first()
    await result.click()
    await page.waitForTimeout(3000)
    await dismissOverlay(page)

    await expect(page.getByRole('heading', { name: /Register/ })).toBeVisible({ timeout: 15_000 })
  })

  test('full registration flow: commit and register', async ({ page }) => {
    await syncBrowserClockToChain(page)
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })

    await page.goto('/')
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)

    // Use a unique name per run to avoid collision with already-registered names
    const uniqueName = `reg${Date.now().toString(36)}`
    const searchInput = page.locator('input[placeholder]').first()
    await searchInput.fill(uniqueName)
    await page.waitForTimeout(3000)
    await dismissOverlay(page)

    const result = page.locator('[data-testid="search-result-name"]').first()
    await result.click()
    await page.waitForTimeout(3000)
    await dismissOverlay(page)

    // Should be on registration page
    await expect(page.getByRole('heading', { name: /Register/ })).toBeVisible({ timeout: 15_000 })

    // Step 1: Pricing — click next
    const nextButton = page.getByTestId('next-button')
    await nextButton.waitFor({ timeout: 10_000 })
    await nextButton.click()
    await page.waitForTimeout(1000)

    // Step 2: Profile — skip (click submit/next)
    const profileSubmit = page.getByTestId('profile-submit-button')
    if (await profileSubmit.isVisible({ timeout: 3000 }).catch(() => false)) {
      await profileSubmit.click()
      await page.waitForTimeout(1000)
    }

    // Step 3: Info/Begin — click Begin
    const beginButton = page.getByTestId('next-button')
    if (await beginButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await beginButton.click()
      await page.waitForTimeout(1000)
    }

    // Transaction modal may appear — close it
    const closeIcon = page.getByTestId('close-icon')
    if (await closeIcon.isVisible({ timeout: 2000 }).catch(() => false)) {
      await closeIcon.click()
      await page.waitForTimeout(500)
    }

    // Start timer (commit transaction)
    const startTimer = page.getByTestId('start-timer-button')
    await startTimer.waitFor({ timeout: 10_000 })
    await startTimer.click()
    await page.waitForTimeout(1000)

    // Confirm commit transaction
    await confirmTransaction(page, wallet)

    // Wait for countdown to appear
    await expect(page.getByTestId('countdown-circle')).toBeVisible({ timeout: 10_000 })

    // Advance chain past minCommitmentAge, then set browser clock well past commit timestamp.
    // Browser cushion = 70s ensures countdown's commitTimestamp + 60000 < Date.now() is satisfied
    // regardless of which block the commit landed in.
    await advanceTime(70)
    await syncBrowserClockToChain(page, 70)
    await page.clock.runFor(1000)
    await page.waitForTimeout(1000)

    // Should show finish button enabled
    await expect(page.getByTestId('finish-button')).toBeEnabled({ timeout: 30_000 })

    // Click finish to start register transaction
    await page.getByTestId('finish-button').click()
    await page.waitForTimeout(1000)

    // Confirm register transaction
    await confirmTransaction(page, wallet)

    // Should show completion — view-name button appears
    await expect(page.getByTestId('view-name')).toBeVisible({ timeout: 30_000 })
  })

  test('admin panel: view state and manage settings', async ({ page }) => {
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })

    await page.goto('/')
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)

    await page.goto('/admin')
    await page.waitForTimeout(5000)

    await expect(page.locator('text=SimpleX Namespace Admin')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('text=Min char length')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('text=You are the owner')).toBeVisible({ timeout: 5_000 })
  })

  test('set simplex.contact during registration profile step', async ({ page }) => {
    await syncBrowserClockToChain(page)
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })

    await page.goto('/')
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)

    const uniqueName = `regp${Date.now().toString(36)}`
    const contactLink = `https://simplex.chat/contact#/?v=2-7&smp=smp%3A%2F%2Fexample-${uniqueName}`

    await registerNameOnUI(page, wallet, uniqueName, [
      { key: 'simplex.contact', value: contactLink },
    ])

    // Verify on-chain that the resolver has the text record set.
    const stored = await readTextRecord(`${uniqueName}.testing`, 'simplex.contact')
    expect(stored).toBe(contactLink)
  })

  test('set simplex.contact after registration via profile editor', async ({ page }) => {
    const uniqueName = `rege${Date.now().toString(36)}`
    const contactLink = `https://simplex.chat/contact#/?v=2-7&smp=smp%3A%2F%2Fexample-${uniqueName}`

    // Pre-register the name + set up a resolver via direct contract call. We need a
    // resolver attached for the profile page to show the Edit Profile action.
    await registerNameOnChain(uniqueName, /* withResolver */ true)

    await syncBrowserClockToChain(page)
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })

    await page.goto('/')
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)

    await page.goto(`/${uniqueName}.testing`)
    await page.waitForTimeout(8000)
    await dismissOverlay(page)

    const editBtn = page.getByTestId('profile-action-Edit profile')
    await editBtn.waitFor({ timeout: 15_000 })
    await editBtn.click()
    await page.waitForTimeout(1000)

    await addProfileRecord(page, 'simplex.contact', contactLink)

    await page.getByTestId('profile-submit-button').click()
    await page.waitForTimeout(1000)
    await confirmTransaction(page, wallet)
    await page.waitForTimeout(2000)

    // Verify on-chain
    const stored = await readTextRecord(`${uniqueName}.testing`, 'simplex.contact')
    expect(stored).toBe(contactLink)

    // Verify the record actually shows in the profile UI (the bug the user hit:
    // setting a record persisted on-chain but didn't display because the profile
    // didn't fetch unknown keys without a subgraph).
    await page.reload()
    await page.waitForTimeout(5000)
    await dismissOverlay(page)
    const linkLocator = page.getByTestId('social-profile-button-simplex.contact')
    await expect(linkLocator).toBeVisible({ timeout: 15_000 })
    // Display text is the friendly label, not the raw URL
    await expect(linkLocator).toContainText('SimpleX Contact')
    // …but the link href points at the actual record value
    await expect(linkLocator).toHaveAttribute('href', contactLink)
  })

  // Documents the contract-enforced NFT gate on the .testing TLD: an account
  // without an SMPXNFT cannot complete a registration. The check sits in
  // SimplexController._checkSimplexGates and only fires during register(), so
  // commit() succeeds. We drive commit via writeContract, then assert that the
  // register() simulation reverts with the NftRequired custom error.
  test('registration fails for an account without the SMPX NFT', async () => {
    const { createPublicClient, createWalletClient, http, parseAbi } = await import('viem')
    const { privateKeyToAccount } = await import('viem/accounts')
    const account = privateKeyToAccount(ACCOUNT1_KEY as `0x${string}`)
    const wallet = createWalletClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545'), account })
    const pub = createPublicClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545') })
    const controller = loadDeployments().ETHRegistrarController
    const abi = parseAbi([
      'function register((string label, address owner, uint256 duration, bytes32 secret, address resolver, bytes[] data, uint8 reverseRecord, bytes32 referrer)) external payable',
      'function makeCommitment((string label, address owner, uint256 duration, bytes32 secret, address resolver, bytes[] data, uint8 reverseRecord, bytes32 referrer)) external pure returns (bytes32)',
      'function commit(bytes32) external',
      'function rentPrice(string,uint256) external view returns ((uint256 base, uint256 premium))',
      'error NftRequired()',
    ])
    const reg = {
      label: `nft${Date.now().toString(36)}`,
      owner: account.address,
      duration: MIN_REGISTRATION_DURATION,
      secret: ('0x' + 'cc'.repeat(32)) as `0x${string}`,
      resolver: '0x0000000000000000000000000000000000000000' as `0x${string}`,
      data: [] as `0x${string}`[],
      reverseRecord: 0,
      referrer: ('0x' + '00'.repeat(32)) as `0x${string}`,
    }
    const commitment = await pub.readContract({ address: controller, abi, functionName: 'makeCommitment', args: [reg] })
    await pub.waitForTransactionReceipt({
      hash: await wallet.writeContract({ address: controller, abi, functionName: 'commit', args: [commitment] }),
    })
    await advanceTime(65)
    const price = await pub.readContract({ address: controller, abi, functionName: 'rentPrice', args: [reg.label, MIN_REGISTRATION_DURATION] })
    const value = ((price as any).base + (price as any).premium) * 12n / 10n

    // Pre-flight: confirm the gate is actually on. If a previous test disabled it,
    // this assertion documents the change rather than failing silently. Also skip
    // the rest of the test if a prior test (e.g. "disableNftGate then non-holder
    // registers") permanently turned the gate off in the same chain session.
    const nftGateAbi = parseAbi([
      'function nftGateEnabled() view returns (bool)',
      'function smpxNft() view returns (address)',
    ])
    const gateOn = await pub.readContract({ address: controller, abi: nftGateAbi, functionName: 'nftGateEnabled' })
    test.skip(gateOn === false, 'NFT gate was already disabled by a prior test')
    const nft = await pub.readContract({ address: controller, abi: nftGateAbi, functionName: 'smpxNft' })
    expect(gateOn).toBe(true)
    const nftBalAbi = parseAbi(['function balanceOf(address) view returns (uint256)'])
    const bal = await pub.readContract({ address: nft, abi: nftBalAbi, functionName: 'balanceOf', args: [account.address] })
    expect(bal).toBe(0n)

    // Now the actual assertion: register() reverts for ACCOUNT1.
    let err: any
    try {
      await pub.simulateContract({ address: controller, abi, functionName: 'register', args: [reg], account, value })
    } catch (e) {
      err = e
    }
    expect(err).toBeDefined()
    // Hardhat returns a generic "Internal error" for custom revert errors instead
    // of the decoded name. The pre-flight checks above (gate on, NFT balance 0) make
    // it unambiguous that the revert is the NFT gate firing.
    expect(err.message).toMatch(/reverted|Internal error/i)
  })

  test('search marks too-short names with the controller minimum', async ({ page }) => {
    await page.goto('/')
    await page.waitForTimeout(2000)
    const searchInput = page.locator('input[placeholder]').first()
    // 2-char label stays below the floor for any contract minCharLength >= 3,
    // which avoids a state-pollution failure after a prior test that lowered
    // the minimum to 3.
    await searchInput.fill('ab')
    await page.waitForTimeout(3000)
    // The status tag carries the live contract minimum, not just a generic "Too Short"
    const result = page.locator('[data-testid="search-result-name"]').first()
    await expect(result).toContainText(/Min \d+ chars/)
  })

  test('my names lists a name registered by the connected wallet', async ({ page }) => {
    const { keccak256, toBytes } = await import('viem')
    const uniqueName = `mn${Date.now().toString(36)}`
    await registerNameOnChain(uniqueName)
    const labelhash = keccak256(toBytes(uniqueName))

    await syncBrowserClockToChain(page)
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })
    await page.goto('/')
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)
    // Seed the ensjs label cache so the on-chain fallback can resolve the labelhash
    // back to the human label. (UI flow already does this on search; we skipped that
    // by registering via direct contract call.)
    await page.evaluate(({ label, hash }) => {
      const cache = JSON.parse(window.localStorage.getItem('ensjs:labels') || '{}')
      cache[hash] = label
      window.localStorage.setItem('ensjs:labels', JSON.stringify(cache))
    }, { label: uniqueName, hash: labelhash })
    await page.goto('/my/names')
    await page.waitForTimeout(8000)
    await dismissOverlay(page)
    const body = await page.textContent('body')
    expect(body).toContain(uniqueName)
  })

  test('registration pricing page hides USD tiers and credit-card option on .testing', async ({ page }) => {
    // .testing is free during the testing phase — the pricing tiers panel and
    // the Moonpay credit-card payment-choice are both intentionally hidden so
    // the user sees only the gas-only registration UI.
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })
    await page.goto('/')
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)

    const uniqueName = `tier${Date.now().toString(36)}`
    const searchInput = page.locator('input[placeholder]').first()
    await searchInput.fill(uniqueName)
    await page.waitForTimeout(3000)
    await dismissOverlay(page)
    await page.locator('[data-testid="search-result-name"]').first().click()
    await page.waitForTimeout(5000)
    await dismissOverlay(page)

    await expect(page.getByTestId('simplex-tier-3')).toHaveCount(0)
    await expect(page.getByTestId('simplex-tier-4')).toHaveCount(0)
    await expect(page.getByTestId('simplex-tier-5')).toHaveCount(0)
    await expect(page.getByTestId('simplex-tier-6')).toHaveCount(0)
    await expect(page.locator('text=/Credit card/i')).toHaveCount(0)
  })

  // Admin lowers the controller's minimum char length from 6 to 3, then registers a
  // 3-char name end-to-end. Asserts: (1) admin tx confirms and the page shows the
  // new minimum, (2) the search no longer marks the short name as Too Short,
  // (3) the full commit/register flow succeeds for the now-allowed 3-char label.
  test('admin lowers min char length and registers a name at the new floor', async ({ page }) => {
    // Read current minCharLength on-chain. Lowering is monotonic so this test
    // is parametric in the starting state: from N, lower to N-1, then register
    // an (N-1)-char name. Skips if the floor is already below 2.
    const { createPublicClient, http, parseAbi, keccak256, toBytes } = await import('viem')
    const pub = createPublicClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545') })
    const controller = loadDeployments().ETHRegistrarController
    const minAbi = parseAbi(['function minCharLength() view returns (uint8)'])
    const currentMin = (await pub.readContract({ address: controller, abi: minAbi, functionName: 'minCharLength' })) as number
    test.skip(currentMin < 2, `min char length is ${currentMin}; nothing left to lower`)
    const newMin = currentMin - 1

    await syncBrowserClockToChain(page)
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })

    await page.goto('/')
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)

    await page.goto('/admin')
    await page.waitForTimeout(5000)
    await dismissOverlay(page)

    await expect(page.locator(`text=Min char length: ${currentMin}`)).toBeVisible({ timeout: 15_000 })

    await page.getByTestId('admin-new-min-char-input').fill(String(newMin))
    await page.getByTestId('admin-set-min-char-button').click()
    await wallet.authorize(Web3RequestKind.SendTransaction)
    await page.waitForTimeout(3000)
    await expect(page.locator(`text=Min char length: ${newMin}`)).toBeVisible({ timeout: 15_000 })

    // Register an (newMin)-char name via the regular UI flow.
    const rand = () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]
    const newMinName = Array.from({ length: newMin }, rand).join('')

    await page.goto('/')
    await page.waitForTimeout(3000)
    await dismissOverlay(page)
    await registerNameOnUI(page, wallet, newMinName)

    const base = loadDeployments().BaseRegistrarImplementation
    const labelhash = keccak256(toBytes(newMinName))
    const owner = await pub.readContract({
      address: base,
      abi: parseAbi(['function ownerOf(uint256) view returns (address)']),
      functionName: 'ownerOf',
      args: [BigInt(labelhash)],
    })
    expect((owner as string).toLowerCase()).toBe('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266')
  })

  test('NFT-gate banner shows and Next is disabled when an NFT-less wallet reaches /register directly', async ({ page }) => {
    // Search-click now blocks navigation outright for NFT-less wallets (see
    // the "clicking an available name without NFT" test). The Pricing-step
    // banner + disabled Next button still fire via direct URL — which is
    // the second line of defence the contract gate already enforces.
    const { createPublicClient, http, parseAbi } = await import('viem')
    const pub = createPublicClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545') })
    const controller = loadDeployments().ETHRegistrarController
    const gateOn = (await pub.readContract({
      address: controller,
      abi: parseAbi(['function nftGateEnabled() view returns (bool)']),
      functionName: 'nftGateEnabled',
    })) as boolean
    test.skip(gateOn === false, 'NFT gate was already disabled by a prior test')

    // ACCOUNT1 has no SMPXNFT — direct nav to a register page should still
    // render the in-page banner + disabled next button.
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [ACCOUNT1_KEY], chains: [hardhatChain] })
    const uniqueName = `nft${Date.now().toString(36)}`
    await page.goto(`/${uniqueName}.testing/register`)
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)
    await page.waitForTimeout(3000)
    await dismissOverlay(page)

    await expect(page.getByTestId('simplex-nft-gate-helper')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('simplex-nft-gate-helper')).toContainText(
      /does not currently hold one/i,
    )
    const nextBtn = page.getByTestId('next-button')
    await expect(nextBtn).toBeDisabled({ timeout: 15_000 })
    await expect(nextBtn).toContainText(/SimpleX NFT required/i)
  })

  // UI test: drop a 4-char name on the registration page and verify that the
  // After admin lowers minCharLength to 4, the FullInvoice on .testing renders
  // a 4-char name with the free-pricing oracle ([0,0,0,0,0]) — the yearly
  // registration cost in the invoice is 0 ETH (gas only). On .simplex this
  // would highlight the $32 tier; on .testing the tier panel is suppressed.
  test('on .testing, a 4-char name shows zero registration cost (free pricing)', async ({ page }) => {
    const { createPublicClient, createWalletClient, http, parseAbi } = await import('viem')
    const { privateKeyToAccount } = await import('viem/accounts')
    const pub = createPublicClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545') })
    const adminAccount = privateKeyToAccount(DEPLOYER_KEY as `0x${string}`)
    const adminWallet = createWalletClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545'), account: adminAccount })
    const controller = loadDeployments().ETHRegistrarController
    const minAbi = parseAbi([
      'function minCharLength() view returns (uint8)',
      'function setMinCharLength(uint8) external',
    ])
    const currentMin = (await pub.readContract({ address: controller, abi: minAbi, functionName: 'minCharLength' })) as number
    if (currentMin > 4) {
      await pub.waitForTransactionReceipt({
        hash: await adminWallet.writeContract({
          address: controller, abi: minAbi, functionName: 'setMinCharLength', args: [4],
        }),
      })
    }

    await syncBrowserClockToChain(page)
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })

    await page.goto('/')
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)

    const rand = () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]
    const fourChar = `${rand()}${rand()}${rand()}${rand()}`

    const searchInput = page.locator('input[placeholder]').first()
    await searchInput.fill(fourChar)
    await page.waitForTimeout(3000)
    await dismissOverlay(page)
    await page.locator('[data-testid="search-result-name"]').first().click()
    await page.waitForTimeout(5000)
    await dismissOverlay(page)

    // Pricing tier panel is hidden on .testing.
    await expect(page.getByTestId('simplex-tier-4')).toHaveCount(0)
    await expect(page.getByTestId('simplex-tier-6')).toHaveCount(0)
    // FullInvoice yearly registration fee is 0 ETH (free pricing oracle).
    // Match either "0 ETH" or "0.0000 ETH" — viem/Thorin formatting may differ.
    await expect(page.locator('body')).toContainText(/0(\.0+)? ETH/, { timeout: 15_000 })
  })

  // Reserved names should not silently land the user in a doomed registration flow.
  // With the on-chain check + UI panel, the Pricing step shows a clear banner and
  // the Next button reads "Reserved name" disabled.
  test('attempting to register a reserved name shows a clear reserved banner', async ({ page }) => {
    // Reserve a fresh label as admin first so this test does not depend on the
    // genesis-seeded list (`simplex`, `simplex-chat` may have been removed by a
    // previous test in the same chain session).
    const { createPublicClient, createWalletClient, http, parseAbi } = await import('viem')
    const { privateKeyToAccount } = await import('viem/accounts')
    const pub = createPublicClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545') })
    const adminAccount = privateKeyToAccount(DEPLOYER_KEY as `0x${string}`)
    const adminWallet = createWalletClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545'), account: adminAccount })
    const controller = loadDeployments().ETHRegistrarController
    const reservedAbi = parseAbi(['function addReservedNames(string[], uint8) external'])
    const label = `rsv${Date.now().toString(36)}`
    await pub.waitForTransactionReceipt({
      hash: await adminWallet.writeContract({
        address: controller,
        abi: reservedAbi,
        functionName: 'addReservedNames',
        args: [[label], REASON_TRADEMARK],
      }),
    })

    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })
    await page.goto('/')
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)

    const searchInput = page.locator('input[placeholder]').first()
    await searchInput.fill(label)
    await page.waitForTimeout(3000)
    await dismissOverlay(page)

    // Search dropdown should mark the name as Reserved (not Available).
    await expect(page.locator('[data-testid="search-result-name"]').first()).toContainText(
      /Reserved/,
      { timeout: 10_000 },
    )

    // Direct nav to the register page (search-click now blocks navigation
    // for reserved names — covered by a separate test). Verifies that the
    // in-page banner + disabled Next button still render as the second
    // line of defence.
    await page.goto(`/${label}.testing/register`)
    await page.waitForTimeout(3000)
    await dismissOverlay(page)

    await expect(page.getByTestId('simplex-reserved-helper')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('simplex-reserved-helper')).toContainText(
      /reserved by the admin/i,
    )
    const nextBtn = page.getByTestId('next-button')
    await expect(nextBtn).toBeDisabled({ timeout: 15_000 })
    await expect(nextBtn).toContainText(/Reserved name/i)
  })

  // Two contract-only flows — no Playwright UI involved. Kept in this spec file so
  // they share the same Hardhat lifecycle and deployment artefact (deployments.local.json).

  test('admin disables NFT gate, then a non-NFT-holder can register', async () => {
    const { createPublicClient, createWalletClient, http, parseAbi, keccak256, toBytes } = await import('viem')
    const { privateKeyToAccount } = await import('viem/accounts')
    const pub = createPublicClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545') })
    const adminAccount = privateKeyToAccount(DEPLOYER_KEY as `0x${string}`)
    const adminWallet = createWalletClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545'), account: adminAccount })
    const controller = loadDeployments().ETHRegistrarController

    const adminAbi = parseAbi([
      'function disableNftGate() external',
      'function nftGateEnabled() view returns (bool)',
    ])

    // Disable the gate (no-op if a previous test already did this in the same session).
    const gateBefore = await pub.readContract({ address: controller, abi: adminAbi, functionName: 'nftGateEnabled' })
    if (gateBefore) {
      await pub.waitForTransactionReceipt({
        hash: await adminWallet.writeContract({ address: controller, abi: adminAbi, functionName: 'disableNftGate' }),
      })
    }
    const gateAfter = await pub.readContract({ address: controller, abi: adminAbi, functionName: 'nftGateEnabled' })
    expect(gateAfter).toBe(false)

    // ACCOUNT1 holds no SMPXNFT. Pre-flight check so a future test author who edits the
    // suite sees a clear failure rather than a confusing register revert.
    const nonHolder = privateKeyToAccount(ACCOUNT1_KEY as `0x${string}`)
    const balAbi = parseAbi(['function balanceOf(address) view returns (uint256)'])
    const nft = loadDeployments().MockSMPXNFT
    const bal = await pub.readContract({ address: nft, abi: balAbi, functionName: 'balanceOf', args: [nonHolder.address] })
    expect(bal).toBe(0n)

    // Run the standard register flow as ACCOUNT1.
    const uniqueName = `ng${Date.now().toString(36)}`
    await registerNameOnChain(uniqueName, false, ACCOUNT1_KEY)

    // Verify ownership on the BaseRegistrar.
    const base = loadDeployments().BaseRegistrarImplementation
    const ownerOfAbi = parseAbi(['function ownerOf(uint256) view returns (address)'])
    const owner = (await pub.readContract({
      address: base,
      abi: ownerOfAbi,
      functionName: 'ownerOf',
      args: [BigInt(keccak256(toBytes(uniqueName)))],
    })) as string
    expect(owner.toLowerCase()).toBe(nonHolder.address.toLowerCase())
  })

  test('reserved name reverts; admin unreserves; same name can then be registered', async () => {
    const { createPublicClient, createWalletClient, http, parseAbi, keccak256, toBytes } = await import('viem')
    const { privateKeyToAccount } = await import('viem/accounts')
    const pub = createPublicClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545') })
    const adminAccount = privateKeyToAccount(DEPLOYER_KEY as `0x${string}`)
    const adminWallet = createWalletClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545'), account: adminAccount })
    const controller = loadDeployments().ETHRegistrarController

    const reservedAbi = parseAbi([
      'function reservedNames(bytes32) view returns (uint8)',
      'function addReservedNames(string[], uint8) external',
      'function removeReservedNames(string[]) external',
    ])
    // Unique label so the test is idempotent across re-runs against the same chain.
    const label = `res${Date.now().toString(36)}`
    const labelhash = keccak256(toBytes(label))

    // Reserve the label as admin, then assert it's marked reserved on-chain.
    await pub.waitForTransactionReceipt({
      hash: await adminWallet.writeContract({
        address: controller,
        abi: reservedAbi,
        functionName: 'addReservedNames',
        args: [[label], REASON_TRADEMARK],
      }),
    })
    expect(
      await pub.readContract({
        address: controller,
        abi: reservedAbi,
        functionName: 'reservedNames',
        args: [labelhash],
      }),
    ).toBe(REASON_TRADEMARK)

    // Attempting to register reverts (NameReserved).
    let err: any
    try {
      await registerNameOnChain(label)
    } catch (e) {
      err = e
    }
    expect(err).toBeDefined()
    // Hardhat collapses custom errors to "Internal error", so we just assert it reverted.
    expect(err.message).toMatch(/reverted|Internal error/i)

    // Admin unreserves.
    await pub.waitForTransactionReceipt({
      hash: await adminWallet.writeContract({
        address: controller,
        abi: reservedAbi,
        functionName: 'removeReservedNames',
        args: [[label]],
      }),
    })
    expect(
      await pub.readContract({
        address: controller,
        abi: reservedAbi,
        functionName: 'reservedNames',
        args: [labelhash],
      }),
    ).toBe(0)

    // Now the same name is registrable. (Re-uses the same deployer key, so we'll
    // own it afterwards.)
    await registerNameOnChain(label)

    const base = loadDeployments().BaseRegistrarImplementation
    const ownerOfAbi = parseAbi(['function ownerOf(uint256) view returns (address)'])
    const owner = (await pub.readContract({
      address: base,
      abi: ownerOfAbi,
      functionName: 'ownerOf',
      args: [BigInt(labelhash)],
    })) as string
    expect(owner.toLowerCase()).toBe(adminAccount.address.toLowerCase())
  })

  // -- Regression tests for the UI hardening landed in this session. --

  test('homepage shows yellow NFT-gate banner for a wallet without an SMPXNFT', async ({ page }) => {
    // Skip if the on-chain gate has been disabled by an earlier test in the run.
    const { createPublicClient, http, parseAbi } = await import('viem')
    const pub = createPublicClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545') })
    const controller = loadDeployments().ETHRegistrarController
    const gateOn = (await pub.readContract({
      address: controller,
      abi: parseAbi(['function nftGateEnabled() view returns (bool)']),
      functionName: 'nftGateEnabled',
    })) as boolean
    test.skip(gateOn === false, 'NFT gate was already disabled by a prior test')

    // ACCOUNT1 has no SMPXNFT — the banner should appear.
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [ACCOUNT1_KEY], chains: [hardhatChain] })
    await page.goto('/')
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)

    const banner = page.getByRole('alert').filter({ hasText: /SimpleX NFT required/i }).first()
    await expect(banner).toBeVisible({ timeout: 15_000 })
    await expect(banner).toContainText(/holders of the SMPXNFT/i)
    // Etherscan link is the canonical mainnet token page, irrespective of which
    // chain the dApp is configured for.
    await expect(banner.locator('a[href*="etherscan.io/token/0x3AF6D9Ee862376A8DFC0a78847Eb20A153557291"]'))
      .toHaveCount(1)
  })

  test('clicking an available name without NFT shows the SMPXNFT toast and does not navigate', async ({ page }) => {
    const { createPublicClient, http, parseAbi } = await import('viem')
    const pub = createPublicClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545') })
    const controller = loadDeployments().ETHRegistrarController
    const gateOn = (await pub.readContract({
      address: controller,
      abi: parseAbi(['function nftGateEnabled() view returns (bool)']),
      functionName: 'nftGateEnabled',
    })) as boolean
    test.skip(gateOn === false, 'NFT gate was already disabled by a prior test')

    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [ACCOUNT1_KEY], chains: [hardhatChain] })
    await page.goto('/')
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)

    const uniqueName = `nogate${Date.now().toString(36)}`
    const searchInput = page.locator('input[placeholder]').first()
    await searchInput.fill(uniqueName)
    await page.waitForTimeout(2000)
    await dismissOverlay(page)
    await page.locator('[data-testid="search-result-name"]').first().click()
    await page.waitForTimeout(2000)

    // Toast surfaces the NFT-required message.
    const toast = page.getByTestId('search-blocked-toast')
    await expect(toast).toBeVisible({ timeout: 10_000 })
    await expect(toast).toContainText(/SimpleX NFT required/i)
    // URL did NOT change to /register/<name> — the handler short-circuited.
    expect(page.url()).not.toMatch(/\/register\//)
  })

  test('clicking a reserved name shows the reserved toast even when the wallet holds the NFT', async ({ page }) => {
    // Reserve a fresh label via the admin path — deployer holds the NFT, so
    // the only block should be the reservation.
    const { createPublicClient, createWalletClient, http, parseAbi } = await import('viem')
    const { privateKeyToAccount } = await import('viem/accounts')
    const pub = createPublicClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545') })
    const adminAccount = privateKeyToAccount(DEPLOYER_KEY as `0x${string}`)
    const adminWallet = createWalletClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545'), account: adminAccount })
    const controller = loadDeployments().ETHRegistrarController
    const reservedAbi = parseAbi(['function addReservedNames(string[], uint8) external'])
    const label = `resv${Date.now().toString(36)}`
    await pub.waitForTransactionReceipt({
      hash: await adminWallet.writeContract({
        address: controller,
        abi: reservedAbi,
        functionName: 'addReservedNames',
        args: [[label], REASON_TRADEMARK],
      }),
    })

    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })
    await page.goto('/')
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)

    const searchInput = page.locator('input[placeholder]').first()
    await searchInput.fill(label)
    await page.waitForTimeout(2000)
    await dismissOverlay(page)
    await page.locator('[data-testid="search-result-name"]').first().click()
    await page.waitForTimeout(2000)

    // Toast picks reserved, NOT NFT — reserved must beat NFT in the gate order.
    const toast = page.getByTestId('search-blocked-toast')
    await expect(toast).toBeVisible({ timeout: 10_000 })
    await expect(toast).toContainText(/This name is reserved/i)
    expect(page.url()).not.toMatch(/\/register\//)
  })

  test('direct nav to /<too-short>.testing/register stays on the page with a disabled "Name too short" button', async ({ page }) => {
    // Read the current minCharLength; build a label exactly one short.
    const { createPublicClient, http, parseAbi } = await import('viem')
    const pub = createPublicClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545') })
    const controller = loadDeployments().ETHRegistrarController
    const minChar = (await pub.readContract({
      address: controller,
      abi: parseAbi(['function minCharLength() view returns (uint8)']),
      functionName: 'minCharLength',
    })) as number
    test.skip(minChar <= 1, 'minCharLength too small to construct a too-short label')
    const tooShort = 'a'.repeat(minChar - 1)

    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })
    await page.goto(`/${tooShort}.testing/register`)
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)
    await page.waitForTimeout(2000)
    await dismissOverlay(page)

    // We must still be on the /register/ page — no silent redirect.
    expect(page.url()).toMatch(/\/register/)

    // Yellow min-chars helper shows the actual label + count.
    const minHelper = page.getByTestId('simplex-min-chars-helper')
    await expect(minHelper).toBeVisible({ timeout: 15_000 })
    await expect(minHelper).toContainText(new RegExp(`Minimum ${minChar} characters`, 'i'))

    // Next button is disabled and reads "Name too short".
    const nextBtn = page.getByTestId('next-button')
    await expect(nextBtn).toBeDisabled({ timeout: 15_000 })
    await expect(nextBtn).toContainText(/Name too short/i)
  })

  test('direct nav to /<too-short>.testing (profile) renders the yellow "too short" warning', async ({ page }) => {
    const { createPublicClient, http, parseAbi } = await import('viem')
    const pub = createPublicClient({ chain: hardhatChain as any, transport: http('http://127.0.0.1:8545') })
    const controller = loadDeployments().ETHRegistrarController
    const minChar = (await pub.readContract({
      address: controller,
      abi: parseAbi(['function minCharLength() view returns (uint8)']),
      functionName: 'minCharLength',
    })) as number
    test.skip(minChar <= 1, 'minCharLength too small to construct a too-short label')
    const tooShort = 'a'.repeat(minChar - 1)

    await page.goto(`/${tooShort}.testing`)
    await page.waitForTimeout(3000)

    const warning = page.getByRole('alert').filter({ hasText: /is too short/i }).first()
    await expect(warning).toBeVisible({ timeout: 15_000 })
    await expect(warning).toContainText(new RegExp(`shorter than ${minChar} characters`, 'i'))
  })

  test('.testing register page hides pricing tiers and the credit-card payment option', async ({ page }) => {
    // Use a name long enough to pass the min-char gate so we land in Pricing
    // proper rather than the too-short warning.
    const wallet = await injectHeadlessWeb3Provider({ page, privateKeys: [DEPLOYER_KEY], chains: [hardhatChain] })
    const longName = `pricing${Date.now().toString(36)}`
    await page.goto(`/${longName}.testing/register`)
    await page.waitForTimeout(2000)
    await connectWallet(page, wallet)
    await page.waitForTimeout(3000)
    await dismissOverlay(page)

    // Wait for the Pricing step to render (FullInvoice is a reliable marker).
    await page.waitForTimeout(5000)
    // None of the 4 tier cards should render on .testing — they're hidden
    // because registration is gas-only. The simplex-info-panel container
    // itself is empty for an NFT-holder with a long, non-reserved name
    // and does not render visibly; we assert on the tier ids directly.
    await expect(page.getByTestId('simplex-tier-6')).toHaveCount(0)
    await expect(page.getByTestId('simplex-tier-5')).toHaveCount(0)
    await expect(page.getByTestId('simplex-tier-4')).toHaveCount(0)
    await expect(page.getByTestId('simplex-tier-3')).toHaveCount(0)
    // Credit-card / Moonpay option is hidden on .testing.
    await expect(page.locator('text=/Credit card/i')).toHaveCount(0)
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
    const name = `${label}.testing`
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
    // The SimpleX link rows always stay on the form; removing a row's link clears it.
    for (const remove of await editor.locator('[data-testid^="multi-url-field-"][data-testid*="-remove-"]').all()) {
      await remove.click()
      await recipientPage.waitForTimeout(300)
    }
    // Every other record has a delete button that removes its row.
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
    await page.goto(`/${label}.testing`)
    await page.waitForTimeout(2000)
    await connectWallet(page, holderWallet)
    await dismissOverlay(page)
    await page.getByRole('button', { name: 'Withdraw offer' }).click({ timeout: 15_000 })
    await confirmTransaction(page, holderWallet)
    await expect
      .poll(() => pub.readContract({ address: registrar, abi: registrarAbi, functionName: 'getApproved', args: [tokenId] }), { timeout: 15_000 })
      .toBe(zeroAddress)
  })
})
