import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  testMatch: [
    'session-settings.spec.ts',
    'wallet.spec.ts',
    'workspace.spec.ts',
    'assets.spec.ts',
    'upstream.spec.ts',
  ],
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    ...devices['Desktop Chrome'],
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
  },
  webServer: {
    command: 'npm run dev -- --mode production',
    cwd: import.meta.dirname,
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: false,
  },
});
