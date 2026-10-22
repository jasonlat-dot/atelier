import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';
const baseURL = process.env.TEST_AUTH_BASE_URL || 'http://127.0.0.1:8080';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(baseURL))
  throw new Error('Test authentication harness must use loopback HTTP');
export default defineConfig({
  testDir: './tests',
  testMatch: 'auth-live.spec.ts',
  workers: 1,
  use: {
    baseURL,
    ...devices['Desktop Chrome'],
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
  },
  webServer: {
    command:
      'cargo test --locked -p atelier-app --test browser_harness -- --ignored --nocapture',
    cwd: '../../services/api',
    url: `${baseURL}/api/v1/health`,
    timeout: 240000,
    reuseExistingServer: false,
    env: {
      TEST_AUTH_HARNESS: '1',
      TEST_AUTH_PORT: new URL(baseURL).port,
      TEST_UPSTREAM_ORIGIN_FILE: resolve(
        import.meta.dirname,
        'test-results/upstream-origin.txt',
      ),
    },
  },
});
