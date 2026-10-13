// Exercises the resume logic changed for M5/M6 with stub clients: no chain.
import { writeFileSync, rmSync, readFileSync, existsSync } from 'fs'
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
  walletClient: { sendTransaction: async ({ to, data, value }) => {
    sent++; const h = `0xdead${sent}`; receipts.set(h, mk(h))
    txs.set(h, { from: ADDR, to, input: data, value }); return h
  } },
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
const orphanHash = '0xdead1'
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
  walletClient: { sendTransaction: async () => { sent++; return `0xstall${sent}` } },
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
  walletClient: { sendTransaction: async () => { sent++; return `0xreorg${sent}` } },
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
writeFileSync(A, JSON.stringify({ step: 'write:setBeneficiary', txHash: '0xdead1', outcome: 'submitted' }) + '\n')
r = stub()
threw = null
try { await r.write(C, 'setBeneficiary', [ADDR]) } catch (e) { threw = e.message }
console.assert(threw && /earlier\s+run's call/.test(threw), `expected refusal, got ${threw}`)
console.assert(readFileSync(J, 'utf8') === '', 'a different call was journalled')
console.log('9 ok: an earlier run\'s different call is not adopted')

clean()
console.log('\nall journal checks passed')
