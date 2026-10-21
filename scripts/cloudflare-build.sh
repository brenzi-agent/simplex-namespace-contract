#!/usr/bin/env bash
# Cloudflare Pages build entry-point.
# Configure in the dashboard:
#   Build command:        bash scripts/cloudflare-build.sh
#   Build output dir:     testing-app/out
#   Submodules:           CF_PAGES_SUBMODULES=true (or this script pulls them)
#
# Required env vars (set in Cloudflare → Settings → Environment variables):
#   NODE_VERSION=22
#   NEXT_PUBLIC_CHAIN_NAME=sepolia    # or 'mainnet'
#   NEXT_PUBLIC_SIMPLEX_TLD=testing   # or 'simplex' (mainnet only, once deployed)
#   NEXT_PUBLIC_IPFS=1
#
# Optional:
#   NEXT_PUBLIC_MAINNET_RPC_URL=https://… — point the dApp at a private
#       mainnet RPC (e.g. Reth behind Caddy). Default uses DRPC + Tenderly.
set -euo pipefail

# ====== load committed defaults ======
# Cloudflare's "Variables and Secrets" panel does not reliably propagate
# into the build shell on Build System version 3 — when that path fails,
# fall back to the values committed in `testing-app/.env.production`. Next
# auto-loads that file too, so the inlined client-side values stay in
# sync with what the bash case statement below reads.
ENV_FILE="testing-app/.env.production"
if [ -f "$ENV_FILE" ]; then
  # `set -a` exports every assignment from the sourced file. Skip comments
  # and blanks so the read is robust against the file's commentary.
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  echo "Loaded defaults from $ENV_FILE"
fi

# ====== build-shell env probe ======
# Print the env vars this script ACTUALLY sees. Compare against what the
# Cloudflare dashboard claims is configured — if a variable shows here as
# "(unset)" but appears in the dashboard, the var was set at the wrong
# scope (Runtime instead of Build, or wrong Production/Preview filter, or
# encrypted-only). This block is intentionally noisy so it survives any
# Cloudflare log filtering.
echo "===== Build-shell env probe ====="
echo "NEXT_PUBLIC_CHAIN_NAME           = '${NEXT_PUBLIC_CHAIN_NAME:-(unset)}'"
echo "NEXT_PUBLIC_SIMPLEX_TLD          = '${NEXT_PUBLIC_SIMPLEX_TLD:-(unset)}'"
echo "NEXT_PUBLIC_MAINNET_RPC_URL      = '${NEXT_PUBLIC_MAINNET_RPC_URL:-(unset)}'"
echo "NODE_VERSION                     = '${NODE_VERSION:-(unset)}'"
echo "CF_PAGES                         = '${CF_PAGES:-(unset)}'"
echo "CF_PAGES_BRANCH                  = '${CF_PAGES_BRANCH:-(unset)}'"
echo "CI                               = '${CI:-(unset)}'"
echo "All NEXT_PUBLIC_* + NODE_* in shell:"
env | grep -E '^(NEXT_PUBLIC_|NODE_)' || echo "  (none — env vars are NOT reaching this shell)"
echo "================================="

# Belt + braces: make sure submodules are populated even if Cloudflare's
# submodule-checkout step is disabled.
git submodule update --init --recursive

# A pnpm-installed git dep (`clones-with-immutable-args`) runs its `prepare`
# step via yarn. Corepack picks yarn 4.x; yarn 4 enables immutable mode by
# default when `CI=true` (which Cloudflare Pages sets), then refuses because
# migrating the lockfile would mutate it. Override that just for this build.
export YARN_ENABLE_IMMUTABLE_INSTALLS=false

corepack enable

pnpm install --frozen-lockfile

(
  cd ens-contracts
  pnpm install --frozen-lockfile
  npx hardhat compile
)

(
  cd testing-app
  # testing-app pins `packageManager: pnpm@10.23.0` and uses 10 patched
  # dependencies. pnpm 10.23 validates patch-file content hashes against the
  # lockfile and rejects --frozen-lockfile if any patch file's hash drifted.
  # Use the lockfile as the resolution source but allow patch hashes to
  # refresh in place — no actual dependency-version changes happen.
  pnpm install --no-frozen-lockfile --prefer-frozen-lockfile

  # Bake the deployment addresses into the static export. Read the file
  # that matches NEXT_PUBLIC_CHAIN_NAME, then export the corresponding
  # NEXT_PUBLIC_*_DEPLOYMENT_ADDRESSES variable that `src/constants/chains.ts`
  # reads at build time. `jq` isn't preinstalled on Cloudflare's build
  # image; use node to minify the JSON.
  CHAIN="${NEXT_PUBLIC_CHAIN_NAME:-sepolia}"
  TLD="${NEXT_PUBLIC_SIMPLEX_TLD:-testing}"
  echo "Cloudflare build env: NEXT_PUBLIC_CHAIN_NAME='${NEXT_PUBLIC_CHAIN_NAME:-(unset → defaulting to sepolia)}', NEXT_PUBLIC_SIMPLEX_TLD='${NEXT_PUBLIC_SIMPLEX_TLD:-(unset → defaulting to testing)}'"
  case "$CHAIN" in
    mainnet)
      ADDR_FILE="../deployments.mainnet.${TLD}.json"
      ADDR_VAR=NEXT_PUBLIC_MAINNET_DEPLOYMENT_ADDRESSES
      ;;
    sepolia)
      # Sepolia's deployment file isn't TLD-suffixed (one TLD per Sepolia run).
      ADDR_FILE="../deployments.sepolia.json"
      ADDR_VAR=NEXT_PUBLIC_SEPOLIA_DEPLOYMENT_ADDRESSES
      ;;
    *)
      echo "ERROR: NEXT_PUBLIC_CHAIN_NAME=$CHAIN is not supported (use 'mainnet' or 'sepolia')." >&2
      exit 1
      ;;
  esac
  if [ ! -f "$ADDR_FILE" ]; then
    echo "ERROR: address file $ADDR_FILE not found. Commit the deploy script's output first." >&2
    exit 1
  fi
  export "$ADDR_VAR=$(node -e "process.stdout.write(JSON.stringify(JSON.parse(require('fs').readFileSync('$ADDR_FILE','utf8'))))")"
  echo "Baking $ADDR_VAR from $ADDR_FILE (chain=$CHAIN, tld=$TLD)"

  pnpm build
  pnpm export
)
