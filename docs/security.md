# SNRC v3 — security review & accepted risks

Review dates: 2026-06-14 (initial) and 2026-07-09 (independent re-review on the
Fable model — see the dated section at the end). Scope: the wrapper-free v3
contracts that differ from upstream ENS, plus the deploy scripts. The `.testing`
TLD is now live on mainnet; findings whose status changed with deployment reality
are called out in the re-review.

- `ens-contracts/contracts/ethregistrar/BaseRegistrarImplementation.sol` (v3 changes)
- `ens-contracts/contracts/simplex/MetadataRenderer.sol` (new)
- `ens-contracts/contracts/simplex/SubnameRegistrar.sol` (new)
- `scripts/deploy-local.mjs`, `scripts/deploy-testnet.mjs`, `scripts/deploy-mainnet.mjs`
- `ens-contracts/deploy/**` (@rocketh; local/test only)

This file is the durable record of findings and **which risks have been
explicitly accepted**, so a later auditor knows what was a conscious decision
versus an oversight. Update it when the design or these decisions change.

## Findings summary

| ID | Severity | Status | Summary |
|----|----------|--------|---------|
| H1 | High (operational) | Accepted (runbook) | Deployer keeps `SimplexController` ownership (incl. UUPS upgrade) until the multisig calls `acceptOwnership()` |
| L1 | Low / informational | Accepted | `SubnameRegistrar` holds a registry-wide operator grant; safe only by immutability + the `_controller(parentNode)==msg.sender` gate |
| L2 | Low / informational | Accepted (by design) | Subnames are **soulbound to the 2LD NFT** (`ownerOf` derives from the token holder); not independently owned or transferable |
| L3 | Low | Accepted | `setMetadataRenderer` does no contract/ERC-165 check (fat-finger → recoverable metadata outage) |
| L4 | Low | **Fixed** | Label length now capped at 63 bytes at deploy (`setMaxLabelLength(63)`) |
| L5 | Low / informational | Accepted | `PublicResolver`'s `nameWrapper` slot is the `SubnameRegistrar` (subname auth via `ownerOf`); the 2LD itself is never wrapped |
| L6 | Low / informational | Accepted | `maxLabelLength` is freely settable up/down (owner-trusted policy knob) |
| L7 | Low / informational | Accepted (read-side) | Enumeration / `tokenURI` include expired-but-unburned names; readers must filter by `nameExpires` |
| L8 | Low / informational | Accepted | `UniversalResolver` deployed with a `DummyGatewayProvider` (CCIP-read unused; clients must not follow CCIP-Read) |
| L9 | Low / informational | Accepted (read-side) | A re-registered 2LD's old subname records keep resolving until `purge`d (generation invalidates ownership immediately; record cleanup is lazy) |

No critical or high vulnerability was found **in the contracts** themselves;
the single High is in the deploy/ownership handoff.

> A second, independent review on 2026-07-09 (run on Fable) confirmed this ledger
> and added findings **N1–N8** — see [the re-review](#2026-07-09--independent-re-review-fable).

## Fixed

### L4 — Unbounded label length → capped at 63 bytes
`registerWithLabel` stores the plaintext label in `labelOf` and the
`MetadataRenderer` builds JSON+SVG from it. With `maxLabelLength = 0` (no limit)
a registrant could store arbitrarily large labels (self-paid SSTORE) and inflate
the `tokenURI` render. No injection risk (the renderer's JSON/XML escaping is
fuzz-verified), but unbounded is undesirable. **Fix:** all deploy scripts now
call `baseRegistrar.setMaxLabelLength(63)` (the DNS octet limit) right after
`setMetadataRenderer`, while the deployer still owns the registrar. 63 bytes =
63 ASCII characters; fewer for multibyte labels (the cap is on `bytes(label).length`).
Subname labels are capped the same way: `SubnameRegistrar.MAX_LABEL_LENGTH = 63`
(a constant, since that contract has no general owner), enforced in `createSubname`.

## Accepted risks

### H1 — Two-step ownership handoff window (operational)
`SimplexController` is `Ownable2StepUpgradeable`. The deploy script calls
`transferOwnership(coldOwner)`, which only sets `pendingOwner`; the cold owner
must then call `acceptOwnership()`. Until it does, the **ephemeral deployer key**
still owns the controller — including `_authorizeUpgrade` (UUPS), `setPriceOracle`
(and, on `.simplex`, the price oracle's own `setPrices` / `setUsdOracle` /
`setPremium`, which have a second, separate `Ownable2Step` handover),
`disableNftGate`, `setMinCharLength`, `setDefaultResolver`, `setPublicSalesOpen`
and `freeze()`, and through it the name policy, which reads its keys from the
controller: `addReservedNames` / `removeReservedNames`, `registerReserved` and
the policy's upgrades.
(The registrar is 1-step `Ownable` and transfers immediately; only the controller
has this window. There is no reverse registrar — removed in names-v2.)

Two names-v2 changes narrow this window. `withdraw()` now pays `beneficiary`,
not `owner()`, and the beneficiary is set *before* the ownership transfer and can
afterwards only be changed by itself — so revenue is out of the deployer's reach
from the first block. And `setRegistrarAllowance` is beneficiary-only, so the
deployer cannot fund a registrar even while it still owns everything else. It can
still point the controller at a sponsor of its own with `setSponsor`, but that is
no more than the upgrade authority it already holds in this window.

**Accepted because** it is inherent to the ephemeral-deployer + 2-step pattern
and cannot be closed from the deploy script (only the cold owner can accept).
**Required operational mitigation (runbook):**
1. Immediately after deploy, the cold owner calls `SimplexController.acceptOwnership()`.
2. Verify `SimplexController.owner() == coldOwner` and `pendingOwner() == address(0)`.
3. Only then destroy/retire the deployer key. Treat it as fully privileged until step 2 passes.

### L1 — `SubnameRegistrar` registry-wide operator grant
Each user grants `ens.setApprovalForAll(subnameRegistrar, true)`, a
registry-wide operator permission over **all** their ENS nodes. This is safe
only because of two properties that an auditor must re-verify on any change:
1. The contract is **immutable** (no proxy, no general `owner`, no `delegatecall`,
   no `selfdestruct`) and its only operator-authorised registry write is
   `ens.setSubnodeRecord(parentNode, labelhash, address(this), resolver, 0)` in
   `createSubname` — i.e. it can only create a subnode **owned by itself** under
   a node the caller controls. (Its other registry writes, `setOwner`/`setResolver`
   in `_clear`, act only on nodes it already owns.)
2. `createSubname`/`deleteSubname` gate on `_controller(parentNode) == msg.sender`
   — the 2LD NFT holder (for a 2LD parent, the registry owner via auto-reclaim;
   for a subname parent, `ownerOf`). This is **load-bearing**: without it, since
   the contract is the grantor's operator, anyone could create subnames under
   another approver's node.

**Accepted** as the deliberate design (a minimal, single-purpose stand-in for the
NameWrapper). Users can revoke at any time with
`setApprovalForAll(subnameRegistrar, false)`. A `SubnameRegistrar` redeploy
requires users to re-approve the new address and re-create subnames. A redeploy
also has no expiry for names registered before it became `BaseRegistrar`'s
subname hook, and nothing can supply one, so their holders cannot create
subnames until they renew: do not replace or unset the hook on a live TLD
without a way to backfill expiries.

**names-v2 extension.** `ENSRegistry.setApprovalForAllWithSig` makes this grant
obtainable by signature as well as by transaction, so a user with no ETH can make
it via a relayer. The state written is byte-for-byte what `setApprovalForAll`
writes, and the signed struct binds `owner`, `operator`, `approved`, a per-signer
nonce and a deadline, so a relayer cannot substitute the operator or replay. The
grant's *scope* is unchanged and still registry-wide, so the two properties above
remain load-bearing. What is new is the phishing surface: signing is cheaper to
solicit than transacting. Two mitigations, both required: the client must never
sign an approval it did not construct itself, and the UI must name the operator
and state the scope before signing. Revocation is also signable, so a mistaken
grant is undone without ETH.

### L2 — Subnames are soulbound to the 2LD NFT (by design)
A subname has no independent owner: in the registry it is owned by the
`SubnameRegistrar`, and its effective owner is whoever holds the parent 2LD token
(`ownerOf(node)` walks up the parent chain to the 2LD node, whose registry owner
tracks the NFT via BaseRegistrar **auto-reclaim** on transfer). Consequences,
all intended:
- Transferring the 2LD NFT moves every subname with it instantly — no reclaim,
  no re-seize, no stale ownership, and the previous owner loses all subname rights
  the moment the token leaves (including the ability to create new subnames,
  because the 2LD registry node also follows the NFT).
- Subnames are **not** independently sellable/transferable; integrators must not
  treat them as standalone assets.
- The verbatim `PublicResolver` authorises subname records against this `ownerOf`
  via its `nameWrapper` hook (see L5).
**Accepted by design.** See also L9 (re-registration cleanup is lazy).

### L3 — `setMetadataRenderer` has no contract check
Setting the renderer to an EOA or a non-conforming contract makes `tokenURI`
revert collection-wide until corrected (it low-level-calls the renderer and
ABI-decodes a `string`). **Accepted:** `onlyOwner` (multisig), not
attacker-reachable, and fully recoverable by setting a correct renderer. Deploy
scripts set a valid renderer; operators should spot-check `tokenURI(sampleId)`
after any future `setMetadataRenderer`.

### L5 — `PublicResolver`'s `nameWrapper` slot is the `SubnameRegistrar`
The verbatim `PublicResolver` is deployed with `nameWrapper = subnameRegistrar`
(not `address(0)`). Its `isAuthorised(node)` does `if (ens.owner(node) ==
nameWrapper) owner = nameWrapper.ownerOf(node)` — so for a subname node (owned by
the registrar) the resolver authorises records against the live 2LD holder
(`subnameRegistrar.ownerOf`), while a **2LD** node (owned directly by the NFT
holder via auto-reclaim) never takes that branch and authorises directly. So the
2LD is **not** wrapped; only subname auth routes through the registrar. The
registrar implements just the one function the resolver calls (`ownerOf(uint256)`);
no other `INameWrapper` method is invoked on this path. We do not modify the
verbatim resolver — only the constructor argument. **Accepted.**

### L6 — `maxLabelLength` not monotonic
Unlike the controller's `minCharLength` (monotonic decrease), the registrar's
`maxLabelLength` is freely settable up/down by the owner. An owner could set it
to a tiny value and block new registrations. **Accepted:** owner is the
multisig (trusted); it's a policy knob, not an attacker surface.

### L7 — Enumeration includes expired names
`ERC721Enumerable` (`totalSupply` / `tokenOfOwnerByIndex` / `balanceOf`) and
`tokenURI` reflect raw token ownership, which is only updated on
transfer/mint/burn — **not** on expiry (a name is burned only on re-registration
after its grace period). So they can disagree with the grace-period `ownerOf`.
**Accepted (read-side contract):** all readers (the dApp, resolvers, integrators)
MUST filter by `nameExpires(id) > block.timestamp`. Documented as an invariant
on `BaseRegistrarImplementation`.

### L8 — `DummyGatewayProvider` on the `UniversalResolver`
The `UniversalResolver` is deployed with a dummy CCIP-read gateway provider.
SNRC resolves on-chain (text records), so no off-chain gateway is relied upon.
The dummy provider does not stop the UR from re-emitting `OffchainLookup` when a
name's resolver reverts with one, so a client that follows CCIP-Read fetches
whatever URL a name holder's resolver names: the holder learns who looked the name
up, and can serve that reader different records. The `.simplex` dApp therefore
refuses every CCIP-Read request: its client's `ccipRead.request` always rejects,
which also covers ensjs's multicall decoder, a path that ignores `ccipRead: false`
(pre-launch review rounds 2 and 3, R2-2 and R3-1). **Accepted** as long as clients
do not follow CCIP-Read; revisit if off-chain resolution is ever added.

### L9 — Re-registered 2LD's old subname records resolve until purged
When a 2LD expires and is re-registered, BaseRegistrar calls
`subnameRegistrar.onReregister(node)`, which bumps a per-2LD `generation`. This
invalidates the previous owner's subnames **immediately** at the ownership level:
`ownerOf` returns `address(0)` for them, so no one can modify them and the dApp
won't list them. But their **stored resolver records keep resolving** until the
registry/resolver storage is cleared — you cannot atomically delete an unbounded
number of subnames inside the re-registration tx. Cleanup is therefore a
permissionless, batched `purge(parentNode, labelhashes[])` (storage-refund
incentivised). **Accepted (read-side):** this matches plain ENS (an expired
name's subnames also linger until cleared); the dApp should `purge` on 2LD
acquisition. The leak is records-only — ownership/authorisation never transfers
to the new owner without an explicit `createSubname`. The dApp does not purge on
acquisition yet; accepted as is in the pre-launch review (2026-10-21, M5).

## Assurances (verified properties)

- **No reentrancy surface** in the new contracts: the registry is trusted, the
  renderer is `view`, no ETH is handled, and the controller's record-write path
  is `nonReentrant` (covered by the `ReentrantResolver` test).
  `SimplexNamePolicy`'s only state-changing outbound call is the
  controller's `nonReentrant` `commit`; its consume paths make no outbound
  calls.
- **`labelOf` cannot be spoofed** (registrar or subname): the key is
  `keccak256(label)` and the value is `label`, so the stored entry is always the
  correct preimage; write-once only avoids redundant writes.
- **`registerWithLabel` is the only registration path** — every registration
  records its label; the raw-labelhash `register(uint256)` was removed.
- **Deploy ordering is sound:** reserved names are set and the TLD node is handed
  to the registrar before registration is possible; `setMetadataRenderer` /
  `setMaxLabelLength` run before the ownership handoff; the 60s commit-reveal
  blocks same-transaction front-running.
- **MetadataRenderer escaping is fuzz-verified** — no JSON or SVG injection from
  adversarial labels (`test/simplex/FuzzMetadataRenderer.test.ts`).
- Removing NameWrapper eliminated the prior renew-desync issue and the
  wrapper-aware-resolver authorization complexity.

---

## 2026-07-09 — independent re-review (Fable)

A fresh review of the same scope, run independently on the Fable model and
cross-checked against live mainnet state. It **confirms every ledger finding
above** (H1, L1–L9) and adds the items below. **Owner note:** the live cold owner
is the `simplexchat.eth` **EOA** (`0xDa06…0340`), not a multisig — read "multisig"
above as "the cold owner."

### Ledger status change

- **H1 — exposure elevated, still open.** 16 days after the `.testing` deploy
  (2026-06-23) the cold owner still has not called `acceptOwnership()`, so the
  ephemeral deployer EOA (`0xD83B…fBC9`) remains the controller owner — and the
  key is demonstrably **hot**: on 2026-07-09 it sent `disableNftGate()` then a
  `commit`/`register`. The blast radius is wider than first stated: the verbatim
  `PublicResolver` trusts `trustedETHController` (the proxy) for **every** node,
  so UUPS-upgrade authority ⇒ the ability to rewrite any name's
  `simplex.contact`/`simplex.channel` records (a routing hijack across all
  `.testing` names), plus arbitrary register/renew, an oracle swap, and a one-step
  `renounceOwnership()` brick. `trustedETHController` is immutable in the resolver,
  so recovery from a malicious upgrade would mean redeploying the resolver and
  migrating every name. **Action: complete the ownership handoff now; treat the
  deployer key as fully privileged until then.**

### New findings

| ID | Severity | Summary |
|----|----------|---------|
| N1 | Medium (operational) | NFT gate now disabled + zero pricing ⇒ open, free `.testing` registration |
| N2 | Low | A revived subname inherits the previous owner's resolver records |
| N3 | Low | Deleting a middle subname strands its descendants (records keep resolving) |
| N4 | Low / info — **FIXED** | Reverse-record registrations always revert on mainnet (reverse registrars are `address(0)`) |
| N5 | Low / info | Unrestricted on-chain charset ⇒ display spoofing (homoglyph/bidi), not injection |
| N6 | Info | `purge`/`delete` linear-scan children — quadratic on large sets; purge front-first |
| N7 | Info — **partly FIXED** | `withdraw()` pays `owner()` (the deployer during the H1 window); `renounceOwnership` not disabled |
| N8 | Info | Documentation drift (some fixed with this review) |

- **N1** — `nftGateEnabled()` is now `false` (disabled on-chain 2026-07-09,
  one-way) and the `.testing` price array is all zeros, so anyone can mass-register
  6+-char `.testing` names for gas only (the reserved list covers only `simplex`,
  `simplex-chat`). If unintended, recourse is `setPriceOracle` (still unfrozen) or
  a UUPS upgrade. Confirm intent.
- **N2** — `createSubname` revives a generation-dead node but leaves the old
  owner's `PublicResolver` records intact (`purge`/`_clear` zero the registry
  resolver pointer, not resolver storage). Mitigation: the dApp should
  `clearRecords(node)` alongside `createSubname`, and on 2LD acquisition.
- **N3 — FIXED (R3-2).** `deleteSubname` on a middle node left descendants that
  `purge` skipped while their generation still matched. A subname now has an
  owner only while its whole chain up to the 2LD is intact, so they have none,
  `purge` removes them, and re-creating the middle node does not restore them;
  their records resolve until purged.
- **N4 — FIXED (names-v2).** `register()` used to call the reverse registrars when
  the reverse bits were set, but both are `address(0)` on mainnet, so such a call
  reverted after the 60 s commit was already spent. The recommended mitigation
  (early-revert) is implemented, and then some: reverse resolution is removed from
  the deployment altogether. `makeCommitment` rejects any non-zero `reverseRecord`
  with `ReverseRecordNotSupported`, so the commit is never spent; the two registrars
  are no longer deployed; and `PublicResolver` no longer inherits `ReverseClaimer`,
  which was the last thing forcing one to exist. A related defect found on the way:
  the branch passed `msg.sender` as the reverse subject, so a *sponsored*
  registration would have named the registrar's hot wallet rather than the buyer.
- **N5** — only min length (≥ 6 codepoints) and max bytes (≤ 63) are enforced;
  labels may contain homoglyph/bidi/zero-width characters. The renderer escaping
  blocks JSON/SVG injection, but lookalike names can be minted for
  marketplace/social spoofing. ENSIP-15-normalising clients won't resolve them.
  Accept (matches ENS's on-chain posture) or enforce an LDH charset in `valid()`.
- **N6** — `_removeChild` linear-scans `_children`; deleting/purging a large dead
  set naively is O(n·m). A front-of-array-first purge is O(1) per item.
  Self-inflicted; document the ordering.
- **N7 — partly FIXED (names-v2).** `withdraw()` no longer pays `owner()`: it pays
  `beneficiary`, a role set once by the owner while unset and thereafter only by
  itself, so the deploy key never controls revenue and the H1 window does not
  cover it. Still open: the inherited one-step `renounceOwnership` is not
  disabled, and an owner slip would permanently orphan admin and upgrades. That
  now matters *more*, not less — the plan deliberately keeps the owner alive
  forever so brand reservation can continue, so there is no point at which
  renouncing is the intended move. Consider overriding it to revert.
- **N8 — FIXED.** The two items this left open outside `docs/` are now corrected:
  `CLAUDE.md`'s claim about keeping upstream `register(uint256,…)`, and
  `ens-contracts/docs/upgrades.md`'s stale `__gap[49]`. `upgrades.md` now
  documents the real layout (`__gap[45]`, the names-v2 block, and the reserved
  placeholder slots) and the fact that `freeze()` ends upgradeability entirely.

**Verdict:** no new critical/high in the contracts themselves. The dominant risk
remains operational — the ownership handoff is still open with a hot deployer key
whose upgrade authority transitively controls every name's resolver records, and
that same key one-way-disabled the NFT gate (with zero pricing ⇒ open, free
registration).

---

## names-v2 — new surface and adversarial review

names-v2 adds sponsored registration (a registrar spends a money allowance, the
user never holds ETH), one-shot EIP-712 intents relayed on the user's behalf, a
two-key governance split, and a one-way `freeze()`. It removes reverse
resolution and, in an earlier revision, an on-chain edit-credit system.

### New privileged surface

| Function | Who | Notes |
|---|---|---|
| `SimplexSponsor.setRegistrarAllowance(registrar, attoUSD)` | the controller's beneficiary only | Replaces, not adds. Zeroing it is the kill switch for a compromised registrar and must take one transaction. |
| `setBeneficiary(address)` | owner while unset, beneficiary thereafter | Set before the ownership handover, so revenue is independent of the deploy key from the first block. |
| `setPublicSalesOpen(bool)` | owner **or** beneficiary | Restrictive direction on the fast key: an exploit in the payable path accrues harm per block. Dies at `freeze()`. |
| `SimplexNamePolicy.addReservedNames(string[],Reason)` | owner **or** beneficiary | Also fast, and for a sharper reason: a scheduled reservation would tell a squatter which name is valuable and how long it stays unprotected. Reserving a held name also stops its renewal, so after expiry and grace only `registerReserved` can assign it. |
| `removeReservedNames`, `registerReserved` (name policy), `setDefaultResolver`, `setMinCharLength`, `setPriceOracle` | owner only | Permissive directions stay behind the timelock. `registerReserved` also releases the reservation, so the holder can renew. |
| `setSponsor(address)` | owner only | The one contract allowed to call `registerSponsored` / `renewSponsored`, trusted with the allowance and the owner-consent check. Dies at `freeze()`. |
| `freeze()` | owner only | One-way. Makes the implementation, the name policy's implementation and the sponsor permanent and seals `setPublicSalesOpen`. Refuses while sales are closed or no sponsor is set, so a mis-ordered freeze cannot shut the payable or the sponsored path forever. |
| `SimplexNamePolicy.addCommunityNames(string[])` | owner **or** beneficiary | Restrictive: a listed name can then be registered or received only by someone who accepts the current community terms, except through `registerReserved` and other registrar controllers (admin), under an off-chain agreement. Skips any name that is registered or in its grace period, since its holder never accepted them. Sent privately, like reservations: a pending listing reveals the name, which a squatter can then register under the general terms. |
| `removeCommunityNames`, `setGeneralTerms(string)`, `setCommunityTerms(string)` | owner only | Each setter stores a link to one file at one commit and its keccak256; an empty link reverts. After a new link, an acceptance of that kind not yet used at registration or claim must be made again; the other kind's acceptances stay valid, and existing holders are not asked to accept. |
| `setNamePolicy(address)` on the controller and on the registrar | owner only | Survive `freeze()`. The policy is called on every paid or sponsored registration, every renewal and every non-controller transfer of every name, so a wrong or hostile target blocks them. The controller's setter refuses zero, so the reserved list always applies; the registrar's accepts zero, which drops the transfer check. A setter reverts unless the target's `controller()` (or `registrar()`) returns that controller or registrar: this catches a target bound to another controller or registrar, not a hostile one, so check that both pointers reference the same instance. The controller's setter also reverts for the policy's implementation; the registrar's accepts it, and every holder transfer then reverts until the pointer is corrected. A new policy contract starts empty: its reservations must be in place before the controller points at it, and it cannot list held names as community names; upgrading the policy keeps both lists. |
| `SimplexNamePolicy` upgrade (UUPS) | controller owner, until the controller is frozen | Keeps the lists, acceptances and nonces. The new implementation must be built for the same controller and registrar (`ImplementationMismatch`). The policy is a registrar controller, so until the freeze an upgrade can mint any available name; the admin can already add a controller. |
| `commitUnderGeneralTerms`, `commitUnderCommunityTerms`, `acceptGeneralTermsForClaim`, `acceptCommunityTermsForClaim`, and their `WithSig` variants | the registrant or recipient, or anyone holding their signature | Records acceptance of the current terms hash of that kind, keyed by the acceptor and, for a claim, by the holder and the offer, so a copied commitment cannot block the owner and an acceptance cannot be reused for another holder. |
| `SimplexSponsor.registerWithCredit`, `renewWithCredit` | any address with allowance | Deducts the name's own list price in attoUSD. No value attached. Registering for anyone but the caller needs the owner's `RegisterName` signature. |
| `approveWithSig`, `setTextWithSig`, `clearRecordsWithSig`, `setApprovalForAllWithSig`, `createSubnameWithSig`, `deleteSubnameWithSig` | anyone holding the owner's signature | The relayer pays gas and chooses nothing else. Each contract keeps its own per-signer nonce. |
| `claimWithSig` | anyone holding the recipient's signature | Completes an open offer to that recipient. |

### What `freeze()` does not stop

`freeze()` fixes the implementation, the name policy's implementation and the sponsor, and
seals the sales switch. It does **not** end issuance, and the plan should not be read as
saying it does:

- the guardian can still fund a registrar (`setRegistrarAllowance`, on the
  sponsor) and that registrar can still mint names through `registerWithCredit`,
  each to itself or to an owner who signed for it;
- the owner can still `addReservedNames` and `registerReserved` on the name
  policy;
- the owner or the guardian can stop the renewal of a held name by reserving it,
  and once its grace period ends only `registerReserved` can assign it;
- the owner or the guardian can list community names, and the owner can set new
  terms, remove names from the list, repoint the controller's pointer to
  `SimplexNamePolicy`, and repoint or unset the registrar's. Unsetting the
  registrar's drops the transfer check; a wrong target can block every
  registration, renewal or transfer, or apply another instance's list and terms,
  until the owner corrects it, after the timelock.

That is deliberate — brand reservation, outreach and disputes have to continue
for the life of the namespace, which is why the owner is never renounced. The
guarantee a freeze gives is narrower and worth stating exactly: **no key can
change the code, and no key can take a name from its holder before its
registration expires.** Names that are unregistered remain issuable by the two
governance keys forever.

### Bounds that are the registrar's job, not the contract's

`SubnameRegistrar` supports arbitrary depth, and `ownerOf` walks the parent chain
on every authorisation, so a subname nested D levels deep costs O(D) per read and
a subtree built to depth D costs O(D²) to create. Nothing on-chain caps D.

This is left off-chain on purpose. The relayer is the only sponsored caller: it
sees the full call before it pays for it, so it can refuse an abusive depth for
free, whereas a constant compiled into an immutable contract is a guess at a
limit that can never be revised. A user paying their own gas is only ever
grieving themselves. **Relayer operators must enforce a depth limit** (5 is
ample for the SimpleX UX) along with the payload and gas bounds they already
apply.

### Shadow subnames, and what a buyer must check

A 2LD's holder owns its registry node, so they can call
`ENSRegistry.setSubnodeOwner` directly and create a subname the
`SubnameRegistrar` never sees. Such a node is not soulbound, is not indexed, and
has no generation, so **selling the 2LD does not move it**: after the sale
`pay.alice.simplex` can still be owned — and still resolve — to the seller,
while `alice.simplex` belongs to the buyer.

Registry authority over a subnode belongs to the parent's owner by construction,
and the registrar's soulbinding works only because the registrar happens to own
the nodes it created; a 2LD owner can pull even a *tracked* subname back out the
same way. Since recipient consent the registry refuses to make anyone but the
caller the owner of such a node, so a shadow subnode can no longer name a third
party — but its holder can still keep one for themselves, and that cannot be
prevented on-chain.

What makes it a disclosure problem rather than a theft one is that it is always
recoverable: `setSubnodeOwner` is authorised against the **parent**, so the new
holder can overwrite any subnode under their name unilaterally, and the previous
owner is then locked out. Both directions are pinned in
`TestShadowSubnames.test.ts`.

So the requirement lands on the buyer, and on whatever surfaces a name for sale:

- **Before buying, enumerate the name's subnodes** — the registrar's index shows
  only the ones it created, so completeness needs `NewOwner` logs on the registry
  filtered by the 2LD node, not `getChildren`.
- **After buying, overwrite anything unexpected.** One `setSubnodeOwner` per
  label; no cooperation from the seller is needed. Overwriting a subname the
  registrar tracks takes it out of the registrar: every subname under it then
  has no owner for good, anyone can `purge` their records, and creating it again
  does not restore them.
- A subname's records survive the overwrite, so re-point or clear them too, or
  call `createSubname`/`createSubnameWithSig` on the node, which clears them.
  That clears the node only: nodes under it need the same, from the top down.

### Recipient consent

An address can be tied on chain to content its owner never chose: register a
name with illegitimate records to it, transfer one to it, or make it the owner of
a node, and the chain records it as the holder for good. So nothing is assigned
to an address without its owner's consent, which means being the caller or
signing an EIP-712 intent ([`plans/recipient-consent.md`](./plans/recipient-consent.md)):

- the payable `register` registers to the caller only; `SimplexSponsor` checks the
  owner's `RegisterName` signature, which covers the label, the resolver and every
  record written at registration, and is single-use through a per-signer nonce;
- a transfer is an offer (`approve` / `approveWithSig`) that only the recipient,
  or a controller, can complete (`transferFrom` to itself / `claimWithSig`), and
  any change of holder clears the offer;
- `ENSRegistry` makes nobody the owner of a node but the caller, except for the
  root node and the subnodes of the root and of a TLD; `reclaim` points at the
  holder only.

Accepted:

- **The root's and the TLDs' owners are trusted, permanently.** They assign nodes
  to anyone, and so do their registry operators. The admin key owns the root and
  `eth`; the registrar owns `simplex` and assigns a name's node only to its holder.
  The deploy scripts deploy no `Root`, so nothing locks the `simplex` label: the
  admin key can point it at itself and re-point the registry owner and resolver of
  any held name, also after `freeze`.
- **`registerReserved` is exempt.** The admin assigns a reserved name to any
  address, for a term of two to eleven years (at most three for a community name), without its signature, also after
  `freeze`, and releases the reservation; the admin or the guardian can reserve
  any name at once, and a reserved name cannot be renewed.
  It is an admin call, and public.
- **Controllers are trusted.** A controller may register any available name
  directly to any address and transfer a name it holds, was offered or operates
  for to anyone, and `addController` survives `freeze` as the repair path.
- **Consent covers the name, not its contents.** Between the recipient's consent
  and the claim landing, the holder can still change the name's records, point
  its registry resolver at a contract of the holder's own, and create subnames
  and shadow subnodes under it, and they stay under the name after the claim; a
  holder watching the mempool can do so right before the claim. Each subname has
  to be deleted separately, and a transfer does not invalidate subnames the way a
  re-registration does. No relayed call resets a 2LD's registry resolver: a
  recipient without ETH needs a registry operator for that. A shadow subnode can
  be taken over without ETH by `setApprovalForAllWithSig(SubnameRegistrar)`,
  `createSubnameWithSig` (after a permissionless `purge` if it is stale) and
  `deleteSubnameWithSig`, but only when its label is known, non-empty and at
  most 63 bytes; otherwise only ETH or a registry operator clears it (and under
  a tracked subname only by taking that subname out of the registrar, which
  costs its whole subtree), so clients
  refuse to claim a name with such a subnode (the dApp instead lists it with a
  warning and requires an acknowledgement; see
  `docs/plans/recipient-consent.md` §9). A holder who front-runs the claim
  can still add one. A claim signature is valid for one offer (`offers(tokenId)`
  is in `ClaimName`), so a holder cannot withdraw, keep the signature and submit
  it later. Before signing a claim, clients must check the name's registry
  resolver and enumerate its subnodes, and theirs in turn, from the registry's
  `NewOwner` logs, ownerless ones included, since those can still have a
  resolver; they must never claim automatically, and should clear records and
  remove unexpected subnames right after claiming.
- **A sponsor is never reinstalled.** Nonces and allowances belong to each
  sponsor, so pointing the controller back at an earlier one would revive its
  unused signatures and allowances.
- **Contract wallets must be deployed to consent.** ERC-1271 signatures work only
  for deployed contracts; a counterfactual smart wallet cannot sign `RegisterName`
  or `ClaimName` (no ERC-6492).
- **A signature consents to whatever it names.** As for L1, the client never
  signs a `RegisterName` or `ClaimName` it did not construct itself, and shows
  the name and what it carries before signing.
- **An unused `RegisterName` signature stays valid until its deadline.** Nothing
  cancels it, so clients sign with short deadlines: a sponsored registration needs
  only the commitment age. The same holds for an unused `ClaimName` signature
  while its offer stands, including an offer that a renewal revives after the
  name expired, and for an unused `ApproveName` signature, which a plain
  `approve` does not invalidate.
- **A failed claim holds up the recipient's later intents.** `ApproveName` and
  `ClaimName` share the registrar's per-signer nonce, and the holder can make a
  claim fail by withdrawing the offer, so clients sign no other registrar intent
  behind an unlanded claim and re-sign after a failed one.
- **Old records can come back with a re-registration.** Records are retired only
  on the resolver the registry points at when the name is re-registered. A
  previous holder who pointed the node at no resolver, or at another past
  default, before the name lapsed leaves records in a default resolver that
  resolve again once the new registration points back at it; a bare registration
  (`resolver == 0`) keeps a non-default resolver pointer. Subnames have similar
  gaps: a subname under a deleted subname, or one taken out of the
  `SubnameRegistrar`, keeps its records, and the previous holder keeps owning and
  writing any shadow subnode, so clients enumerate a previously held label's
  subnodes before registering it, as before a claim. These predate recipient
  consent.
  The pre-launch review (2026-10-21, M4 and M5) found the gap wider than stated
  and the client mitigations absent, and both were accepted as they are: the
  re-point to no resolver works after the name has lapsed and even after the
  next buyer's commit, and the `.simplex` dApp neither clears records nor
  purges or enumerates a previously held label's subnodes when it registers
  one, so a buyer who does not clear and purge by hand can inherit the previous
  holder's records and subnames.
  Round 3 (R3-2) closed the part that went beyond this: a former holder could
  create subnames under a subname they had pulled out of the registrar, and
  the registrar credited those to the next holder. `SubnameRegistrar` now
  gives a subname an owner only while its whole chain up to the 2LD is intact,
  gives no node outside that chain a controller, and clears a node's records
  when `createSubname` is called on a node it does not own, so leftovers no
  longer show as the buyer's subnames, and `createSubnameWithSig` clears one
  without ETH. That clears the node only: nodes under it need the same, from
  the top down, and a stale node the registrar owns must be purged first.
  Leftover registry nodes still resolve for clients that do not check
  `ownerOf`.
- **An offer is public before it is accepted.** `Approval`, and the announcement
  when one is sent, name the recipient though nothing has moved. So do
  `ApprovalForAll` on the registry, the registrar and the resolver, and the
  resolver's per-node `Approved`; none of them assigns anything. An announcement
  costs its sender only gas and stays in the logs after the offer is withdrawn or
  replaced, so a scanner treats it as an offer only while `getApproved` returns
  its stealth address.
- **An offer outlives its signature.** The `ApproveName` deadline limits when the
  signature can be submitted. The offer itself stands until a transfer, a burn or
  a withdrawal, including through the grace period, so a renewal by anyone
  revives it. Plain `approve` still accepts a lapsed name, and a renewal makes
  that offer claimable too. `approveWithSig` refuses a lapsed name, so a holder
  without ETH withdraws an offer during the grace period only after a renewal.
- **Records can still name someone else.** An `addr` record, and the registry's
  resolver pointer, can point at any address, and a text record can contain
  another person's SimpleX link. Records assign nothing; the client shows a name
  against a profile only with that profile's `SimplexDomainProof`.
- **No marketplace sales.** A settlement contract that delivers to the buyer is
  neither the buyer nor signed by them. Counting a buyer's operator approval as
  consent was turned down: anyone who had approved a marketplace could then be
  sent names through it.
- **No push to a burn address.** A holder who wants rid of a name offers it to a
  contract that takes it and never transfers it on. None is deployed, a holder
  without ETH cannot deploy one, and letting the name lapse is not in the holder's
  control, since anyone may renew it.
- **Contracts that take a name and transfer it on trap it.** Escrow-style markets,
  lending and staking vaults transfer to a third party without calling `approve`
  first, so the transfer reverts and the name stays in the contract until it
  lapses. Clients must warn before offering a name to a contract.
- **The root of trust is no longer additive.** The rule is a restriction in
  `ENSRegistry` itself. The upstream `ReverseRegistrar`, which assigns each address
  a node under `addr.reverse`, cannot run against it; SNRC deploys none.

### Terms acceptance and front-running

Every registration and every non-controller transfer consumes an acceptance of
the name's terms: the community terms for a listed name, the general terms
for any other. What a third party can do with what it sees in the mempool:

- **Commit the same commitment first.** The policy then skips its own commit and
  still records the buyer's acceptance, keyed by the buyer; commit age only
  starts sooner. Nobody can accept, or overwrite an acceptance, for someone else.
- **Copy a signed acceptance and submit it first.** It records only the signer's
  acceptance, and the relayer's transaction reverts `InvalidNonce`. The relayer
  must then read `acceptedTerms` and go on to the registration when it holds the
  required hash, rather than ask the buyer to sign again.
- **Replay a signature.** The four EIP-712 types differ per kind and bind the
  commitment or offer, the hash, the nonce and the deadline; the per-signer nonce
  is shared by all four, so an older unsent signature dies once a newer one is used.
- **Learn whether a committed name is listed** from the commit call it uses. The
  list is public and small, and registration stays first commit, first reveal.

Terms change only by the admin through the timelock, and the list only by the
admin or the guardian; a buyer whose terms changed accepts again for the same
commitment. A claim acceptance can be invalidated only by the holder, by
offering again.

### Client and relayer version coupling

`TRANSFER_TYPEHASH` gained `ephemeralPubKey` and `viewTag`, and the transfer
announcement is now ERC-5564's `Announcement` rather than a bespoke event. Both
are consensus between the contract and everything that signs for or watches it,
and `BaseRegistrarImplementation` is **not** upgradeable — so the two shapes
cannot coexist in one deployment and cannot be migrated after the fact.

- Signers, relayers and scanners must ship in lockstep with the deployment they
  talk to.
- The live `.testing` registrar keeps the **old** typehash and the old event
  permanently. A client must key both off the deployment it is addressing, not
  off its own build. `.testing` is not being upgraded, so this is a fork in the
  client, not a migration.
- Recipient consent changed the shapes again for `.simplex`. `transferWithSig`
  and `TRANSFER_TYPEHASH` are gone: a transfer is an `ApproveName` offer, whose
  `approveWithSig` emits the announcement, followed by the recipient's
  `ClaimName`, which names the offer it claims. A sponsored registration needs
  `RegisterName`, verified by `SimplexSponsor`. `.testing` keeps
  `transferWithSig` and has neither.

### Deployment opsec

The deploy runner is as much a part of the security boundary as the contracts,
because a mis-run is unrecoverable in the same way a bad constructor argument is.
What it now refuses to do:

- **Run against the wrong chain.** `chainId` is asserted to be 1 before any
  spend, so an `MAINNET_RPC_URL` pointing at a testnet stops the run instead of
  deploying a full stack to the wrong place and journalling it as a success.
- **Accept a mistyped address.** Every address input goes through viem's
  `getAddress`, which re-checksums rather than rejects a wrong EIP-55 checksum, so
  a transposed character is not caught. The admin is covered anyway: nothing
  irreversible goes to `OWNER_ADDRESS` before it has accepted ownership. The
  guardian is not: run 1 makes `GUARDIAN_ADDRESS` the permanent beneficiary with
  no proof that anyone can sign for it, and `GUARDIAN_ADDRESS` equal to the deploy
  key is not refused. A wrong guardian loses registrar funding and the `withdraw`
  payee until an admin upgrade before `freeze()`; the admin keeps the pause and
  reservations. Accepted (pre-launch review round 2, R2-1): plan A1's rehearsal
  transaction and the guardian's first use at GOV3 surface it before any third
  party holds a name.
- **Deploy against a dead price feed.** `latestAnswer()` is probed up front; a
  feed returning zero or negative makes every quote revert and the payable path
  unusable from the first block.
- **Deploy stale bytecode.** The run compiles before it starts. Freshness is not
  inferred from timestamps — Hardhat caches on content, so an mtime heuristic
  both misses real staleness and blocks on touched-but-unchanged files. This is
  also the check that would have caught the branch that did not compile.
- **Pay without limit.** The stall bump compounds 20% per stalled interval and
  had no ceiling; it now stops at `ABSOLUTE_MAX_BASE_FEE_GWEI` (4× the configured
  cap by default) rather than paying whatever a congested week demands.
- **Build on a block that might not survive.** Each step waits three
  confirmations before the next one depends on it, and a receipt that a reorg
  removes returns the step to waiting rather than being journalled.
- **Overwrite the record of a live deployment.** An addresses file with no
  journal beside it aborts the run.
- **Leak the provider key.** The fork URL reaches the child process through the
  environment; `--fork <url>` put it in argv, where any local user could read it
  from `ps`.

And what it now proves rather than assumes: a **post-deploy read-back** checks
the TLD node's owner, the controller's registration, `maxLabelLength`, the
subname hook, the metadata renderer, the default resolver, the beneficiary, the
sponsor and its controller, the NFT gate, `minCharLength`, the freeze and sales flags, the subname registrar's
resolver, every reserved label, the oracle and its feed, and that a six-character name quotes a non-zero price. A journal proves
each transaction was mined; only the read-back proves the stack is wired the way
the script intended. The first run reads back while the deploy key still owns
everything, then prints the `acceptOwnership()` calls the admin must make — until
those land, `Ownable2Step` leaves the deploy key in control and it must be
treated as hot. The registrar and the registry root, `eth` and `data.eth` take
effect at once when handed over, so only a second run hands them over, and only
after reading that the admin owns both `Ownable2Step` contracts; its read-back
checks that the admin owns everything and nothing is pending.

### The invariant everything rests on

`BaseRegistrarImplementation._register` opens with `require(available(id))`, and
`available(id)` is `expiries[id] + GRACE_PERIOD < block.timestamp`. That check is
in the **immutable** registrar, so no owner power on any contract — including an
arbitrary controller upgrade before the freeze — can seize, transfer or re-point
a name someone holds. `reclaim` requires `_isApprovedOrOwner` and points the node
at the holder only; `approveWithSig` requires the holder's signature and a
grace-aware `ownerOf`, and only the recipient, or a controller, can complete the transfer.

### Adversarial review (three expert personas + independent refutation)

No critical, high or medium finding survived. Fixed as a result: a permissionless
edit-credit faucet and an overflow that could brick renewals (both removed with
the credit system itself); `freeze()`'s missing `publicSalesOpen` guard;
`StablePriceOracle`'s unchecked `latestAnswer()` cast; the sponsored path's
needless dependency on the ETH/USD feed; and the reverse-record subject bug.

A second round against the branch found, and this revision fixes, four issues
that all shared one root — **state that outlives the registration it belongs
to**:

- **Stale records on re-registration.** A name that lapsed kept its previous
  owner's text records, so a squatter's SimpleX address resolved under the new
  owner's name. `_registerCore` and `registerReserved` now retire records on the
  default resolver before writing anything new.
- **Revived subnames.** The same leak one level down: re-creating a label left
  behind by a previous 2LD owner resurfaced their records. Creating over a
  generation-dead subname is now refused outright — `purge` first — and both
  `purge` and `deleteSubname` retire the records they drop. Nodes the registrar
  does not own (left in the registry, or pulled out of the registrar) have their
  records cleared when a subname is created over them (pre-launch review round
  3, R3-2).
- **Expired 2LDs kept their subtree.** Registry ownership of a 2LD survives
  expiry, so its former holder retained subname authority indefinitely. The
  registrar now mirrors each registration's expiry (`onExpiryChanged`) and gates
  authority on it.
- **Unauthenticated announcement fields.** `ephemeralPubKey` and `viewTag` sat
  outside the signed struct, so a relayer could fabricate a stealth derivation on
  a genuine transfer. They are now part of `TRANSFER_TYPEHASH`, and the event
  itself is ERC-5564's `Announcement` verbatim rather than a bespoke one.

A third pass over those fixes found two more, both fixed here:

- **Record retirement was scoped to the *current* default resolver**, so the
  first `setDefaultResolver` rotation would have silently stopped retiring
  records for every name still pointing at the old one — reopening the leak
  without any code changing. The controller now remembers every resolver it has
  ever made the default (`wasDefaultResolver`) and retires against that set. The
  set is deliberately not "any resolver": each entry is one we deployed and that
  trusts the controller, so the call can neither revert nor burn the
  registrant's gas on a hostile resolver.
- **The deploy runner treated inclusion as success.** A transaction that reverted
  at inclusion still produced a receipt, and the step was journalled as done and
  skipped on every later resume. `recordSuccess` now refuses a non-success
  receipt and stops the run.

Accepted, and new to this ledger:

- **V1 — a compromised guardian is unrecoverable after the freeze.** Only the
  beneficiary may rotate itself, and the post-freeze upgrade escape is closed, so
  a compromised guardian permanently holds `withdraw` and `setRegistrarAllowance`.
  No name can be taken from its holder before it expires, but the guardian can
  reserve held names, which stops their renewal, and reserve them again whenever
  the admin releases them. The admin's recovery is to release and renew each
  such name in one atomic timelock batch, every term, or to add a
  `BaseRegistrar` controller that renews regardless of reservations
  (`addController` survives the freeze). Accepted on the basis that the guardian
  is a Safe:
  compromise requires the multisig threshold, and the alternative — letting the
  slow owner replace the beneficiary — would put the treasury back under the key
  the split exists to keep it away from.
  The same power is unbounded in amount: the guardian can give itself any
  allowance and mint unreserved names to itself for free, up to eleven years each, three for a community name,
  and renew any name for free. Until GOV8 it is a single hardware wallet, not a
  Safe, so one compromised device suffices. Accepted for that window as well
  (pre-launch review, 2026-10-21); before the freeze the admin can stop it with
  `setSponsor(0)` or rotate the guardian by upgrade, but names already minted
  stay minted.
- **V2 — relayed gas is bounded off-chain, not on-chain.** Several sponsored
  entry points take unbounded arguments, and OZ `SignatureChecker` falls through
  to an ERC-1271 `staticcall` when recovery fails. A contract-level cap would be
  a guess at a future limit baked into a contract that is immutable or frozen at
  lockdown. The relayer is the only caller of these paths and the only party that
  can judge abuse, so it must pre-flight simulate every relayed transaction and
  refuse above a gas threshold, and validate payload sizes before submitting.
  This is a security property carried by the service, not the contracts.
- **V3 — hostile pricing is the one path from a retained key to a held name
  that is not reserved.**
  `setPriceOracle` survives the freeze by necessity: the Chainlink feed is
  `immutable` inside the oracle, so freezing pricing would let a retired feed end
  registration and renewal forever. The cost is that an admin could price
  renewals out of reach and take names as they lapse. It is the slowest and
  loudest attack available — public for the timelock delay, then each name's
  remaining term plus 90 days of grace, with renewal permissionless throughout.
  The other path is reservation: a reserved name cannot be renewed, and after
  its grace period `registerReserved` assigns it (see "What `freeze()` does not
  stop").
- **V4 — `SimplexPriceOracle` does not check feed staleness.** It reads
  `latestAnswer()` and ignores `updatedAt`, so a frozen but positive feed keeps
  quoting its last price. The recovery is the oracle owner's `setUsdOracle`.

### Reservations must not be public before they are mined

`addReservedNames` is a single atomic call with no commit/reveal, while both
registration paths must present a commitment already aged `minCommitmentAge` (60 s
in the deployment). That protects a reservation only if it is mined before a
commitment made after it first became visible can mature: about five slots. A
reservation that waits longer in public — an underpriced transaction in the
mempool, or a guardian Safe proposal waiting in the Safe Transaction Service queue
for its second signature — tells a squatter which name to take, and the squatter's
`register` lands first. The reservation then succeeds on a name that is already
held, and nothing takes the name back before it expires: the reservation stops
only its renewal. A pre-aged speculative commitment can also
win the ordering, but gains nothing over registering the guessed label outright.
`test/simplex/TestReservationRace.test.ts` pins only the case where the
reservation is mined first.

So reservations after launch are sent privately (pre-launch review round 2, R2-3):
the guardian Safe's signatures are collected off the Safe Transaction Service and
the last signer executes through private orderflow (Flashbots Protect or MEV
Blocker), or a module lets one guardian signer call only `addReservedNames`. If
neither is available, the guardian first stops the paths a squatter would use —
`setPublicSalesOpen(false)` and `setRegistrarAllowance(registrar, 0)`, neither of
which reveals the label — and restores them once the reservation is mined.
