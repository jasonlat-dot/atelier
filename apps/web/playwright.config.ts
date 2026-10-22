import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  testMatch: 'mock-baseline.spec.ts',
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    ...devices['Desktop Chrome'],
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
  },
  webServer: {
    command: 'npm run dev -- --mode mock-preview',
    cwd: import.meta.dirname,
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: false,
  },
});
