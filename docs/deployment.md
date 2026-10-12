# Deployment

SNRC is **one deployment per TLD**, each an independent ENS-shaped stack. Only
`SimplexController` is behind a proxy (ERC-1967 / UUPS); every other contract is
immutable. There is **no NameWrapper** (v3 is wrapper-free); the stack adds
`MetadataRenderer` and `SubnameRegistrar`, and `PublicResolver` is deployed with
its `nameWrapper` slot pointed at the `SubnameRegistrar` (subname records
authorise via `SubnameRegistrar.ownerOf`). For the canonical contract-by-contract
deploy order see `CLAUDE.md` → "Deployment order" and `scripts/deploy-*.mjs`.

Active targets: **local Hardhat** and **Ethereum mainnet**. (Sepolia is retired —
the historical playbook lives in [`legacy/sepolia-deployment.md`](./legacy/sepolia-deployment.md).)

## Status

| TLD        | Contracts | dApp | Notes |
|------------|-----------|------|-------|
| `.testing` | **Live on mainnet** — addresses in [`deployments.mainnet.testing.json`](../deployments.mainnet.testing.json) | **Live** on GitHub Pages — [`testing-names.simplex.chat`](https://testing-names.simplex.chat) | NFT gate **disabled** (lifted on-chain 2026-07-09 via `disableNftGate`, one-way); `minCharLength = 6`; registration is **open and free** (all-zero price oracle). Controller ownership handoff to the cold owner is **still pending** — see [below](#completing-the-ownership-handover). |
| `.simplex` | **Not deployed** | — | Planned: same stack, **no** NFT gate, the real USD price curve. dApp will likely be **self-hosted + IPFS** (see [dApp hosting](#dapp-hosting)). |

The live `.testing` controller is the proxy at
`0xeeb9b6bf5fb68fb726005f7ba549c2f4b32f2dad` (`ETHRegistrarController` in the
addresses file); its current implementation is `0x281ca41311c2aa808c917c4674639d7567b75714`.

## Contents

- [Quick reference](#quick-reference)
- [Local Hardhat](#local-hardhat)
- [Mainnet](#mainnet)
- [Post-deploy operations](#post-deploy-operations)
- [dApp hosting](#dapp-hosting)
- [Frontend env vars](#frontend-env-vars)
- [Deploy-time env vars](#deploy-time-env-vars)
- [Verification](#verification)
- [Gotchas](#gotchas)

## Quick reference

| What                          | Command / Variable                                  |
|-------------------------------|------------------------------------------------------|
| Compile                       | `cd ens-contracts && npx hardhat compile`            |
| Local one-shot (`.testing`)   | `./scripts/run-local.sh`                             |
| Local one-shot (`.simplex`)   | `SIMPLEX_TLD=simplex ./scripts/run-local.sh`         |
| Deploy to mainnet             | `DEPLOYER_KEY=… MAINNET_RPC_URL=… MAX_BASE_FEE_GWEI=… SIMPLEX_TLD=… node scripts/deploy-mainnet.mjs` |
| Cold owner                    | `OWNER_ADDRESS` env (defaults to the simplexchat.eth cold key) |
| Verify on Etherscan           | `ETHERSCAN_API_KEY=… NETWORK=mainnet SIMPLEX_TLD=… node scripts/verify-etherscan.mjs` |
| Addresses output (local)      | stdout + `deployments.local.json`                    |
| Addresses output (mainnet)    | `deployments.mainnet.${tld}.json` + `.journal.jsonl` + `.attempts.log` (**deployer must commit JSON + journal**) |
| Frontend addresses (local)    | `NEXT_PUBLIC_DEPLOYMENT_ADDRESSES` (JSON)            |
| Frontend addresses (mainnet)  | `NEXT_PUBLIC_MAINNET_DEPLOYMENT_ADDRESSES` (JSON)    |
| TLD select                    | `NEXT_PUBLIC_SIMPLEX_TLD` (`testing` or `simplex`)  |
| Chain select                  | `NEXT_PUBLIC_CHAIN_NAME` (`localhost` / `mainnet`)  |
| Static-export routing         | `NEXT_PUBLIC_IPFS=1` (GitHub Pages / IPFS build)    |

---

## Local Hardhat

`./scripts/run-local.sh` runs the following in a single process:

1. `npx hardhat --network hardhat node` — starts Hardhat at `127.0.0.1:8545`
   with chainId **1337**. The `--network hardhat` flag is required; without it,
   `npx hardhat node` defaults to chainId 31337, which the frontend's
   `localhostWithEns` chain does not recognise.
2. `node scripts/deploy-local.mjs` — deploys the wrapper-free stack for the TLD
   selected by `SIMPLEX_TLD` (default `testing`):
   - `ENSRegistry`, `BaseRegistrarImplementation` (v3)
   - `DummyOracle` (fixed ETH/USD = $1) + the price oracle
     (`SimplexPriceOracle` for `.simplex`, `ExponentialPremiumPriceOracle` for
     `.testing`)
   - `MockSMPXNFT`, with token #0 minted to the deployer (the NFT gate is on
     for `.testing`, off for `.simplex`)
   - `SimplexController` + ERC-1967 proxy (deployed **before** `PublicResolver`
     so its address can be passed as `trustedETHController`)
   - `SubnameRegistrar`, then `PublicResolver` (its `nameWrapper` slot =
     `SubnameRegistrar`, `trustedETHController` = controller)
   - `MetadataRenderer` → `baseRegistrar.setMetadataRenderer(...)`
   - `UniversalResolver`, mock `Multicall3` (implements both `aggregate3` and
     `tryAggregate`)
   - `eth-usd.data.eth` resolver record → `DummyOracle` (the frontend's
     `useEthPrice` resolves this ENS name on chain)
   - Two reserved labels by default: `simplex`, `simplex-chat`
   - Addresses persisted to `deployments.local.json` and printed as a JSON line
     prefixed with `NEXT_PUBLIC_DEPLOYMENT_ADDRESSES=`.
3. Starts the Next.js dev server with `NEXT_PUBLIC_DEPLOYMENT_ADDRESSES`,
   `NEXT_PUBLIC_PROVIDER`, and `NEXT_PUBLIC_SIMPLEX_TLD` exported.

### MetaMask setup

- Network: `Hardhat`, RPC `http://127.0.0.1:8545`, Chain ID `1337`
- Test account: import private key
  `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`
  (Hardhat account #0, 10000 ETH, holds `MockSMPXNFT` #0)

---

## Mainnet

Two separate deployments — `.testing` (done) and `.simplex` (pending). Both go
to Ethereum mainnet, driven by `scripts/deploy-mainnet.mjs`, which uses an
**ephemeral-deployer / cold-owner** model plus a frugal gas strategy, a
total-spend cap, and a journal-backed resume mechanism for partial failures.

### Key model: ephemeral deployer, cold owner

`DEPLOYER_KEY` is **ephemeral** — it holds only gas, signs the deploy
transactions, briefly owns every `Ownable` contract so the script can wire
things up, and is handed off at the end of the run. `OWNER_ADDRESS` defaults to
**`0xDa064C4567fAD2c9Da7b6DD08b5C2B2607960340`** (the EOA that owns
`simplexchat.eth`, held in cold storage); override it to hand off to a SAFE
instead. The `SimplexController` uses `Ownable2Step`, so the cold owner must
submit `acceptOwnership()` after the run to finish the handover. Until then the
deployer EOA retains controller admin + UUPS-upgrade authority (this is the
open item on the live `.testing` deploy).

### Pre-flight

- **Chainlink ETH/USD feed**: `0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419`
  (override with `ETHUSD_FEED`).
- **SMPXNFT contract**: `0x3AF6D9Ee862376A8DFC0a78847Eb20A153557291`
  (override with `SMPXNFT_ADDR`). The real contract is used directly (no mock).
- **Ephemeral deployer**: a fresh EOA. The script tells you exactly how much ETH
  to top it up with before sending any tx (see the preflight below).
- The `simplex` branch on both the `ens-contracts` and `ens-app-v3` forks must
  be audit-finalised — the `main...simplex` GitHub diff is the audit surface.

### Gas strategy at a glance

The script optimises for cost, not speed — it will happily take days when
mainnet stays expensive. For each tx:

1. **Priority fee is always 0.**
2. **Cap**: `maxFeePerGas = MAX_BASE_FEE_GWEI` (e.g. `0.078`, picked from a
   base-fee distribution as a low percentile of recent blocks).
3. **Submit policy**: poll `latest.baseFeePerGas` every ~12 s; submit only when
   `base ≤ cap`.
4. **Stall handling**: if a submitted tx hasn't mined within `BUMP_AFTER_HOURS`
   (default 24 h), the cap multiplies by `BUMP_PCT%` (default +20 %) and the tx
   is resubmitted at the same nonce. Every bump goes to the attempts log.
5. **Upfront cost ceiling**: at startup the script spawns
   `npx hardhat node --fork $MAINNET_RPC_URL` and runs the whole deploy against
   the fork as a dry run. Captured gas × cap = worst-case spend; real cost is
   usually lower.

### Run

Choose `MAX_BASE_FEE_GWEI` from a base-fee distribution (~5th percentile is a
reasonable start), then:

```sh
DEPLOYER_KEY=0x…                    # fresh ephemeral EOA
MAINNET_RPC_URL=https://…           # your RPC (used for fork + real)
MAX_BASE_FEE_GWEI=0.078             # cap; a tx only lands when base ≤ this
SIMPLEX_TLD=simplex                 # 'testing' is already deployed
OWNER_ADDRESS=0x…                   # cold owner (optional override)
BUMP_AFTER_HOURS=24                 # stall threshold (optional)
BUMP_PCT=20                         # bump on stall (optional)
node scripts/deploy-mainnet.mjs
```

The script prints a preflight summary (strategy, current base fee, forked
dry-run gas, deployer balance vs the remaining ceiling) and waits for `Y/N`.
Pass `CONFIRM=yes` to skip the prompt. The dry run is read-only against mainnet
(it executes on a local fork, torn down before the prompt).

### What the deploy does

1. Deploys the full wrapper-free stack: `ENSRegistry`, `BaseRegistrarImplementation`
   (v3), the price oracle (`SimplexPriceOracle` for `.simplex`,
   `ExponentialPremiumPriceOracle` for `.testing`),
   `SimplexController` + UUPS proxy, `SubnameRegistrar`, `PublicResolver`,
   `MetadataRenderer`, `UniversalResolver`.
2. Wires the controller into the `BaseRegistrar`, pre-loads the reserved labels
   (`simplex`, `simplex-chat`), sets the metadata renderer, caps
   `maxLabelLength` at 63, and registers `eth-usd.data.eth` → the Chainlink feed
   so the frontend's `useEthPrice` resolves on chain.
3. Hands ownership of every persistent role to `OWNER_ADDRESS`; the ENS-root
   transfer is the last write, after which the deployer can't reassign any TLD
   or contract role (except that it still holds the controller until the cold
   owner accepts).

### Resume on interruption

Re-run with the same env vars. The runner reads
`deployments.mainnet.${tld}.journal.jsonl`, skips every step already recorded as
mined, and continues from the next one. Step labels (`step:001…NNN`) are
deterministic from the script's operation order — the journal stays valid as
long as you don't reorder or insert operations in `scripts/deploy-mainnet.mjs`.
If you edit the script mid-flight, delete the journal and re-deploy.

### Commit the addresses file AND the journal

When the script finishes it writes `deployments.mainnet.${tld}.json`. Two
sidecar files travel with it:

- `deployments.mainnet.${tld}.journal.jsonl` — one line per successful tx (hash,
  address, gas, effective price, cost). **Commit this** — it's the paper trail
  and the resume source.
- `deployments.mainnet.${tld}.attempts.log` — every attempt with the reason it
  didn't land. Verbose; gitignore unless you want it in the audit trail.

```sh
git add deployments.mainnet.testing.json deployments.mainnet.testing.journal.jsonl
git commit -m "deploy: SNRC .testing mainnet addresses + journal"
```

Without the addresses file committed, the dApp build, Etherscan verification,
and upgrade/admin tooling have no way to reference the deployment.

Each on-chain deployment also **tags the git commit** it deploys (see
`CLAUDE.md` → "tracking of deployed versions"; the live `.testing` deploy is
tag `simplex-mainnet-testing-v3`).

---

## Post-deploy operations

All of these are `onlyOwner` calls on the `SimplexController` proxy (the cold
owner once the handover is complete; the deployer EOA until then).

### Completing the ownership handover

From a wallet controlling `OWNER_ADDRESS`, submit at the proxy address (stored as
`ETHRegistrarController` in the addresses file):

```
SimplexController.acceptOwnership()
```

Confirm:

```sh
cast call <PROXY> "owner()(address)" --rpc-url $MAINNET_RPC_URL
# → 0xDa064C4567fAD2c9Da7b6DD08b5C2B2607960340 (the cold owner)
cast call <PROXY> "pendingOwner()(address)" --rpc-url $MAINNET_RPC_URL
# → 0x0000000000000000000000000000000000000000
```

Until the cold owner accepts, the ephemeral deployer EOA still has admin — discard
the deployer key only after `acceptOwnership` lands. **On the live `.testing`
deploy this step has not yet run**, so the deployer EOA still holds admin +
UUPS-upgrade authority (security review finding H1).

### Source verification on Etherscan

`deploy-mainnet.mjs` writes `verification.mainnet.${tld}.json` at the end of a
fresh deploy, so no extra build step is needed:

```sh
ETHERSCAN_API_KEY=…   # v2 multi-chain key
NETWORK=mainnet SIMPLEX_TLD=testing node scripts/verify-etherscan.mjs
```

For a deploy that pre-dates the auto-write, run `scripts/build-verification.mjs`
once to reconstruct the file first.

### Changing prices

On `.simplex` this is a plain owner call. `SimplexPriceOracle.setPrices(base,
rungs)` replaces the whole curve atomically, with no deployment and no
`setPriceOracle`. `base` is attoUSD per year for every length above the tallest
rung; each rung is `(maxLength, priceUSDPerYear)` and covers every length up to
`maxLength`, so lengths between two rungs need no entry of their own:

| length | per year | rung |
|---|---|---|
| 6+ | $10 | base price |
| 5 | $100 | `(5, 100e18)` |
| 4 | $1,000 | `(4, 1000e18)` |
| 3 | $10,000 | `(3, 10000e18)` |
| 2 | $100,000 | `(2, 100000e18)` |
| 1 | $1,000,000 | `(1, 1000000e18)` |

That is `setPrices(10e18, [(1, 1000000e18), (2, 100000e18), (3, 10000e18),
(4, 1000e18), (5, 100e18)])`. Rungs go in ascending length order with
non-increasing prices, each `maxLength` in 1..64, and the base must not exceed the
lowest rung; the setter reverts otherwise, so no length can ever be cheaper than a
longer one. A free TLD is `setPrices(0, [])`. `setUsdOracle` moves the Chainlink
feed. The oracle has its own `Ownable2Step` owner, handed over separately from the
controller's.

`setPremium(startPremium, totalDays)` retunes the Dutch auction on lapsed names.
It takes the starting premium in attoUSD and the number of days it takes to decay
to nothing, so $1,024 over 10 days is `setPremium(1024e18, 10)`, giving
`endValue = 1024e18 >> 10 = 1e18`. The premium is charged on top of the rent from
the moment the name becomes registrable (its expiry plus the registrar's 90-day
grace period) and halves every day, with `endValue` subtracted throughout so the
curve lands exactly on zero at `totalDays` rather than stepping off a cliff:

| days past grace | premium |
|---|---|
| 0 | $1,023 |
| 1 | $511 |
| 2 | $255 |
| 5 | $31 |
| 9 | $1 |
| 10 and after | $0 |

ENS's mainnet auction is `setPremium(100000000e18, 21)`, which is what `.testing`
inherited. `setPremium(x, 0)` makes `endValue` equal `startPremium`, zeroing the
premium at every elapsed time, and is how the auction is switched off.

`.testing` predates this and runs the vendored `StablePriceOracle`, whose prices
are `immutable`. Changing them there means deploying a fresh oracle pointed at the
mainnet Chainlink feed (`0x5f4eC3Df…`) with the desired `PRICES` — **six**
attoUSD/sec rates for label lengths 1/2/3/4/5/6+ — and submitting
`SimplexController.setPriceOracle(<new oracle>)`. A **five**-entry array is still
accepted and keeps the old behaviour, where `price5Letter` applies to every name of
five characters or more, so 5 and 6+ are priced alike; pass six entries to split
them. Deploying a `SimplexPriceOracle` as the replacement is the better move, since
every later change is then a call.

The oracle must implement `IPriceOracleUSD`, i.e. `priceUSD()` alongside
`price()`. `price()` converts to wei through the Chainlink feed for the payable
path; `priceUSD()` returns the same quote in attoUSD before conversion, and is
what the registrar allowance is denominated and deducted in. That is why the
sponsored path keeps working when the feed does not.

There is **no** `freezePriceOracle`. Pricing must stay changeable: the feed
address is `immutable` inside the oracle, so a frozen oracle whose feed was
retired would end registration and renewal permanently, with no recovery on any
key. `setPriceOracle` deliberately survives `freeze()`.

> ⚠ The helper `scripts/deploy-oracle.mjs` is currently **Sepolia-wired** — it
> reads `SEPOLIA_RPC_URL` and defaults to the Sepolia ETH/USD feed. Generalise it
> (RPC + `ETHUSD_FEED`) before using it for a mainnet oracle, or deploy the oracle
> contract directly.

### Other admin calls

- `disableNftGate()` — one-way (true → false); permanently removes the SMPXNFT
  registration gate. Once called, the dApp's gate UI clears automatically (it
  reads `nftGateEnabled` on-chain).
- `setMinCharLength(uint8)` — monotonic decrease only (6 → 5 → 4 → 3).
- `addReservedNames(string[],Reason)` — owner **or beneficiary**, so a name under
  threat can be reserved immediately rather than at the timelock's pace. Bulk, one
  reason for the batch; about 25k gas per name, so batch ~300 per transaction (gas
  *estimators* run roughly 3× over actual on this loop, so the submitted limit
  looks far larger than the gas really burned). `Reason.None` (0) is rejected — it
  is the value meaning *not reserved*, so passing it would silently unreserve.
  `removeReservedNames(string[])` is owner-only — releasing a reserved name is the
  direction that should be visible before it lands.
- `setReservationReason(string[],Reason)` — owner **or beneficiary**; reclassifies
  names that are already reserved. Use this rather than removing and re-adding,
  which would leave the name registrable for the gap between the two transactions.
  Reverts for a name that is not reserved: it is not a second way to reserve.
- `Reason` is an on-chain enum — `None(0)`, `Unspecified(1)`, `Trademark(2)`,
  `PublicInterest(3)`, `Offensive(4)`, `Internal(5)`, `Premium(6)`. The wording a
  user sees is client-side, so new phrasing needs no upgrade. The integers are
  **append-only** once names are reserved against them: reordering silently
  relabels every existing reservation and nothing on chain can detect it.
- `registerReserved(string,address,uint256)` — owner-only; bypasses the gates and
  the commit/reveal. Sets `defaultResolver` on the node and transfers the token,
  so a brand's name resolves immediately without the brand ever holding ETH.
- `setDefaultResolver(address)` — the resolver `registerReserved` points names at.
- `setPublicSalesOpen(bool)` — owner **or beneficiary**; gates the payable
  `register()` only. The credited path, `registerReserved` and both renew paths
  are exempt, so pausing never blocks the app-store flow or a renewal. Two-way
  until `freeze()`, then sealed in its current position.
- `setSponsor(address)` — owner-only, refused after `freeze()`. The
  `SimplexSponsor` the controller lets register and renew without value; the
  deploy scripts set it.
- `SimplexSponsor.setRegistrarAllowance(address,uint256)` — **the controller's
  beneficiary only**. The registrar's spending limit in attoUSD; a sponsored registration or renewal deducts the
  name's own list price. Replaces rather than adds, so zeroing it is a
  one-transaction kill switch for a compromised registrar.
- `setBeneficiary(address)` — owner while unset, beneficiary thereafter. Set it
  **before** transferring ownership, or the deploy key controls revenue.
- `freeze()` — owner-only, one-way. Makes the implementation and the sponsor
  permanent and seals the sales switch. Refuses while sales are closed. There is no `setTreasury`;
  `withdraw()` is permissionless and pays `beneficiary`.

### Registering a registrar service

There is no separate registration step: any address with a non-zero allowance is
a registrar, and zero means it is not one. From the guardian key:

```
sponsor.setRegistrarAllowance(0xREGISTRAR_HOT_WALLET, 100000000000000000000000)  // $100,000
```

The hot wallet also needs its own ETH for gas — the allowance authorises, it does
not pay. Kill switch, same key, no delay:
`sponsor.setRegistrarAllowance(0xREGISTRAR_HOT_WALLET, 0)`. The registrar calls
`sponsor.registerWithCredit(registration, deadline, sig)`, where `sig` is the
owner's EIP-712 `RegisterName` signature (domain `SimplexSponsor`), unless the
registrar registers to itself.

### Upgrading the controller (UUPS)

Deploy a fresh implementation, then have the owner submit `upgradeTo(newImpl)`
(or `upgradeToAndCall`) on the proxy. This is possible only until `freeze()`,
which makes `_authorizeUpgrade` revert `Frozen` permanently. **Every upgrade must
preserve storage layout** — see [`../ens-contracts/docs/upgrades.md`](../ens-contracts/docs/upgrades.md)
for the `__gap` / append-only invariants and the pre-upgrade checklist.

> ⚠ `scripts/deploy-controller-impl.mjs` (which records the new impl in
> `impls.${network}.json`) is currently **Sepolia-wired** (reads
> `SEPOLIA_RPC_URL`); generalise it for mainnet or deploy the implementation
> directly.

---

## dApp hosting

The dApp is a static SPA (Next.js `next export`). One deployment targets one TLD
via `NEXT_PUBLIC_SIMPLEX_TLD` + `NEXT_PUBLIC_CHAIN_NAME`.

### `.testing` — GitHub Pages (canonical)

Built and deployed by `ens-app-v3/.github/workflows/deploy-pages.yml`, which is
**self-contained in the `ens-app-v3` fork** (`deployments.mainnet.testing.json`
is checked in beside it). On every push to the fork's `simplex` branch it:

1. `pnpm install --no-frozen-lockfile --prefer-frozen-lockfile` (pnpm 10 rejects
   `--frozen-lockfile` when a patched-dependency hash drifts; resolution stays
   pinned).
2. Builds the static export with these inlined at build time:
   - `NEXT_PUBLIC_CHAIN_NAME=mainnet`, `NEXT_PUBLIC_SIMPLEX_TLD=testing`
   - `NEXT_PUBLIC_MAINNET_RPC_URL` — a dedicated Alchemy key, origin-restricted
     to `*.simplex.chat` + spend-capped (safe to ship in the bundle; a GH secret
     would not help, since `NEXT_PUBLIC_*` is inlined into the public JS anyway).
   - `NEXT_PUBLIC_MAINNET_DEPLOYMENT_ADDRESSES` — the minified
     `deployments.mainnet.testing.json`.
3. Layers GitHub-Pages-only files onto the export: `CNAME`
   (`testing-names.simplex.chat`), `.nojekyll` (keep `_next/` intact), and a
   `404.html` JS redirect that mirrors `public/_redirects` (GitHub Pages doesn't
   honour `_redirects`, so path URLs like `/foo.testing/register` are rewritten
   client-side by the 404 page).
4. Deploys via `actions/upload-pages-artifact` + `actions/deploy-pages`.

One-time setup on `simplex-network/ens-app-v3`: Settings → Pages → Source =
GitHub Actions; add the custom domain `testing-names.simplex.chat`; add a DNS
`CNAME testing-names → simplex-network.github.io`; enable "Enforce HTTPS" once
DNS resolves.

To ship a new deployment, commit the updated `deployments.mainnet.testing.json`
into the `ens-app-v3` fork and push `simplex`.

### `.simplex` — self-hosted + IPFS (planned)

`.simplex` will not use a managed Pages host. The intended path is the same
static export (`NEXT_PUBLIC_IPFS=1` for hash-based asset routing) published to
**IPFS** and served from **self-hosted** infrastructure, with the `_redirects` /
`404.html` routing shim carried over. Contract addresses come from
`NEXT_PUBLIC_MAINNET_DEPLOYMENT_ADDRESSES` (the `.simplex` bundle) baked in at
build time. Concrete host + pinning setup is TBD until the `.simplex` contracts
are deployed.

> A Cloudflare Pages setup also exists as a documented alternative mirror — see
> [`hosting-cloudflare.md`](./hosting-cloudflare.md). It is **not** the canonical
> host for `.testing`.

---

## Frontend env vars

| Variable                                    | Meaning                                          |
|---------------------------------------------|--------------------------------------------------|
| `NEXT_PUBLIC_DEPLOYMENT_ADDRESSES`          | JSON object of contract addresses (local)        |
| `NEXT_PUBLIC_MAINNET_DEPLOYMENT_ADDRESSES`  | JSON object of contract addresses (mainnet)      |
| `NEXT_PUBLIC_MAINNET_RPC_URL`               | Mainnet JSON-RPC URL baked into the static build |
| `NEXT_PUBLIC_PROVIDER`                      | `http://127.0.0.1:8545` (local only)             |
| `NEXT_PUBLIC_CHAIN_NAME`                    | `localhost` / `mainnet`                          |
| `NEXT_PUBLIC_SIMPLEX_TLD`                   | `testing` or `simplex`                           |
| `NEXT_PUBLIC_IPFS`                          | `1` for static-export-friendly (hash) routing    |

## Deploy-time env vars

| Variable            | Meaning                                             |
|---------------------|-----------------------------------------------------|
| `DEPLOYER_KEY`      | Ephemeral hot key (gas only)                         |
| `MAINNET_RPC_URL`   | JSON-RPC URL (used for the fork dry-run + real send) |
| `MAX_BASE_FEE_GWEI` | Per-gas cap; a tx only lands when base ≤ this        |
| `SIMPLEX_TLD`       | `testing` (default) or `simplex`                     |
| `OWNER_ADDRESS`     | Final cold owner; defaults to the simplexchat.eth key |
| `ETHUSD_FEED`       | Override the Chainlink ETH/USD feed                  |
| `SMPXNFT_ADDR`      | Override the SMPXNFT gate contract                   |
| `ETHERSCAN_API_KEY` | Etherscan v2 multi-chain key (verify script)         |
| `BUMP_AFTER_HOURS` / `BUMP_PCT` / `FORK_PORT` / `CONFIRM` | Gas-strategy tuning (see the script header) |

---

## Verification

After each deployment:

1. `cd ens-contracts && npx hardhat compile` — no warnings.
2. `npx vitest run` from `ens-contracts/` — the **119** SNRC unit + fuzz tests
   (across `test/simplex/`) pass alongside the upstream ENS suite.
3. Bring up the stack and run the parent-repo Playwright e2e suite:
   `./scripts/run-local.sh` then `npx playwright test --project=simplex` — all
   **25** tests pass (some conditionally skip based on live chain state).
4. Manual smoke: search a 6-char name → "Available"; register it; set
   `simplex.contact` and `simplex.channel`; visit the profile and confirm both
   records render as clickable links.
5. Admin panel `/admin`: confirm `minCharLength`, `nftGateEnabled`, and owner.

## Gotchas

The `CLAUDE.md` at the repo root lists a longer set of build-time gotchas
(Hardhat 3 chainId, `eth_createAccessList`, Multicall3 `aggregate3`, etc.). Read
it before the first deployment of a new environment.
