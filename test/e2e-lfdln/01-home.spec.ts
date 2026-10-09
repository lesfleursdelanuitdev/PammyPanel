// lfdln's Home and menu (docs/lfdln-standup-plan.md L1): only what phases 5 and 6 bring.
import { expect, test } from './fixtures.ts';

test('Home greets the admin, and the menu has only Home, Hosts, Services, File Explorer and its tags, Monitoring, the visitors\' pages and the account pages', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Home · lesfleursdelanuit.com panel');
  await expect(page.getByRole('heading', { name: /, momolig$/, level: 1 })).toBeVisible();
  await expect(page.getByText('The panel for lesfleursdelanuit.com on this server.')).toBeVisible();
  await page.getByRole('button', { name: 'Open the menu' }).click();
  const menu = page.getByRole('dialog', { name: /lesfleursdelanuit\.com panel/ });
  // exactly these, in this order: nothing of a module that is off here
  await expect(menu.getByRole('navigation', { name: 'Sections' }).getByRole('link')).toHaveText(['Home', 'Responses', 'Comments', 'Requests', 'Hosts', 'Services', 'Projects', 'File Explorer', 'File tags', 'Tags & categories', 'Monitoring', 'Media', 'Make media folders', 'Forms', 'Your databases', 'Database users', 'People', 'Email', 'Visitors', 'Backups', 'API keys', 'Passkeys & devices', 'Accounts', 'Activity', 'Help']);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(page.getByTestId('stat-hosts-on')).toHaveText('0');
  await expect(page.getByText('No hosts yet. Make one on the Hosts page.')).toBeVisible();
  // its signing in is in Activity, on Home too
  await expect(page.getByRole('list', { name: 'Recent activity' })).toContainText('momolig');
});

test('a page of a module that is off here is not a page: back to Home', async ({ page }) => {
  // (Installed software is pammy.org's only, P8-11)
  await page.goto('/software');
  await expect(page).toHaveURL('/');
  const r = await page.request.get('/api/software');
  expect(r.status()).toBe(404);
});

test('the pages are plainly technical: "admin", not "account manager"', async ({ page }) => {
  await page.goto('/accounts');
  await expect(page.getByRole('heading', { name: 'Accounts', level: 1 })).toBeVisible();
  await expect(page.getByText(/admin/).first()).toBeVisible();
  await expect(page.getByText(/account manager/i)).toHaveCount(0);
});
