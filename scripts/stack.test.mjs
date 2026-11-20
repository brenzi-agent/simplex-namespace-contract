import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REPO_ROOT, childEnv, git } from './stack.mjs'

const withDeployerKey = (check) => {
  process.env.DEPLOYER_KEY = '0x01'
  try {
    check()
  } finally {
    delete process.env.DEPLOYER_KEY
  }
}

test('git runs with the PATH of the calling process and without its DEPLOYER_KEY', () => withDeployerKey(() => {
  const variables = git(REPO_ROOT, '-c', 'alias.environment=!env', 'environment').split('\n')
    .map((line) => line.slice(0, line.indexOf('=')))
  assert.ok(variables.includes('PATH'), variables.join(', '))
  assert.ok(!variables.includes('DEPLOYER_KEY'), variables.join(', '))
}))

test('a child process receives PATH, HOME and the variables named for it only', () => withDeployerKey(() => {
  assert.deepEqual(Object.keys(childEnv({ MAINNET_RPC_URL: 'https://rpc.example' })).sort(), ['HOME', 'MAINNET_RPC_URL', 'PATH'])
}))
