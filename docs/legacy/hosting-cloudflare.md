# dApp hosting — Cloudflare Pages (alternative / superseded)

> **Not the canonical host.** The mainnet `.testing` dApp is deployed via
> **GitHub Pages** (`testing-names.simplex.chat`) — see
> [`deployment.md` → dApp hosting](./deployment.md#dapp-hosting). This Cloudflare
> Pages setup is kept as a documented alternative (it can still mirror the same
> static export). Do not treat it as the primary deployment.

---

## dApp on Cloudflare Pages

The dApp is built as a static SPA and served from
[`simplex-namespace-contract.pages.dev`](https://simplex-namespace-contract.pages.dev/).
Cloudflare watches the GitHub repo and rebuilds on every push.

### One-time setup

1. In the Cloudflare dashboard → **Workers & Pages** → **Create** →
   **Pages** → **Connect to Git**, pick the `simplex-namespace-contract`
   repo. Important: pick **Pages**, not Workers — the newer unified UI
   defaults to Workers, which uses `wrangler deploy` instead of
   `wrangler pages deploy` and fails with a permissions error against a
   Pages project name.
2. Build configuration:
   - **Build command**: `bash scripts/cloudflare-build.sh`
   - **Build output directory**: read from `wrangler.toml`
     (`pages_build_output_dir = "./out"`) — the newer
     dashboard no longer surfaces this field, but `wrangler.toml`
     supersedes it.
   - **Root directory**: empty.
3. Environment variables (Settings → Environment variables, Production):
   - `NODE_VERSION=22`
   - `NEXT_PUBLIC_CHAIN_NAME=sepolia` (or `mainnet` once that deploy lands)
   - `NEXT_PUBLIC_SIMPLEX_TLD=testing` (or `simplex`)
   - `NEXT_PUBLIC_IPFS=1`
4. Commit `deployments.sepolia.json` (and later
   `deployments.mainnet.${tld}.json`) to the repo root. The build script
   reads the file at build time with a node one-liner and injects its
   contents into `NEXT_PUBLIC_SEPOLIA_DEPLOYMENT_ADDRESSES` — there's
   nothing to paste into the dashboard for the address bundle.
5. `.gitmodules` must use **HTTPS** URLs for the two ENS forks, not SSH.
   Cloudflare's build runner has no SSH key; `git@github.com:…` clones
   fail at submodule init.
6. (Optional) Custom domain: Settings → Custom domains → add yours; add
   the corresponding DNS record at your registrar. The Cloudflare-pinned
   `og:image` URL in `src/pages/index.tsx` hardcodes the `pages.dev`
   host — swap to the custom domain at the same time to keep social
   previews resolving.

### What the build does

The Cloudflare-side build runs `scripts/cloudflare-build.sh`, which is
the canonical entry point — edit it (not the dashboard build command) to
change build steps. In order:

1. `git submodule update --init --recursive` — defensive, in case
   Cloudflare's submodule-init step is disabled. `.gitmodules` must
   resolve over HTTPS.
2. `export YARN_ENABLE_IMMUTABLE_INSTALLS=false` — a pnpm-installed git
   dep (`clones-with-immutable-args`) runs `yarn install` as its
   `prepare` step. Corepack upgrades yarn to 4.x, which defaults to
   immutable mode when `CI=true` (Cloudflare sets this) and refuses to
   migrate the embedded lockfile.
3. `corepack enable`.
4. `pnpm install --frozen-lockfile` in the parent.
5. `pnpm install --frozen-lockfile && npx hardhat compile` in
   `ens-contracts/` — the frontend reads ABIs from
   `ens-contracts/artifacts/`.
6. `pnpm install --no-frozen-lockfile --prefer-frozen-lockfile` in
   `ens-app-v3/` — `pnpm@10.x` validates patch-file content hashes
   against the lockfile and rejects `--frozen-lockfile` if any of the
   ~10 patched-dependency hashes drift. `--prefer-frozen-lockfile` keeps
   the lockfile authoritative for versions while allowing the patch
   hashes to refresh in place.
7. Inline the addresses + run the static export:
   ```sh
   export NEXT_PUBLIC_SEPOLIA_DEPLOYMENT_ADDRESSES="$(node -e ...read deployments.sepolia.json...)"
   pnpm build && pnpm export
   ```
   `jq` is not preinstalled on the Cloudflare build image — the script
   uses a node one-liner to minify the JSON, which is guaranteed available.
8. The script copies `testing-app/out/` to `out/`, and Cloudflare deploys
   `out/` to the Pages project. The
   `wrangler.toml`'s `pages_build_output_dir` tells the deploy step
   where to look.

### The `.simplex` staging project

A second Pages project on the same repo builds `simplex-app`:

- **Build command**: `bash scripts/cloudflare-build-simplex.sh`
- **Production branch**: `main`; **Preview branches**: None
- **Build output directory**: `out`, from `wrangler.toml`, as for `.testing`

The script initialises only `simplex-app`, sets `NEXT_PUBLIC_CHAIN_NAME=mainnet`,
`NEXT_PUBLIC_SIMPLEX_TLD=simplex` and the addresses from
`deployments.mainnet.simplex.json` itself, builds the static export and copies it
to `out/`. Dashboard variables do not reach the build shell while `wrangler.toml`
is present, so the script sets every value. The deployed dApp is the
`simplex-app` commit pinned on `main`.

### Routing on a static host

Next.js `rewrites()` in `next.config.mjs` are server-side only and
don't survive `next export`. To make path-based URLs like
`/foobar.testing` and `/foobar.testing/register` work on Cloudflare
Pages, the rewrites are mirrored in `ens-app-v3/public/_redirects`
using Netlify-compatible syntax (which Cloudflare also supports). The
file is copied into `ens-app-v3/out/` by `next export` and Cloudflare
honours it for edge rewrites.

Two caveats:

- **No regex constraints on path placeholders.** Next.js's
  `/:address(0x[a-fA-F0-9]{40}$)` → `/address?address=:address` rule
  can't be expressed in `_redirects`, so the implicit `0x…` profile
  shortcut is dropped. If you need it, route through `/address/0x…`
  explicitly.
- **Order matters.** First match wins. Multi-segment rules
  (`/:name/register`, `/tld/:tld`, etc.) come before the catch-all
  `/:name`. Real static pages (`/admin`, `/import`, `/register`, etc.)
  resolve to their `.html` files because Cloudflare checks static files
  before `_redirects`.

### Limitations

- **No server-side data fetching.** Anything that relied on
  `getServerSideProps` would fail the export step — there is no such
  code in our diff today; revisit if upstream ENS adds one.
- **Deployment freshness.** The address bundle is baked in at build
  time. Re-running `scripts/deploy-testnet.mjs` (or
  `scripts/deploy-mainnet.mjs`) only takes effect after the new
  `deployments.${network}.json` is committed and pushed.
- **Custom-domain icon swap.** If you add a custom domain, update the
  hardcoded `og:image` URL in `src/pages/index.tsx` so social previews
  resolve against the new host.

