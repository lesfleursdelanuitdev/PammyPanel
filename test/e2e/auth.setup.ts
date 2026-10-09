import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { addAuthenticator, watchForProblems } from './fixtures.ts';
import { STATE } from './playwright.config.ts';

// The account manager uses their setup link: a passkey is made, and they're signed in.
test('a setup link makes a passkey and signs in', async ({ page }) => {
  const problems = watchForProblems(page);
  const { cdp, authenticatorId } = await addAuthenticator(page, false);
  const { token } = JSON.parse(readFileSync(`${STATE}invite.json`, 'utf8'));

  await page.goto('/invite');
  await expect(page.getByRole('heading', { name: "This link doesn't work" })).toBeVisible();

  await page.goto(`/invite#${token}`);
  await expect(page.getByRole('heading', { name: 'Hello, Pamela' })).toBeVisible();
  await expect(page).toHaveTitle('Set up your passkey · pammy.org panel');
  await page.getByLabel('Name this passkey').fill('e2e device');
  await page.getByRole('button', { name: 'Create passkey' }).click();
  await expect(page).toHaveURL('/passkeys');
  await expect(page.getByRole('heading', { name: 'Passkeys & devices', level: 1 })).toBeVisible();

  const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  expect(credentials).toHaveLength(1);
  writeFileSync(`${STATE}credential.json`, JSON.stringify(credentials[0]));
  await page.context().storageState({ path: `${STATE}auth.json` });

  // the link is used up
  await page.goto(`/invite#${token}`);
  await expect(page.getByRole('heading', { name: "This link doesn't work" })).toBeVisible();
  expect(problems).toEqual([]);
});
