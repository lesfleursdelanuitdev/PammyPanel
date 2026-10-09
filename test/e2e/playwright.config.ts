// Browser tests of the whole panel: npm run e2e (build.sh runs them).
// Headless Chromium with a virtual passkey authenticator, against
// test/e2e/server.ts (a throwaway website and databases on localhost:3199).
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const STATE = fileURLToPath(new URL('./.state/', import.meta.url));
const PORT = 3199;

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
    // The same phone tests in Safari's engine, as an iPhone (docs/rich-text-plan.md,
    // "On a phone"). Off unless PAMMY_E2E_WEBKIT=1: WebKit needs ~110 system
    // packages this server does not have (sudo npx playwright install-deps webkit).
    // WebKit has no clipboard permissions to grant, hence the empty list.
    ...(process.env.PAMMY_E2E_WEBKIT === '1' ? [{
      name: 'iphone', dependencies: ['desktop'], testMatch: /phone\.spec\.ts$/,
      use: { ...devices['iPhone 15'], permissions: [], storageState: `${STATE}auth.json` },
    }] : []),
  ],
  webServer: {
    command: 'node --disable-warning=ExperimentalWarning test/e2e/server.ts',
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
