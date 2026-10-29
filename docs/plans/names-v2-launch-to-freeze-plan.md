# `.simplex`: launch to freeze

Who controls the contracts, from deployment until the powers are given up.

## 1. Table of contents

1. Table of contents
2. Timeline
3. The keys
4. Powers, before and after the freeze
5. What no key can ever do
6. Why it is built this way
7. The fallback: snapshot and redeploy
8. Appendix A: transition recipes

## 2. Timeline

Four keys act in this plan: the deploy key, the admin key, the guardian key and the registrar
hot wallet.

| Milestone | Change |
|---|---|
| GOV1 | The deploy key deploys `.simplex` and reserves the roughly 3000 names chosen in advance. Public sales closed. |
| GOV2 | Handover: `setBeneficiary` first, then four ownership transfers, all on one day. The deploy key stops being used. |
| GOV3 | The guardian gives the registrar hot wallet its spending allowance. First real use of the new keys. |
| GOV4 | Contracts, registrar, app and codes all live. |
| GOV5 | The handover is verified and the deploy key is destroyed. |
| GOV6 | The investor window opens. Hard deadline for the handover, because names now start belonging to third parties. |
| GOV7 | Public sales open. |
| GOV8 | Hardening: the hardware wallets are replaced by multi-signature Safes, and admin actions start taking seven days instead of taking effect at once. No fixed date. |
| GOV9 | The freeze: `Root.lock` ends the ability to replace the deployment, and `controller.freeze()` ends the ability to upgrade the controller's and the name policy's code. No fixed date, and never before GOV8. |

GOV1 to GOV7 are dated and binding. GOV8 and GOV9 are not: both wait until the namespace is
big enough to be worth the work they cost.

## 3. The keys

**Deploy key.** A hot wallet, a plain EOA. It owns everything from GOV1 to GOV5, then is
destroyed.

**Admin key.** A hardware wallet. From GOV2 it owns `Root`, `BaseRegistrarImplementation`,
`SimplexController` and `SimplexPriceOracle`. Its calls take effect the moment they are
signed. The price oracle is a separate contract with its own owner, so it is handed over
separately. It holds the price curve, the ETH/USD feed pointer and the expired-name auction;
the controller holds none of those.

**Guardian key.** A hardware wallet, separate from the admin key. It is the controller's
`beneficiary`, so it receives the revenue and holds the powers that stop things quickly. Its
calls are also immediate.

**Registrar hot wallet.** Owns nothing. It lives in KMS, run by the names service. It pays
gas, spends the allowance the guardian gives it, and relays users' signed requests.

The admin key and the guardian key are two authorisation tiers, ranked by how much damage a
compromised key can do. The admin tier can replace the controller's code, and new code can do
anything the contracts allow, so its reach has no bound. The guardian tier is bounded in kind:
halt sales, set registrar allowances, redirect revenue, reserve names (which also stops their
renewal), and nothing else. It is not bounded in amount: it can give itself any allowance and
mint unreserved names with it, an accepted risk (`docs/security.md`, V1). They are separate
keys so that one compromise does not hand over both tiers. The timelock, the Safes and the
multi-signer rotation are deferred to GOV8, not abandoned.

## 4. Powers, before and after the freeze

| Key | GOV2 until GOV9 | After GOV9 |
|---|---|---|
| Deploy key | nothing | nothing |
| Admin key | upgrade the controller and the name policy; `setSponsor`; `namePolicy.removeReservedNames`; `namePolicy.registerReserved`; `setMinCharLength`; `setDefaultResolver`; `setPriceOracle`; `priceOracle.setPrices`; `priceOracle.setUsdOracle`; `priceOracle.setPremium`; `recoverFunds`; `addController`; `removeController`; `setMetadataRenderer`; `setMaxLabelLength`; `setSubnameHook`; `setNamePolicy` (registrar and controller); `namePolicy.removeCommunityNames`; `namePolicy.setGeneralTerms`; `namePolicy.setCommunityTerms`; `baseRegistrar.setResolver`; `Root.setResolver`; `Root.setController`; `Root.lock`; `freeze()` | the same list without the upgrade calls, `setSponsor` and `freeze()`, since all are used up |
| Guardian key | `namePolicy.addReservedNames`; `namePolicy.addCommunityNames`; `setPublicSalesOpen`; `sponsor.setRegistrarAllowance`; `setBeneficiary`; receives `withdraw()` | the same list without `setPublicSalesOpen` |
| Registrar hot wallet | `sponsor.registerWithCredit` (with the owner's `RegisterName` signature); `sponsor.renewWithCredit`; and relaying signed user requests: `approveWithSig`, `claimWithSig`, `setTextWithSig`, `clearRecordsWithSig`, `setApprovalForAllWithSig`, `createSubnameWithSig`, `deleteSubnameWithSig`, `commitUnderGeneralTermsWithSig`, `commitUnderCommunityTermsWithSig`, `acceptGeneralTermsForClaimWithSig`, `acceptCommunityTermsForClaimWithSig` | same |
| Anyone | `commit`; `commitUnderGeneralTerms`; `commitUnderCommunityTerms`; `acceptGeneralTermsForClaim`; `acceptCommunityTermsForClaim`; payable `register` and `renew`; `withdraw`; all signed-request paths; record writes on names they own; `reclaim`; subname create and delete; `purge` | same |

Until GOV8 every call in this table takes effect when it is signed. After GOV8 the admin's
calls wait seven days and the guardian's stay immediate.

`disableNftGate` is the one owner function missing from the table. `.simplex` deploys with
the gate off, and the function reverts when the gate is off, so it does nothing from day one.

There is no reverse registrar and no reverse resolution: `.simplex` maps names to SimpleX
links in one direction only. A registration carrying a `reverseRecord` bit reverts with
`ReverseRecordNotSupported`. The controller's two old slots for the feature are reserved
rather than deleted, so an upgrade could bring it back without a storage migration.

There are no on-chain edit credits. Metering relayed writes is the relayer's job: it is the
only caller of those paths and the only party that can refuse before it has paid.

These powers outlive GOV9 because losing them would be worse than keeping them.
`registerReserved` and `addReservedNames` keep brand outreach open with no end date.
`addController` is the only repair path if the frozen controller has a bug.
`setMetadataRenderer` updates NFT artwork, since the renderer is immutable and is replaced
rather than edited.

## 5. What no key can ever do

No key can take, transfer or re-point a name somebody owns. `_register` requires
`available(id)`, false until 90 days past expiry, and that check lives in the immutable
registrar. `reclaim` needs the token holder. `approveWithSig` needs the owner's signature, and
only the recipient, or a controller, can complete a transfer.
After GOV9 no key can change the controller's code either, so no key can write records on a
name it does not own. That matters because the controller is `trustedETHController` on the
resolver, and a hostile upgrade would abuse exactly that authority.

Two indirect paths stay open. Reserving a held name stops its renewal, and after its grace
period `registerReserved` assigns it, which is how disputes are settled (A6). The admin can
also price renewals out of reach and collect names as they lapse, either by pointing
`setPriceOracle` at a hostile oracle or by calling `priceOracle.setPrices` with a punishing
curve. The second adds nothing, since an arbitrary oracle can already do anything a curve
change can. Before GOV8 there is no warning: the change takes effect when signed. What limits
the damage is slow and public. Every name keeps its remaining term plus 90 days of grace, and
renewal of an unreserved name is permissionless throughout, so anyone can renew anyone's name
at the old price as soon as the change is noticed. That is months of visible behaviour rather
than seven days of notice. GOV8 buys the notice back.

## 6. Why it is built this way

**Two keys, split by direction.** The guardian stops things: reserve a name, pause sales, cut
a registrar's allowance to zero. It also funds registrars and opens sales (A3, A4), the two
permissive powers on the fast key. The admin changes things: release reserved names, hand names
to brands.

Neither key waits for a delay yet, so the split can look like a formality. It is not. It
keeps the revenue off the upgrade key, so a stolen admin key cannot also take the
treasury. Upgrading the controller and moving the money then need two separate keys. And it
puts the emergency stops on the key that is not used for routine work, which is the one more
likely to be sitting in a drawer.

The same split decides which powers get a delay at GOV8. The guardian's stay immediate,
because the harm they answer grows with every block: a compromised registrar mints junk names
block after block, and so does an exploit in the payable path. Reserving can never be
scheduled, because a queued `addReservedNames(["nike"])` tells a squatter which name
is worth taking and how long it stays unprotected. The admin's powers answer outages rather
than losses, so they can wait. A dead price feed stops sales, but 90 days of grace means
nobody loses a name while the repair sits in the queue. Fixing that feed is now a single
`priceOracle.setUsdOracle` instead of a redeploy, which shortens the outage but does not
change which key it belongs to.

**Hardware wallets now, Safes and a timelock later.** Only the date changed. Safes and a
timelock cost coordination every week, and until the namespace has enough names and enough
turnover that cost is real while the benefit is theoretical. The first months therefore run
on plain hardware wallets, with snapshot and redeploy as the way out: fresh contracts, every
name re-created on them, clients pointed at the new addresses. That fallback only works while
the namespace is small, which is the same condition, so the arrangement ends itself.

Four things are worse in the meantime:

- **No warning period.** As section 5 describes, an admin action takes effect when signed and
  there is no scheduled transaction for the guardian to cancel.
- **No signing threshold.** Lose the admin key and its powers are gone; steal it and they are
  taken. No other key recovers either case.
- **Rotation is one-shot and unchecked.** `BaseRegistrar` and `Root` use OpenZeppelin's
  single-step `Ownable` and are both immutable, so moving them to a new device is a
  `transferOwnership` the recipient never has to accept. OpenZeppelin rejects the zero
  address, not an address that is valid but wrong. `SimplexController` is `Ownable2Step` and
  does require acceptance, so of the three it is the only one safe to rotate carelessly.
- **Nothing records who signed.** A person leaving is an incident rather than a membership
  change.

GOV8 answers all four. Waiting answers none.

**Prices stay changeable, and so does the oracle.** `SimplexPriceOracle` keeps the curve, the
feed pointer and the auction in storage rather than in `immutable`s, so the owner can change
all three. Chainlink has retired feeds before. On the older `StablePriceOracle` that
`.testing` runs, `usdOracle` is `immutable`, so a retired feed there means a fresh oracle and
a `setPriceOracle`. Either way, an oracle that could not be replaced and had a retired feed
would break registration and renewal permanently, with no key able to fix it. That is why
`setPriceOracle` outlives GOV9.

The oracle also refuses bad input. A zero or negative answer from the feed reverts with
`InvalidPriceFeed` instead of dividing by zero or wrapping the cast and quoting names at
nothing, and installing an already-dead feed is refused for the same reason.
`AggregatorInterface` has no `decimals()` to read, so `setUsdOracle` takes the replacement
feed's scale as an explicit argument; otherwise a feed on a different scale would misprice
every name by orders of magnitude and never revert. The sponsored path reads no feed at all,
because a registrar's allowance is denominated in attoUSD through `priceUSD()`, so a dead
feed closes the payable path and leaves the app-store flow running.

**The sales switch does not stay changeable.** `freeze()` locks `publicSalesOpen` in whatever
position it is in, and a switch left closed could never be reopened. So `freeze()` reverts
while sales are closed. The contract enforces that ordering, not a runbook.

**GOV9 waits for GOV8.** The freeze removes the only way to fix a bug in the controller, and
`Root.lock` removes the redeploy this plan leans on. Slipping GOV9 costs nothing
operationally, since brand reservation, `registerReserved` and everything else keep working.
It does keep the upgrade power alive, and that is the one power in the system with no bound
on it.

## 7. The fallback: snapshot and redeploy

This is what makes plain hardware wallets acceptable, so be precise about what it can and
cannot save.

**Why it is possible.** `Root.lock` is deliberately not called at GOV1. While the `.simplex`
label is unlocked, the root owner can point the TLD node at a freshly deployed registrar and
controller and keep the same `ENSRegistry`. Every SimpleX client reads the contract addresses
from configuration we ship, so switching them is a release, not a migration users perform.

**What has to be carried over**, or somebody loses something: each name's owner, its
remaining expiry, its `simplex.contact` and `simplex.channel` records, and any subnames.
`registerReserved` is owner-callable forever and takes an arbitrary owner and duration, so
the new deployment re-mints the snapshot directly, with no user action and no signature.
Subnames are the exception: only a name's holder can create them, and a name the admin holds
reaches its holder only when the holder claims it, so re-creating them needs a purpose-built
migration controller or the holders' signatures.

**The order that makes it safe.**

1. `setPublicSalesOpen(false)`, guardian, immediate. The set of names stops growing. This is
   what the switch is really for.
2. Snapshot at a stated block: owner, expiry, records, subnames.
3. Deploy the new registrar, controller and name policy. `addReservedNames` for the whole
   set, then `registerReserved` each name to its snapshot owner for its remaining term,
   writing the records in the same call. `registerReserved` releases each reservation, so
   afterwards reserve again every name that was under dispute; a disputed name past its
   expiry stays reserved and is not re-minted, since `registerReserved` would give it a fresh
   term of at least two years.
4. Re-snapshot and apply the difference, because transfers do not stop when sales do.
5. Point the TLD at the new contracts, ship the client release, announce the old addresses as
   dead.

**What can still be lost.** A redeploy voids the old NFTs: they stay in wallets and stop
meaning anything. Anyone who buys a `.simplex` NFT from its holder between the snapshot
and the switch has bought a dead asset, and step 4 is the only thing that catches it. Names
held by a contract are re-minted to that contract, which
may have no idea what to do with them. Both risks grow with the number of names and the depth
of any secondary market.

**Why the fallback expires.** Step 3 costs roughly a full registration per name, so 3000
names is already several hundred million gas, and step 4's exposure grows with trading
volume. The point where redeploy stops being credible is the point where Safes and a timelock
become worth their weight. GOV8 is due when redeploy stops being believable, not on a date.

## 8. Appendix A: transition recipes

Every on-chain call, in order, with who signs it.

### A1. Deployment (GOV1)

Caller: **deploy key**, alone.

1. Deploy `ENSRegistry`, `Root`, `BaseRegistrarImplementation`, `SimplexPriceOracle`,
   `SimplexController` implementation and proxy, `SimplexSponsor(controllerProxy)`,
   `SimplexNamePolicy(controllerProxy, baseRegistrar)` implementation and proxy,
   `SubnameRegistrar`, `SimplexResolver`, `MetadataRenderer`, `UniversalResolver`.
2. `Root.setController(deployKey, true)`; `Root.setSubnodeOwner(labelhash("simplex"), baseRegistrar)`.
3. `baseRegistrar.addController(controllerProxy)`; `baseRegistrar.addController(namePolicy)`;
   `controller.setNamePolicy(namePolicy)`; `baseRegistrar.setMetadataRenderer(renderer)`;
   `baseRegistrar.setMaxLabelLength(63)`; `baseRegistrar.setSubnameHook(subnameRegistrar)`.
4. `subnameRegistrar.setResolver(simplexResolver)`.
5. `controller.setDefaultResolver(simplexResolver)`; `controller.setSponsor(sponsor)`.
   `namePolicy.setGeneralTerms(link)` and `namePolicy.setCommunityTerms(link)`, the links of `terms.<tld>.json`;
   `namePolicy.addCommunityNames([...])` in batches of 200;
   `baseRegistrar.setNamePolicy(namePolicy)`.
6. `namePolicy.addReservedNames([...])` for the roughly 3000 names chosen in advance, in
   batches of 200. Measured cost is 25.8k gas per name: 5.2M per batch, 77M in total,
   single-digit dollars at the base fee we expect. Run it at a low base fee;
   `deploy-mainnet.mjs` supports that through `MAX_BASE_FEE_GWEI`.
7. Leave `publicSalesOpen == false` and `Root.locked("simplex") == false`.

A transaction may use at most 16,777,216 gas (EIP-7825), and the gas estimate for the loop
in step 6 passes that above about 210 names, so the batches stay at 200. The name list is
final well before GOV1: the deployer commits it as `reserved-names.simplex.csv`, and
`deploy-mainnet.mjs` refuses to deploy `.simplex` without it.

No reverse registrar is deployed. That is possible because `PublicResolver` and
`UniversalResolver` no longer inherit `ReverseClaimer`, whose constructor called `claim` on
whatever owned `addr.reverse`. That was a hard dependency on a deployed reverse registrar,
which a subclass could not work around.

`SimplexPriceOracle` takes a **base price per year** plus a sparse list of **rungs**, each
`(maxLength, priceUSDPerYear)`. A rung at `K` covers every length up to `K`, and anything
longer than the tallest rung pays the base price. The launch curve is $10 a year at six
characters and above, then ten times more for each character below that:

```
setPrices(10e18, [(1, 1000000e18), (2, 100000e18), (3, 10000e18),
                  (4, 1000e18), (5, 100e18)])
```

The rungs go down to one character so that lowering `minCharLength` later never hands out
free names. `deploy-mainnet.mjs` reads them from `scripts/simplex-price-curve.mjs`, the one
place the curve is written down, and the post-deploy read-back checks every rung and the feed
scale on chain before the handover.

Mind the unit: these are attoUSD **per year**. The older oracle that `.testing` runs takes
attoUSD **per second**, so the two lists are not interchangeable. Pasting one into the other
is off by a factor of 31,536,000, and neither contract rejects it.

Reserving at GOV1 rather than after the handover closes a hole. `publicSalesOpen` gates only
the payable `register`, so once the guardian funds a registrar (A3) the sponsored path can
register any label that is not reserved. The post-deploy read-back checks every reserved
label, which makes the reserved set part of the deployment's acceptance check.

Before GOV1, the hardware wallets must be initialised, their addresses recorded, and **each
must have executed one rehearsal transaction on mainnet** from the device itself. Two of the
handover transfers take effect with nobody having to accept them, so an address nobody can
sign for is unrecoverable. The rehearsal proves the device, not the address.

### A2. Handover (GOV2)

Order matters. `setBeneficiary` is owner-callable only while the beneficiary is unset. After
that only the beneficiary can move it, so the guardian is chosen here or not at all.

| # | Caller | Call |
|---|---|---|
| 1 | deploy key | `controller.setBeneficiary(guardianKey)`. Rejects the zero address, and `deploy-mainnet.mjs` refuses to run if `GUARDIAN_ADDRESS` is unset or equals `OWNER_ADDRESS` |
| 2 | deploy key | `controller.transferOwnership(adminKey)` |
| 3 | admin key | `controller.acceptOwnership()`, required by `Ownable2Step` |
| 4 | deploy key | `baseRegistrar.transferOwnership(adminKey)` |
| 5 | deploy key | `root.setController(adminKey, true)` and `root.setController(deployKey, false)` |
| 6 | deploy key | `root.transferOwnership(adminKey)` |
| 7 | deploy key | `priceOracle.transferOwnership(adminKey)` |
| 8 | admin key | `priceOracle.acceptOwnership()`, required by `Ownable2Step` |

All eight complete on one day, since there is no delay to wait out. Steps 4 and 6 are
single-step `Ownable`: they take effect immediately, nobody has to accept, and the
transaction gives no sign of whether anyone holds the key. So the admin address must be
correct, and there is no second chance. Confirm the admin device can sign before step 4, by
having it execute step 3.

Verify: `owner()` is the admin key on all four contracts; `beneficiary()` is the guardian
key; `sponsor()` is the verified `SimplexSponsor`, whose `controller()` is this controller; `pendingOwner()` is empty on both the controller and the price oracle; every call the
deploy key used to make now reverts. The oracle is the one most easily missed, because it is
not reachable from the controller. A handover that checks only the controller looks complete
while the price curve is still held by a key that is about to be destroyed.

Between steps 2 and 3 the deploy key can still redirect the controller elsewhere, so it is
destroyed only once all eight calls have landed and those checks pass. That is GOV5.

### A3. Guardian's first use (GOV3)

Caller: **guardian key**.

1. `sponsor.setRegistrarAllowance(registrarHotWallet, N)`, with `N` in **attoUSD**, sized
   to expected sales plus headroom.

Not before the post-deploy read-back has reported every reserved name: a funded registrar
can register any label that is not reserved, whatever the sales switch says.

A sponsored registration or renewal deducts that name's own list price, so the allowance
bounds exposure in money rather than counting transactions. At the launch curve, $100,000
buys 10,000 one-year six-character names, or 100 four-character ones, or ten three-character
ones.

There is no separate step to register a registrar: any address with a non-zero allowance is
one, and zero means it is not. The hot wallet also needs its own ETH for gas, because the
allowance authorises spending but does not pay for it. `setRegistrarAllowance` is
beneficiary-only (the controller's beneficiary) and does not depend on who owns the controller, so it works regardless of
how far the handover has got.

### A4. Open public sales (GOV7)

Caller: **guardian key**. `controller.setPublicSalesOpen(true)`.

### A5. Hardening (GOV8)

Moves both tiers onto Safes, and puts a timelock in front of the admin.

| # | Caller | Call |
|---|---|---|
| 1 | none | Deploy a 3-of-5 admin Safe and a 2-of-4 guardian Safe. Signers on hardware wallets, geographically distributed. |
| 2 | none | Deploy an OpenZeppelin `TimelockController` with a 7-day delay. Proposer and executor are the admin Safe, canceller is the guardian Safe. |
| 3 | guardian key | `controller.setBeneficiary(guardianSafe)`. Beneficiary-only once set, so the guardian moves its own role. Do this **first**, because it is the one step the admin key cannot perform. |
| 4 | admin key | `controller.transferOwnership(timelock)`, then the admin Safe has the timelock schedule and execute `controller.acceptOwnership()`. |
| 5 | admin key | `root.setController(timelock, true)`, then `root.setController(adminKey, false)`. |
| 6 | admin key | `baseRegistrar.transferOwnership(timelock)` and `root.transferOwnership(timelock)`. Single-step, immediate, and nothing confirms the new owner can act. |
| 7 | admin key | `priceOracle.transferOwnership(timelock)`, then the admin Safe has the timelock schedule and execute `priceOracle.acceptOwnership()`. |

Order matters twice. Step 3 comes before step 4, because once ownership moves the admin key
can no longer do anything, and `setBeneficiary` was never its call to make. Step 4 comes
before step 6, because step 4 is the only one that proves the timelock can execute, and steps
5 and 6 cannot be undone without that proof. Step 7 goes last because it is two-step like
step 4, so a wrong address there is still recoverable.

Verify: `owner()` is the timelock on all four contracts; `beneficiary()` is the guardian
Safe; the old devices revert on every admin and guardian call; a scheduled no-op executes
after 7 days, and the guardian Safe can cancel one.

Retire the old hardware wallets only after that. Any later signer rotation follows the same
pattern, except that it is then a Safe transaction rather than a contract call.

### A6. Routine operations

Before GOV8 the callers are the hardware wallets and nothing waits. After GOV8, read the form
in brackets.

| Action | Caller | Call |
|---|---|---|
| Reserve a brand name under threat | guardian key *(guardian Safe, 2 sigs)* | `namePolicy.addReservedNames([name], reason)`, sent privately (see below) |
| Give a brand its name | admin key *(admin Safe, timelock, 7 days)* | `namePolicy.registerReserved(label, brandAddr, duration)`; releases the reservation, so the brand renews like any holder |
| List community names | guardian key *(guardian Safe, 2 sigs)* | `namePolicy.addCommunityNames([names])`, sent privately; names that are registered or in grace are skipped (`CommunityNameSkipped`) |
| Publish new general terms or community terms | admin key *(admin Safe, timelock, 7 days)* | Commit the file to `simplex-chat/simplex-chat`, tag it `general-terms-vN` or `community-terms-vN`, wait until git.simplex.chat mirrors it, run `scripts/terms-check.mjs` on the link, then `namePolicy.setGeneralTerms(link)` or `namePolicy.setCommunityTerms(link)`. An acceptance of that kind not yet used at registration or claim must then be made again; existing holders are not asked to accept. |
| Hold a disputed name | guardian key *(guardian Safe, 2 sigs)* | `namePolicy.addReservedNames([name], reason)`, sent privately (see below): the name can no longer be renewed. Settle with `removeReservedNames([name])` (admin, executed before the grace period ends; the holder keeps it) or, once the grace period has ended, `registerReserved` to whoever the ruling names |
| Keep a lapsing brand name protected | guardian key *(guardian Safe, 2 sigs)* | for a name handed out by `registerReserved` and not renewed: `namePolicy.addReservedNames([name], reason)` before its grace period ends, sent privately |
| Refill a registrar's allowance | guardian key *(guardian Safe, 2 sigs)* | `sponsor.setRegistrarAllowance(registrar, N)`, in attoUSD; replaces the old value rather than adding to it |
| Cut off a compromised registrar | guardian key *(guardian Safe, 2 sigs)* | `sponsor.setRegistrarAllowance(registrar, 0)` |
| Pause payable sales | guardian key *(guardian Safe, 2 sigs)* | `controller.setPublicSalesOpen(false)` |
| Change prices | admin key *(admin Safe, timelock, 7 days)* | `priceOracle.setPrices(base, rungs)`; replaces base and rungs together, and rejects a curve where a shorter name is cheaper than a longer one |
| Replace a retired ETH/USD feed | admin key *(admin Safe, timelock, 7 days)* | `priceOracle.setUsdOracle(feed, decimals)`; the scale is explicit, since the interface has no `decimals()` to read |
| Retune the expired-name auction | admin key *(admin Safe, timelock, 7 days)* | `priceOracle.setPremium(startPremium, totalDays)`; `totalDays = 0` switches it off |
| Replace the price oracle wholesale | admin key *(admin Safe, timelock, 7 days)* | `controller.setPriceOracle(newOracle)`; the escape hatch if the oracle itself is defective |
| Update NFT artwork | admin key *(admin Safe, timelock, 7 days)* | `baseRegistrar.setMetadataRenderer(newRenderer)` |
| Cancel a scheduled admin action | none *(guardian Safe, 2 sigs)* | `timelock.cancel(id)`; exists only after GOV8 |

Every label passed to `addReservedNames` or `registerReserved` must follow the dApp's label rule (`ALLOWED_LABEL_REGEX`: lowercase a-z, 0-9 and hyphens; transliterate accents and drop apostrophes). The contract hashes whatever bytes it is given, so `Coinbase` or `nestlé` reserves a name nobody can type and leaves `coinbase` and `nestle` open. The admin page enforces the rule; raw calls from a Safe, a timelock or a block explorer do not, so check each label against it first. `reason` is `Internal` (1), `Trademark` (2) or `Community` (3).

A reservation must not sit in public before it is mined: a squatter who sees it can still register the name first. Collect the guardian Safe's signatures off the Safe Transaction Service and let the last signer execute through private orderflow (Flashbots Protect or MEV Blocker). Failing that, first `setPublicSalesOpen(false)` and `setRegistrarAllowance(registrar, 0)`, then reserve, then restore both. See `docs/security.md`, "Reservations must not be public before they are mined".

### A7. The freeze (GOV9)

All four conditions must hold before anything is scheduled:

- GOV8 is complete. Freezing before then would make the code permanent and the weakest
  custody permanent with it.
- No open bug or unexplained behaviour against the controller implementation.
- The full sponsored journey has run in production since GOV7 with no defect that needed an
  upgrade to fix.
- No redeploy is under consideration, since `Root.lock` ends that option.

If any of them fails, wait. There is no date to move.

**Scheduling day.** Caller: **admin Safe**, 3 of 5. Schedule two timelock operations:

1. `root.lock(labelhash("simplex"))`
2. `controller.freeze()`

**Seven days later.** Before executing, read `controller.publicSalesOpen()`. If it is false,
the guardian Safe sets it true first, and this is the last moment it can. Also read
`controller.sponsor()` and confirm that its code is the verified `SimplexSponsor` and its
`controller()` is this controller: the freeze fixes the sponsor, and `freeze()` reverts only
while none is set. Read the name policy's ERC-1967 implementation slot and confirm that it
holds the audited `SimplexNamePolicy`: the policy's upgrades end at the freeze only because
that implementation checks `controller.frozen()`. Then execute both operations in order. The
executor role is open, so anyone can submit them.

The contract enforces this ordering: `freeze()` reverts with `PublicSalesClosed` while sales
are closed. The race is real. The pause belongs to the guardian and is immediate, the freeze
belongs to the admin and is delayed, so a pause answering an incident can land between the
scheduling and the execution. With the guard in place the queued freeze reverts and is queued
again, instead of sealing the payable path shut forever.

Verify: `root.locked(labelhash("simplex")) == true`; `controller.frozen() == true`; simulated
`upgradeTo`, `upgradeToAndCall`, `setPublicSalesOpen` and `setSponsor` all revert; simulated
`setPriceOracle` still succeeds; the oracle's own `setPrices`, `setUsdOracle` and
`setPremium` still succeed, because the freeze belongs to the controller and the oracle is a
separate contract; `owner()` is still the timelock and not `address(0)` on both. A simulated
`namePolicy.upgradeTo` reverts `Frozen`.

Then confirm live: a sponsored registration, a relayed record edit, a signed offer and claim,
`registerReserved`, and `withdraw()` paying the guardian Safe, which is the beneficiary by
then because GOV9 comes after GOV8.
