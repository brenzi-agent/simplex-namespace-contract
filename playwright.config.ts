import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './test/e2e',
  timeout: 180_000,
  retries: 0,
  workers: 1,
  reporter: [['html', { open: 'never' }]],
  projects: [
    {
      name: 'simplex',
      testMatch: 'simplex-flow.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // .simplex TLD flows. Requires the stack started with
      // `SIMPLEX_TLD=simplex ./scripts/run-local.sh`.
      name: 'simplex-tld',
      testMatch: 'simplex-tld-flow.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Read-only smoke tests against the live Sepolia deployment. Selected
      // by `npx playwright test --project=sepolia`. Requires the dApp to be
      // built+served with NEXT_PUBLIC_CHAIN_NAME=sepolia + the matching
      // NEXT_PUBLIC_SEPOLIA_DEPLOYMENT_ADDRESSES, plus a Sepolia-funded
      // test wallet in env.
      name: 'sepolia',
      testMatch: 'sepolia-readonly.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },
})
