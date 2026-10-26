# Recipient consent — contract work plan

Built on `simplex-namespace-contract` @ `540cd29` / `ens-contracts` @ `0654cd2`, on
`ens-contracts@ab/recipient-consent`. Decided with the owner on 12 Oct 2026.

## 1. Table of contents

1. Table of contents
2. Executive summary
3. Every path that assigned an owner
4. Registration
5. NFT transfer
6. Registry ownership
7. The `SimplexSponsor` split
8. What stays open
9. Effects outside this repo
10. Tests
11. Decisions and the alternatives turned down

## 2. Executive summary

An address can be tied on chain to content it never chose: register a name with
illegitimate records to someone's address, or transfer one to them, and the chain
records them as its holder for good. A name, or a registry node, now goes to an
address only with its owner's consent: being the caller, or signing an EIP-712
intent, as record edits already do.

**Registration.** The payable `register` registers to the caller only. Registering
for someone else goes through the sponsored path, which needs the owner's
`RegisterName` signature and a registrar with an allowance to submit it; a paying
user registers the name to their own address and offers it. `registerReserved`
stays exempt: the admin is trusted.

**Transfer.** A name moves only when its recipient takes it. The holder offers it
with `approve`, or with a signed `approveWithSig`; the recipient takes it with
`transferFrom` to itself, or with a signed `claimWithSig`. `transferWithSig` is
gone. Pushing a name to anyone else reverts, which also ends marketplace sales:
a marketplace's settlement contract delivers to the buyer without the buyer
calling or signing.

**Registry.** `ENSRegistry` makes nobody the owner of a node except the caller.
Exempt are the root node and the subnodes of the root and of a TLD, which the
root's owner (the admin key) and the TLD's registrar assign. That closes both
manager changes and shadow subnodes owned by a third party.

**The split.** The signature check pushed `SimplexController` 394 bytes over the
24,576-byte limit, so the sponsored path moved into its own contract,
`SimplexSponsor`, the only address allowed to call the controller's sponsored
entry points; `setSponsor` is fixed by `freeze`. The controller is 22,975 bytes
and the sponsor 5,763.

## 3. Every path that assigned an owner

- **Minting:** `register` and `registerWithCredit` on the controller, and
  `registerReserved` on the name policy, through `BaseRegistrar._register`, which
  mints and sets the registry node.
- **Moving the NFT:** `transferFrom`, both `safeTransferFrom` overloads, and
  `transferWithSig`.
- **Registry only:** `reclaim(id, x)`, `ENSRegistry.setOwner` / `setRecord` on a
  2LD (its manager), and `setSubnodeOwner` / `setSubnodeRecord` under a 2LD (H2's
  shadow subnodes).
- **Not a path:** `SubnameRegistrar` takes no owner; its subnames follow the 2LD
  holder.

## 4. Registration

`SimplexSponsor` verifies `RegisterName(string label,address owner,address
resolver,bytes[] data,uint256 nonce,uint256 deadline)` in the domain
`SimplexSponsor` v1, unless the owner is the caller. So the registrar refuses a
client's registration whose owner is the registrar's own address: the client
would choose the name and records the registrar holds.

- **Signed:** the label, the owner, and everything written at registration — the
  resolver and the resolver calls in `data` — so a relayer cannot attach records
  the owner did not approve.
- **Not signed:** the secret, so an owner can sign before the payer has chosen
  one (the web store's link from the app needs that); the duration, since
  anyone may renew anyone's name anyway; and the referrer, a 32-byte tag the
  payer chooses for the `NameRegistered` event.
- **A per-signer nonce**, as every other intent has. An earlier revision relied on
  the deadline alone; review showed that a signature with a distant deadline
  could register the name to its owner again after the owner let it lapse.

`register` reverts `OwnerMustBeCaller` unless `registration.owner == msg.sender`.
Both places the controller wrote the owner into the registry now write the
controller itself (`ens.setRecord(namehash, address(this), …)`); handing over
the NFT then sets the registry owner through auto-reclaim.

## 5. NFT transfer

- `transferFrom` and the four-argument `safeTransferFrom` (the three-argument one
  delegates to it) revert `RecipientMustBeCaller` unless `to == msg.sender`.
  `transferFrom` also accepts a controller as the caller, so a new registration
  can be transferred from the controller to its owner; no controller uses
  `safeTransferFrom`, so it has no exemption.
- **Offer:** `approve(to, id)`, or `approveWithSig(from, to, tokenId, nonce,
  deadline, sig, ephemeralPubKey, viewTag)` signing `ApproveName(address
  from,address to,uint256 tokenId,bytes ephemeralPubKey,bytes1 viewTag,uint256
  nonce,uint256 deadline)`. It refuses `to == from`, emits the ERC-5564
  announcement when a key is given, and `to = address(0)` withdraws the offer.
- **Claim:** `transferFrom(owner, self, id)`, or `claimWithSig(from, to, tokenId,
  offer, nonce, deadline, sig)` signing `ClaimName(address from,address to,uint256
  tokenId,uint256 offer,uint256 nonce,uint256 deadline)` by the recipient. It
  needs `getApproved(tokenId) == to` and `offer == offers(tokenId)` (else
  `NotOffered`), and `ownerOf(tokenId) == from`.
- `offers(tokenId)` is incremented by every `approve`, so a claim signature is
  valid for exactly one offer. Without it, a holder could withdraw an offer,
  keep the recipient's unused claim signature, change the name's contents, offer
  the name again and submit the old claim at a time the holder chooses (found in
  review).
- Both signed halves share the registrar's per-signer nonce, so a holder who
  withdraws an offer also holds up the recipient's later registrar intents until
  the recipient re-signs; clients sign none behind an unlanded claim.
- OpenZeppelin clears an approval on every transfer and burn, so any change of
  holder clears the offer, re-registration included. Nothing else does: the
  `ApproveName` deadline limits when the signature can be submitted, not how
  long the offer stands, and an offer stands through the grace period, so a
  renewal by anyone revives it. Plain `approve` still accepts a lapsed name, and
  a renewal makes that offer claimable too. `approveWithSig` refuses a lapsed
  name, so a holder without ETH withdraws an offer during the grace period only
  after a renewal.

## 6. Registry ownership

- `setOwner`, and `setRecord` through it, reverts `OwnerMustBeCaller` unless the
  new owner is the caller or zero. The root node is exempt, because deployment
  assigns it to the admin key.
- `setSubnodeOwner`, and `setSubnodeRecord` through it, applies the same rule
  unless the parent is the root or a TLD. The registry records a node as a TLD
  (`isTld`) when the root assigns it, which also covers a TLD re-pointed at a new
  registrar. The exemption trusts whoever owns the root or a TLD, and their
  registry operators: today the admin key owns the root and `eth`, and the
  registrar owns `simplex`.
- `reclaim(id, owner)` requires `owner == ownerOf(id)`.
- Nobody can be appointed manager: an address becomes a node's owner only by
  setting itself, which a registry operator the holder appointed can do. Record
  delegation is the resolver's per-node `approve`, which assigns nothing.
- The upstream `ReverseRegistrar` assigns reverse nodes to their addresses under
  `addr.reverse`, which is not a TLD, so none of its entry points works against
  this registry: each makes the user or a third party the node's owner.
  SNRC deploys none; its three suites are excluded in `vitest.config.ts`.

## 7. The `SimplexSponsor` split

Measured at the repository's optimizer setting (runs 1,000,000), against the
24,576-byte limit: the controller with the check was 24,970 bytes. Two splits by
concern were prototyped — the sponsored path (controller 22,529) and the name
policy of minimum length, reserved names and NFT gate (22,706), or both (20,218).
The owner chose the sponsored path alone; lowering optimizer runs was turned
down in favour of a split.

- **`SimplexSponsor`** (non-upgradeable): `registrarAllowance`,
  `setRegistrarAllowance` (the controller's `beneficiary` only),
  `registerWithCredit(Registration, nonce, deadline, sig)`, `renewWithCredit`, the
  `RegisterName` check, `nonces` and the allowance events. It holds no key of its
  own, and prices a name through the controller's `rentPriceUSD`, which replaces
  the controller's private `_rentPriceUSD`. Nonces and allowances belong to each
  sponsor, so an earlier sponsor is never reinstalled: that would revive its
  unused signatures and allowances.
- **`SimplexController`** keeps `registerSponsored` and `renewSponsored`,
  callable only by `sponsor` (`onlySponsor`), the external `rentPriceUSD`, and
  `setSponsor`, owner-only and refused once frozen. `sponsor` takes the slot
  `registrarAllowance` had: no deployed proxy ever held that mapping, so nothing
  needs reserving and `__gap` stays at 44. `freeze` reverts while no sponsor is
  set, as it does while sales are closed.
- The guardian's kill switch is unchanged: one call zeroes a registrar, now on the
  sponsor. A zero allowance is refused even when the price list quotes zero, so
  the switch holds with a zero curve. After `freeze`, the sponsored path's code is
  as fixed as the controller's.

## 8. What stays open

- `registerReserved` gives a reserved name to any address, for a term of two to
  eleven years, without its signature, also after `freeze`, and the admin or the
  guardian can reserve any name at once, which stops a held name's renewal, by
  the owner's choice: the admin is trusted, and every call is public.
- Controllers are trusted the same way. A controller may register any available
  name directly to any address and transfer a name it holds, was offered or
  operates for to anyone, and `addController` survives `freeze` as the repair
  path, so the admin key can always add one.
- The owner of the root, and of every TLD, can assign nodes under it to anyone,
  permanently: the scripts give the root and `eth` to the admin key and deploy no
  `Root`, so nothing locks the `simplex` label, and the admin can point it at
  itself and re-point the registry owner and resolver of any held name.
- **Consent covers the name, not its contents.** Between the recipient's consent
  and the claim landing, the holder can still change the name's records, point
  its registry resolver at a contract of the holder's own, and create subnames
  and shadow subnodes under it, which stay under the name after the claim; a
  holder watching the mempool can do so right before the claim. Each subname has
  to be deleted separately, and a transfer does not invalidate subnames the way
  a re-registration does. No relayed call resets a 2LD's registry resolver, and a
  shadow subnode is taken over without ETH by
  `setApprovalForAllWithSig(SubnameRegistrar)`, `createSubnameWithSig` (after a
  permissionless `purge` if it is stale) and `deleteSubnameWithSig`, but only
  when its label is known, non-empty and at most 63 bytes; clients refuse to
  claim a name with any other subnode, though a holder who front-runs the claim
  can still add one. Before signing a claim, clients must check the name's
  registry resolver and enumerate its subnodes, and theirs in turn, from the
  registry's `NewOwner` logs, ownerless ones included, since those can still
  have a resolver; they must never claim automatically, and should clear records
  and remove unexpected subnames right after claiming.
- An unused `RegisterName` signature stays valid until its deadline, and nothing
  cancels it. Clients sign with short deadlines, minutes rather than days: a
  sponsored registration needs only the commitment age. The same holds for an
  unused `ClaimName` signature while its offer stands, including an offer that a
  renewal revives after the name expired, so claims are signed with short
  deadlines too, and for an unused `ApproveName` signature, which a plain
  `approve` does not invalidate.
- Old records can come back with a re-registration. Records are retired only on
  the resolver the registry points at when the name is re-registered: a previous
  holder who pointed the node at no resolver, or at another past default, before
  the name lapsed leaves records in a default resolver that resolve again once
  the new registration points back at it, and a bare registration
  (`resolver == 0`) keeps a non-default resolver pointer. Subnames have similar
  gaps: a subname under a deleted subname, or one taken out of the
  `SubnameRegistrar`, keeps its records, and the previous holder keeps owning and
  writing any shadow subnode, so clients enumerate a previously held label's
  subnodes before registering it, as before a claim. These predate the change.
- An offer is on chain before it is accepted: `Approval`, and the announcement
  when one is sent, name the recipient though nothing moved. Other approvals —
  `ApprovalForAll` on the registry, the registrar and the resolver, and the
  resolver's per-node `Approved` — name arbitrary addresses the same way, and
  grant nothing to their owner. An announcement costs its sender only gas and
  stays in the logs after the offer is withdrawn or replaced, so a scanner treats
  it as an offer only while `getApproved` returns its stealth address.
- A record can point at someone else: an `addr` record or the registry's
  resolver pointer at any address, a text record at another person's SimpleX
  link. Records assign nothing, and the client renders a name only with that
  profile's `SimplexDomainProof`.
- A 2LD holder can still create shadow subnodes owned by itself (H2's disclosure
  case).
- A holder can no longer push a name to a burn address. The way out is to offer it
  to a contract that takes it and never sends it on, but none is deployed, and a
  holder without ETH cannot deploy one. Letting the name lapse is not in the
  holder's control either, since anyone may renew it.
- A contract that takes a name and later transfers it on, without first calling
  `approve` for the recipient, can no longer transfer it: escrow-style markets,
  lending and staking vaults trap a name until it lapses. Clients must warn
  before offering a name to a contract.
- ERC-1271 consent works only for deployed contracts: a counterfactual smart
  wallet cannot sign `RegisterName` or `ClaimName` (no ERC-6492).
- A signature consents to whatever it names, so, as for `setApprovalForAllWithSig`,
  the client never signs a `RegisterName` or `ClaimName` it did not construct
  itself, and shows the name and what it carries before signing.

## 9. Effects outside this repo

- **simplex-chat #7530:** core signs `RegisterName` with the name's wallet key and
  the key's current `nonces` value from the sponsor, and ShopService calls
  `SimplexSponsor.registerWithCredit(reg, nonce, deadline, sig)`; ShopService
  refuses a registration whose owner is its own address (§4).
- **Web store plan (`sh/names-design`):** the browser signs with the wallet it
  generates; the link from the app contains the app's signature and deadline; the
  store registers through the sponsor rather than the payable `register`, as it
  must during the investor window anyway.
- **#7519 stealth transfers:** the sender's `approveWithSig` emits the
  announcement; accepting is the recipient's `claimWithSig` from the stealth key.
- **The guardian** funds registrars on `SimplexSponsor`.
- **ens-app-v3:** Send on a `.simplex`/`.testing` 2LD is an offer (`approve`,
  withdrawable) that the recipient claims from the name's page after reviewing
  its resolver, records and subnodes. Unlike the clients described in §8, it
  still allows claiming a name with a subnode that only ETH can remove: it lists
  the subnode with a warning and requires the recipient's acknowledgement. Past
  100 nodes the walk stops, and the claim needs a second acknowledgement that the
  subnodes it could not check stay too. The claim is disabled only when a read
  fails, except a read of a holder-chosen resolver, which is listed with a
  warning instead. An optional switch adds a second transaction, right after the
  claim, that clears the records on the resolver the review showed
  (`clearRecords`); a resolver change front-run into the claim's block is not
  caught. The claim transaction re-checks the review on every block, and a check
  still running when the next block arrives finishes instead of restarting, so
  the claim can rest on a check one block old. A
  name whose label fails the app's label rule (lowercase letters, digits and
  hyphens, no hyphen at either end and no `--` in positions 3–4), such as one
  known only by its labelhash, cannot be offered or claimed in the app, since
  the app could not show or manage it. Manager editing is gone, since the
  registry assigns a node only to the caller or to zero (§6).
- **Deploy scripts:** deploy the sponsor and call `setSponsor`; assign the TLD
  with `setSubnodeOwner` from the root; at handover, set the owner of
  `eth-usd.data.eth` to zero (its parent `data.eth` is not a TLD, so it cannot be
  assigned to the admin, and `data.eth`'s new owner can take it back).
- **Redeploy contingency:** re-creating every name on a new stack now needs each
  holder's signature, or the admin exemption (reserve the names, then
  `registerReserved` them to their holders). Subnames need a purpose-built
  migration controller or the holders' signatures.

## 10. Tests

- `TestRecipientConsent.test.ts`: the payable path registers to the caller only;
  the sponsored path needs the owner's signature, which covers label, resolver and
  data but leaves secret and duration to the payer; a signature registers a name
  once, even after the name lapses; expiry; a contract owner through ERC-1271;
  only the sponsor reaches the controller's sponsored entry points; pushes
  refused on all three entry points and by spenders and operators;
  approve-then-take; an offer is cleared on transfer and on re-registration;
  manager changes, third-party subnodes and `reclaim` to anyone but the holder
  refused.
- `TestApproveClaimWithSig.test.ts` replaces `TestTransferWithSig.test.ts`: type
  hashes pinned, offer then claim, the announcement on the offer, self-offers,
  wrong signers, missing and withdrawn offers, a claim signature that a later
  offer does not revive, replay, expiry, expired names.
- Updated: the fixture (deploys and wires the sponsor, `signRegistration`), every
  credited-path test, `TestRegistrarAllowance` (a zero allowance refused at a zero
  price), `TestControllerStorageLayout` (the sponsor slot), `TestAdminSplit` and
  `TestBeneficiaryAndFreeze` (`setSponsor`, and `freeze` without a sponsor), tests
  that pushed names or reassigned nodes, and upstream setups in
  `TestPublicResolver`, the UniversalResolver fixture and the grace-period test in
  `TestBaseRegistrar`.
- The suite is green except one upstream test that failed before this change,
  `TestBaseRegistrar`'s "should permit the owner to transfer a registration". It
  used to fail at its registry-owner assertion (auto-reclaim) and now fails
  earlier, at its first `transferFrom`, which pushes the name.
- Each new guard, removed, fails at least one test.

## 11. Decisions and the alternatives turned down

- **Offer and claim on chain** over a countersigned single transaction. Two relayed
  transactions and a public offer, in exchange for an offer the sender can
  withdraw.
- **No marketplace exception.** Counting a recipient's operator approval as
  consent would let anyone who approved a marketplace be sent names through it.
- **Registry consent too**, including shadow subnodes, at the cost of the upstream
  `ReverseRegistrar`.
- **No appointable managers.** A registry-level offer and claim would add about
  fifteen lines to the root of trust for a role SNRC does not use.
- **`registerReserved` exempt.**
- **The sponsored path split out** rather than lowering optimizer runs, and rather
  than also splitting out the name policy.
