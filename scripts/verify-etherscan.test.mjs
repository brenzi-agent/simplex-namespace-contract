import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ARTIFACT = 'contracts/simplex/SimplexSponsor.sol/SimplexSponsor.json'
const ZERO = '0x0000000000000000000000000000000000000000'
const SPONSOR = '0x000000000000000000000000000000000000bEEF'

function verifyEtherscan(contracts) {
  const root = mkdtempSync(join(tmpdir(), 'verify-etherscan-'))
  try {
    mkdirSync(join(root, 'scripts'))
    copyFileSync(join(REPO_ROOT, 'scripts', 'verify-etherscan.mjs'), join(root, 'scripts', 'verify-etherscan.mjs'))
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'))
    mkdirSync(join(root, 'ens-contracts', 'artifacts', dirname(ARTIFACT)), { recursive: true })
    writeFileSync(join(root, 'ens-contracts', 'artifacts', ARTIFACT), JSON.stringify({ buildInfoId: 'local' }))
    writeFileSync(join(root, 'verification.mainnet.simplex.json'), JSON.stringify({ contracts }))
    return spawnSync(process.execPath, [join(root, 'scripts', 'verify-etherscan.mjs')], {
      env: { PATH: process.env.PATH, ETHERSCAN_API_KEY: 'unused', NETWORK: 'mainnet', SIMPLEX_TLD: 'simplex' },
      encoding: 'utf8',
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('an entry built from another commit is skipped, counted and named in the summary', () => {
  const { status, stdout } = verifyEtherscan({
    'SimplexSponsor@0xbeef': { address: SPONSOR, artifact: ARTIFACT, constructorArgs: '0x', buildInfoId: 'old', ensContractsCommit: 'c0ffee' },
    NameWrapper: { address: ZERO, artifact: 'contracts/wrapper/NameWrapper.sol/NameWrapper.json', constructorArgs: '0x' },
  })
  assert.equal(status, 0)
  assert.match(stdout, /skipped: built as old from ens-contracts c0ffee, and the local artifact is local/)
  assert.deepEqual(stdout.trimEnd().split('\n').slice(-2), [
    '0 verified, 1 skipped (built from ens-contracts c0ffee).',
    'Not all contracts verified: run this again from a compiled checkout of each commit above.',
  ])
})

test('an entry that is not deployed is neither verified nor skipped', () => {
  const { status, stdout } = verifyEtherscan({
    NameWrapper: { address: ZERO, artifact: 'contracts/wrapper/NameWrapper.sol/NameWrapper.json', constructorArgs: '0x' },
  })
  assert.equal(status, 0)
  assert.deepEqual(stdout.trimEnd().split('\n').slice(-2), ['0 verified, 0 skipped.', 'All contracts verified.'])
})
