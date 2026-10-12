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
records them as its holder for good. A name, or a registry node, now goes only to
an address that agreed, and agreeing means being the caller or signing an EIP-712
intent, as record edits already do.

**Registration.** The payable `register` registers to the caller only. Registering
for someone else goes through the sponsored path, which needs the owner's
`RegisterName` signature. `registerReserved` stays exempt: the admin is trusted.

**Transfer.** A name moves only when its recipient takes it. The holder offers it
with `approve`, or with a signed `approveWithSig`; the recipient takes it with
`transferFrom` to itself, or with a signed `claimWithSig`. `transferWithSig` is
gone. Pushing a name to anyone else reverts, which also ends marketplace sales:
a marketplace's settlement contract delivers to the buyer without the buyer
calling or signing.

**Registry.** `ENSRegistry` makes nobody the owner of a node except the caller.
The root and the TLD registrars are exempt, since they assign names whose consent
the registrar and controller have already checked. That closes both manager
changes and shadow subnodes owned by a third party.

**The split.** The signature check pushed `SimplexController` 394 bytes over the
24,576-byte limit, so the sponsored path moved into its own contract,
`SimplexSponsor`, which the controller trusts until `freeze`. The controller is
22,529 bytes and the sponsor 5,741.

## 3. Every path that assigned an owner

- **Minting:** `register`, `registerWithCredit` and `registerReserved` on the
  controller, through `BaseRegistrar._register`, which mints and sets the
  registry node.
- **Moving the NFT:** `transferFrom`, both `safeTransferFrom` overloads, and
  `transferWithSig`.
- **Registry only:** `reclaim(id, x)`, `ENSRegistry.setOwner` / `setRecord` on a
  2LD (its manager), and `setSubnodeOwner` / `setSubnodeRecord` under a 2LD (H2's
  shadow subnodes).
- **Not a path:** `SubnameRegistrar` takes no owner; its subnames follow the 2LD
  holder.

## 4. Registration

`SimplexSponsor` verifies `RegisterName(string label,address owner,address
resolver,bytes[] data,uint256 deadline)` in the domain `SimplexSponsor` v1, unless
the owner is the caller.

- **Signed:** the label, the owner, and everything written at registration — the
  resolver and the resolver calls in `data` — so a relayer cannot attach records
  the owner did not approve.
- **Not signed:** the secret, so an owner can sign before the payer has chosen
  one (the web store's link from the app needs that), and the duration, since
  anyone may renew anyone's name anyway.
- **No nonce.** A deadline is enough: once used, the name stays unavailable for
  longer than any signature should live, and a replay could only repeat what was
  signed.

`register` reverts `OwnerMustBeCaller` unless `registration.owner == msg.sender`.
Both places the controller wrote the owner into the registry now write the
controller itself (`ens.setRecord(namehash, address(this), …)`); handing over
the NFT then sets the registry owner through auto-reclaim.

## 5. NFT transfer

- `transferFrom` and the four-argument `safeTransferFrom` (the three-argument one
  delegates to it) revert `RecipientMustBeCaller` unless `to == msg.sender` or the
  caller is a controller. The controller hands a fresh registration from itself
  to an owner whose consent it has checked.
- **Offer:** `approve(to, id)`, or `approveWithSig(from, to, tokenId, nonce,
  deadline, sig, ephemeralPubKey, viewTag)` signing `ApproveName(address
  from,address to,uint256 tokenId,bytes ephemeralPubKey,bytes1 viewTag,uint256
  nonce,uint256 deadline)`. It refuses `to == from`, emits the ERC-5564
  announcement when a key is given, and `to = address(0)` withdraws the offer.
- **Claim:** `transferFrom(owner, self, id)`, or `claimWithSig(from, to, tokenId,
  nonce, deadline, sig)` signing `ClaimName(address from,address to,uint256
  tokenId,uint256 nonce,uint256 deadline)` by the recipient. It needs
  `getApproved(tokenId) == to` (else `NotOffered`) and `ownerOf(tokenId) == from`.
- Both signed halves share the registrar's per-signer nonce. OpenZeppelin clears
  an approval on every transfer and burn, so an offer dies with any change of
  holder, re-registration included.

## 6. Registry ownership

- `setOwner`, and `setRecord` through it, reverts `OwnerMustBeCaller` unless the
  new owner is the caller or zero. The root node is exempt, because deployment
  hands it to `Root`.
- `setSubnodeOwner`, and `setSubnodeRecord` through it, applies the same rule
  unless the parent is the root or a TLD. The registry marks a TLD (`isTld`) when
  the root assigns it, which also covers a TLD re-pointed at a new registrar.
- `reclaim(id, owner)` requires `owner == ownerOf(id)`.
- Nobody can be appointed manager: an address becomes a node's owner only by
  setting itself, which a registry operator the holder appointed can do. Record
  delegation is the resolver's per-node `approve`, which assigns nothing.
- The upstream `ReverseRegistrar` assigns reverse nodes to their addresses under
  `addr.reverse`, which is not a TLD, so it cannot work against this registry.
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
  `registerWithCredit(Registration, deadline, sig)`, `renewWithCredit`, the
  `RegisterName` check and the allowance events. It holds no key of its own.
- **`SimplexController`** keeps `registerSponsored` and `renewSponsored`,
  callable only by `sponsor`, and `setSponsor`, owner-only and refused once
  frozen. The `registrarAllowance` slot is kept as `_unusedRegistrarAllowance`;
  `sponsor` is appended and `__gap` goes from 44 to 43.
- The guardian's kill switch is unchanged: one call zeroes a registrar, now on the
  sponsor. After `freeze`, the sponsored path's code is as fixed as the
  controller's.

## 8. What stays open

- `registerReserved` gives a name without the brand's signature, by the owner's
  choice: the admin is trusted, and every call is public.
- An offer is on chain before it is accepted: `Approval`, and the announcement
  when one is sent, name the recipient though nothing moved.
- A record can point at someone else's SimpleX link. The client renders a name
  only with that profile's `SimplexDomainProof`, so the check is client-side.
- A 2LD holder can still create shadow subnodes owned by itself (H2's disclosure
  case).
- A holder can no longer push a name to a burn address. Approving a contract that
  takes it is the way out.

## 9. Effects outside this repo

- **simplex-chat #7530:** core signs `RegisterName` with the name's wallet key, and
  ShopService calls `SimplexSponsor.registerWithCredit(reg, deadline, sig)`.
- **Web store plan (`sh/names-design`):** the browser signs with the wallet it
  generates; the link from the app carries the app's signature and deadline; the
  store registers through the sponsor rather than the payable `register`, as it
  must during the investor window anyway.
- **#7519 stealth transfers:** the sender's `approveWithSig` carries the
  announcement; accepting is the recipient's `claimWithSig` from the stealth key.
- **The guardian** funds registrars on `SimplexSponsor`.
- **ens-app-v3:** its Send flow will revert and needs an offer and claim flow. Not
  verified: the submodule is not checked out here.
- **Deploy scripts:** deploy the sponsor and call `setSponsor`; assign the TLD
  with `setSubnodeOwner` from the root; at handover, drop `eth-usd.data.eth` to
  zero (its parent `data.eth` is not a TLD, so it cannot be handed on, and
  `data.eth`'s new owner can take it back).

## 10. Tests

- `TestRecipientConsent.test.ts`: the payable path registers to the caller only;
  the sponsored path needs the owner's signature, which covers label, resolver and
  data but leaves secret and duration to the payer; expiry; a contract owner
  through ERC-1271; only the sponsor reaches the controller's sponsored entry
  points; pushes refused on all three entry points and by spenders and operators;
  approve-then-take; an offer dies on transfer and on re-registration; manager
  changes, third-party subnodes and `reclaim` to anyone but the holder refused.
- `TestApproveClaimWithSig.test.ts` replaces `TestTransferWithSig.test.ts`: type
  hashes pinned, offer then claim, the announcement on the offer, self-offers,
  wrong signers, missing and withdrawn offers, replay, expiry, expired names.
- Updated: the fixture (deploys and wires the sponsor, `withConsent`), every
  credited-path test, `TestControllerStorageLayout` (the sponsor slot),
  `TestAdminSplit` and `TestBeneficiaryAndFreeze` (`setSponsor`), tests that
  pushed names or reassigned nodes, and upstream setups in `TestPublicResolver`,
  the UniversalResolver fixture and the grace-period test in `TestBaseRegistrar`.
- The suite is green except the one upstream failure that predates this change.
  Each new guard, removed, fails at least one test.

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
