import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  outputDir: 'test-results',
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:3101',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    serviceWorkers: 'block',
  },
  projects: [{ name: 'chromium', use: {
    ...devices['Desktop Chrome'],
    // Optional fallback to an installed Chromium-based Chrome when browser downloads are unavailable.
    channel: process.env.PLAYWRIGHT_CHANNEL === 'chrome' ? 'chrome' : undefined,
    viewport: { width: 1440, height: 1000 },
  } }],
  webServer: {
    command: 'tsx tests/fixture-server.ts',
    url: 'http://127.0.0.1:3101/api/workspace',
    reuseExistingServer: false,
    timeout: 120_000,
    env: { OPENAI_API_KEY: '', OPENAI_MODEL: 'e2e-cloud-model', OLLAMA_MODEL: 'e2e-local-model' },
  },
})