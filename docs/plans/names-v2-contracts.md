# Names v2 — contract work plan

Built on `simplex-namespace-contract` @ `66ec89f` / `ens-contracts` @ `0905c7d`.
Target: `.simplex` deployed on mainnet 30 Oct 2026, governance handover 2 Nov, all live
4 Nov, investor window 12 Nov, public registration 12 Dec. Custody and the freeze are in
[`names-v2-launch-to-freeze-plan.md`](./names-v2-launch-to-freeze-plan.md).

Amended by [`recipient-consent.md`](./recipient-consent.md): the sponsored path
(`registerWithCredit`, `renewWithCredit`, the registrar allowance) moved to
`SimplexSponsor` and needs the owner's signature, and `transferWithSig` became
`approveWithSig` plus the recipient's `claimWithSig`. The rest of this plan is the
record of names-v2 as built.

## 1. Table of contents

1. Table of contents
2. Executive summary
3. The baseline this built on
4. Work items
5. Design decisions
5b. Adversarial review outcomes
5c. Second review round (PR #26)
6. Storage layout
7. Deployment, handover and freeze
8. Redeploy contingency
9. Requirements handed to the names service
10. Test plan
11. Sequencing
12. Out of scope

## 2. Executive summary

`.simplex` sells names through the app store and relays every on-chain action on the
user's behalf, so a user never needs ETH. Three mechanisms carry that.

**A registrar spending limit.** The guardian Safe grants a registrar hot wallet an
allowance in attoUSD; a sponsored registration or renewal deducts that name's own list
price and attaches no value. No fee moves, a compromised registrar can only spend up to its
limit, and the guardian can zero it in one transaction with no delay. The unit is the one
the price list is configured in, so the limit does not drift with the ETH price.

**Signed intents.** Every post-registration action — transfer, record edit, record clear,
subname creation, registry approval — is a one-shot EIP-712 signature submitted by a
relayer that pays gas and nothing else. No standing delegation.

**Relayed writes are metered off-chain.** The relayer is the only caller of the sponsored
write path — it is the party with ETH — so an on-chain budget could only reject a
transaction the relayer had already chosen to pay for. Authority comes from the signature
and the nonce; how much relaying a name may consume is the service's ledger, alongside the
payload and gas limits it already enforces (§9).

**Status.** W1 to W6 and W11 are implemented on `ens-contracts@ab/names-v2` and green: 1062 tests
pass, 219 of them in `test/simplex` across 19 files. W7 to W10 — the deployment script, the
handover and freeze runbooks, the redeploy runbook and the docs — live in the parent repo
and are not started. One pre-existing failure remains in
`test/ethregistrar/TestBaseRegistrar.test.ts`, an upstream test asserting the registry owner
stays with the seller, which contradicts the SNRC auto-reclaim deviation; it fails without
these changes too.

## 3. The baseline this built on

Already implemented, 19 tests passing:

- `BaseRegistrarImplementation.transferWithSig(from, to, tokenId, nonce, deadline, sig,
  ephemeralPubKey, viewTag)` — EIP-712 domain `SimplexNames`, per-signer nonces,
  grace-aware ownership check, self-transfer rejected, `_transfer` so auto-reclaim fires,
  and an announcement emitted only when an ephemeral key is supplied. (The announcement's
  shape and signing changed in the second review round — see §5c.)
- `SimplexResolver` — `PublicResolver` subclass with `setTextWithSig`, per-signer nonces,
  and `relayedSigner`.
- `Root.sol` compiles but is deployed nowhere.
- `SimplexController` is UUPS behind `SimplexControllerProxy`, with `_reentrancyStatus`
  and `uint256[48] __gap` at the tail.

Not yet present: the registrar allowance, the beneficiary role, the upgrade freeze, the public
sales switch, sponsored subname creation, and a `.simplex` deployment script.

## 4. Work items

W1 to W6 and W11 are implemented in `ens-contracts` on `ab/names-v2`. W7 to W10 live in
the parent repo and are outstanding.

### W1 — `SimplexController`: allowance, beneficiary, sales switch, freeze (done)

New state (§6): `beneficiary`, `frozen`, `registrarAllowance`, `defaultResolver`,
`publicSalesOpen`.

```solidity
function setBeneficiary(address) external;             // owner while unset, beneficiary after
function addReservedNames(string[] calldata) external; // owner or beneficiary
function setRegistrarAllowance(address, uint256) external onlyBeneficiary;  // attoUSD
function setDefaultResolver(address) external onlyOwner;
function setPublicSalesOpen(bool) external;             // owner or beneficiary; reverts once frozen
function freeze() external onlyOwner;                  // one-way
function withdraw() public nonReentrant;               // pays beneficiary
function registerWithCredit(Registration calldata) external nonReentrant;
function renewWithCredit(string calldata, uint256, bytes32) external nonReentrant;
```

`_authorizeUpgrade` and `setPublicSalesOpen` both gain `if (frozen) revert Frozen();`. One
flag closes both: after the freeze the implementation is permanent and the sales switch
holds whatever value it had, so the contract can no longer be made to do less than it does
at that moment.

`freeze()` refuses while `publicSalesOpen` is false. Freezing then would shut the payable
path permanently, since the same flag disables both the switch and the upgrade escape, and
the ordering is racy in practice: the pause belongs to the guardian and is immediate, the
freeze belongs to the owner and sits behind a timelock, so a pause answering an incident
can land between a queued freeze and its execution. The check makes that race fail safe —
the freeze reverts and is re-queued — and turns a runbook step into an enforced invariant.

`freezePriceOracle()` is removed. `StablePriceOracle.usdOracle` is `immutable`, so
changing the price feed means deploying a new oracle and calling `setPriceOracle`; freezing
that would mean a retired Chainlink feed permanently breaks registration and renewal.
`setPriceOracle` is therefore a power the owner must keep after the freeze, and leaving a
one-way function in the contract that must never be called is a footgun worth deleting. Its
storage slot is kept as an unused private bool rather than deleted, so nothing after it
shifts.

`prices`, `setPriceOracle` and `initialize` are typed `IPriceOracleUSD` rather than
`IPriceOracle`, so a replacement oracle must be able to quote in attoUSD. The variable is
still one address, so the layout is unchanged.

The payable `register()` reverts with `PublicSalesClosed` while `publicSalesOpen` is
false. `registerWithCredit`, `registerReserved` and both renew paths are exempt: the
credited path is how the investor window is served, and renewal must never be blocked by a
pause.

The body of `register()` from the availability check to the `NameRegistered` emit moves
into a private `_registerCore(Registration calldata) returns (uint256 expires)`.
`register()` wraps it in the price computation, the `msg.value` check and the refund;
`registerWithCredit()` wraps it in `_spendAllowance(_rentPriceUSD(...))`, so the deduction
is the name's own list price. `renew` gets the same treatment, and both credited paths emit
the wei-equivalent list price in their event — nothing is paid either way, and the
accompanying `RegistrarAllowanceSpent` records what was actually consumed. An exhausted
registrar reverts with `InsufficientAllowance(required, available)`.

`registerWithCredit` applies `minCharLength` and `reservedNames`, and skips the NFT gate,
whose `msg.sender` would be the registrar rather than the buyer.

`registerReserved` gains the resolver path. Today it calls `base.registerWithLabel` and
nothing else, and `setSubnodeOwner` sets an owner but not a resolver, so a reserved name
does not resolve at all. It takes the shape of `register`'s resolver branch: register to
the controller, `ens.setRecord(namehash, owner, defaultResolver, 0)`, transfer the token,
transfer the token. A brand's name then resolves the moment it is reserved and its later
edits can be relayed, without the brand ever holding ETH.

### W2 — on-chain edit credits: removed (done)

An earlier revision metered relayed writes with a per-name on-chain credit balance
(`editCredits`, `grantEditCredits`, `topUpEditCredits`, `editCreditPriceUSD`,
`EDIT_CREDITS_PER_YEAR`). It is deleted. The rationale did not survive scrutiny: the
relayer is the sole caller of the metered functions, so the on-chain check could only fire
on a transaction it had already decided to send and pay for — it gated the relayer against
itself and could not bound gas exposure the way the service's own ledger does. Credits
never protected the user either; the signature and the nonce do that, so removing them
costs no sovereignty.

What went with it: a permissionless credit faucet whenever `editCreditPriceUSD` sat at its
zero default, a checked-addition overflow that could brick both renewal paths for a name,
a full-year grant on a one-day renewal, and the nonce-stall where a zero-credit node's
intent reverted without consuming its nonce.

The one property lost is portability — an on-chain, node-bound allowance would let a user
recovering from their seed carry metered relaying to any relayer. That only pays off with
several independent relayers; with one service it buys nothing the service's ledger does
not. Revisit if that changes.

Kept: the per-signer nonce (replay protection) and the registrar money allowance (§W1),
which is the real kill switch.

### W3 — `clearRecordsWithSig` on the resolver (done)

`clearRecordsWithSig(bytes32 node, uint256 nonce, uint256 deadline, bytes calldata sig)`,
type hash `ClearRecords(bytes32 node,uint256 nonce,uint256 deadline)`, reusing
`_authorizeRelayed`, then `recordVersions[node]++` and the `VersionChanged` event.
Constant gas regardless of how many records exist, which is what makes accepting a gifted
name affordable: one call wipes whatever the sender left behind.

### W4 — subname records in `_authorizeRelayed` (done)

`_authorizeRelayed` resolves the signer as `ens.owner(node)`. A subname node is owned by
the `SubnameRegistrar`, so relayed edits currently reach 2LDs only. Mirror
`PublicResolver.isAuthorised`:

```solidity
address owner = ens.owner(node);
if (owner == address(nameWrapper)) owner = nameWrapper.ownerOf(uint256(node));
```

`nameWrapper` is `internal` on `PublicResolver`, so this needs no upstream change.

### W5 — `ENSRegistry.setApprovalForAllWithSig` (done)

For the `.simplex` deployment only; `.testing`'s registry is untouched. EIP-712 domain
`SimplexENSRegistry`, type hash
`ApproveAll(address owner,address operator,bool approved,uint256 nonce,uint256 deadline)`,
a `nonces(address)` map, `SignatureChecker`, and the same `_operatorApprovals` write and
`ApprovalForAll` event the existing setter produces.

This is the one change to the root of trust in this plan and gets the most review of
anything here.

### W6 — `SubnameRegistrar.createSubnameWithSig` (done)

`createSubnameWithSig(parentNode, label, nonce, deadline, sig)` and
`deleteSubnameWithSig(...)`, verifying against the effective owner `_controller` already
computes, with the contract's own nonce map.

Both W5 and W6 ship in the 30 Oct deployment even though subnames are a February 2027
feature, for the reason in §5.

### W11 — remove reverse resolution (done)

`.simplex` runs no reverse registrar. `SimplexController` loses the `reverseRegistrar` and
`defaultReverseRegistrar` storage slots, their two initializer arguments, the
`REVERSE_RECORD_*` bit constants and the branches in `_registerCore`.
`Registration.reverseRecord` stays in the struct — it belongs to
`IETHRegistrarController` and removing it would change the ABI tooling encodes against —
but `makeCommitment` now rejects any non-zero value with `ReverseRecordNotSupported`, so
the field is refused rather than silently dropped.

One upstream deviation was unavoidable: `PublicResolver` inherited `ReverseClaimer`, whose
constructor calls `claim` on whatever owns `addr.reverse`. That is a hard dependency on a
deployed reverse registrar — with the node unowned the call hits `address(0)` and the
resolver deployment reverts. It cannot be short-circuited from `SimplexResolver`, because
the call is in a parent constructor, so the inheritance is dropped from `PublicResolver`.
Three lines, all deletions, of a feature this deployment does not use. The upstream
resolver and reverse-registrar suites still pass unchanged.

`trustedReverseRegistrar` stays in the `PublicResolver` constructor and is passed
`address(0)`. It is a second permanently-trusted address with authority over every node,
so leaving it inert is the point; removing the parameter would be a wider diff for no
change in behaviour.

`UniversalResolver` inherited `ReverseClaimer` as well, and it is deployed — so it needed
the same three-line deletion. Its `owner` constructor argument is retained and unused, to
keep the constructor ABI compatible with upstream and with the deploy scripts.

Deploy scripts drop the `ReverseRegistrar` and `DefaultReverseRegistrar` dependencies and
the `setController` / `setDefaultResolver` wiring — both the `ens-contracts/deploy/` ones
and the parent repo's `scripts/deploy-{mainnet,local,testnet}.mjs`. The contracts stay in
the tree for the upstream test suite, as other unused upstream code does; they are simply
never deployed.
`TestSponsoredReverseRecord.test.ts` is deleted with the feature it tested.

Docs follow the code: both diagram generators mark the reverse registrars removed —
greyed, dashed, with a legend entry — rather than deleting the box, so what was dropped
stays legible; `architecture.md`, `deployment.md` and `sequence-happy-flow.md` no longer
list or draw them; and `security.md`'s finding **N4** ("reverse-record registrations
always revert on mainnet") is marked FIXED, since this implements its recommended
early-revert and then removes the feature outright.

Storage: the two slots are **reserved, not removed**. `reverseRegistrar` and
`defaultReverseRegistrar` become `_unusedReverseRegistrar` and
`_unusedDefaultReverseRegistrar`, two `address private` placeholders, following the
`_unusedPriceOracleFrozen` precedent. Deleting them would have shifted every variable
below, and reserving them means reverse resolution can be reintroduced in a later upgrade
by re-typing the slots, with no layout migration. Verified empirically rather than argued
from the packing rules: `maxCommitmentAge` sits at slot 254 and `prices` at 257, so the
placeholders take exactly one slot each and nothing below them moved.
`TestControllerStorageLayout.test.ts` pins that gap.

### W7 — `.simplex` deployment script (partly done)

The existing `scripts/deploy-{mainnet,local,testnet}.mjs` are brought up to date: no
reverse registrar, `SimplexResolver` in place of `PublicResolver`, the six-entry price
curve, the shortened `initialize` signature, `setMaxLabelLength(63)`,
`setDefaultResolver`, and — critically — `setBeneficiary(guardian)` **before** the
ownership handover, since it is owner-callable only while unset. `deploy-mainnet.mjs`
takes the guardian from `GUARDIAN_ADDRESS` and warns if it equals the admin owner, which
would defeat the two-key split. Verified by running `deploy-local.mjs` end to end against
a Hardhat node and then registering through both the payable and the sponsored path on the
deployed stack.

Still outstanding: a purpose-built `.simplex` script that also deploys `Root`, reserves
the ~3000 a-priori names, and prints the handover calls.



`scripts/deploy-simplex.mjs`, modelled on `deploy-mainnet.mjs`. Only what differs is listed
here; the full call sequence including the unchanged wiring is Appendix A1 of the
launch-to-freeze plan. Deploy `Root` and give it the registry root, assign the TLD through
it, deploy `SimplexResolver` with `nameWrapper = SubnameRegistrar`,
`trustedETHController` and `trustedController` = the controller proxy, and
`trustedReverseRegistrar = address(0)`. `nftGateEnabled = false`, `smpxNft = address(0)`,
`minCharLength = 6`, `setMaxLabelLength(63)` on the registrar, and the six-entry price
curve against the Chainlink ETH/USD feed, in attoUSD per second:

```
price1Letter  31709791983700000    $1,000,000 / year
price2Letter   3170979198370000      $100,000 / year
price3Letter    317097919837000       $10,000 / year
price4Letter     31709791983700        $1,000 / year
price5Letter      3170979198370          $100 / year
price6Letter       317097919837           $10 / year   (six characters and above)
```

Six entries, not five: `StablePriceOracle` used to apply `price5Letter` to everything of
five characters or more, so a six-character name could not be priced apart from a
five-character one. The sixth entry splits them, and a five-entry array still behaves
exactly as before. Every rung is an exact multiple of the 6+ rung, so the ten-times-per-
character ratio holds without rounding drift. The one- and two-character rungs continue
the ladder rather than sitting at zero, so lowering `minCharLength` further can never hand
out free names.

`setDefaultResolver` after both the controller and the resolver exist — the dependency is
circular, which is why it is a setter and not an initializer argument.

The script also reserves the ~3000 a-priori names from `reserved-names.simplex.csv`, in batches of 200. Measured cost
is 25.8k gas per name — 5.2M per batch, 77M in total — so at the base fee quoted in the
launch-to-freeze plan the whole set is single-digit dollars. A transaction may use at most
16,777,216 gas (EIP-7825), and the gas estimate for this loop passes that above about 210
names. It stops there: the registrar allowance and the ownership transfer are governance actions
with their own dates and callers (§7), and the script must not perform them.
It requires the admin `TimelockController` and both Safes to exist already, since it prints
the handover calls against their addresses.

Do not call `Root.lock` at deployment (§8).

### W8 — handover and freeze runbooks (outstanding)

`scripts/handover-simplex.mjs` and `scripts/freeze-simplex.mjs`, each with a dry-run mode
and a post-condition check per step. Custody — the two Safes, the timelock, which power
sits where and why, and the picture before and after — is
[`names-v2-launch-to-freeze-plan.md`](./names-v2-launch-to-freeze-plan.md); these scripts
implement its Appendix A recipes and assert the verification steps in each.

### W9 — redeploy runbook and address inventory (outstanding)

`scripts/redeploy-simplex.mjs` covering both variants — keep the `ENSRegistry` and
re-point the TLD, or deploy the whole stack fresh — emitting a new
`deployments.mainnet.simplex.json` and printing the §8 list of every consumer that must be
updated, with a verification step for each.

### W10 — documentation (outstanding)

`docs/architecture.md` for the registrar allowance, relayed writes and the announcement.
`docs/security.md` for the new accepted risks: relayer liveness, the registry-wide scope
of a signed approval, the deliberately unbounded relayed entry points and the service-side
mitigation that replaces a contract cap, the public sales switch, and the fact that the
chat database now holds assets. `docs/sequence-happy-flow.md` for sponsored registration
and acceptance. `verification.mainnet.testing.json` correction, and `CLAUDE.md`'s
admin-capability list, which still names `setTreasury` and calls `maxLabelLength`
optional.

## 5. Design decisions

**The registrar limit is money, not a count of operations.** A flat per-operation credit
prices a ten-year four-character name the same as a one-year six-character one, so it
bounds transactions rather than exposure. `IPriceOracle.price` returns wei, which moves
with ETH and is useless as a limit, so `StablePriceOracle` gains `priceUSD` returning the
same quote in attoUSD before conversion — the unit the price list is already configured
in — and `setPriceOracle` is typed to `IPriceOracleUSD` so a replacement oracle must
provide it.

**Relayed writes are metered off-chain, not on-chain.** The relayer is the only caller of
`setTextWithSig` and `clearRecordsWithSig`, so an on-chain per-name budget could only
reject a transaction the relayer had already agreed to pay for. It is the same reasoning
that puts payload and gas ceilings in the service (§9): the party paying is the party that
must decide before submitting. What stays on-chain is what an off-chain ledger genuinely
cannot do — the signature that authorises the write, and the nonce that makes it
single-use. W2 records what the on-chain version cost.

**`setRegistrarAllowance` replaces rather than adds.** It is a kill switch, and zeroing a
compromised registrar must take one transaction. Note that `renew()` is `external payable`
with no access control, so anyone may renew anyone's name — deliberate, and now
consequence-free since renewal no longer grants anything.

**Public sales are an owner switch, not a date.** A hard-coded timestamp cannot absorb a
moved release, and a date already passed cannot be undone. `setPublicSalesOpen(bool)`
follows the pattern of the NFT gate, but stays two-way rather than one-way, so it is also
the pause switch if something goes wrong during or after the launch. Since the controller
owner is retained (see the launch-to-freeze plan), it stays available indefinitely.

**No signed batch, but `clearRecordsWithSig` is kept.** `Multicallable._multicall`
delegatecalls into `address(this)`, preserving `msg.sender`, so a signature-authorised
batch would require making `PublicResolver.isAuthorised` virtual — a change to a verbatim
upstream file. Clearing is not a batch: it is one constant-gas write that does the job a
batch was wanted for.

**Relayed gas is bounded by the service, not the contracts.** Several sponsored entry
points take unbounded arguments, and OZ `SignatureChecker` falls through to an ERC-1271
`staticcall` when recovery fails. A contract-level cap would be a guess at a future limit
baked into a contract that is immutable or frozen — the fallback-URL CSV alone
is a reason to want a larger record later. The relayer is the only caller of these paths
and the only party that can judge abuse. §9 records what it must therefore do.

**Subname creation goes through a forked registry, not a change of ownership model.**
Creating a subname needs the `SubnameRegistrar` to have registry authority under the
parent node, which today means the owner calling `ens.setApprovalForAll` from their own
address — the one call that cannot be relayed. The alternative, making the registrar the
registry owner of every 2LD, would turn `ens.owner(name)` into a contract address for
every name and break every reader that follows the ENS convention. Adding
`setApprovalForAllWithSig` to `.simplex`'s own registry keeps ENS semantics exactly as
they are, keeps the approval per-user and opt-in, and adds one capability: signing instead
of paying gas.

**The `SubnameRegistrar` deployed on 30 Oct is final.** `PublicResolver` declares
`INameWrapper immutable nameWrapper` and authorises subname records through it, so the
resolver is permanently bound to the registrar address given at its construction. A
registrar deployed later would produce subnodes the resolver refuses to authorise.
Everything the sponsored subname flow needs therefore ships at deployment and lies dormant
until the client uses it.

**The controller owner is kept, and the code is frozen instead.** Brand reservation and
`registerReserved` must remain available indefinitely, so the owner is not renounced. What
makes that safe is `freeze()`, and the reason is specific: the controller is
deployed as `trustedETHController` on the resolver, and `PublicResolver.isAuthorised`
returns true unconditionally for that address, so the controller holds standing authority
to write any record on any node. Today it uses that only during registration, on the node
being registered — but that restraint lives in its code. `BaseRegistrar`'s immutable
`require(available(id))` protects ownership from a malicious controller; only a frozen
implementation protects records. Once frozen, the retained owner's whole surface is
bounded by what §4 of the launch-to-freeze plan enumerates.

**Pricing stays changeable; the sales switch does not.** A frozen oracle is a liveness risk
with no recovery: the Chainlink feed is `immutable` inside the oracle, so a retired feed
would end registration and renewal forever. A live sales switch is a censorship risk with
no recovery either, since a permanently paused payable path could never be reopened. So the
freeze locks the switch and leaves the oracle alone. The residual risk — an owner pricing
renewals out of reach so names lapse — is, besides reserving the name (below), the only path
by which any retained key reaches a name someone already owns, and it needs the change to
stay public through the timelock and then through every name's remaining term plus 90 days
of grace, with renewal permissionless the whole time unless the name is reserved.

**Powers are split by how fast their harm accrues, not by contract.** A power sits on the
untimelocked guardian key only when the harm it answers outruns a timelock delay. Zeroing
registrar credits qualifies: a compromised registrar mints junk names every block and each
one is permanent. Pausing the payable path qualifies for the same reason. Fixing a dead
price feed does not: it is an outage, and `GRACE_PERIOD` is 90 days with `renew` working
throughout, so nobody can lose a name while the repair is scheduled.

**Controls with two directions are split between the keys.** The restrictive direction goes
to the guardian, because it is what answers an incident, is reversible by the admin, and can
never acquire anything; the permissive direction stays behind the timelock. So
`setPublicSalesOpen` and `addReservedNames` are callable by the owner or the beneficiary,
while `removeReservedNames` and `registerReserved` are owner-only. Reserving in particular
cannot be timelocked: a scheduled `addReservedNames` announces which name is valuable and
how long it stays unprotected, which invites the squatting it exists to prevent. It acquires
nothing, but it does stop renewal: `renew` reverts for a reserved name, so a held name that
is reserved expires, and after its grace period only `registerReserved` can assign it. That
is how a dispute is handled. `registerReserved` releases the reservation, so a brand renews
like any holder, and if it lets the name lapse, anyone can register it after its grace period
unless it is reserved again. When a competing claim arises, the guardian reserves the name
again, and the admin settles it with `removeReservedNames` executed before the grace period
ends (the holder keeps it) or, after the grace period, `registerReserved` to whoever the
ruling names. The hold takes effect at the name's current expiry, which its holder may have
pushed up to three years out, or eleven through a sponsored renewal of a name not on the community list. A reservation made in error
can be undone with `removeReservedNames` until the name's grace period ends.

**The beneficiary is permanent and independent of the owner.** `setBeneficiary` is
callable by the owner only while the beneficiary is unset, so setting it before the
ownership handover makes the guardian Safe independent of the admin from the first block.

**`BaseRegistrar`'s owner is retained too.** `addController` is the only recovery path from
a frozen, buggy controller, and it cannot touch a live name because `_register` requires
`available(id)`. It is owned by the admin timelock like the other two.

**`Root`'s owner stays at the admin timelock** after the lock. Once `simplex` is locked nobody
can re-point the TLD, and the only remaining power is `setResolver` on the root node.

**Six price rungs, not five.** `StablePriceOracle` applied `price5Letter` to every name of
five characters or more, so a six-character name could not be priced apart from a
five-character one — which is what the published pricing has always assumed. A sixth
constructor entry splits them; a five-entry array behaves exactly as before, so every
existing caller is unaffected.

**Controller storage is append-only.** `.simplex` stays UUPS-upgradeable until
`freeze()`, so every implementation until then must preserve the layout.

**`_registerCore` is extracted rather than duplicated.** Ninety lines of registration
logic living in two places is where a divergence bug hides. `SimplexController` is a
heavily customised fork, not verbatim ENS, so keeping `register` byte-identical in the
`main...simplex` diff buys less than the duplication costs.

**Community names live in their own contract.** A listed name can be registered
by anyone, without the consortium, but only by accepting written terms: the name is used in
the best interest of the community it names. `SimplexNamePolicy` holds the list, the
links to the current terms with their keccak256, and the acceptances; the controller and the registrar
each call it once. It is separate because the controller had too little bytecode left: the
same logic inside it came out 708 B over the limit.

- *A holder must have had the chance to accept.* Listing skips any name that is registered
  or in its grace period, and every holder accepts: the registrant at commit, keyed by the
  commitment hash so the label stays hidden until the reveal, and a recipient for the
  holder's specific offer before claiming. Controller transfers and `registerReserved` are exempt;
  a name reassigned that way gets the terms through an off-chain agreement.
- *Acceptances are keyed by the acceptor.* Anyone can commit, so an acceptance keyed by the
  commitment alone could be front-run with the same hash and block the owner. A claim
  acceptance is also keyed by the holder: the offer number advances only on `approve`, so
  after a re-registration or an operator transfer it alone would match an old acceptance.
- *An acceptance includes the terms hash.* `commitUnderCommunityTerms` and
  `acceptCommunityTermsForClaim`, like their general-terms counterparts for every other
  name, take the terms hash they accept and revert on any other, so even a direct contract
  call records exactly which terms the holder accepted; `CommunityTermsAccepted(name,
  holder, termsHash)` or `GeneralTermsAccepted` is emitted at registration and at claim.
- *Enforcement reuses the reservation.* A name whose holder breaches the terms is reserved,
  which stops its renewal; after its grace period `registerReserved` assigns it.

**The reserved names moved into the same contract, and it became upgradeable.** The
community name hooks left the controller 315 B under the size limit. Moving the reserved list,
`addReservedNames`, `setReservationReason`, `removeReservedNames` and `registerReserved` into
`SimplexNamePolicy` frees about 2.9 KB and puts every rule about who may hold a name in one
place.

- *One call per registration.* The controller's existing call to the policy now also
  refuses a reserved name, so `NameReserved` is raised after the commitment checks rather
  than first. `available()` and renewal ask the policy directly.
- *`registerReserved` mints from the policy.* The policy is a registrar controller: it
  registers the name to itself, retires a former default resolver's records as the node's
  owner, sets the default resolver and transfers the token.
- *The controller always has a policy.* Its setter refuses zero, so the reserved list
  always applies; the registrar's pointer may be zero, which turns the transfer check off.
- *Upgrades keep the lists.* The policy sits behind a UUPS proxy. Upgrades need the
  controller's owner, end when the controller is frozen, and refuse an implementation
  built for another controller or registrar. A new policy contract would start empty, so
  an upgrade, not a replacement, is how the policy changes.

## 5b. Adversarial review outcomes

An adversarial review by three expert personas, a completeness critic and independent
refutation produced no critical, high or medium finding. The non-custodial invariant, the
EIP-712 intent surfaces, the allowance kill switch, the split-key rule and the storage
layout all held. What came out of it:

**Fixed.** The on-chain edit credits are gone (W2), which removed a permissionless faucet
at the zero-price default, an overflow that could brick both renewal paths for a name, a
full-year grant on a one-day renewal, and a nonce stall. `freeze()` now enforces
`publicSalesOpen` (W1).

**Accepted.** *A compromised guardian is unrecoverable after the freeze.* Only the
beneficiary may rotate itself, and the post-freeze upgrade escape is closed, so a
compromised guardian permanently holds `withdraw` and `setRegistrarAllowance`. No name can
be taken from its holder before it expires — `require(available(id))` in the immutable
registrar holds even here — but the guardian can reserve held names, which stops their
renewal, and reserve them again whenever the admin releases them. The admin's recovery is to
release and renew each such name in one atomic timelock batch, every term, or to add a
`BaseRegistrar` controller that renews regardless of reservations (`addController` survives
the freeze). Accepted
on the basis that the guardian is a Safe: compromise requires the multisig threshold, and
the alternative — letting the slow owner replace the beneficiary — would put the treasury
back under the key the split exists to keep away from it.

**Reservations must not be public before they are mined.** `addReservedNames` is a single
atomic call with no commit/reveal, while both registration paths must present a commitment
already aged `minCommitmentAge` (60s in the deployment). That protects a reservation only if
it is mined within about five slots of first becoming visible; one that waits longer in the
mempool or in the Safe Transaction Service queue is front-run, and the squatter keeps the
name for its term: a late reservation stops only its renewal. A speculative pre-commitment
gains nothing: if they had targeted the name in advance they could have registered it at any
earlier moment. Reservations after launch are therefore sent through private orderflow; see
`docs/security.md`, "Reservations must not be public before they are mined".

**Out of scope.** *The `.testing` proxy needs a migration batch after an in-place upgrade.*
`.testing` is not being upgraded; it is left as it stands and `.simplex` is a fresh deploy.

**Fixed since.** *The price feed.* `StablePriceOracle` reverts `InvalidPriceFeed(answer)`
when `latestAnswer()` reports zero or negative, instead of panicking on the division or
wrapping the cast and flooring every quote to zero. And the sponsored path no longer reads
the feed at all: `registerWithCredit` and `renewWithCredit` used to compute a wei price
purely to fill an event field, which coupled the app-store flow to Chainlink — a dead feed
took registration *and* renewal down on both paths, not just the payable one, which the
review understated. They now emit a zero cost, which is also the honest figure: nothing is
paid on-chain, and `RegistrarAllowanceSpent` carries what was consumed in attoUSD. That
closes the review's INFO about credited events overstating on-chain revenue too.

Deferred deliberately: a staleness bound would mean moving to `latestRoundData`, which
changes the `AggregatorInterface` this file declares and therefore `DummyOracle` and every
deployment and test that uses it. Worth doing, but as its own change.

**Fixed since.** *The reverse-record subject.* `_registerCore` passed `msg.sender` as the
address a `reverseRecord` bit applies to. That is right on the payable path, where the
caller is the buyer, and wrong on the sponsored one, where the caller is the registrar's
shared hot wallet: the relayer got named instead of the buyer, and every later sponsored
registration overwrote it. `_registerCore` now takes the subject explicitly —
`msg.sender` from `register`, `registration.owner` from `registerWithCredit` — and the
buyer owns their own reverse node, so they can change it later. Both reverse registrars
authorise a registered controller to act for an arbitrary address, so no new privilege was
needed. Superseded by W11, which removes reverse resolution outright — the fix and its
test stand in history so the defect is on the record and the removal is a separate,
reviewable decision rather than a way to bury it.

Nothing from the review is left open.

**Noted, then made moot.** The payable path kept upstream's semantics, where the reverse
record follows `msg.sender` rather than `registration.owner` — so paying for someone else
pointed the *payer's* primary name at a name they did not own. Defensible on its own terms,
since the caller is the one expressing the intent and writing the recipient's reverse
record would touch a third party's namespace without consent; and inert in practice,
because reverse records are self-asserted (`ReverseRegistrar.setName` takes an arbitrary
string) and mean nothing until forward-verified. W11 removes the question.

## 5c. Second review round (PR #26)

A second adversarial pass over the branch found four issues sharing one root — **state that
outlives the registration it belongs to** — plus a set of deploy-tooling and documentation
defects. All are fixed on the branch.

**Stale records survived re-registration.** A lapsed name kept its previous owner's text
records, so after the grace period a new registrant received a name that already resolved to
a stranger's SimpleX address, invisibly. `_registerCore` and `registerReserved` now retire
records on the default resolver before writing anything new — before, because the version
bump would otherwise wipe the records the same call is about to set. The clear is scoped to
the default resolver: calling into a caller-supplied resolver could revert and brick the
registration.

**Reviving a subname inherited the previous owner's records.** The same leak one level down.
Creating over a generation-dead subname is now refused (`StaleSubnameMustBePurged`) — the new
owner runs the permissionless `purge` first — and both `purge` and `deleteSubname` retire the
records they drop. Retirement needs a path the registrar can actually use: the resolver's
`authorised` check resolves a subname's owner to the *2LD holder*, never the registrar, so
`SimplexResolver` gained `clearSubnameRecords`, callable only by the registrar and only for
nodes the registrar itself owns in the registry. That is a narrower grant than
`trustedETHController`, which can write any record on any node.

**An expired 2LD kept authority over its subtree.** Registry ownership of a 2LD is never
cleared, so its former holder could keep creating and editing subnames indefinitely after
expiry. The registrar cannot derive the expiry — it holds the node hash, and `expiries` is
keyed by a label hash it cannot invert — so `BaseRegistrar` now pushes it: `ISubnameHook`
gained `onExpiryChanged`, called on registration and renewal, and `ownerOf` / `_controller`
gate on the mirror. The threshold is expiry, not expiry-plus-grace, matching the registrar's
own `ownerOf`.

**The stealth announcement was unauthenticated and non-canonical.** `ephemeralPubKey` and
`viewTag` sat outside the signed struct, so a relayer could attach a fabricated derivation to
a genuine transfer or suppress the real one. Both are now inside `TRANSFER_TYPEHASH`. The
event is ERC-5564's `Announcement` verbatim — `schemeId`, `stealthAddress`, `caller`,
`ephemeralPubKey`, `metadata` — so any indexer that knows the standard decodes ours by topic,
with the ERC-721 metadata layout (view tag, `transferFrom` selector, token contract, token
id). It is still emitted by the registrar rather than the canonical singleton announcer,
which is the deliberate choice that keeps a recovery scan scoped to SimpleX name transfers.

**Accepted as documentation, not code.** Subname depth stays uncapped on-chain: the relayer
is the only sponsored caller, it sees the call before it pays for it, and a constant compiled
into an immutable contract would be a guess at a limit that can never be revised. Relayer
operators enforce it (see `docs/security.md`). And `freeze()` was never a freeze on
*issuance* — the guardian can still fund a registrar and the owner can still reserve and
register — which is deliberate but was not stated plainly enough to survive a careless
reading.

**Deploy tooling.** `SIMPLEX_TLD` must now be given explicitly and must be a known TLD; an
unset or typo'd value silently re-targeted the entire run, including which journal it
resumed. `GUARDIAN_ADDRESS` now hard-fails when unset or equal to `OWNER_ADDRESS` instead of
warning: `setBeneficiary` is owner-callable only while the beneficiary is unset, so the
mistake is permanent. Journal step keys name the operation (`write:setBeneficiary#2`) rather
than its ordinal, since a positional key silently remaps every later step when one is
inserted; each entry records a digest of the call it made, and a resume that would send
something different aborts rather than skipping. A step submitted but not yet journalled —
the window is up to `BUMP_AFTER_HOURS` — is now recovered from the attempts log instead of
being sent a second time. Journals written under the old positional scheme are refused
outright rather than mis-resumed.

**Third pass, on the fixes themselves.** Record retirement was scoped to the *current*
default resolver, so the first `setDefaultResolver` rotation would have silently stopped
retiring records for every name still pointing at the old one; the controller now remembers
every resolver it has ever defaulted to (`wasDefaultResolver`, appended, `__gap` 45 → 44).
And the deploy runner treated inclusion as success — a reverted transaction was journalled as
done and skipped on every later resume — so `recordSuccess` now refuses a non-success receipt.

**H2, shadow subnames: documented, not fixed, and it cannot be fixed on-chain.** A 2LD holder
owns its registry node and can create subnodes the registrar never tracks — or pull tracked
ones back out. Registry authority over a subnode belongs to the parent's owner by
construction; the registrar's soulbinding holds only because it happens to own the nodes it
created. What makes this a disclosure problem rather than a theft one is that it is always
recoverable: `setSubnodeOwner` is authorised against the parent, so a buyer can overwrite
anything under their name unilaterally and lock the seller out. The obligation is therefore on
the buyer and on any marketplace surface — enumerate a name's subnodes from registry
`NewOwner` logs (the registrar's index shows only what it created), then overwrite what should
not be there. Pinned in `TestShadowSubnames.test.ts`; see `docs/security.md`.

**Build verification.** `scripts/build-verification.mjs` had drifted out of the branch
entirely: a 9-argument `initialize`, the pre-names-v2 five-entry price array, `PublicResolver`
where the deploy uses `SimplexResolver`, and no targets for `SubnameRegistrar`,
`MetadataRenderer` or the gateway provider. Realigned and exercised end to end.

## 6. Storage layout

Appended after `_reentrancyStatus`, before `__gap`, per
`ens-contracts/docs/upgrades.md`:

```
slot n+0   address beneficiary;      bool frozen;              // packed
slot n+1   mapping(address => uint256) registrarAllowance;     // attoUSD
slot n+2   address defaultResolver;  bool publicSalesOpen;     // packed
           uint256[45] __gap;                                  // was 48
```

`defaultResolver` survives the credit removal because `registerReserved` needs it: it is
what a brand's name is pointed at so the name resolves without the brand holding ETH.

## 7. Deployment, handover and freeze

Dates and the full custody model are in the launch-to-freeze plan; this is the contract
view of the same sequence.

1. **30 Oct 2026** — deploy per W7, reserve the ~3000 a-priori names, verify on Etherscan,
   tag the commit (`simplex-mainnet-v1`). `publicSalesOpen` false, `Root.locked("simplex")`
   false.
2. **2 Nov 2026** — governance handover. Before it, confirm the six-entry price curve is in
   place: `setPriceOracle` is owner-only, so after the handover it moves at the timelock's
   pace. `setBeneficiary(guardianSafe)` first, since it is
   owner-callable only while unset, then ownership of all three ownable contracts to the
   admin timelock. `SimplexController` is `Ownable2Step`, so the timelock's
   `acceptOwnership` is itself a scheduled call and lands 9 Nov; `BaseRegistrar` and `Root`
   are single-step and finish on 2 Nov. Hard deadline 12 Nov, when third parties first own
   names.
3. **2–3 Nov 2026** — guardian Safe calls `setRegistrarAllowance` for the registrar hot
   wallet. Instant, so it does not wait on the timelock or on the handover completing.
4. **12 Nov – 11 Dec 2026** — investor window. Registrations flow through
   `registerWithCredit`; `publicSalesOpen` stays false.
5. **12 Dec 2026** — guardian Safe calls `setPublicSalesOpen(true)`.
6. **1 Mar 2027 at the earliest**, gated on production experience rather than the calendar:
   confirm `publicSalesOpen == true`, then `Root.lock(labelhash("simplex"))`, then
   `freeze()`, both executed from the timelock. The controller owner is **not** renounced
   and the price oracle is **not** frozen.

Brand reservation and `registerReserved` survive the freeze, so brand outreach does not
gate it. What gates it is having no open bug against the implementation, since `freeze()`
removes the only way to fix one.

## 8. Redeploy contingency

The point of no return is the first user-owned name. Deployment is 30 Oct and the
all-live milestone 2 Nov, but the first third-party owner appears on 12 Nov. Everything
before that is our own state, and the a-priori reserved set replays in one batch. So
30 Oct – 11 Nov is a live rehearsal at no extra cost: if something is wrong, redeploy and
move the addresses.

While `simplex` is unlocked, the cheap variant is available — keep the `ENSRegistry` and
re-point the TLD at a new registrar, which leaves the resolver service untouched. This is
why `Root.lock` sits at the freeze and not at deployment. After 12 Nov a redeploy is still
recoverable but no longer free: names must be re-minted to their holders, records
rewritten, and stealth-received names reconstructed from the announcements.

The client holds no contract address — `Simplex/Chat/Names.hs` has none, and resolution
goes over SMP to the names role — so a redeploy never requires an app release. What does
change: `deployments.mainnet.simplex.json` and `verification.mainnet.simplex.json`;
`SNRC_REGISTRY_SIMPLEX` for `snrc-resolve.py`, and nothing at all if the registry is kept;
the names service's registrar and controller addresses and its announcement scan start
block; `ens-metadata-service`'s `ADDRESS_ETH_REGISTRAR` and `ADDRESS_ETH_REGISTRY`;
`ens-subgraph/subgraph.yaml` addresses and start blocks plus a re-index; and in
`ens-app-v3`, `.env.simplex`'s `NEXT_PUBLIC_DEPLOYMENT_ADDRESSES`,
`deploy/01_get_contract_addresses.ts`, its copy of the deployments JSON, and
`src/constants/{chains,resolverAddressData,tldData}.ts`, which are keyed by chain id and
must move together. Then Etherscan verification.

## 9. Requirements handed to the names service

These carry security properties the contracts deliberately do not:

- Pre-flight simulate every relayed transaction and refuse to submit above a gas
  threshold. This covers both oversized payloads and the gas an ERC-1271 fallthrough would
  otherwise make the relayer pay for when a signature fails against a contract "owner".
- Validate payload sizes and entry counts at request time, before submitting.
- Meter how much relaying each name may consume. This moved off-chain deliberately (W2);
  it is now the only place it happens.
- Treat the thresholds as tunable configuration, not constants.
- Monitor the registrar allowance with generous headroom, in money rather than in
  operations: exhaustion is a hard service stop only the guardian Safe can clear.
- Get the owner's EIP-712 `RegisterName` signature (domain `SimplexSponsor`, with
  the owner's current `nonces` value) before registering for them, and submit it
  with `registerWithCredit`.
- Refuse a registration whose owner is the registrar's own address:
  `registerWithCredit` checks no signature then, so the client would choose the
  name and records the registrar holds.
- Relay a transfer as two intents: the holder's `approveWithSig`, then the
  recipient's `claimWithSig`. Nothing moves until the recipient claims.

## 10. Test plan

New files under `ens-contracts/test/simplex/`, following the existing fixture idiom:

- `TestRegistrarAllowance.test.ts` — a sponsored registration deducts the name's list
  price in attoUSD and attaches no value; a longer term and a shorter label cost more; the
  deduction is unchanged when the ETH price moves; the allowance refuses a name it cannot
  cover; the payable path is unaffected and still refunds; `setRegistrarAllowance` zeroes
  in one transaction; only the beneficiary may call it.
- `TestReservationRace.test.ts` — a squatter who commits on seeing the reservation cannot
  land in time; a matured speculative commitment is refused just the same; an immature
  commitment is refused on both registration paths; `registerReserved` needs no commitment.
- `TestCommunityTerms.test.ts` — listing by the owner or guardian skips names that are
  registered or in grace; a listed name cannot be registered without accepting, on either
  path; accepting at commit, directly or signed, registers it and emits the acceptance;
  another acceptor's acceptance neither counts nor blocks the owner; new terms require a new
  acceptance; a listed name cannot be claimed without the recipient's acceptance for the
  holder's offer, on any path, and not with an acceptance made for an earlier holder;
  controller transfers and `registerReserved` are exempt; a name removed from the list
  registers without acceptance, an unset registrar pointer turns the transfer check off,
  and each `setNamePolicy` reverts for a contract bound to another controller or
  registrar.
- `TestNamePolicy.test.ts` — removing a name from one list, or `registerReserved`, leaves it
  on the other; only the controller's owner upgrades the policy, never once the
  controller is frozen, and never to an implementation built for another controller or
  registrar; an upgrade keeps both lists, the terms and pending acceptances;
  `registerReserved` mints from the policy on the resolver path and the bare path,
  retiring a former default resolver's records, and stops working once the policy is no
  longer a registrar controller; `available()` and renewal follow the current policy's
  reserved list; the controller's `setNamePolicy` reverts for zero and for a policy built
  for another controller; the implementation reverts every write made to it directly, the
  controller's `setNamePolicy` reverts for it, and a registrar pointed at it reverts every
  claim.
- `TestRegisterReserved.test.ts` — a brand receives the token, the registry node and a
  working resolver, and can then have records relayed; unreserved names, short durations
  and a guardian caller are refused; a name someone already holds cannot be taken; and the
  no-default-resolver degradation is pinned. `registerReserved` releases the reservation so
  the brand can renew; a disputed name reserved again cannot be renewed on either path, can
  be renewed once released, and after its grace period goes to the claimant.
- `TestClearRecordsWithSig.test.ts` — type-hash pinning, every prior
  record reads empty, wrong signer, replay, expiry, refusal at zero credits.
- `TestSubnameRelayedEdit.test.ts` — the 2LD holder signs an edit for a subname and it
  lands; a non-holder's does not.
- `TestApproveAllWithSig.test.ts` — type-hash pinning, a relayer lands the owner's signed
  approval, revocation by signing `approved = false`, wrong signer, replay, expiry, and
  that the result is identical to the transaction form.
- `TestCreateSubnameWithSig.test.ts` — end to end with no ETH at the owner's address:
  signed approval, signed creation, relayed edit on the new subname; plus wrong signer,
  replay, expiry, and creation refused without the approval.
- `TestPublicSalesSwitch.test.ts` — the payable path reverts while closed and succeeds
  when open; `registerWithCredit`, `registerReserved` and both renews are exempt; the
  switch is two-way before the freeze and reverts after it; owner and beneficiary may both
  flip it and nobody else may.
- `TestAdminSplit.test.ts` — the access split the custody model depends on:
  `addReservedNames` accepts owner and beneficiary; `removeReservedNames`,
  `registerReserved`, `setDefaultResolver`, `setMinCharLength`, `setPriceOracle` and
  `freeze` accept the owner only and reject the beneficiary; `setRegistrarAllowance` and
  `setBeneficiary` accept the beneficiary only and reject the owner.
- `TestBeneficiaryAndFreeze.test.ts` — beneficiary bootstrap and permanence, `withdraw`
  pays the beneficiary and not the owner, `freeze` refuses while sales are closed and the
  guardian's mid-timelock pause makes a queued freeze fail safe, `freeze` blocks
  `upgradeTo`, `upgradeToAndCall` and
  `setPublicSalesOpen` and is one-way, while `setPriceOracle`, `registerReserved` and the
  reserved-name setters still work afterwards — so the retained surface is exactly what the
  launch-to-freeze plan enumerates and nothing more.
- `TestControllerStorageLayout.test.ts` — the append-only discipline, by raw slot
  inspection rather than the OZ upgrades plugin, which this repo does not carry: that
  `beneficiary` packs with `frozen`, `defaultResolver` with `publicSalesOpen`, that the new
  slots sit immediately after `_reentrancyStatus`, and that the allowance mapping hashes out
  of the linear range.
- `TestRegistrarAllowance.test.ts` also walks the price ladder — a name at each rung from
  thirteen characters down to three — asserting the deduction matches that length's price,
  that an allowance covering a long name refuses a short one, and that the deduction is
  unchanged when the ETH price moves.
- `TestStaleRecords.test.ts` — the squatter scenario end to end (register, set records, let
  the name lapse past grace, re-register to someone else, confirm every key reads empty),
  that a fresh registration's own records are not wiped by the clear, that `registerReserved`
  and the payable path clear too, and that a first registration is a no-op. Four of its
  assertions fail with the fix reverted.
- `TestSubnameLapse.test.ts` — reviving a subname left behind by a previous 2LD owner is
  refused; after `purge` the label is free and carries no records; `deleteSubname` retires
  records too; `clearSubnameRecords` rejects everyone but the registrar; a lapsed 2LD loses
  `ownerOf` and cannot create subnames; a renewal restores both; only the base registrar may
  move the mirror. Reverting each of the three guards fails 1, 2 and 2 of them respectively.
- `TestTransferWithSig.test.ts` pins the extended `TRANSFER_TYPEHASH` and the exact ERC-5564
  metadata layout, so a client that stops matching the standard fails here rather than in the
  field.
- `TestShadowSubnames.test.ts` — an untracked subnode is invisible to the registrar and
  survives the sale of its 2LD, but the buyer can always overwrite it and the seller is then
  locked out; the same holds for a tracked subname pulled out of the registrar.
- `TestStaleRecords.test.ts` also covers the resolver rotation: with retirement scoped to the
  current default instead of the historical set, that case fails.
- `scripts/` resume behaviour is covered by a stub-client harness: named keys survive an
  inserted step, a changed call to a journalled step aborts, an orphaned submitted tx is
  recovered rather than resent, and an old positional journal is refused.
- A mainnet fork test of registration → edit → transfer → accept. **Not run** — it needs an
  `INFURA_API_KEY`.

Existing suites stay green, in particular `TestSimplexController.test.ts`, which exercises
the register and renew bodies that W1 refactors.

## 11. Sequencing

Steps 1 and 2 are done; the rest are outstanding. Inside the contract window,
7 Sep – 29 Oct:

1. W1 and W2 with their tests — the largest, and what everything else depends on.
2. W3, W4, W5, W6 — independent of W1, can run in parallel. W5 gets the most review time
   of anything in this plan.
3. W7 on a local chain, then against a mainnet fork.
4. W9, written before the deployment rather than improvised after it.
5. W8 and W10.
6. Fork rehearsal of §7 end to end, then the 30 Oct deployment, then the §8 window as the
   live rehearsal: the sponsored journey, the payable path, the sales switch, and
   `transferWithSig` recovered from a seed.

## 12. Out of scope

Client crypto, the wallet, the names service, payments and UI. Refunds. The secondary
market. `.testing`, which is left as it stands. ERC-6538, ERC-4337 and ERC-2771.
