import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  testMatch: 'auth-live.spec.ts',
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:8080',
    ...devices['Desktop Chrome'],
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
  },
  webServer: {
    command:
      'cargo test --locked -p atelier-app --test browser_harness -- --ignored --nocapture',
    cwd: '../../services/api',
    url: 'http://127.0.0.1:8080/api/v1/health',
    timeout: 240000,
    reuseExistingServer: false,
    env: { TEST_AUTH_HARNESS: '1' },
  },
});
