# CLAUDE.md — SimpleX Namespace Registry Contract (SNRC)

Implementation plan: [`snrc-implementation-plan.md`](./snrc-implementation-plan.md).

## BINDING: Minimize diff to upstream

This project forks ENS contracts and ENS app v3. The #1 priority is **minimal diff to upstream** for auditability. Every changed line must be justified.

Rules:
- **Do NOT rename files** unless the contract's interface/behavior actually changes. `ENSRegistry.sol` stays `ENSRegistry.sol`.
- **Do NOT restyle the frontend.** Keep ENS's Thorin design system, colors, fonts, layout. Only swap logo/favicon.
- **Do NOT refactor, reformat, or "clean up"** ENS code. Match their style even if you'd do it differently.
- **Do NOT add comments** explaining what you changed or why — that belongs in commit messages and the plan, not in the diff.
- **Do NOT add abstractions** "for flexibility" — if a one-line change works, don't wrap it in a helper.
- **Disable features by short-circuiting** (early return, skip rendering), not by deleting ENS code.
- **Proxy wrapping is mechanical**: for a constructor with storage writes, keep it, add `_disableInitializers()` to it, add `Initializable`, and add an `initialize` that repeats each of those writes. A private variable written by a base constructor and lacking an internal setter is out of `initialize`'s reach: override its getter instead (the registrar's `name()` and `symbol()`). A constructor in which only immutables are assigned stays as it is. No other changes to the contract body.
- **Do NOT rename variables, functions, or files** unless the name is actively misleading after our changes.
- **Do NOT move code** between files unless scope genuinely needs to change.
- Anything not strictly required by our functional changes is **completely prohibited** — no drive-by refactoring, no "making code better."
- When in doubt, leave ENS code untouched. A smaller diff is always better.

## What this is

GitHub forks of [ENS contracts](https://github.com/ensdomains/ens-contracts) + [ENS app v3](https://github.com/ensdomains/ens-app-v3) adapted for SimpleX Chat's decentralized namespace system. Maps human-readable names (`alice.simplex`) to categorized SimpleX short link data (contact links, channel links) on Ethereum.

## Repo structure

Public forks as git submodules of this repo:

```
simplex-namespace-contract/           ← this repo (parent)
  ens-contracts/                      ← submodule → simplex-network/ens-contracts
  testing-app/                        ← submodule → simplex-network/ens-app-v3 (.testing dApp)
  simplex-app/                        ← submodule → simplex-chat/simplex-domains-app-v3 (.simplex dApp)
  scripts/                            ← cross-repo deployment helpers
  docs/                               ← project-level docs
  test/                               ← cross-repo test fixtures
```

- `main` in each fork tracks upstream ENS (fetch-only)
- `simplex` branch is our working branch — all SNRC changes here
- `main...simplex` diff on GitHub is the audit surface
- This parent repo holds the plan, docs, and cross-repo tooling

## Architecture

Two separate deployments — one per TLD. Each is a near-standard ENS deployment with a custom controller. `.testing` launches first.

- `.testing` — NFT-gated (SMPXNFT holders only initially), 6+ char minimum, reserved names
- `.simplex` — NO NFT gate, 6+ char minimum, reserved names

Each deployment: `ENSRegistry` + `BaseRegistrarImplementation` + `SimplexController` + `SimplexSponsor` + `SimplexResolver` + `MetadataRenderer` + `SubnameRegistrar` + `SimplexNamePolicy` + `Root`. ENS contracts are used verbatim except: `SimplexController` (custom), `BaseRegistrarImplementation` (modified — ERC721Enumerable + on-chain label index + `tokenURI` + consented transfer + community name transfer check (`setNamePolicy`)), `ENSRegistry` (adds `setApprovalForAllWithSig` and the owner-consent rule), `PublicResolver` (no longer inherits `ReverseClaimer`), `StablePriceOracle` (adds `priceUSD` + a sixth length bucket), plus the new SNRC contracts `SimplexSponsor`, `MetadataRenderer`, `SubnameRegistrar`, `SimplexResolver` and `SimplexNamePolicy` (the reserved and community names). **No NameWrapper** and **no reverse registrar** (both removed — see Deviations).

On `.simplex`, `ENSRegistry`, `BaseRegistrarImplementation`, `SimplexResolver`, `SubnameRegistrar`, `SimplexController`, `SimplexNamePolicy`, `SimplexSponsor` and `UniversalResolver` are each deployed behind an OpenZeppelin 5.1.0 `TransparentUpgradeableProxy` with a `ProxyAdmin` of its own, owned by the admin Safe; renouncing a `ProxyAdmin` freezes that one contract (see [`docs/plans/upgradeable-stack.md`](./docs/plans/upgradeable-stack.md)). Of the `.testing` contracts, only `SimplexController` is upgradeable (UUPS, ERC-1967 proxy). Every upgrade must preserve the contract's storage layout — see [`ens-contracts/docs/upgrades.md`](./ens-contracts/docs/upgrades.md) for the `__gap` / append-only invariants and the pre-upgrade checklist.

Resolver: `SimplexResolver` — `PublicResolver` plus signed record writes (`setTextWithSig`, `clearRecordsWithSig`). SimpleX links stored as text records: `simplex.contact`, `simplex.channel`.

Subnames are on-chain via the `SubnameRegistrar`: registry subnodes **owned by the registrar and soulbound to the 2LD NFT** — a subname's effective owner is the current 2LD token holder, derived via `SubnameRegistrar.ownerOf` (which walks up the parent chain to the 2LD node), so transferring the NFT moves all its subnames instantly. Record authorisation routes through `PublicResolver`'s `nameWrapper` hook (the resolver is deployed with `nameWrapper = subnameRegistrar`); the 2LD node itself is owned directly by the NFT holder because `BaseRegistrar` **auto-reclaims** it to the new holder on transfer. On re-registration, `BaseRegistrar` calls `subnameRegistrar.onReregister` to bump a per-2LD generation that invalidates the previous owner's subnames (garbage-collected via permissionless `purge`); creating over a generation-dead subname is refused, and creating over a node the registrar did not own (left in the registry, or pulled out of the registrar) clears its records, so a revived label always starts with no records. A subname has an owner only while its whole chain up to the 2LD is intact — each subname on the way up still owned by the registrar and created under its parent's current generation, which is bumped whenever `createSubname` is called on a node the registrar does not own — so a subname pulled out of the registrar, and everything under it, has no owner, and re-creating a deleted middle subname does not restore its old children. Authority follows the *registration*, not the registry record it outlives: `BaseRegistrar` mirrors every expiry change via `onExpiryChanged`, and a lapsed 2LD loses its subtree. Deleting or purging a subname retires its records through `SimplexResolver.clearSubnameRecords` (registrar-only, and only for nodes the registrar owns), because the node hash is reused verbatim if the label is ever created again. Subnames are created + indexed on-chain so they enumerate without an indexer; depth (subnames of subnames) is supported in the contracts. 2LDs themselves are ERC-721 tokens on the `BaseRegistrar`, but a transfer completes only when the recipient takes it, so marketplaces that deliver to the buyer cannot settle them (see Recipient consent); their NFT metadata (JSON + SVG, with the domain name) is rendered fully on-chain by the `MetadataRenderer`. There is no NameWrapper and no ERC-1155 wrapping.

Payment is ETH (same as ENS). Pricing: $50/year (6+ chars). `.simplex` uses `SimplexPriceOracle` (SNRC): a base price per year plus exceptions `(labelLength, priceCentsPerYear)`, each for labels of exactly that length, in US cents, all replaceable by one owner call, with the ETH/USD feed settable too; its premium is zero, so a lapsed name costs the same as any other. `.testing` still runs ENS's `StablePriceOracle` plus a sixth length bucket and `priceUSD` — see names-v2.

## Key references

- Whitepaper: `/work/community-credits-whitepaper/community_credits_whitepaper.tex` (§Public Namespaces, §SNRC definition)
- RFC PR: https://github.com/simplex-chat/simplex-chat/pull/7001
- ENS contracts: https://github.com/ensdomains/ens-contracts
- ENS app v3: https://github.com/ensdomains/ens-app-v3
- Community credits PoC: `/work/simplex-community-credits-poc/` (match Solidity 0.8.24 + Hardhat conventions)

## NFT gate contract (mainnet)

Address: `0x3AF6D9Ee862376A8DFC0a78847Eb20A153557291`
Name: "SimpleX NFT: SMPX testnet access", Symbol: SMPXNFT, ERC-721, 560 tokens.
Key non-standard functions: `setMinter(address)`, `setNextTokenURI(string)`, `lockMintingPermanently()`, `burn(uint256)`, `withdraw()`. Sequential token IDs via `nextTokenId` counter. Gate check is `balanceOf(sender) > 0`.
`MockSMPXNFT.sol` replicates this interface for local/testnet.

## SimpleX data in resolver

`SimplexResolver` — `PublicResolver` plus a sponsored path (see names-v2 below).
SimpleX links stored as text records:
- `simplex.contact` — contact short link (1:1 messaging)
- `simplex.channel` — channel short link (group/channel)

Both records store a **comma-separated list** of URLs (primary first, fallbacks after) so a name can advertise multiple SMP servers for redundancy. Clients SHOULD try them in order. The on-chain layer is unchanged — it's still a plain `setText` / `text` against the ENSIP-5 key. The SNRC REST resolver (`scripts/resolver/snrc-resolve.py`) parses the CSV and returns each as `string[]` (`simplexContact`, `simplexChannel`). The dApp's editor caps the list at 5 entries.

## names-v2

A user buys a name through the app store and never holds ETH; SimpleX relays every on-chain action. See [`docs/plans/names-v2-contracts.md`](./docs/plans/names-v2-contracts.md).

- **Registrar allowance.** The guardian grants a registrar hot wallet a spending limit in **attoUSD** on `SimplexSponsor`; its `registerWithCredit` / `renewWithCredit` deduct the name's own list price and attach no value. Replaces rather than adds, so zeroing it is a one-transaction kill switch. `StablePriceOracle` gained `priceUSD()` (`IPriceOracleUSD`) so the limit is denominated in the unit the price list is configured in and does not drift with ETH.
- **Signed intents.** One-shot EIP-712 signatures relayed by anyone: `RegisterName` (SimplexSponsor, the owner's consent to a sponsored registration, submitted by a registrar with an allowance), `approveWithSig` / `claimWithSig` (BaseRegistrar, the two halves of a transfer; the offer emits ERC-5564's `Announcement` verbatim, with `ephemeralPubKey` and `viewTag` inside the signed struct, so a relayer cannot fabricate or suppress a derivation), `setTextWithSig` / `clearRecordsWithSig` (SimplexResolver), `setApprovalForAllWithSig` (ENSRegistry — the one call that otherwise forces a user to hold ETH), `createSubnameWithSig` / `deleteSubnameWithSig` (SubnameRegistrar), `commitUnderGeneralTermsWithSig` / `commitUnderCommunityTermsWithSig` / `acceptGeneralTermsForClaimWithSig` / `acceptCommunityTermsForClaimWithSig` (SimplexNamePolicy: acceptance of the current terms of the name's kind for a commitment, or for a holder's offer). Each contract keeps its own per-signer nonce.
- **Metering is off-chain.** The relayer is the only caller of the sponsored write paths, so, with an on-chain budget, a transaction it had already agreed to pay for could only be rejected. It bounds payload size and gas itself; the signature and the nonce are checked by the contracts.
- **Recipient consent.** No name or registry node is assigned to an address without its owner's consent: being the caller, or an EIP-712 signature. The payable `register` registers to the caller only; registering for someone else needs their `RegisterName` signature (with a per-signer nonce) on `SimplexSponsor`, submitted by a registrar with an allowance. Transfers are an offer (`approve` / `approveWithSig`) and a claim by the recipient (`transferFrom` to itself / `claimWithSig`); pushing to anyone else reverts. `ENSRegistry` makes nobody owner but the caller, except for the root node and the subnodes of the root and of a TLD. `registerReserved` and controllers are exempt. See [`docs/plans/recipient-consent.md`](./docs/plans/recipient-consent.md).
- **No reverse resolution.** `ReverseRegistrar` / `DefaultReverseRegistrar` are not deployed, `PublicResolver` no longer inherits `ReverseClaimer`, and a non-zero `reverseRecord` reverts `ReverseRecordNotSupported`. The controller's two slots are reserved, not deleted.

## Admin capabilities

Two keys. **Admin** (the admin Safe, 2 of 4, with a 7-day timelock in front of it from GOV8) holds the rare and permissive powers; **guardian** (the guardian Safe, 1 of 4 until GOV7 and 2 of 4 from GOV7, no delay) holds the restrictive and urgent ones. The rule: a power is on the fast key only when the harm it answers accrues faster than the timelock delay.

- `disableNftGate()` — one-way (true→false) — *admin*
- `setMinCharLength(uint8)` — monotonic decrease only (6→5→4→3) — *admin*
- `setDefaultResolver` / `setPriceOracle` / `recoverFunds`, and on `SimplexNamePolicy` `removeReservedNames` / `registerReserved` (the policy is a registrar controller and mints the name itself) — *admin*
- `SimplexPriceOracle.setPrices` / `setUsdOracle` — *admin*, on the oracle's own `Ownable2Step` owner. Both are strictly weaker than `setPriceOracle`, which can install an arbitrary oracle
- `SimplexNamePolicy.addReservedNames` / `setReservationReason` — *admin **or** guardian*: a scheduled reservation would tell a squatter which name is valuable and for how long. A reserved name cannot be renewed: a registered name reserved during a dispute expires, and after its grace period only `registerReserved` can assign it. `registerReserved` releases the reservation
- `SimplexController.unregister(label, until)` — *admin **or** guardian*, also after the controller's `ProxyAdmin` is renounced: only before the name's `disputeUntil`, which a sponsored registration sets from the `disputeDays` of `registerWithCredit` (14 to 120; the store uses 120 for cards and in-app purchases, 14 for BTC, XMR and prepaid codes, and for a balance the largest days among the payments that funded it; the owner signs them, unless the registrar registers to itself), and the payable path and `registerReserved` leave at 0; `until` must equal `disputeUntil`, so a call prepared for one registration cannot end a later one whose dispute ends at another second; once a name is unregistered, the guardian and the admin cancel any other prepared `unregister` of it. It clears the records on the default resolver and on a past default the node points at, sets the expiry and the registry node's owner and resolver to 0, and ends the `SubnameRegistrar`'s subnames (subnodes the holder created directly in the registry keep their owner, resolver and records, also after the next registration, until the next holder replaces them, as after a lapse); the name is available to anyone at once. The registrar refuses a renewal until `disputeUntil`. After a disputed renewal, the guardian reserves the name, so it is not renewed again
- `setPublicSalesOpen(bool)` — *admin **or** guardian*: gates the payable path only; the credited, reserved and renew paths are exempt
- `SimplexNamePolicy.addCommunityNames` — *admin **or** guardian*: a listed name can be registered or received only by someone who accepts the current community terms (`commitUnderCommunityTerms`, `acceptCommunityTermsForClaim`, or their `WithSig` variants), and any other name only by someone who accepts the current general terms (`commitUnderGeneralTerms`, `acceptGeneralTermsForClaim`, or their `WithSig` variants), except through `registerReserved` and other registrar controllers (admin), under an off-chain agreement. Names that are registered or in grace are skipped, since their holders never accepted. A listed name is registered or renewed at most 1095 days out on the payable and sponsored paths and in `registerReserved`. `removeCommunityNames` / `setGeneralTerms` / `setCommunityTerms` — *admin*; each setter stores a link to one file at one commit and its keccak256, the hash an acceptance names
- The two pointers `setNamePolicy` (controller and registrar) — *admin*; both setters survive every freeze. The policy is called on every paid or sponsored registration, every renewal and every non-controller transfer of every name. Zero is refused by the controller's setter, so reservations always apply; the registrar's accepts zero, which drops the transfer check. A setter reverts unless the target's `controller()` (or `registrar()`) returns the contract that sets it; this catches a target bound to another controller or registrar, not a hostile one, so check that both pointers reference the same instance. The controller's setter also reverts for the policy's implementation; the registrar's accepts it, and every holder transfer then reverts until the pointer is corrected
- `SimplexSponsor.setRegistrarAllowance` / the controller's `setBeneficiary` — **guardian only**; `withdraw()` is permissionless and pays `beneficiary` (there is no `setTreasury`)
- `setSponsor` — *admin*
- `ProxyAdmin.upgradeAndCall` and `ProxyAdmin.transferOwnership` on each of the eight `ProxyAdmin`s — *admin*, owner of all eight from their creation, until that `ProxyAdmin` is renounced. A transfer is single-step; `scripts/prepare-upgrade.mjs` prepares it only once the GOV8 prerequisites exist, and it is sent only after `scripts/governance-check.mjs` passes for the recipient
- `ProxyAdmin.renounceOwnership()` — *admin*, one-way: freezes that one contract's code, at a time of its own. A seal of the sponsor or of the sales switch, where wanted, is added by the controller's last upgrade before its freeze. The owner of each contract is **not** renounced: brand reservation must continue indefinitely

## Deviations from `snrc-implementation-plan.md`

- **NameWrapper removed entirely (wrapper-free v3).** The wrapper was the largest source of complexity/defects (`.eth`-hardcoding, renew-desync, wrapper-aware-resolver auth) for features SNRC doesn't need (ERC-1155 wrapping, fuses/emancipation for trustless subname markets). It is deleted from the source tree. Replacements: 2LDs are plain ERC-721 tokens; **`BaseRegistrarImplementation` (v3, modified)** adds `ERC721Enumerable` (trustless "My Names"), a write-once `labelOf` label index (`registerWithLabel(string,…)`), an owner-settable `maxLabelLength` guard, and `tokenURI` delegating to a swappable `metadataRenderer`; **`MetadataRenderer`** (SNRC, swappable via `setMetadataRenderer`) renders JSON + SVG fully on-chain; **`SubnameRegistrar`** (SNRC; `.testing`: immutable, `.simplex`: behind a transparent proxy) creates + indexes subnames. Only the `wrapper/INameWrapper.sol` interface is kept, because the verbatim `PublicResolver` imports it (deployed with `nameWrapper = SubnameRegistrar`). The earlier `simplex-mainnet-testing-v2` wrapper deployment (`0x0994819e…e9ef`) is historical; v3 is a fresh redeploy.
- **`BaseRegistrarImplementation` is no longer verbatim.** `registerWithLabel` is the only registration path (the raw-labelhash `register` is gone), so every registration records its label; it also adds `labelOf` / `tokenURI` / `setMetadataRenderer` / `setMaxLabelLength` / ERC721Enumerable, in names-v2 the ERC-5564 `Announcement`, and for recipient consent `transferFrom` / `safeTransferFrom` that only the recipient (or, for `transferFrom`, a controller) may call, `approveWithSig` / `claimWithSig`, and a `reclaim` that points the node at the holder only, and for community names `setNamePolicy`, called on every non-controller transfer, and for the dispute period a `disputePeriod` argument to `registerWithLabel`, `disputeUntil`, the controller-only `unregister`, and a `renew` refused before `disputeUntil`. The `.testing` registrar is immutable; the `.simplex` one is deployed behind a transparent proxy (see below).
- **`ENSRegistry` is no longer verbatim.** names-v2 adds `setApprovalForAllWithSig`. It is the root of trust, so that diff is deliberately additive: the same `_operatorApprovals` write and `ApprovalForAll` event the existing setter produces, reached by signature instead of by transaction. Recipient consent then restricts it: `setOwner` / `setSubnodeOwner` (and the record setters through them) make nobody owner but the caller or zero, except for the root node and the subnodes of the root and of a TLD (`isTld`, recorded when the root assigns it). That is why the upstream `ReverseRegistrar`, which assigns `addr.reverse` subnodes to their addresses, cannot run against it; its suites are excluded.
- **Subname depth is bounded off-chain.** `ownerOf` walks the parent chain, so a depth-D subtree costs O(D²) to build. The relayer sees the call before it pays for it and refuses abusive depth there; a constant compiled into the contract would be a guess at a limit that only an upgrade before its freeze could revise. See `docs/security.md`.
- **Transparent proxies in place of UUPS (the `.simplex` v2 redeploy).** `ENSRegistry`, `BaseRegistrarImplementation`, `SimplexResolver`, `SubnameRegistrar`, `SimplexController`, `SimplexNamePolicy`, `SimplexSponsor` and `UniversalResolver` are each deployed behind an OpenZeppelin 5.1.0 `TransparentUpgradeableProxy`, whose `ProxyAdmin` the admin Safe owns from its creation; a contract is frozen on its own when its `ProxyAdmin` is renounced. The UUPS code is removed from `SimplexController` and `SimplexNamePolicy`, and `freeze()` and `frozen` from the controller. `Initializable`, `_disableInitializers()` in the constructor and an `initialize` are added to `ENSRegistry` and `BaseRegistrarImplementation`; the registrar's `name()` and `symbol()` are also overridden, since the values passed to the `ERC721` constructor are stored in the implementation's storage, which is not read through the proxy. The code of `SimplexResolver`, `SubnameRegistrar`, `SimplexSponsor` and `UniversalResolver` stays as it is: their constructors assign only immutables, so their proxies need no initializer. See [`docs/plans/upgradeable-stack.md`](./docs/plans/upgradeable-stack.md).
- **`PublicResolver` no longer inherits `ReverseClaimer`.** Its constructor called `claim` on whatever owns `addr.reverse`, which is a hard dependency on a deployed reverse registrar. It cannot be short-circuited from a subclass, so the inheritance is dropped — three lines, all deletions, of a feature this deployment does not use.

## Toolchain

- Node 22.x, pnpm 9.x
- Solidity 0.8.26, Hardhat 3.x (ENS upstream uses this)
- OpenZeppelin Contracts 4.9.x (ERC-721 + ERC721Enumerable, Base64, Ownable) + contracts-upgradeable 4.9.x (`Initializable`, and `Ownable2StepUpgradeable` for `SimplexController`) + `@openzeppelin/contracts-v5`, an npm alias of OpenZeppelin Contracts 5.1.0, for `TransparentUpgradeableProxy` and `ProxyAdmin`
- Frontend: Next.js + styled-components + wagmi/viem (fork of ens-app-v3, logo swap only)
- Tests: Hardhat + ethers v6 (contracts), Playwright (e2e)

## Deployment targets

- **Local**: Hardhat node, MockSMPXNFT + DummyOracle (fixed ETH/USD rate)
- **Sepolia testnet**: chainId 11155111, MockSMPXNFT deployed once + Chainlink ETH/USD feed (`0x694AA17…`)
- **Mainnet**: Chainlink ETH/USD oracle, real SMPXNFT (`0x3AF6D9Ee...`), treasury = SNCC multisig

### tracking of deployed versions

Maintain the rule that each onchain deployment shall tag the git commit it deploys for later reference. Existing tags:
* https://github.com/simplex-network/ens-contracts/releases/tag/simplex-sepolia-testing-v1
* https://github.com/simplex-network/ens-contracts/releases/tag/simplex-mainnet-testing-v1
* https://github.com/simplex-network/ens-contracts/releases/tag/simplex-mainnet-testing-v2 (NameWrapper TLD-parameterisation — needs tagging on the redeploy commit)

## Deployment order (per TLD)

Each TLD is an independent deployment. `ENSRegistry`, `BaseRegistrarImplementation`,
`SimplexController`, `SimplexNamePolicy`, `SubnameRegistrar`, `SimplexResolver`,
`SimplexSponsor` and `UniversalResolver` are
each an implementation behind a `TransparentUpgradeableProxy` whose `initialOwner` is
the admin (on mainnet, the admin Safe); every other contract is non-upgradeable. The `.testing` stack predates
this: only its controller is deployed behind a proxy, UUPS. The list gives the dependencies; the
order of calls on mainnet is steps 1 to 16 of `docs/deployment.md`, "Deployment and wiring",
and the local order is that of `scripts/deploy-local.mjs`.

1. MockSMPXNFT (local/testnet only, shared)
2. ENSRegistry = impl + proxy (`initialize(deploy key)`)
3. Registry root: held by the deploy key, which assigns the TLD from it; it moves into `Root` at the handover (step 12)
4. BaseRegistrarImplementation v3 = impl + proxy (`initialize(registry, namehash(tld), deploy key)`) (own the TLD node)
5. Price oracle (DummyOracle local / Chainlink mainnet) + SimplexPriceOracle for `.simplex` (ExponentialPremiumPriceOracle on the legacy `.testing` stack); transfer its `Ownable2Step` ownership to the admin key separately from the controller's
6. SimplexController = impl + proxy (NFT gate on for .testing, off for .simplex); add as controller on the base registrar → SimplexNamePolicy = impl(controller, baseRegistrar) + proxy → add as controller on the base registrar → `controller.setNamePolicy(policy)` → reserve the a-priori names on the policy
7. SubnameRegistrar = impl(registry, baseRegistrar) + proxy
8. SimplexResolver = impl(`nameWrapper = SubnameRegistrar`, `trustedETHController = controller`, `trustedReverseRegistrar = address(0)`) + proxy → `subnameRegistrar.setResolver(resolver)` → `controller.setDefaultResolver(resolver)` → SimplexSponsor = impl(controller) + proxy → `controller.setSponsor(sponsor)` → `policy.setGeneralTerms` → `policy.setCommunityTerms` (the links of `terms.<tld>.json`) → `policy.addCommunityNames` → `baseRegistrar.setNamePolicy(policy)`
9. MetadataRenderer(`.<tld>`) → `baseRegistrar.setMetadataRenderer(renderer)`
10. UniversalResolver = impl(deploy key, registry, gateway provider) + proxy; Multicall3
11. `baseRegistrar.setMaxLabelLength(63)` — not optional: the label is written to `labelOf` permanently
12. `setBeneficiary(guardian)` is the last call of the wiring, before any handover (owner-callable only while unset). After the read-back, hand over: BaseRegistrar, `eth` and `data.eth` to the admin in single steps, the registry root into a `Root` that the admin owns and controls, and the controller and the oracle as `Ownable2Step` proposals, which the admin accepts in one batch (launch-to-freeze plan A2). The registrar allowance is set later, in a step of its own, once the owner provides the registrar wallet (launch-to-freeze plan A3)
13. Output addresses: run 1 writes `deployments.mainnet.simplex.json`; `scripts/deploy-local.mjs` writes `deployments.local.json`

No reverse registrar is deployed. `Root` comes after the deploy and `Root.lock` at GOV9 — while the label is unlocked a redeploy can keep the registry and re-point the TLD, which is the cheap recovery path until real users exist.

## Conventions from the PoC to follow

- Use `hardhat.config.ts` (not `.cjs`), but match PoC's solc settings
- ethers v6 footguns: `NonceManager` doesn't auto-increment across calls; `signer.reset()` after expected reverts; use `await signer.getAddress()` not `signer.address`

## Frontend approach

Fork ens-app-v3, minimal diff. Each frontend deployment targets one TLD via `NEXT_PUBLIC_SIMPLEX_TLD` env var.

### Done
- **ensjs patch**: `getNameType` + `validation` patched so `.testing`/`.simplex` are treated as eth-like TLDs (pnpm patch, 4 one-line changes)
- **TLD support**: all `.endsWith('.eth')` checks expanded to include our TLDs
- **Search**: bare name search appends configured TLD
- **Branding**: placeholder logo SVGs (need real SimpleX logo)
- **Disable**: DNS import, ENS v2, legacy favourites, ENS nav links — short-circuited
- **Images**: avatar upload hidden, avatar display disabled (useEnsAvatar returns null)
- **Chains**: Sepolia testnet wired (Hoodi was rejected — Sepolia gives us Chainlink ETH/USD and a public subgraph)
- **Config**: `.env.simplex` with all env vars, contract addresses via `NEXT_PUBLIC_DEPLOYMENT_ADDRESSES`
- **Build**: `pnpm build` passes

### Remaining
- **Admin panel**: new page for reserved names, char length, NFT gate management
- **NFT gate indicator**: show NFT requirement on .testing registration
- **Pricing display**: show $50/year instead of ENS pricing
- **Real logo**: replace placeholder SVGs with SimpleX brand assets
- **End-to-end test**: deploy contracts to Hardhat, point frontend, verify full registration flow

## Gotchas / time-sinks learned the hard way

Don't re-derive these. Check here first.

### Hardhat 3 (`hardhat@3.x` with `npx hardhat node`)
- `npx hardhat node` uses the network named **`default`**, NOT `hardhat`. Setting `chainId` on the `hardhat` network in config does nothing. To get a non-default chainId, run `npx hardhat --network hardhat node`. Run script does this.
- Default in-memory chainId is **31337**. Viem's `localhost` chain (which the ENS app uses) is **1337**. We standardised on 1337 so they match. If the test wallet's chainId differs from RPC's, `eth_sendRawTransaction` rejects with "invalid chainId".
- Hardhat 3 doesn't implement `eth_createAccessList` (returns -32004). Viem uses this for gas-tightening; we patched `createAccessList.ts` to swallow that error and return an empty list.
- `eth_estimateGas` with state overrides (3rd param) returns a JSON-parse error "trailing characters". Hardhat doesn't accept state overrides. The fallback in `createAccessList` returning empty avoids this.
- Hardhat's block.timestamp drifts ahead of wall-clock after every `evm_increaseTime`. The advance is permanent for the node session. Fresh restart resets it. Frontend's CountdownCircle compares `block.timestamp*1000` against `Date.now()`, so big drift breaks the wait.

### viem batching
- viem batches reads via Multicall3's `aggregate3` (`0x82ad56cb`), **NOT `tryAggregate`**. Our mock must implement both. Symptom: every read fails with Hardhat "Internal error" → wagmi shows `data: undefined`.

### ENS app local dev expectations
- `useEthPrice` hardcodes `eth-usd.data.eth` — must be registered locally with addr → DummyOracle. Without it, the Pricing-step Next button is disabled forever ("Loading"). Deploy script handles this.
- `localhost` chain in ENS app's frontend config = chainId 1337. Resolver address tables in `src/constants/{resolverAddressData,tldData}.ts` key off `'1337'`. If you change one, change all.

### Process hygiene
- Always `pkill -9 -f "hardhat\|next\|playwright"` AND `lsof -ti :8545 :3000 | xargs -r kill -9` before restarting the stack. Background playwright runs from prior turns will silently re-grep the same test you're trying to run now.
- `pnpm dev` Fast Refresh can get stuck in a reload loop after many code edits in the same session — `rm -rf testing-app/.next` (or `simplex-app/.next`) between major restarts.
- `bash scripts/run-local.sh` must run from `/work/simplex-namespace-contract/` (it doesn't `cd` to repo root).

### PublicResolver `trustedETHController` parameter
- PublicResolver constructor takes `(ENS, INameWrapper, trustedETHController, trustedReverseRegistrar)`. SNRC is wrapper-free; the **NameWrapper** slot holds the `SubnameRegistrar`, so subname records are authorised through its `ownerOf`. But do **not** pass zero for **trustedETHController**: that means the controller cannot write resolver records during `register()` (register reverts deep in `multicallWithNodeCheck` when `registration.data` is non-empty). So deploy the controller FIRST, then the resolver with the controller address as `trustedETHController`.
- `trustedReverseRegistrar` is `address(0)` on `.simplex`, which deploys no reverse registrar; the `.testing` resolver holds the ReverseRegistrar address there.

### Playwright fixture playbook (steal from ens-app-v3)
- `testing-app/playwright/fixtures/time.ts` (same in `simplex-app`) already solves the wall-clock vs block-clock issue: `page.clock.install({ time: blockTimestamp })` overrides browser `Date.now()` to match chain time, then `page.clock.runFor(ms)` + `testClient.increaseTime` advance both in lockstep. Use this pattern instead of `await page.waitForTimeout(60000)`.
- `testing-app/e2e/specs/stateless/registerName.spec.ts` (same in `simplex-app`) is a 2391-line existing test for the full registration flow. Before writing custom e2e tests from scratch, check whether an adapted ENS spec covers the same flow — that's likely the lower-diff path long-term.

### Stateful test names
- Hardhat runs in a single shared session — names registered by one test persist for the rest of the suite. Either use unique per-run name (e.g. `reg${Date.now().toString(36)}`) or reset chain state between tests. Symptom: a test passes when run alone but fails in suite (the previously-registered name is no longer `available`).
