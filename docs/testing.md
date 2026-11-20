# Testing

| Layer                  | Where                | Runner                                  |
|------------------------|----------------------|-----------------------------------------|
| Solidity unit + fuzz   | `ens-contracts/`     | `npx vitest run`                        |
| Frontend unit          | `testing-app/`, `simplex-app/` | `pnpm test`                   |
| End-to-end (Hardhat)   | parent repo          | `npx playwright test --project=simplex` |
| End-to-end `.simplex`  | parent repo          | `npx playwright test --project=simplex-tld` |
| Deployment-script tests | parent repo, `scripts/*.test.mjs` | `node --test`, with the files the step "Script tests" of `.github/workflows/deployment-scripts.yml` names |
| Journal checks         | parent repo          | `node scripts/journal-check.mjs`        |
| Rehearsal of runs 1 and 2, the registrar step and the upgrade tooling on a mainnet fork | parent repo | `node scripts/rehearse-mainnet.mjs`, with `MAINNET_RPC_URL` exported after `read -rs MAINNET_RPC_URL` |

The deployment-script tests, the journal checks and the rehearsal are described in
`docs/deployment.md`, "Rehearsal on a mainnet fork".

## Solidity unit tests

The SNRC-specific suites live under `ens-contracts/test/simplex/`, one file per contract
or flow. Among them:

| File                            | Covers |
|---------------------------------|--------|
| `TestSimplexController.test.ts` | commit-reveal (happy + too-early/too-late), NFT gate, reserved-name flows, `setMinCharLength` monotonic guard, `disableNftGate` one-way guard, pricing/oracle swap, `onlyOwner` access control |
| `TestRegistrarV3.test.ts`       | `registerWithLabel`/`labelOf`, ERC721Enumerable, `tokenURI`/renderer hook, `maxLabelLength`, auto-reclaim on transfer, `onReregister` |
| `TestSubnameRegistrar.test.ts`  | `createSubname`/`deleteSubname`/`purge`, `ownerOf` walk-up, generation GC, `getChildren` index |
| `TestMetadataRenderer.test.ts`  | on-chain JSON+SVG output, escaping |
| `FuzzSubnameRegistrar.test.ts`  | fuzz: subname create/delete/purge invariants |
| `FuzzMetadataRenderer.test.ts`  | fuzz: label escaping never breaks JSON/SVG |

Run:

```bash
cd ens-contracts
npx vitest run                    # SNRC + the full upstream ENS suite
npx vitest run test/simplex       # just our additions
```

What's **not** covered in-contract today:

- A single integration test that walks the full lifecycle (register → set records
  → transfer → renew → expire → re-register at premium → create subname → admin
  ops). Parts of this are covered cross-layer by the e2e suite (registration +
  records + admin); the renew / expire paths are only in the per-contract unit
  suites above. (v3 is wrapper-free — there is no wrap path.)
- Formal coverage measurement. The plan target was >90% line coverage on
  `SimplexController`; `npx hardhat coverage` hasn't been run against the SNRC
  branch yet.

## Frontend unit tests

Both app forks keep the upstream vitest suite (`pnpm test`) running for the
parts we didn't touch. Most of our additions are exercised by the e2e suite
instead; the offer and claim flow has unit tests of its own (`snrcClaimChecks`,
`snrcOffers`, `useNameOffer`, `useClaimChecks`, `NameOfferBanner`, the
`OfferName` and `ClaimName` flows, and the `offerName` / `withdrawOffer` /
`claimName` transactions).

## End-to-end (Playwright)

The tests of `test/e2e/simplex-flow.spec.ts` in the parent repo share one Hardhat
instance and one Next.js dev server (`./scripts/run-local.sh`).

Each test is written to run individually against a fresh chain. A few mutate
controller and policy state (admin lowering `minCharLength`, `disableNftGate`,
`addReservedNames`/`removeReservedNames`) and are placed late in the file so
earlier tests see a clean state. Some tests **adapt to the current chain state**:
they read `minCharLength` / `nftGateEnabled` first and either parametrise or
`test.skip` (e.g. skip an NFT-gate assertion once a previous test has disabled the
gate) rather than asserting the initial deploy values verbatim.

Run:

```bash
# from the parent repo, with the stack already running
npx playwright test --project=simplex

# single test
npx playwright test --grep "search shows name as available"
```

### Test catalogue

| Test | What it asserts |
|------|-----------------|
| homepage loads and shows search | The search box renders |
| search appends .testing TLD | Bare label auto-appends the configured TLD |
| search with connected wallet does not crash | Smoke test for the wallet-injected variant |
| search shows name as available | An unregistered name surfaces the `Available` tag |
| clicking available name navigates to registration | Search → `/register/<name>.testing` |
| full registration flow: commit and register | The whole UI commit/register flow ends with the view-name button |
| admin panel: view state and manage settings | `/admin` shows controller state + owner-only sections |
| set simplex.contact during registration profile step | Records added during registration are written on-chain |
| set simplex.contact after registration via profile editor | Records added via the profile editor are written + displayed |
| registration fails for an account without the SMPX NFT | `register()` reverts for a non-holder (contract-level) — *skips if the gate is already off* |
| search marks too-short names with the controller minimum | Search tag shows live `Min N chars` |
| my names lists a name registered by the connected wallet | `/my/names` chain-scan fallback returns the registered name |
| registration pricing page hides USD tiers and credit-card option on .testing | On `.testing` the USD tier cards + card-payment option are hidden |
| admin lowers min char length and registers a name at the new floor | Reads current min, lowers by 1, registers at the new floor — *parametric; skips if min < 2* |
| NFT-gate banner shows and Next is disabled when an NFT-less wallet reaches /register directly | Banner + disabled Next on `.testing` — *skips if the gate is off* |
| on .testing, a 4-char name shows zero registration cost (free pricing) | The all-zero `.testing` oracle yields a zero-cost invoice |
| attempting to register a reserved name shows a clear reserved banner | Reserved-name flow: dropdown shows `Reserved`, register page shows banner + disabled Next |
| admin disables NFT gate, then a non-NFT-holder can register | Contract-level: `disableNftGate` then a non-holder commits + registers |
| reserved name reverts; admin unreserves; same name can then be registered | Contract-level: reserved → revert; admin removes; succeeds |
| homepage shows yellow NFT-gate banner for a wallet without an SMPXNFT | Homepage banner for a gate-blocked wallet — *skips if the gate is off* |
| clicking an available name without NFT shows the SMPXNFT toast and does not navigate | Search gate: blocked toast, no nav — *skips if the gate is off* |
| clicking a reserved name shows the reserved toast even when the wallet holds the NFT | Reserved check fires regardless of NFT holding |
| direct nav to /&lt;too-short&gt;.testing/register stays on the page with a disabled "Name too short" button | Too-short guard on the register route — *skips if minChar ≤ 1* |
| direct nav to /&lt;too-short&gt;.testing (profile) renders the yellow "too short" warning | Too-short guard on the profile route — *skips if minChar ≤ 1* |
| .testing register page hides pricing tiers and the credit-card payment option | `.testing` register UI hides USD tiers + card payment |
| journey: name + subname, offered and claimed, then the recipient clears everything | UI: register a name and a subname with records, offer, review and claim (Claim stays disabled until acknowledged), then delete the subname and every record; asserts that no subname and no text, address or contenthash record is left on chain or in the app |
| the holder can withdraw a pending offer | The name page's Withdraw clears the registrar approval |

### `.simplex`

The tests of `test/e2e/simplex-tld-flow.spec.ts` run against a stack started with
`SIMPLEX_TLD=simplex ./scripts/run-local.sh`: the `.simplex` search suffix and
minimum, the USD tier on the register page, paid registration (the controller
keeps exactly the quoted price), records at registration, no NFT gate, reserved
names, the admin page refusing labels users cannot register, My Names, the
too-short guard, and the offer, claim and withdraw flows.
Terms: every name accepts its terms, served by `scripts/serve-terms.mjs` from
`test/fixtures/terms/`, at registration and at claim; a plain name is refused
without the general terms at both; while the general terms link is not a terms link, the
pricing step says names cannot be registered now. Community names: a listed name is
registered only for two years, and its community terms are accepted before it is
committed, after its commit when it was listed later, and before it is claimed; the
prompt returns, for each kind, when its terms change after the commit; the admin page
shows both terms from their links, lists a name and caps its reserved registration at
1095 days. A held name cannot be extended once reserved.

## Running everything

```bash
# Solidity + ENS upstream
cd ens-contracts && npx vitest run

# Stack + Playwright e2e (Hardhat-backed)
cd ..
./scripts/run-local.sh                 # in one terminal
npx playwright test --project=simplex  # in another

SIMPLEX_TLD=simplex ./scripts/run-local.sh  # .simplex stack, in one terminal
npx playwright test --project=simplex-tld   # in another
```

## Manual UI testing

From `testing-app` (`.testing`) or `simplex-app` (`.simplex`).

### Against mainnet (`.testing`)

The `.testing` NFT gate is disabled and pricing is zero, so any wallet can
register for gas only.

```bash
NEXT_PUBLIC_CHAIN_NAME=mainnet \
NEXT_PUBLIC_SIMPLEX_TLD=testing \
NEXT_PUBLIC_MAINNET_DEPLOYMENT_ADDRESSES="$(node -e "process.stdout.write(JSON.stringify(JSON.parse(require('fs').readFileSync('../deployments.mainnet.testing.json','utf8'))))")" \
pnpm dev
```

## Gotchas

- **Port hygiene** — Next.js falls back to 3001 / 3002 / 3003 when 3000 is busy
  from a zombie process. The Playwright config hits port 3000 only; always kill
  stragglers between runs:
  ```bash
  lsof -ti :3000 :3001 :3002 :3003 :8545 | xargs -r kill -9
  ```
- **Hardhat chain time drift** — `evm_increaseTime` only moves forward. The
  full-registration test re-syncs `page.clock` to the post-advance block
  timestamp; skip that and the CountdownCircle's wall-clock check stays in the
  past and the finish button never enables.
- **Compile flow** — the frontend reads contract ABIs from
  `ens-contracts/artifacts/` at deploy time. If you change a contract, run
  `npx hardhat compile` before `./scripts/run-local.sh`.
- **State pollution** — the adaptive tests read `minCharLength` /
  `nftGateEnabled` and either parametrise or skip. The non-adaptive
  registrar-state tests can still leave names registered on the chain; if you
  re-run a test that uses a fixed label, restart the stack to get a clean
  `BaseRegistrar`.

The longer running list of build-time gotchas lives in `CLAUDE.md` at the repo
root.
