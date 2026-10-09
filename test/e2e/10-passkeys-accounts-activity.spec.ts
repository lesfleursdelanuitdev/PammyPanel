import { confirmDialog, expect, notice, row, test } from './fixtures.ts';

test('passkeys: rename, and this device already has one', async ({ page }) => {
  await page.goto('/passkeys');
  const pk = page.getByRole('list', { name: 'Your passkeys' }).getByRole('listitem');
  await expect(pk).toContainText('e2e device');
  await expect(pk).toContainText('signed in with this');
  await pk.getByRole('button', { name: 'Rename' }).click();
  await confirmDialog(page).getByLabel('New name').fill('Laptop');
  await confirmDialog(page).getByRole('button', { name: 'Rename' }).click();
  await expect(notice(page)).toHaveText('Renamed.');
  await expect(pk).toContainText('Laptop');

  await page.getByLabel('Add a passkey on this device').fill('Again');
  await page.getByRole('button', { name: 'Add passkey' }).click();
  await expect(notice(page, 'error')).toHaveText('This device already has a passkey for this account.');

  await expect(page.getByRole('list', { name: "Where you're signed in" })).toContainText('this browser');
});

test('accounts: add one, make and cancel a setup link, switch it off', async ({ page }) => {
  await page.goto('/accounts');
  await expect(row(page, 'Pamela (pamela)')).toContainText('account manager');
  await page.getByLabel('Username').fill('momo');
  await page.getByLabel('Name', { exact: true }).fill('Momo');
  // what they can use, chosen with the account (docs/permissions-plan.md R6)
  await page.getByRole('checkbox', { name: /^Forms/ }).check();
  await page.getByRole('checkbox', { name: /^Responses/ }).check();
  await page.getByRole('button', { name: 'Add account' }).click();
  await expect(notice(page)).toHaveText('Account added. Now create a setup link so Momo can add a passkey.');
  const momo = row(page, 'Momo (momo)');
  await expect(momo).toContainText('Forms, Responses');
  await momo.getByRole('button', { name: 'Create setup link' }).click();
  await expect(momo).toContainText('Send this to Momo privately.');
  await expect(momo).toContainText(/http:\/\/localhost:3199\/invite#\S+/);
  await expect(momo).toContainText('setup link open until');
  await momo.getByRole('button', { name: 'Cancel link' }).click();
  await expect(notice(page)).toHaveText('Setup link cancelled.');
  await momo.getByRole('button', { name: 'Switch off' }).click();
  await confirmDialog(page).getByRole('button', { name: 'Switch off' }).click();
  await expect(notice(page)).toHaveText('Account switched off.');
  await expect(momo).toContainText('switched off');
});

test('activity says what happened, in words', async ({ page }) => {
  await page.goto('/activity');
  const list = page.getByRole('list', { name: 'Activity' });
  await expect(list).toContainText('pamela switched off the account momo');
  await expect(list).toContainText('pamela changed what momo can use (forms: on, responses: on)');
  await expect(list).toContainText('pamela uploaded recipes/media/images/lemon-cake.png');
  await expect(list).toContainText('pamela made the form "olivias-form"');
  await expect(list).toContainText('pamela approved a response to "sample-contact-form"');
  await expect(list).toContainText('pamela made the API key "Olivia\'s website"');
  await expect(list).toContainText('pamela created the subdomain cakes');
  await expect(list.locator('time').first()).toHaveAttribute('datetime', /^\d{4}-\d\d-\d\dT/);
});
