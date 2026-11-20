import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pad } from 'viem'
import { verificationFile } from './build-verification.mjs'
import {
  ADDRESSES_PATH, ERC1967_ADMIN_SLOT, IMMUTABLE, UPGRADEABLE, VERIFICATION_PATH, artifact, ensContractsHead, parentHead,
  proxyAdminOf,
} from './stack.mjs'

const ADMIN_SAFE = '0xf38920389740E46A7f4160DaF1672f3df2754Df4'
const DEPLOYER = '0x0000000000000000000000000000000000001234'
const REPLACEMENT = '0x0000000000000000000000000000000000000099'
const at = (n) => `0x${n.toString(16).padStart(40, '0')}`

const names = Object.keys(UPGRADEABLE)
const addresses = {
  ...Object.fromEntries(names.map((name, i) => [UPGRADEABLE[name].key, at(i + 1)])),
  ...Object.fromEntries(Object.keys(IMMUTABLE).map((name, i) => [name, at(i + 0x100)])),
  DummyOracle: at(0x200),
}
const runOneImplementations = new Map(names.map((name, i) => [addresses[UPGRADEABLE[name].key], at(i + 0x10)]))
const codeAt = new Map(names.map((name) =>
  [runOneImplementations.get(addresses[UPGRADEABLE[name].key]), artifact(UPGRADEABLE[name].artifact).deployedBytecode]))
const chain = (implementations = runOneImplementations) => ({
  getStorageAt: async ({ address, slot }) => pad(slot === ERC1967_ADMIN_SLOT ? proxyAdminOf(address) : implementations.get(address)),
  getCode: async ({ address }) => codeAt.get(address),
})
const inputs = {
  addresses,
  exists: false,
  journal: names.map((name) => ({ step: `deploy:${name}`, address: runOneImplementations.get(addresses[UPGRADEABLE[name].key]) })),
  deployer: DEPLOYER,
  adminSafe: ADMIN_SAFE,
}

test('a missing addresses file is refused', async () => {
  assert.deepEqual(await verificationFile(chain(), { ...inputs, addresses: undefined }),
    { refused: true, failures: [`${ADDRESSES_PATH} not found.`] })
})

test('an existing verification file is refused', async () => {
  assert.deepEqual(await verificationFile(chain(), { ...inputs, exists: true }), {
    refused: true,
    failures: [`${VERIFICATION_PATH} exists, and it records every implementation since run 1; it is not rebuilt.`],
  })
})

test('a proxy that runs an implementation other than the one run 1 deployed is refused', async () => {
  const upgraded = new Map(runOneImplementations).set(addresses.ENSRegistry, REPLACEMENT)
  assert.deepEqual(await verificationFile(chain(upgraded), inputs), {
    refused: true,
    failures: [`the ENSRegistry proxy runs ${REPLACEMENT}, not the implementation run 1 deployed.`],
  })
})

test('a missing deployer is refused', async () => {
  assert.deepEqual(await verificationFile(chain(), { ...inputs, deployer: undefined }), {
    refused: true,
    failures: ['deployer address not provided and no journal available to look it up. ' +
      'Set DEPLOYER=0x… (the EOA that ran deploy-mainnet.mjs).'],
  })
})

test('the file is built when every proxy runs the implementation run 1 deployed', async () => {
  const built = await verificationFile(chain(), inputs)
  assert.equal(built.refused, false)
  assert.equal(built.meta.deployer, DEPLOYER)
  assert.deepEqual(Object.keys(built.meta.contracts).sort(), [
    ...names.flatMap((name) => [`${name}@${runOneImplementations.get(addresses[UPGRADEABLE[name].key])}`, `${name}Proxy`, `${name}ProxyAdmin`]),
    ...Object.keys(IMMUTABLE),
  ].sort())
  assert.ok(Object.values(built.meta.contracts).every(({ ensContractsCommit, parentCommit }) =>
    ensContractsCommit === ensContractsHead() && parentCommit === parentHead()))
})
