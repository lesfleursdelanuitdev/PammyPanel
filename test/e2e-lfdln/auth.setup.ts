import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { addAuthenticator, watchForProblems } from './fixtures.ts';
import { STATE } from './playwright.config.ts';

// The first admin uses the setup link the command line gave (docs/lfdln-standup-plan.md L5).
test('the first admin sets up a passkey and is signed in', async ({ page }) => {
  const problems = watchForProblems(page);
  const { cdp, authenticatorId } = await addAuthenticator(page, false);
  const { token } = JSON.parse(readFileSync(`${STATE}invite.json`, 'utf8'));

  await page.goto(`/invite#${token}`);
  await expect(page.getByRole('heading', { name: 'Hello, momolig' })).toBeVisible();
  await expect(page).toHaveTitle('Set up your passkey · lesfleursdelanuit.com panel');
  await page.getByLabel('Name this passkey').fill('e2e device');
  await page.getByRole('button', { name: 'Create passkey' }).click();
  await expect(page).toHaveURL('/passkeys');

  const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  expect(credentials).toHaveLength(1);
  writeFileSync(`${STATE}credential.json`, JSON.stringify(credentials[0]));
  await page.context().storageState({ path: `${STATE}auth.json` });
  expect(problems).toEqual([]);
});
