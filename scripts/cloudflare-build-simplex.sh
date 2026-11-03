#!/usr/bin/env bash
set -euo pipefail

git submodule update --init simplex-app

export NEXT_PUBLIC_CHAIN_NAME=mainnet
export NEXT_PUBLIC_SIMPLEX_TLD=simplex
NEXT_PUBLIC_MAINNET_DEPLOYMENT_ADDRESSES="$(node -e "process.stdout.write(JSON.stringify(JSON.parse(require('fs').readFileSync('deployments.mainnet.simplex.json','utf8'))))")"
export NEXT_PUBLIC_MAINNET_DEPLOYMENT_ADDRESSES

corepack enable

(
  cd simplex-app
  pnpm install --no-frozen-lockfile --prefer-frozen-lockfile
  pnpm build
  pnpm export
)

rm -rf out
cp -r simplex-app/out out
