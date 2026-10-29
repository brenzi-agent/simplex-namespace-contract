#!/bin/bash
set -e

cd "$(dirname "$0")/.."

TLD="${SIMPLEX_TLD:-testing}"

for PORT in 8545 3000 8097; do
  if (echo > /dev/tcp/127.0.0.1/$PORT) 2>/dev/null; then
    echo "ERROR: port $PORT is already in use; stop the process listening there first"
    exit 1
  fi
done

echo "=== Starting the terms server ==="
node scripts/serve-terms.mjs &
TERMS_PID=$!
trap 'kill $TERMS_PID 2>/dev/null' EXIT

echo "=== Starting Hardhat node ==="
(cd ens-contracts && exec ./node_modules/.bin/hardhat --network hardhat node) &
NODE_PID=$!
until (echo > /dev/tcp/127.0.0.1/8545) 2>/dev/null; do
  kill -0 $NODE_PID 2>/dev/null || { echo "ERROR: Hardhat node exited"; exit 1; }
  sleep 1
done

echo "=== Deploying .${TLD} contracts ==="
DEPLOY_OUTPUT=$(SIMPLEX_TLD="$TLD" node scripts/deploy-local.mjs 2>&1) || true
echo "$DEPLOY_OUTPUT" | grep -v "^$"

ADDRS=$(echo "$DEPLOY_OUTPUT" | grep "^NEXT_PUBLIC_DEPLOYMENT_ADDRESSES=" | sed "s/^NEXT_PUBLIC_DEPLOYMENT_ADDRESSES=//")
if [ -z "$ADDRS" ]; then
  echo "ERROR: Failed to extract deployment addresses"
  kill $NODE_PID 2>/dev/null
  exit 1
fi

# Hardhat mines only when a transaction arrives, so chain time would stand still
# after a registration commit; a block every 5 s lets the commitment mature.
curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"evm_setIntervalMining","params":[5000]}' \
  http://127.0.0.1:8545 > /dev/null

echo ""
echo "=== Starting frontend ==="
if [ "$TLD" = simplex ]; then cd simplex-app; else cd testing-app; fi
# Pin the chain to localhost inline: `next dev` otherwise reads
# NEXT_PUBLIC_CHAIN_NAME=mainnet from .env.development.local and targets mainnet.
# Inline vars override .env files, and clearing .next forces fresh inlining of
# the per-run deployment addresses.
rm -rf .next
NEXT_PUBLIC_DEPLOYMENT_ADDRESSES="$ADDRS" \
NEXT_PUBLIC_CHAIN_NAME=localhost \
NEXT_PUBLIC_PROVIDER=http://127.0.0.1:8545 \
NEXT_PUBLIC_SIMPLEX_TLD="$TLD" \
pnpm dev
