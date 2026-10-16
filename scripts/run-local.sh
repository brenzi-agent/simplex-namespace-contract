#!/bin/bash
set -e

cd "$(dirname "$0")/.."

TLD="${SIMPLEX_TLD:-testing}"

for PORT in 8545 3000; do
  if (echo > /dev/tcp/127.0.0.1/$PORT) 2>/dev/null; then
    echo "ERROR: port $PORT is already in use; stop the process listening there first"
    exit 1
  fi
done

echo "=== Starting Hardhat node ==="
(cd ens-contracts && npx hardhat --network hardhat node) &
NODE_PID=$!
sleep 4

echo "=== Deploying .${TLD} contracts ==="
DEPLOY_OUTPUT=$(SIMPLEX_TLD="$TLD" node scripts/deploy-local.mjs 2>&1)
echo "$DEPLOY_OUTPUT" | grep -v "^$"

ADDRS=$(echo "$DEPLOY_OUTPUT" | grep "^NEXT_PUBLIC_DEPLOYMENT_ADDRESSES=" | sed "s/^NEXT_PUBLIC_DEPLOYMENT_ADDRESSES=//")
if [ -z "$ADDRS" ]; then
  echo "ERROR: Failed to extract deployment addresses"
  kill $NODE_PID 2>/dev/null
  exit 1
fi

echo ""
echo "=== Starting frontend ==="
cd ens-app-v3
# Pin the chain to localhost inline: `next dev` otherwise reads
# NEXT_PUBLIC_CHAIN_NAME=mainnet from .env.development.local and targets mainnet.
# Inline vars override .env files, and clearing .next forces fresh inlining of
# the per-run deployment addresses.
rm -rf .next
NEXT_PUBLIC_DEPLOYMENT_ADDRESSES="$ADDRS" \
NEXT_PUBLIC_CHAIN_NAME=localhost \
NEXT_PUBLIC_PROVIDER=http://127.0.0.1:8545 \
NEXT_PUBLIC_SIMPLEX_TLD="$TLD" \
exec pnpm dev
