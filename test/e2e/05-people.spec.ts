import { confirmDialog, expect, notice, row, test } from './fixtures.ts';

test('add a person with a setup link, edit, switch off and on, set a password, remove', async ({ page }) => {
  await page.goto('/people');
  await page.getByLabel('Username').fill('cousin.al');
  await page.getByLabel('Name (only you see it)').fill('Cousin Al');
  await page.getByLabel('How to reach them (only you see it)').fill('al@example.com');
  await page.getByRole('checkbox', { name: 'family' }).first().click();
  await page.getByRole('button', { name: 'Add person' }).click();
  await expect(notice(page)).toHaveText('cousin.al was added. Send them the setup link below.');
  const creds = page.getByTestId('credentials');
  await expect(creds).toContainText('Send this link to Cousin Al privately (al@example.com). With it they choose their password.');
  await creds.getByRole('button', { name: 'Copy link' }).click();
  await expect(notice(page)).toHaveText('Link copied.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^https:\/\/pammy\.org\/_pammy\/invite#\S{43}$/);
  await creds.getByRole('button', { name: 'Done' }).click();

  const al = row(page, 'cousin.al');
  await expect(al).toContainText("hasn't chosen a password yet");
  await expect(al).toContainText('contact: al@example.com');
  await expect(al.getByRole('checkbox', { name: 'family' })).toBeChecked();

  await al.getByRole('button', { name: 'Edit' }).click();
  await confirmDialog(page).getByLabel('Name (only you see it)').fill('Cousin Alan');
  await confirmDialog(page).getByRole('button', { name: 'Next' }).click();
  await expect(confirmDialog(page).getByLabel('A phone number or email (only you see it)')).toHaveValue('al@example.com');
  await confirmDialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(notice(page)).toHaveText('Saved.');
  await expect(al).toContainText('Cousin Alan');

  await al.getByRole('button', { name: 'Switch off' }).click();
  await confirmDialog(page).getByRole('button', { name: 'Switch off' }).click();
  await expect(notice(page)).toHaveText('cousin.al is switched off.');
  await expect(al.getByText('switched off', { exact: true }).first()).toBeVisible();
  await al.getByRole('button', { name: 'Switch on' }).click();
  await expect(notice(page)).toHaveText('cousin.al is switched on.');

  await al.getByRole('button', { name: 'Set a password' }).click();
  await expect(confirmDialog(page).getByLabel('Password (at least 10 characters)')).toHaveValue(/^\S{19}$/);
  await confirmDialog(page).getByRole('button', { name: 'Set password' }).click();
  await expect(notice(page)).toHaveText('Password changed.');
  await expect(page.getByTestId('credentials')).toContainText('Username: cousin.al');
  await expect(page.getByTestId('credentials')).toContainText('Sign in at: https://pammy.org/family/');

  await al.getByRole('button', { name: 'Remove' }).click();
  await confirmDialog(page).getByRole('button', { name: 'Remove' }).click();
  await expect(notice(page)).toHaveText('cousin.al was removed.');
  await expect(al).toBeHidden();
});
