// Exercises the resume logic changed for M5/M6 with stub clients: no chain.
import { writeFileSync, rmSync, readFileSync, existsSync } from 'fs'
import { TransactionNotFoundError, encodeFunctionData, keccak256, toHex } from 'viem'
import { createWaitForBaseRunner, makeStepKeys, DEFAULTS } from './gas-tools.mjs'

const J = '/tmp/j.jsonl', A = '/tmp/a.jsonl'
const clean = () => [J, A].forEach((f) => existsSync(f) && rmSync(f))
const ABI = [
  { type: 'function', name: 'setBeneficiary', inputs: [{ type: 'address' }], outputs: [] },
  { type: 'function', name: 'setPriceOracle', inputs: [{ type: 'address' }], outputs: [] },
]
const C = { address: '0x1111111111111111111111111111111111111111', abi: ABI }
const ADDR = '0x2222222222222222222222222222222222222222'

let sent = 0
const receipts = new Map()
const txs = new Map()
let nextStatus = 'success'
const mk = (hash) => ({ transactionHash: hash, gasUsed: 21000n, effectiveGasPrice: 1n, contractAddress: null, status: nextStatus, blockNumber: 100n })
const signedRequests = new Map()
const signTransaction = async (request) => {
  const serialized = toHex(`signed ${signedRequests.size}`)
  signedRequests.set(serialized, request)
  return serialized
}
const broadcast = (accept) => async ({ serializedTransaction }) => {
  const hash = keccak256(serializedTransaction)
  return accept(hash, signedRequests.get(serializedTransaction))
}
let lastHash

const stub = (opts = {}) => createWaitForBaseRunner({
  publicClient: {
    getBlock: async () => ({ baseFeePerGas: 1n }),
    getBlockNumber: async () => 200n,   // deep enough to satisfy confirmations
    estimateGas: async () => 21000n,
    getTransactionCount: async () => 0,
    getTransactionReceipt: async ({ hash }) => {
      const r = receipts.get(hash); if (!r) throw new Error('none'); return r
    },
    getTransaction: async ({ hash }) => txs.get(hash),
  },
  walletClient: { signTransaction, sendRawTransaction: broadcast((h, { to, data, value, nonce, maxFeePerGas }) => {
    sent++; lastHash = h; receipts.set(h, mk(h))
    txs.set(h, { from: ADDR, to, input: data, value, nonce, maxFeePerGas }); return h
  }) },
  account: { address: ADDR },
  maxBaseFeeWei: 10n, bumpAfterMs: 1000, bumpPct: 20n,
  journalPath: J, attemptsLogPath: A, ...opts,
})

// 1. keys name the operation, and repeats stay distinct
const k = makeStepKeys()
console.assert(k('deploy', 'ENSRegistry') === 'deploy:ENSRegistry', 'key 1')
console.assert(k('write', 'setSubnodeOwner') === 'write:setSubnodeOwner', 'key 2')
console.assert(k('write', 'setSubnodeOwner') === 'write:setSubnodeOwner#2', 'key 3')
console.log('1 ok: named keys, repeats distinguished')

// 2. a step inserted before another no longer remaps it
clean(); sent = 0
let r = stub()
await r.write(C, 'setBeneficiary', [ADDR])
const before = sent
r = stub()
await r.write(C, 'setPriceOracle', [ADDR])   // NEW step inserted ahead of it
await r.write(C, 'setBeneficiary', [ADDR])   // must still be recognised as done
console.assert(sent === before + 1, `expected 1 new send, got ${sent - before}`)
console.log('2 ok: inserting a step does not replay the ones after it')

// 3. changed arguments to a journalled step are caught, not silently skipped
clean(); sent = 0
r = stub()
await r.write(C, 'setBeneficiary', [ADDR])
r = stub()
let threw = null
try { await r.write(C, 'setBeneficiary', ['0x3333333333333333333333333333333333333333']) }
catch (e) { threw = e.message }
console.assert(threw && /journal mismatch/.test(threw), `expected mismatch, got ${threw}`)
console.log('3 ok: a changed call is rejected')

// 4. a tx submitted but never journalled is recovered, not resent
clean(); sent = 0
r = stub()
await r.write(C, 'setBeneficiary', [ADDR])
const orphanHash = lastHash
writeFileSync(J, '')                                   // journal lost / never written
writeFileSync(A, JSON.stringify({ step: 'write:setBeneficiary', txHash: orphanHash, outcome: 'submitted' }) + '\n')
const sentBefore = sent
r = stub()
await r.write(C, 'setBeneficiary', [ADDR])
console.assert(sent === sentBefore, `double-sent: ${sent - sentBefore} extra`)
console.assert(readFileSync(J, 'utf8').includes(orphanHash), 'recovered tx not journalled')
console.log('4 ok: an orphaned tx is recovered from the attempts log')

// 5. an old positional journal is refused rather than mis-resumed
clean()
writeFileSync(J, JSON.stringify({ step: 'step:001', txHash: '0xold', costWei: '0' }) + '\n')
threw = null
try { stub() } catch (e) { threw = e.message }
console.assert(threw && /positional step keys/.test(threw), `expected refusal, got ${threw}`)
console.log('5 ok: a positional journal is refused')

// 6. a tx that reverts at inclusion is never journalled as done
clean(); sent = 0; receipts.clear(); nextStatus = 'reverted'
r = stub()
threw = null
try { await r.write(C, 'setBeneficiary', [ADDR]) } catch (e) { threw = e.message }
console.assert(threw && /REVERTED/.test(threw), `expected revert to throw, got ${threw}`)
console.assert(!existsSync(J) || readFileSync(J, 'utf8') === '', 'reverted tx was journalled')
console.log('6 ok: a reverted tx is not journalled as success')
nextStatus = 'success'

// 7. the bump loop stops at the absolute ceiling instead of paying anything (L25)
clean(); sent = 0; receipts.clear()
let stalls = 0
r = createWaitForBaseRunner({
  publicClient: {
    getBlock: async () => ({ baseFeePerGas: 1n }),
    getBlockNumber: async () => 200n,
    estimateGas: async () => 21000n,
    getTransactionCount: async () => 0,
    getTransactionReceipt: async () => { stalls++; throw new Error('never mined') },
  },
  walletClient: { signTransaction, sendRawTransaction: broadcast((h) => { sent++; return h }) },
  account: { address: ADDR },
  maxBaseFeeWei: 10n, absoluteMaxBaseFeeWei: 15n,   // one 20% bump fits, the second does not
  bumpAfterMs: 1, bumpPct: 20n,
  journalPath: J, attemptsLogPath: A,
})
threw = null
try { await r.write(C, 'setBeneficiary', [ADDR]) } catch (e) { threw = e.message }
console.assert(threw && /absolute ceiling/.test(threw), `expected ceiling abort, got ${threw}`)
console.log('7 ok: the bump loop stops at the absolute fee ceiling')

// 8. a reorg that removes the receipt does not journal the step (L27)
clean(); sent = 0; receipts.clear(); nextStatus = 'success'
let reads = 0
r = createWaitForBaseRunner({
  publicClient: {
    getBlock: async () => ({ baseFeePerGas: 1n }),
    getBlockNumber: async () => 100n,           // only 1 confirmation deep
    estimateGas: async () => 21000n,
    getTransactionCount: async () => 0,
    getTransactionReceipt: async ({ hash }) => {
      reads++
      if (reads === 1) return mk(hash)          // first sighting
      throw new Error('reorged out')            // then it vanishes
    },
  },
  walletClient: { signTransaction, sendRawTransaction: broadcast((h) => { sent++; return h }) },
  account: { address: ADDR },
  maxBaseFeeWei: 10n, bumpAfterMs: 1200, bumpPct: 20n, confirmations: 3,
  journalPath: J, attemptsLogPath: A,
})
threw = null
try { await r.write(C, 'setBeneficiary', [ADDR]) } catch (e) { threw = e.message }
console.assert(!existsSync(J) || readFileSync(J, 'utf8') === '', 'reorged tx was journalled')
console.assert(readFileSync(A, 'utf8').includes('reorged-out'), 'reorg not logged')
console.log('8 ok: a receipt undone by a reorg is not journalled')

// 9. an attempts-log tx that made a different call is refused, not adopted
clean(); sent = 0
r = stub()
await r.write(C, 'setBeneficiary', ['0x3333333333333333333333333333333333333333'])
writeFileSync(J, '')
writeFileSync(A, JSON.stringify({ step: 'write:setBeneficiary', txHash: lastHash, outcome: 'submitted' }) + '\n')
r = stub()
threw = null
try { await r.write(C, 'setBeneficiary', [ADDR]) } catch (e) { threw = e.message }
console.assert(threw && /earlier\s+run's call/.test(threw), `expected refusal, got ${threw}`)
console.assert(readFileSync(J, 'utf8') === '', 'a different call was journalled')
console.log('9 ok: an earlier run\'s different call is not adopted')

clean(); sent = 0; receipts.clear()
const pendingHash = '0xpending'
txs.set(pendingHash, {
  from: ADDR, to: C.address, input: encodeFunctionData({ abi: ABI, functionName: 'setBeneficiary', args: [ADDR] }),
  value: 0n, nonce: 7, maxFeePerGas: 12n,
})
writeFileSync(A, JSON.stringify({ ts: new Date().toISOString(), step: 'write:setBeneficiary', txHash: pendingHash, outcome: 'submitted', bumps: 0 }) + '\n')
r = stub({ pollReceiptMs: 1 })
setTimeout(() => receipts.set(pendingHash, mk(pendingHash)), 50)
await r.write(C, 'setBeneficiary', [ADDR])
console.assert(sent === 0, `a pending tx was sent again: ${sent} sends`)
console.assert(readFileSync(J, 'utf8').includes(pendingHash), 'the pending tx was not journalled once mined')
console.assert(readFileSync(A, 'utf8').includes('adopted-pending'), 'the adoption was not logged')
console.log('10 ok: a tx still pending from an earlier run is waited for, not sent again')

const submitted = (txHash) => JSON.stringify({ ts: new Date().toISOString(), step: 'write:setBeneficiary', txHash, nonce: 5, maxFeePerGas: '10', bumps: 0, outcome: 'submitted' }) + '\n'
const unknown = async ({ hash }) => { throw new TransactionNotFoundError({ hash }) }

clean(); receipts.clear()
writeFileSync(A, submitted('0xdropped'))
const nonces = []
r = createWaitForBaseRunner({
  publicClient: {
    getBlock: async () => ({ baseFeePerGas: 1n }),
    getBlockNumber: async () => 200n,
    estimateGas: async () => 21000n,
    getTransactionCount: async () => 5,
    getTransactionReceipt: async ({ hash }) => { const r = receipts.get(hash); if (!r) throw new Error('none'); return r },
    getTransaction: unknown,
  },
  walletClient: { signTransaction, sendRawTransaction: broadcast((h, { nonce }) => {
    nonces.push(nonce); receipts.set('0xdropped', mk('0xdropped')); return h
  }) },
  account: { address: ADDR },
  maxBaseFeeWei: 10n, bumpAfterMs: 20, bumpPct: 20n, pollReceiptMs: 1,
  journalPath: J, attemptsLogPath: A,
})
await r.write(C, 'setBeneficiary', [ADDR])
console.assert(JSON.stringify(nonces) === '[5]', `sent at nonces [${nonces}], not once at the recorded nonce 5`)
console.assert(readFileSync(J, 'utf8').includes('0xdropped'), 'the dropped tx, mined elsewhere, was not journalled')
console.log('11 ok: a tx the node dropped is sent again only at its recorded nonce, and its mined hash is journalled')

clean(); sent = 0
writeFileSync(A, submitted('0xunreadable'))
r = stub({ publicClient: { getTransaction: async () => { throw new Error('fetch failed') } } })
threw = null
try { await r.write(C, 'setBeneficiary', [ADDR]) } catch (e) { threw = e.message }
console.assert(threw === 'fetch failed' && sent === 0, `expected a stop without a send, got ${threw} after ${sent} sends`)
console.log('12 ok: an attempts-log tx that cannot be read stops the run before any send')

clean(); sent = 0; receipts.clear()
writeFileSync(A, submitted('0xlost'))
r = stub({ publicClient: { getTransaction: unknown, getTransactionCount: async () => 6, getTransactionReceipt: async () => { throw new Error('none') } } })
threw = null
try { await r.write(C, 'setBeneficiary', [ADDR]) } catch (e) { threw = e.message }
console.assert(threw && /nonce 5 of 0xlost is used/.test(threw) && sent === 0, `expected a stop without a send, got ${threw} after ${sent} sends`)
console.log('13 ok: a recorded nonce used by another tx stops the run')

clean(); sent = 0; receipts.clear()
r = stub({ pollReceiptMs: 1, walletClient: { signTransaction, sendRawTransaction: broadcast((h) => {
  sent++; lastHash = h; receipts.set(h, mk(h)); throw new Error('The request took too long to respond.')
}) } })
await r.write(C, 'setBeneficiary', [ADDR])
const attempts = readFileSync(A, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
console.assert(sent === 1 && readFileSync(J, 'utf8').includes(lastHash), `expected the accepted tx journalled after one send, got ${sent} sends`)
console.assert(attempts.findIndex(({ outcome }) => outcome === 'submitted') < attempts.findIndex(({ outcome }) => outcome === 'broadcast-error') &&
  attempts.some(({ outcome, txHash, nonce }) => outcome === 'submitted' && txHash === lastHash && nonce === 0), 'the hash and nonce were not logged before the broadcast')
console.log('14 ok: a broadcast that fails after the node accepted the tx is waited for, its hash and nonce logged first')

clean(); sent = 0; receipts.clear()
threw = null
r = createWaitForBaseRunner({
  publicClient: {
    getBlock: async () => ({ baseFeePerGas: 1n }),
    getBlockNumber: async () => 200n,
    estimateGas: async () => 21000n,
    getTransactionCount: async ({ blockTag }) => (blockTag === 'latest' ? 1 : 0),
    getTransactionReceipt: async () => { throw new Error('none') },
  },
  walletClient: { signTransaction, sendRawTransaction: broadcast(() => { sent++; throw new Error('nonce too low') }) },
  account: { address: ADDR },
  maxBaseFeeWei: 10n, bumpAfterMs: 20, bumpPct: 20n, pollReceiptMs: 1,
  journalPath: J, attemptsLogPath: A,
})
try { await r.write(C, 'setBeneficiary', [ADDR]) } catch (e) { threw = e.message }
console.assert(threw && /nonce 0 of 0x[0-9a-f]{64} is used/.test(threw) && sent === 1, `expected a stop after one send, got ${threw} after ${sent} sends`)
console.log('15 ok: "nonce too low" with the nonce used by another tx stops the run instead of sending at the next nonce')

clean()
console.log('\nall journal checks passed')
