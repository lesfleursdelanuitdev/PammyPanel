// Browser tests of lfdln's panel (docs/lfdln-standup-plan.md L9): npm run e2e:lfdln
// (build.sh runs them). Headless Chromium with a virtual passkey authenticator, against
// test/e2e-lfdln/server.ts (throwaway site folders, nginx stood in for, on localhost:3299).
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const STATE = fileURLToPath(new URL('./.state/', import.meta.url));
const PORT = 3299;

export default defineConfig({
  testDir: '.',
  outputDir: `${STATE}results`,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  workers: 1,                 // one server, one set of data: the tests take turns
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    permissions: ['clipboard-read', 'clipboard-write'],
    locale: 'en-GB',
    timezoneId: 'Europe/London',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    { name: 'desktop', dependencies: ['setup'], testMatch: /\.spec\.ts$/, testIgnore: /phone\.spec\.ts$/, use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 }, storageState: `${STATE}auth.json` } },
    { name: 'phone', dependencies: ['desktop'], testMatch: /phone\.spec\.ts$/, use: { ...devices['Pixel 7'], storageState: `${STATE}auth.json` } },
  ],
  webServer: {
    command: 'node --disable-warning=ExperimentalWarning test/e2e-lfdln/server.ts',
    cwd: root,
    url: `http://localhost:${PORT}/healthz`,
    reuseExistingServer: false,
    env: { PAMMY_E2E_PORT: String(PORT), PAMMY_E2E_STATE: STATE },
    stdout: process.env.PAMMY_E2E_LOG ? 'pipe' : 'ignore',
    stderr: 'pipe',
    // SIGTERM, not the default SIGKILL: the server removes its Postgres test container on the way out
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
  },
});
