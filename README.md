# SimpleX Namespace Registry Contract (SNRC)

Decentralized namespace registry for [SimpleX Chat](https://simplex.chat), built as a minimal fork of [ENS](https://ens.domains). Maps human-readable names (`alice.testing`, `bob.simplex`) to SimpleX contact and channel links on Ethereum.

See [`snrc-implementation-plan.md`](./snrc-implementation-plan.md) for the full design and change justification.

## Repository structure

```
simplex-namespace-contract/           ← this repo
  ens-contracts/                      ← submodule: simplex-network/ens-contracts (simplex branch)
  testing-app/                        ← submodule: simplex-network/ens-app-v3 (simplex branch), .testing dApp
  simplex-app/                        ← submodule: simplex-chat/simplex-domains-app-v3 (simplex branch), .simplex dApp
  scripts/                            ← deployment scripts
```

## Prerequisites

- Node.js 22+
- pnpm 9+
- MetaMask browser extension

## Setup from scratch

```bash
git clone --recurse-submodules git@github.com:brenzi/simplex-namespace-contract.git
cd simplex-namespace-contract
```

Install dependencies:

```bash
pnpm install                          # parent repo (deploy script)
cd ens-contracts && pnpm install && cd ..
cd testing-app && pnpm install && cd ..
cd simplex-app && pnpm install && cd ..
```

After pulling into an existing clone, check out the submodule commits the pull
recorded, then reinstall and recompile:

```bash
git submodule update --init
pnpm install
cd ens-contracts && pnpm install && npx hardhat compile && cd ..
cd testing-app && pnpm install && cd ..
cd simplex-app && pnpm install && cd ..
```

## Compile and test contracts

```bash
cd ens-contracts
npx hardhat compile                   # required before running locally
npx vitest run
```

## Run locally

One command starts everything (Hardhat node, deploys contracts, starts frontend):

```bash
./scripts/run-local.sh
```

For `.simplex` TLD instead of `.testing`:

```bash
SIMPLEX_TLD=simplex ./scripts/run-local.sh
```

Open http://localhost:3000.

The script deploys the contracts in `ens-contracts/artifacts/`, so compile them
first (see above). It needs ports 8545 and 3000 free; Ctrl-C stops both the node
and the frontend. If something is still listening on either port, stop it with
`fuser -k 8545/tcp 3000/tcp` (or `kill $(lsof -t -i :8545 -i :3000)`).

<details>
<summary>Manual setup (separate terminals)</summary>

**Terminal 1**: Hardhat node (chain 1337; plain `npx hardhat node` starts chain 31337, which the frontend does not use)

```bash
cd ens-contracts && npx hardhat --network hardhat node
```

**Terminal 2**: Deploy + frontend, with the same TLD in both commands

```bash
SIMPLEX_TLD=testing node scripts/deploy-local.mjs
# Copy the NEXT_PUBLIC_DEPLOYMENT_ADDRESSES line from the output, then:
cd testing-app && rm -rf .next
NEXT_PUBLIC_DEPLOYMENT_ADDRESSES='<paste>' \
NEXT_PUBLIC_CHAIN_NAME=localhost \
NEXT_PUBLIC_PROVIDER=http://127.0.0.1:8545 \
NEXT_PUBLIC_SIMPLEX_TLD=testing \
pnpm dev
```

</details>

## MetaMask setup

1. Add network: **Settings → Networks → Add Network**
   - Network name: `Hardhat`
   - RPC URL: `http://127.0.0.1:8545`
   - Chain ID: `1337`
   - Currency: `ETH`

2. Import test account: **Settings → Import Account → Private Key**
   ```
   0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
   ```
   This is Hardhat account #0 (deployer) — has 10000 ETH and owns NFT #0 (needed for `.testing` registration).

3. For the offer and claim flow, also import account #1 as the recipient:
   ```
   0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
   ```

4. Every restart of the stack starts a new chain. Clear MetaMask's activity and
   nonce data after each one (**Settings → Advanced → Clear activity tab data**),
   or its transactions fail with nonce errors. Also delete the dapp's saved
   registration progress (Chrome DevTools → **Application → Local Storage →
   http://localhost:3000**, key `registration-status`), or a name you registered
   before the restart opens on its old "Congratulations" screen.

## What to test

### Search (homepage)

- Type a name like `myname` in the search bar — it should auto-complete to `myname.testing` (`myname.simplex` on `.simplex`)
- Search for a 6+ character name → should show as **Available**
- Search for a 5-character name like `short` → should show as unavailable (min char length is 6)

### Registration flow

> Ignore the warning `Error syncing data`. It only appears on hardhat local testing

1. Search for an available 6+ char name (e.g., `testname`)
2. Click to register → `.testing` is free (gas only); `.simplex` costs $10/year, which the local oracle's $1/ETH makes about 20 ETH for the two-year minimum
3. **Commit** transaction → confirm in MetaMask
4. Wait 60 seconds (commit-reveal delay)
5. **Register** transaction → confirm in MetaMask, pay ETH
6. Name should appear in **My Names**

### NFT gate (`.testing` only)

- Account #0 (deployer) holds NFT #0 — registration should work
- Import account #1 (`0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d`) — has no NFT, registration should fail with `NftRequired`

### Profile / text records

1. After registering a name, go to its profile
2. Edit records → set `simplex.contact` and `simplex.channel` text records
3. Save → confirm transaction
4. Reload → records should persist

### Transfer (offer and claim)

1. As the holder (account #0), open the name → **Ownership** → **Send**, enter
   account #1's address and confirm the offer. Nothing moves yet: the name page
   shows **Offer pending** with **Withdraw offer**.
2. Switch MetaMask to account #1, open the name's page → **Review and claim**.
3. The claim screen lists the name's resolver, records and subnames. Optionally
   switch on **Clear records**, tick the acknowledgement, then **Claim**.
4. The name, its registry node and its subnames now belong to account #1.

### Admin panel

1. Go to http://localhost:3000/admin (must be connected as account #0 = deployer = owner)
2. Should show: controller address, owner, min char length (6), NFT gate (enabled)
3. **Lower min char length**: set to 5 → confirm tx → now 5-char names are registrable
4. **Reserve a name**: type `simplex` → click Reserve → confirm tx → trying to register `simplex.testing` should fail
5. **Unreserve**: unreserve `simplex` → now it's registrable again
6. **Register reserved**: reserve a name, then use "Register Reserved Name" to assign it to a specific address
7. **Disable NFT gate**: click → confirm → now any account can register (one-way, can't re-enable)

#### Lowering the minimum character length

At launch, only names of 6 characters or longer can be registered. The
contract owner can lower this limit over time as the namespace matures —
typically 6 → 5 → 4 → 3 — to ration out shorter, more desirable names.

To lower it from the UI:

1. Connect the deployer (admin) wallet and open http://localhost:3000/admin.
2. In the **Min Character Length** card, type the new minimum (lower than the
   current value) into the input.
3. Click **Set** and confirm the `setMinCharLength` transaction in MetaMask.
4. The status line reports `setMinCharLength confirmed`, then "Min char length"
   re-reads as the new value.
5. Search for a name shorter than the previous floor — the **"Min N chars"**
   tag disappears, the result shows **Available**, and the registration flow
   proceeds normally.

The change is **monotonic — strictly decreasing**. The contract reverts with
`MinCharLengthCanOnlyDecrease` if you submit a value greater than or equal
to the current minimum, so once a length tier opens it cannot be re-closed.

## Managing the set of registered names

Two distinct lifecycles change the on-chain registry: the **genesis state**
baked in by the deploy script, and **post-launch** owner-only operations
exposed through `SimplexController`. The admin panel
(`http://localhost:3000/admin`) is a thin wrapper over the post-launch
functions; you can call the same functions from a script or block explorer if
you prefer.

### Pre-deployment (genesis state)

Before the controller is renounced or handed off, every `.testing` /
`.simplex` deployment can be seeded with names in two ways. Edit
[`scripts/deploy-local.mjs`](./scripts/deploy-local.mjs) (or a copy adapted
for testnet / mainnet) and add the calls below at the end of `main()`, after
`controller` and `publicResolver` are deployed:

1. **Pre-reserve names** — prevents them from being publicly registered. Use
   for trademarks, official SimpleX names, abuse-prone words, or anything you
   want to hand-assign later. `addReservedNames` takes a string array and
   reserves all entries in a single transaction; pass a one-element array to
   reserve a single name. The block gas limit comfortably holds ~1000 names
   per call.

   ```js
   await write(controller, 'addReservedNames', [
     ['simplex', 'admin', 'support', 'help'],
   ])
   ```

2. **Pre-register a reserved name to a known address** — calls
   `registerReserved(label, owner, duration)` which bypasses the public gate
   checks (length, NFT, even the reserved-name check itself). Use for
   handing out names to founders, partners, or a community multisig before
   the public phase.

   ```js
   const oneYear = 31536000n
   await write(controller, 'registerReserved', ['simplex', officialOwner, oneYear])
   ```

After running the modified deploy script the controller starts in the desired
state — `addReservedNames` produces one entry per label in `reservedNames`,
`registerReserved` mints the BaseRegistrar ERC-721 to the chosen owner.

### Post-launch (admin operations)

After deployment the same calls are still available, just gated to the
controller owner. The admin panel exposes them as separate cards:

| What you want                                | Admin-panel card             | Underlying call                              |
|---------------------------------------------|------------------------------|----------------------------------------------|
| Block names from public registration        | **Reserve name(s)**          | `addReservedNames([label, …])`               |
| Restore names to public registration        | **Unreserve name(s)**        | `removeReservedNames([label, …])`            |
| Check whether a name is currently reserved  | **Check Reserved**           | `reservedNames(keccak256(label))` (read-only)|
| Assign a reserved name to a specific address | **Register Reserved Name**  | `registerReserved(label, owner, duration)`   |

Step-by-step (from the UI):

1. Connect the deployer/owner wallet and open `/admin`.
2. **To reserve** (one or many at once): type bare labels (e.g. `simplex`,
   not `simplex.testing`) in the **Reserve name(s)** input — newline- or
   comma-separated for batches — → **Reserve** → confirm tx. Any subsequent
   public `register()` for any of those labels reverts with `NameReserved`.
   The block gas limit comfortably holds ~1000 names per call.
3. **To unreserve**: type the same labels in the **Unreserve name(s)**
   input → **Unreserve** → confirm tx. They go back in the public pool.
4. **To assign**: fill **Register Reserved Name** with the label, the
   recipient address, and a duration in days. Click **Register**, confirm
   the tx, and the recipient becomes the owner of the BaseRegistrar NFT for
   that labelhash. This works whether or not the name was previously
   reserved — the function bypasses every gate including length, NFT, and
   reserved-name checks.

All four operations require the connected wallet to be `controller.owner()`.
Once the SimpleX namespace is mature you can renounce ownership (`Ownable`
inherits the standard OpenZeppelin pattern) to remove the admin's ability
to mutate this set further; from that point only public registrations and
expiries change the set.

### Verifying the on-chain state

Without a subgraph, the source of truth is the chain. Two quick checks:

- **Was a name reserved?** Read `reservedNames(keccak256("label"))` on the
  `SimplexNamePolicy` — returns the reason, `0` if not reserved.
- **Who owns a name?** Read `ownerOf(uint256(keccak256("label")))` on the
  BaseRegistrar — reverts if the name is unregistered or expired.

The contract addresses are written to `deployments.local.json` after each
local deploy; use that file (or the equivalent for testnet/mainnet) to
target the right contracts.

## Known limitations

- **No subgraph**: The ENS app uses The Graph for name queries. Without a local subgraph, some features (name list, search suggestions) may not work fully. Direct contract interactions (registration, profile editing) work.
- **Avatar/images disabled**: Avatar upload and display are intentionally hidden.
- **DNS features disabled**: DNS import page returns blank.
- **Logo placeholder**: SimpleX logo SVGs are text placeholders — replace with real brand assets.
