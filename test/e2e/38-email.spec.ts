// Email (docs/apps-plan.md phase 3), in a browser: the key put in once (with
// the passkey), never shown again; the two test emails; which notices. The
// mail service is real (test/e2e/server.ts), with Resend stood in for.
import { expect, notice, test } from './fixtures.ts';

test('set up mail, send the two tests, choose the notices', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open the menu' }).click();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Email' }).click();
  await expect(page).toHaveURL('/email');
  await expect(page.getByText('not set up')).toBeVisible();
  await expect(page.getByText('No Resend key has been set.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'From the panel' })).toBeDisabled();

  // the key, once; the addresses start as decided (M1, M3)
  await expect(page.getByLabel('Sent from')).toHaveValue('noreply@mail.lesfleursdelanuit.com');
  await expect(page.getByLabel('Notices go to')).toHaveValue('hello@pammy.org');
  await page.getByLabel('Resend API key').fill('re_E2eOnlyTestKey_4242');
  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect(notice(page)).toHaveText('Saved. Send yourself a test to be sure.');
  await expect(page.getByText('ready', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Resend API key')).toHaveValue('');
  await expect(page.getByText(/The key in use ends in 4242/)).toBeVisible();
  expect(await page.content()).not.toContain('re_E2eOnlyTestKey_4242');

  await page.getByRole('button', { name: 'From the panel' }).click();
  await expect(notice(page)).toHaveText('Sent to hello@pammy.org.');
  await page.getByRole('button', { name: /^From WordPress/ }).first().click();
  await expect(notice(page)).toHaveText('WordPress sent it to hello@pammy.org.');

  // the notices: a form and requests, kept when the page is opened again
  const form = page.getByRole('group', { name: 'New responses to' }).getByRole('checkbox').first();
  await form.check();
  await page.getByRole('checkbox', { name: /Someone asks to be let in/ }).check();
  await page.getByRole('button', { name: 'Save' }).nth(1).click();
  await expect(notice(page)).toHaveText('Saved.');
  await page.reload();
  await expect(page.getByRole('group', { name: 'New responses to' }).getByRole('checkbox').first()).toBeChecked();
  await expect(page.getByRole('checkbox', { name: /Someone asks to be let in/ })).toBeChecked();

  await page.goto('/activity');
  await expect(page.getByText(/changed how email is sent \(a new key, ending 4242\)/)).toBeVisible();
  await expect(page.getByText(/sent a test email to hello@pammy\.org \(from WordPress \(blog\)\)/)).toBeVisible();
});
