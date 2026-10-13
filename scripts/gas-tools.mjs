/**
 * Live-network deploy helpers — "wait for cheap base fee" strategy.
 *
 * Strategy:
 *   - Submit every tx with `maxPriorityFeePerGas = 0` and
 *     `maxFeePerGas = MAX_BASE_FEE_GWEI`.
 *   - Before each submission, poll `eth_getBlockByNumber('latest')` every
 *     ~12s until `baseFeePerGas <= maxFeePerGas`. Then send.
 *   - Wait for inclusion. If the tx stalls (base climbed back above cap
 *     right after submit, mempool drop, etc.) for `BUMP_AFTER_HOURS`,
 *     bump `maxFeePerGas` by `BUMP_PCT%` and resubmit at the same nonce.
 *
 * Total cost is bounded by `sum(gasUsed) * maxFeePerGas` (modulo any
 * bumps), and `sum(gasUsed)` is measured upfront by a forked dry-run.
 *
 * Resume + log files: same shape as before — JSONL journal indexed by
 * monotonic step labels, JSONL attempts log.
 *
 * Exports:
 *   spawnHardhatFork({mainnetRpcUrl, port, ensContractsDir})
 *     → { url, stop() } — spawns `npx hardhat node --fork`, waits for
 *       the port, returns the local URL and a stop function.
 *
 *   fundOnFork({forkUrl, address, weiHex})
 *     → uses `hardhat_setBalance` so the deployer EOA can pay gas on the fork.
 *
 *   createDryRunRunner({forkUrl, account, journalSkip})
 *     → returns {deploy, write, totals()} that execute against the fork
 *       and record per-step gasUsed. The dry runner ignores the journal
 *       (we always re-run the full sequence on the fork) but accepts a
 *       `journalSkip` callback to no-op for steps already mined on real
 *       chain — see `runDeploySequence` for how it's used on resume.
 *
 *   createWaitForBaseRunner({publicClient, walletClient, account,
 *                            maxBaseFeeWei, bumpAfterMs, bumpPct,
 *                            journalPath, attemptsLogPath})
 *     → returns {deploy, write, spent(), completedSteps()} that wait for
 *       base ≤ cap, submit, watch for inclusion, bump on long stall.
 *
 *   analyzeAndConfirm({publicClient, account, maxBaseFeeWei, dryRunTotals,
 *                      journalPath, label})
 *     → prints stats + dry-run total + resume state + projected ceiling,
 *       prompts Y/N (or CONFIRM=yes).
 */
import { encodeDeployData, encodeFunctionData, formatEther, formatGwei, http, createPublicClient, createWalletClient, parseGwei, keccak256, concatHex, toHex} from 'viem'
import { mainnet } from 'viem/chains'
import { appendFileSync, existsSync, readFileSync } from 'fs'
import { spawn } from 'child_process'
import { createServer } from 'net'
import readline from 'readline'

const POLL_BASE_INTERVAL_MS = 12_000     // ~one mainnet block
const POLL_RECEIPT_INTERVAL_MS = 10_000  // poll inclusion every 10s
const FORK_BOOT_TIMEOUT_MS = 90_000      // hardhat node has slow first boot
const DEFAULT_BUMP_PCT = 20n
const DEFAULT_BUMP_AFTER_HOURS = 24
/// Depth a receipt must reach before the next dependent step is built on it.
const DEFAULT_CONFIRMATIONS = 3
/// How far the stall bump may compound above the configured cap before the run
/// gives up. 4× is roughly seven 20% bumps, i.e. a week of sustained stalling.
const DEFAULT_ABSOLUTE_CAP_MULTIPLE = 4n

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fmtGwei = (wei) => Number(formatGwei(wei)).toFixed(4)
const fmtEth = (wei) => formatEther(wei)
const nowIso = () => new Date().toISOString()

// ---------------- journal ----------------

export function loadJournal(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
}

/// Step keys name the operation, never its position. A positional counter
/// silently remaps every later step when one is inserted or reordered, so a
/// resumed run would skip the wrong call — or replay one. `occurrence` keeps
/// repeated calls of the same function distinct, and the key is deliberately
/// NOT derived from calldata: the preflight dry run executes on a fork, where
/// every deployed address differs, and its steps must still line up with the
/// live journal.
export function makeStepKeys() {
  const uses = new Map()
  return (kind, label) => {
    const base = `${kind}:${label}`
    const n = (uses.get(base) || 0) + 1
    uses.set(base, n)
    return n === 1 ? base : `${base}#${n}`
  }
}

/// Identifies the exact call a step made, so a resumed run can prove the
/// journal entry it is about to skip is the step it is actually looking at.
function callDigest(to, data, value = 0n) {
  return keccak256(
    concatHex([to || '0x', data, toHex(value, { size: 32 })]),
  ).slice(0, 18)
}

function sumSpent(journal) {
  return journal.reduce((acc, e) => acc + BigInt(e.costWei || 0), 0n)
}

async function promptYesNo(question) {
  if (process.env.CONFIRM === 'yes') {
    console.log(`${question}y  [auto via CONFIRM=yes]`)
    return true
  }
  if (!process.stdin.isTTY) {
    console.error('Not a TTY and CONFIRM!=yes — refusing to proceed.')
    return false
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim().toLowerCase() === 'y')
    })
  })
}

// ---------------- hardhat fork helpers ----------------

async function isPortFree(host, port) {
  return new Promise((resolve) => {
    const sock = createServer()
    sock.once('error', () => resolve(false))
    sock.once('listening', () => sock.close(() => resolve(true)))
    sock.listen(port, host)
  })
}

async function rpcCall(url, method, params = []) {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), 4000)
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
      signal: controller.signal,
    })
    const text = await r.text()
    if (!r.ok) return { ok: false, status: r.status, body: text.slice(0, 200) }
    if (!text) return { ok: false, status: r.status, body: '(empty)' }
    let parsed
    try { parsed = JSON.parse(text) } catch { return { ok: false, body: text.slice(0, 200) } }
    if (parsed.error) return { ok: false, error: parsed.error.message || JSON.stringify(parsed.error) }
    return { ok: true, result: parsed.result }
  } catch (e) {
    return { ok: false, error: e.message }
  } finally {
    clearTimeout(t)
  }
}

async function waitForRpc(url, timeoutMs) {
  const start = Date.now()
  let last
  while (Date.now() - start < timeoutMs) {
    const r = await rpcCall(url, 'eth_chainId')
    if (r.ok) return BigInt(r.result)
    last = r
    await sleep(500)
  }
  throw new Error(
    `${url} did not respond to eth_chainId within ${timeoutMs}ms. ` +
      `Last response: ${JSON.stringify(last)}`,
  )
}

export async function spawnHardhatFork({ mainnetRpcUrl, port = 8546, ensContractsDir }) {
  if (!(await isPortFree('127.0.0.1', port))) {
    throw new Error(
      `Port ${port} is already in use on 127.0.0.1. Something else is bound there ` +
        `(stale hardhat node, reverse proxy, etc.). Stop it or set FORK_PORT to a free port.`,
    )
  }
  console.log(`Spawning forked hardhat node at :${port} (fork of mainnet) …`)
  // `detached: true` puts the child in its own process group so we can
  // signal the whole tree (npx + node + hardhat) at once. Without it,
  // `proc.kill()` only signals npx, leaving hardhat running.
  // The fork URL goes through the environment, not argv: `--fork <url>` puts
  // the provider key in the child's command line, where any local user can read
  // it out of `ps`. hardhat.config.ts's `mainnetFork` network reads
  // MAINNET_RPC_URL for exactly this.
  const proc = spawn(
    'npx',
    ['hardhat', 'node', '--network', 'mainnetFork', '--port', String(port), '--hostname', '127.0.0.1'],
    {
      cwd: ensContractsDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, MAINNET_RPC_URL: mainnetRpcUrl },
    },
  )
  proc.on('error', (e) => console.error('hardhat node spawn error:', e))
  let stderr = ''
  let stdout = ''
  proc.stdout.on('data', (c) => { stdout += c.toString() })
  proc.stderr.on('data', (c) => { stderr += c.toString() })

  const stop = () => {
    // Kill the whole process group (note the negative pid). If SIGTERM
    // doesn't take after a grace period, escalate to SIGKILL.
    try { process.kill(-proc.pid, 'SIGTERM') } catch { /* already gone */ }
    setTimeout(() => {
      try { process.kill(-proc.pid, 'SIGKILL') } catch {}
    }, 3000).unref()
  }

  const url = `http://127.0.0.1:${port}`
  let chainId
  try {
    chainId = Number(await waitForRpc(url, FORK_BOOT_TIMEOUT_MS))
    console.log(`  fork ready at ${url} (chainId=${chainId})`)
  } catch (e) {
    stop()
    throw new Error(
      `${e.message}\n` +
        `--- hardhat stdout ---\n${stdout || '(empty)'}\n` +
        `--- hardhat stderr ---\n${stderr || '(empty)'}`,
    )
  }
  return { url, chainId, stop }
}

export async function fundOnFork({ forkUrl, address, weiHex }) {
  // Different node implementations expose set-balance under different
  // RPC names — try the common ones. Hardhat 2 had `hardhat_setBalance`;
  // Hardhat 3's EDR-based runtime sometimes returns empty bodies on it,
  // anvil ships `anvil_setBalance`, and a few support `evm_setAccountBalance`.
  // First one that responds with no error wins.
  const methods = ['hardhat_setBalance', 'anvil_setBalance', 'evm_setAccountBalance']
  const tried = []
  for (const method of methods) {
    const body = JSON.stringify({
      jsonrpc: '2.0', method, params: [address, weiHex], id: 1,
    })
    const r = await fetch(forkUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    })
    const text = await r.text()
    if (!text) {
      tried.push(`${method}: empty body (status ${r.status})`)
      continue
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      tried.push(`${method}: unparseable response (${text.slice(0, 80)})`)
      continue
    }
    if (parsed.error) {
      tried.push(`${method}: ${parsed.error.message || JSON.stringify(parsed.error)}`)
      continue
    }
    return  // success
  }
  throw new Error(
    `fundOnFork: no working balance-setting RPC method on ${forkUrl}.\n` +
      `Tried:\n  - ${tried.join('\n  - ')}\n` +
      `If your local node exposes a different method name, set the deployer's\n` +
      `balance manually before re-running.`,
  )
}

// ---------------- dry-run runner (forked node) ----------------

export function createDryRunRunner({ forkUrl, forkChainId, account, alreadyDone = new Set() }) {
  const transport = http(forkUrl)
  // The fork keeps mainnet *state* but uses its own chainId (Hardhat
  // defaults to 31337 even with `--fork`). Sign with the fork's id, not
  // mainnet's, or the node rejects every raw tx.
  const chain = { ...mainnet, id: forkChainId }
  const publicClient = createPublicClient({ chain, transport })
  const walletClient = createWalletClient({ chain, transport, account })
  const nextKey = makeStepKeys()
  let totalGas = 0n
  const perStep = []

  async function send(label, name, { to, data, value = 0n }) {
    if (alreadyDone.has(label)) {
      // Already mined on real chain — the journal will tell us its
      // gasUsed; the dry run can skip it here since we already counted
      // it in `accountedJournalGas`.
      perStep.push({ step: label, name, gasUsed: 0n, skipped: true })
      return null
    }
    const hash = await walletClient.sendTransaction({
      to, data, value,
      // Generous fees — hardhat node accepts anything; we only care about gasUsed.
      maxFeePerGas: parseGwei('100'),
      maxPriorityFeePerGas: parseGwei('1'),
    })
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') {
      throw new Error(`[dry-run ${label}] tx ${hash} reverted on fork`)
    }
    totalGas += BigInt(receipt.gasUsed)
    perStep.push({ step: label, name, gasUsed: BigInt(receipt.gasUsed), address: receipt.contractAddress })
    return receipt
  }

  return {
    totals: () => ({ totalGas, perStep }),
    deploy: async (name, abi, bytecode, args = []) => {
      const step = nextKey('deploy', name)
      const data = encodeDeployData({ abi, bytecode, args })
      const receipt = await send(step, name, { to: null, data })
      // For skipped (alreadyDone) steps, the address comes from elsewhere
      // — runDeploySequence resolves it. We just return a sentinel.
      if (!receipt) return { address: null, abi, _skipped: true }
      return { address: receipt.contractAddress, abi }
    },
    write: async (contract, fn, args) => {
      const step = nextKey('write', fn)
      const data = encodeFunctionData({ abi: contract.abi, functionName: fn, args })
      if (contract.address === null) {
        // Step is skipped on the fork because the prior deploy was skipped
        // (already on real chain). Don't try to send writeContract against
        // a null address.
        perStep.push({ step, name: fn, gasUsed: 0n, skipped: true })
        return
      }
      await send(step, fn, { to: contract.address, data })
    },
  }
}

// ---------------- real runner (wait-for-base-fee) ----------------

export function createWaitForBaseRunner({
  publicClient, walletClient, account,
  maxBaseFeeWei, bumpAfterMs, bumpPct,
  journalPath, attemptsLogPath,
  absoluteMaxBaseFeeWei, confirmations = DEFAULT_CONFIRMATIONS,
}) {
  // L25: the stall bump is unbounded on its own — 20% every 24h compounds past
  // any budget if the chain simply stays expensive. The run stops rather than
  // quietly paying whatever it takes.
  const hardCap = absoluteMaxBaseFeeWei ?? maxBaseFeeWei * DEFAULT_ABSOLUTE_CAP_MULTIPLE
  const journal = loadJournal(journalPath)
  const completed = new Map(journal.map((e) => [e.step, e]))
  let spent = sumSpent(journal)
  const nextKey = makeStepKeys()

  // Journals written before steps were named by operation cannot be resumed:
  // their `step:007` says nothing about which call it was, so matching it to
  // this run's steps would be guesswork about money already spent.
  const positional = journal.filter((e) => /^step:\d+$/.test(e.step))
  if (positional.length > 0) {
    throw new Error(
      `${journalPath} uses positional step keys (${positional.length} entr${positional.length === 1 ? 'y' : 'ies'}, e.g. ${positional[0].step}).\n` +
        `  Those cannot be mapped onto named steps. This journal belongs to a completed deployment;\n` +
        `  start a new one rather than resuming it.`,
    )
  }

  const priorAttempts = existsSync(attemptsLogPath)
    ? readFileSync(attemptsLogPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
    : []

  function logAttempt(entry) {
    appendFileSync(attemptsLogPath, JSON.stringify(entry) + '\n')
  }

  function recordSuccess(step, receipt, digest) {
    // Inclusion is not success. A tx that reverts at inclusion still yields a
    // receipt and still costs gas, and journalling it would mark the step done
    // and skip it on every later resume.
    if (receipt.status !== 'success') {
      logAttempt({ ts: nowIso(), step, txHash: receipt.transactionHash,
        outcome: 'reverted', gasUsed: receipt.gasUsed.toString() })
      throw new Error(
        `[${step}] tx ${receipt.transactionHash} was included but REVERTED — not journalled.\n` +
          `  Investigate before rerunning; the gas is spent either way.`,
      )
    }
    const cost = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)
    spent += cost
    const entry = {
      ts: nowIso(), step, callDigest: digest,
      txHash: receipt.transactionHash,
      address: receipt.contractAddress || undefined,
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPrice: receipt.effectiveGasPrice.toString(),
      costWei: cost.toString(),
    }
    appendFileSync(journalPath, JSON.stringify(entry) + '\n')
    completed.set(step, entry)
    logAttempt({ ts: nowIso(), step, txHash: receipt.transactionHash,
      outcome: 'mined', gasUsed: receipt.gasUsed.toString(),
      effectiveGasPrice: receipt.effectiveGasPrice.toString(), costWei: cost.toString() })
    const what = receipt.contractAddress || receipt.transactionHash.slice(0, 10) + '…'
    console.log(`  ✓ ${step}: ${what}  (${fmtEth(cost)} ETH @ ${fmtGwei(BigInt(receipt.effectiveGasPrice))} gwei, total ${fmtEth(spent)} ETH)`)
    return entry
  }

  async function waitForCheapBase(step, currentCap) {
    let waited = 0
    while (true) {
      const block = await publicClient.getBlock({ blockTag: 'latest' })
      const base = block.baseFeePerGas
      if (base <= currentCap) return base
      if (waited % (60_000 / POLL_BASE_INTERVAL_MS) === 0) {
        // log roughly every minute
        console.log(`  [${step}] base ${fmtGwei(base)} gwei > cap ${fmtGwei(currentCap)} gwei — waiting…`)
        logAttempt({ ts: nowIso(), step, outcome: 'waiting-for-base',
          baseFee: base.toString(), cap: currentCap.toString() })
      }
      await sleep(POLL_BASE_INTERVAL_MS)
      waited += 1
    }
  }

  /// Every step here feeds the next — an address from a deploy, a permission
  /// from a write — so a one-confirmation read that a reorg then unwinds would
  /// have the rest of the run building on state that no longer exists.
  async function awaitConfirmations(step, receipt) {
    if (confirmations <= 1) return receipt
    while (true) {
      const head = await publicClient.getBlockNumber()
      const depth = head - BigInt(receipt.blockNumber) + 1n
      if (depth >= BigInt(confirmations)) return receipt
      await sleep(POLL_RECEIPT_INTERVAL_MS)
      // Re-read: a reorg can drop the tx entirely, in which case the caller
      // must go back to waiting rather than journal it.
      const again = await publicClient
        .getTransactionReceipt({ hash: receipt.transactionHash })
        .catch(() => null)
      if (!again) {
        logAttempt({ ts: nowIso(), step, txHash: receipt.transactionHash,
          outcome: 'reorged-out' })
        return null
      }
      receipt = again
    }
  }

  async function waitForInclusion(step, hash, deadline) {
    while (Date.now() < deadline) {
      await sleep(POLL_RECEIPT_INTERVAL_MS)
      const receipt = await publicClient.getTransactionReceipt({ hash }).catch(() => null)
      if (receipt) {
        const settled = await awaitConfirmations(step, receipt)
        if (settled) return { status: 'mined', receipt: settled }
        continue // reorged out — keep waiting on the same hash
      }
    }
    return { status: 'stall', reason: `tx ${hash} not included within ${bumpAfterMs / 3600000}h` }
  }

  async function runStep(step, { to, data, value = 0n }) {
    const digest = callDigest(to, data, value)

    if (completed.has(step)) {
      const e = completed.get(step)
      // A resumed run rebuilds every prior address from the journal, so the
      // call it is about to skip must hash to what was recorded. If it does
      // not, the script changed under the journal and skipping would drop a
      // step that never actually ran.
      if (e.callDigest && e.callDigest !== digest) {
        throw new Error(
          `[${step}] journal mismatch: recorded ${e.callDigest}, this run would send ${digest}.\n` +
            `  The deploy script changed since the journal was written. Resolve by hand — ` +
            `do not delete the journal, it is the only record of what is already on chain.`,
        )
      }
      if (!e.callDigest) {
        console.warn(`  ! ${step}: journal entry predates call digests — skipping unverified`)
      }
      console.log(`  ↻ ${step}: already in journal (${e.txHash}) — skipped`)
      return e
    }

    // Crash recovery. A step can be submitted and then wait up to
    // BUMP_AFTER_HOURS for inclusion; a kill in that window leaves the tx on
    // chain and nothing in the journal, so a naive resume would send it twice.
    // The attempts log recorded every hash, so check them before spending.
    for (const a of priorAttempts) {
      if (a.step !== step || !a.txHash) continue
      const r = await publicClient
        .getTransactionReceipt({ hash: a.txHash })
        .catch(() => null)
      if (r) {
        // The attempts log outlives a journal moved aside, so the hash may be an
        // earlier run's different call. Adopt only this exact call from this key.
        const tx = await publicClient.getTransaction({ hash: a.txHash })
        const sent = callDigest(tx.to, tx.input, tx.value)
        if (tx.from.toLowerCase() !== account.address.toLowerCase() || sent !== digest) {
          throw new Error(
            `[${step}] the attempts log names ${a.txHash}, sent by ${tx.from} as ${sent},\n` +
              `  but this run would send ${digest} from ${account.address}. That is an earlier\n` +
              `  run's call: to start over, move ${attemptsLogPath} aside along with the journal.`,
          )
        }
        const settled = await awaitConfirmations(step, r)
        if (!settled) continue
        console.log(`  ⤿ ${step}: recovered ${a.txHash} from a previous run — not resending`)
        return recordSuccess(step, settled, digest)
      }
    }

    // Real estimateGas once per step. A revert here = the tx would fail.
    let gasEstimate
    try {
      const raw = await publicClient.estimateGas({
        account: account.address, to, data, value,
      })
      gasEstimate = (raw * 110n) / 100n
      logAttempt({ ts: nowIso(), step, outcome: 'estimated',
        gasEstimate: gasEstimate.toString(), gasEstimateRaw: raw.toString() })
      console.log(`  [${step}] estimated gas: ${gasEstimate.toLocaleString()} (raw ${raw.toLocaleString()} + 10%)`)
    } catch (e) {
      const msg = e.shortMessage || e.message || String(e)
      logAttempt({ ts: nowIso(), step, outcome: 'estimate-error', reason: msg })
      throw new Error(`[${step}] estimateGas reverted — would fail on chain: ${msg}`)
    }

    let cap = maxBaseFeeWei
    let nonce = await publicClient.getTransactionCount({
      address: account.address, blockTag: 'pending',
    })
    const hashes = []
    let bumps = 0

    while (true) {
      await waitForCheapBase(step, cap)
      let hash
      try {
        hash = await walletClient.sendTransaction({
          to, data, value, nonce,
          maxFeePerGas: cap, maxPriorityFeePerGas: 0n,
        })
      } catch (e) {
        const msg = e.shortMessage || e.message || String(e)
        // If the tx was already mined under an earlier hash, collect it.
        for (const h of hashes) {
          const r = await publicClient.getTransactionReceipt({ hash: h }).catch(() => null)
          if (r) return recordSuccess(step, r, digest)
        }
        // "Nonce too low" means a prior tx (probably from a prior partial
        // run) already used this nonce — refresh and retry the same step.
        if (/nonce too low/i.test(msg)) {
          nonce = await publicClient.getTransactionCount({
            address: account.address, blockTag: 'pending',
          })
          logAttempt({ ts: nowIso(), step, outcome: 'nonce-refresh', reason: msg })
          continue
        }
        if (/insufficient funds/i.test(msg)) throw e
        logAttempt({ ts: nowIso(), step, outcome: 'submit-error', reason: msg })
        throw e
      }
      hashes.push(hash)
      logAttempt({ ts: nowIso(), step, txHash: hash,
        maxFeePerGas: cap.toString(), bumps,
        outcome: 'submitted' })
      console.log(`  [${step}] submitted ${hash}  (cap=${fmtGwei(cap)} gwei, bumps=${bumps})`)

      const deadline = Date.now() + bumpAfterMs
      const result = await waitForInclusion(step, hash, deadline)
      if (result.status === 'mined') return recordSuccess(step, result.receipt, digest)

      // Stall handling — bump cap and resubmit at the same nonce.
      // First check whether a prior hash mined while we were waiting.
      for (const h of hashes) {
        const r = await publicClient.getTransactionReceipt({ hash: h }).catch(() => null)
        if (r) return recordSuccess(step, r, digest)
      }
      bumps += 1
      const nextCap = (cap * (100n + bumpPct)) / 100n
      if (nextCap > hardCap) {
        logAttempt({ ts: nowIso(), step, txHash: hash, outcome: 'cap-exhausted',
          cap: cap.toString(), wouldBe: nextCap.toString(), hardCap: hardCap.toString() })
        throw new Error(
          `[${step}] bumping past the absolute ceiling (${fmtGwei(nextCap)} > ${fmtGwei(hardCap)} gwei) — stopping.\n` +
            `  tx ${hash} is still pending at ${fmtGwei(cap)} gwei and may yet be mined; do NOT\n` +
            `  resend by hand. Wait, or raise ABSOLUTE_MAX_BASE_FEE_GWEI and resume — the journal\n` +
            `  and attempts log will adopt it if it lands.`,
        )
      }
      cap = nextCap
      logAttempt({ ts: nowIso(), step, txHash: hash, outcome: 'stalled',
        reason: result.reason, bumps, newCap: cap.toString() })
      console.warn(`  [${step}] stalled — bumping cap to ${fmtGwei(cap)} gwei (bump ${bumps})`)
    }
  }

  return {
    completedSteps: () => completed,
    spent: () => spent,
    deploy: async (name, abi, bytecode, args = []) => {
      const step = nextKey('deploy', name)
      const data = encodeDeployData({ abi, bytecode, args })
      const e = await runStep(step, { to: null, data })
      return { address: e.address, abi }
    },
    write: async (contract, fn, args) => {
      const step = nextKey('write', fn)
      const data = encodeFunctionData({ abi: contract.abi, functionName: fn, args })
      await runStep(step, { to: contract.address, data })
    },
  }
}

// ---------------- preflight summary + confirm ----------------

export async function analyzeAndConfirm({
  publicClient, account,
  maxBaseFeeWei, dryRunTotals,
  journalPath, label,
  bumpAfterMs, bumpPct,
}) {
  console.log(`\n=== ${label} ===`)
  const block = await publicClient.getBlock({ blockTag: 'latest' })
  const baseNow = block.baseFeePerGas

  console.log(`  Strategy:`)
  console.log(`    priority fee:         0 always`)
  console.log(`    maxFeePerGas:         ${fmtGwei(maxBaseFeeWei)} gwei  (your MAX_BASE_FEE_GWEI)`)
  console.log(`    submit policy:        wait for baseFee ≤ cap, then send (no escalation by default)`)
  console.log(`    bump rule:            after ${bumpAfterMs / 3600000}h of stall, cap × ${Number(100n + bumpPct) / 100} and resubmit at same nonce`)
  console.log(`\n  Current chain:`)
  console.log(`    base fee:             ${fmtGwei(baseNow)} gwei  (${baseNow <= maxBaseFeeWei ? 'BELOW' : 'ABOVE'} cap)`)

  const { totalGas, perStep } = dryRunTotals
  const ceilingCost = totalGas * maxBaseFeeWei
  console.log(`\n  Preflight captured ${perStep.length} step${perStep.length === 1 ? '' : 's'}:`)
  console.log(`    total gas used:       ${totalGas.toLocaleString()} units`)
  console.log(`    ceiling cost @ cap:   ${fmtEth(ceilingCost)} ETH  (= total gas × ${fmtGwei(maxBaseFeeWei)} gwei)`)
  console.log(`    actual cost may be lower (paid at the chain's baseFee at inclusion, ≤ cap)`)

  const journal = loadJournal(journalPath)
  const spent = sumSpent(journal)
  console.log(`\n  Journal state:`)
  if (journal.length === 0) {
    console.log(`    fresh deploy (no prior steps recorded)`)
  } else {
    console.log(`    ${journal.length} prior step${journal.length === 1 ? '' : 's'} already mined`)
    console.log(`    spent so far:         ${fmtEth(spent)} ETH`)
    const tail = journal.slice(-3)
    for (const e of tail) {
      const addrFrag = e.address ? `  → ${e.address}` : ''
      console.log(`      ${e.step.padEnd(10)} ${e.txHash.slice(0, 14)}…${addrFrag}`)
    }
    if (journal.length > 3) console.log(`      ... and ${journal.length - 3} earlier`)
  }

  const balance = await publicClient.getBalance({ address: account.address })
  console.log(`\n  Deployer:`)
  console.log(`    address:              ${account.address}`)
  console.log(`    balance:              ${fmtEth(balance)} ETH`)
  // Required = ceiling cost across REMAINING steps (sum of dry steps not in journal).
  const remainingGas = perStep
    .filter((s) => !journal.find((j) => j.step === s.step))
    .reduce((acc, s) => acc + (s.gasUsed || 0n), 0n)
  const remainingCeiling = remainingGas * maxBaseFeeWei
  console.log(`    remaining ceiling:    ${fmtEth(remainingCeiling)} ETH  (${remainingGas.toLocaleString()} gas left × cap)`)
  if (balance < remainingCeiling) {
    console.log(`\n  ⚠  Balance is below the remaining ceiling. Top up at least`)
    console.log(`     ${fmtEth(remainingCeiling - balance)} ETH before proceeding.`)
  }

  const ok = await promptYesNo('\nProceed? [y/N] ')
  if (!ok) { console.log('Aborted.'); process.exit(1) }
}

// ---------------- shared default knobs ----------------

export const DEFAULTS = {
  BUMP_AFTER_MS: DEFAULT_BUMP_AFTER_HOURS * 60 * 60 * 1000,
  BUMP_PCT: DEFAULT_BUMP_PCT,
  CONFIRMATIONS: DEFAULT_CONFIRMATIONS,
  ABSOLUTE_CAP_MULTIPLE: DEFAULT_ABSOLUTE_CAP_MULTIPLE,
  POLL_BASE_INTERVAL_MS,
  POLL_RECEIPT_INTERVAL_MS,
}
