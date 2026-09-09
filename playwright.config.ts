import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 7_000 },
  outputDir: './output/playwright/results',
  reporter: [['list'], ['html', { outputFolder: './output/playwright/report', open: 'never' }]],
  globalTeardown: './scripts/e2e-server.mjs',
  use: {
    baseURL: 'http://127.0.0.1:3137',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `"${process.execPath}" scripts/e2e-server.mjs`,
    url: 'http://127.0.0.1:3137/api/auth/status',
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
  },
});
