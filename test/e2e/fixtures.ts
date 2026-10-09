import { readFileSync } from 'node:fs';
import { expect, test as base, type Page } from '@playwright/test';
import { STATE } from './playwright.config.ts';

// A passkey on this "device": Chrome's virtual authenticator, holding the
// credential auth.setup.ts made (or a new, empty one).
export async function addAuthenticator(page: Page, withCredential = true) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  if (withCredential) {
    const credential = JSON.parse(readFileSync(`${STATE}credential.json`, 'utf8'));
    await cdp.send('WebAuthn.addCredential', { authenticatorId, credential });
  }
  return { cdp, authenticatorId };
}

// Every test fails on a Content-Security-Policy violation, an error in the
// console or an uncaught exception.
export function watchForProblems(page: Page) {
  const problems: string[] = [];
  // (a refused API call is logged by the browser too; those are the app's business)
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) problems.push(`console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 400 && !new URL(r.url()).pathname.startsWith('/api/')) problems.push(`${r.status()} ${r.url()}`); });
  page.on('pageerror', (e) => problems.push(`page error: ${e.stack ?? e.message}`));
  void page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}:${e.columnNumber} ${e.sample}`);
    });
  });
  return problems;
}

export const test = base.extend<{ problems: string[] }>({
  page: async ({ page }, use) => {
    await addAuthenticator(page);
    await use(page);
  },
  problems: [async ({ page }, use) => {
    const problems = watchForProblems(page);
    await use(problems);
    expect(problems, 'no console errors or CSP violations').toEqual([]);
  }, { auto: true }],
});

export { expect };

export const notice = (page: Page, kind: 'ok' | 'error' = 'ok') => page.locator(`[data-kind="${kind}"]`);
export const row = (page: Page, text: string | RegExp) => page.getByRole('listitem').filter({ hasText: text });
export const confirmDialog = (page: Page) => page.getByRole('alertdialog');
