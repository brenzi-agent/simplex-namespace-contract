import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { HttpRequestError } from 'viem'
import { REPO_ROOT, causes, childEnv, git, uncommitted } from './stack.mjs'

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

test('the committed-inputs guard names an untracked input and passes a committed one', () => {
  const name = `uncommitted-input-${process.pid}.csv`
  writeFileSync(join(REPO_ROOT, name), '')
  try {
    assert.equal(uncommitted([name, 'governance.mainnet.json']), `?? ${name}`)
  } finally {
    rmSync(join(REPO_ROOT, name))
  }
})

test('a top-level error prints its short message and its causes, without the URL of the request', () => {
  const error = new HttpRequestError({
    url: 'https://rpc.example/v2/secret-token', status: 403, body: { method: 'eth_getLogs' }, cause: new TypeError('fetch failed'),
  })
  assert.ok(error.message.includes('secret-token'))
  assert.deepEqual(causes(error), ['HttpRequestError: HTTP request failed.', 'TypeError: fetch failed'])
})
