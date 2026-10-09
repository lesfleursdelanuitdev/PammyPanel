import { expect, notice, row, test } from './fixtures.ts';

test('approve a request for access, and make a new link for a forgotten password', async ({ page }) => {
  await page.goto('/requests');
  const rose = row(page, 'Rose Smith wants to open "family"');
  await expect(rose).toContainText('contact: rose@example.com');
  await expect(rose).toContainText('It is Rose, your cousin!');
  await rose.getByText('Approve…').click();
  await expect(rose.getByRole('textbox', { name: 'Username' })).toHaveValue('rose.smith');
  await rose.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(notice(page)).toHaveText('rose.smith can open "family" once they choose a password. Send them the link below.');
  await expect(page.getByTestId('credentials')).toContainText('Send this link to Rose Smith privately (rose@example.com)');
  await expect(rose).toBeHidden();

  const jo = row(page, 'forgot their password');
  await expect(jo).toContainText('Auntie Jo (auntie.jo)');
  await expect(jo).toContainText('I forgot it again');
  await jo.getByRole('button', { name: 'Make a new link' }).click();
  await expect(notice(page)).toHaveText('New setup link made for auntie.jo. Their old password keeps working until they use the link.');
  await expect(page.getByTestId('credentials')).toContainText('With it they choose a new password.');
  await expect(page.getByRole('list', { name: 'Waiting requests' })).toHaveText('No requests waiting.');

  await page.getByText('Dealt with in the last 30 days').click();
  await expect(page.getByText('Rose Smith asked to open "family"')).toBeVisible();
  await expect(page.getByText(/approved by pamela/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open the menu' }).getByTestId('menu-dot')).toBeVisible();   // messages still unread
});
