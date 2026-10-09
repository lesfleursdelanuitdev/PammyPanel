// Accounts on lfdln (docs/permissions-plan.md R5, H9): a place is a host. A person kept
// to one host sees and changes only its routes, and can't make hosts or folders.
import { expect, test } from './fixtures.ts';
import { addAuthenticator } from './fixtures.ts';

test('an account kept to one host sees only that host', async ({ browser }) => {
  const r = await fetch('http://127.0.0.1:3298/kept/docs', { method: 'POST' });
  const { token } = await r.json() as { token: string };
  const context = await browser.newContext();
  const page = await context.newPage();
  await addAuthenticator(page, false);
  await page.goto(`/invite#${token}`);
  await page.getByLabel('Name this passkey').fill('ericka phone');
  await page.getByRole('button', { name: 'Create passkey' }).click();
  await expect(page).toHaveURL('/passkeys');

  await page.goto('/');
  await expect(page.getByTestId('limited-to')).toContainText('You look after docs');
  await page.getByRole('button', { name: 'Open the menu' }).click();
  await expect(page.getByRole('dialog').getByRole('navigation', { name: 'Sections' }).getByRole('link')).toHaveText(['Home', 'Hosts', 'Passkeys & devices', 'Activity', 'Help']);
  await page.keyboard.press('Escape');

  await page.goto('/hosts');
  await expect(page.getByRole('list', { name: 'Hosts' })).toContainText('docs');
  await expect(page.getByRole('heading', { name: 'Add a static folder' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Add a host' })).toHaveCount(0);
  await context.close();
});

test('the admin sees her on Accounts, kept to the host docs', async ({ page }) => {
  await page.goto('/accounts');
  await expect(page.getByText('Ericka').first()).toBeVisible();
  await expect(page.getByText(/docs/).first()).toBeVisible();
});

test("the parts to give are lfdln's: Visitors, not Protected folders, and no Subdomains", async ({ page }) => {
  await page.goto('/accounts');
  const add = page.getByRole('region', { name: 'Add an account' }).or(page.locator('section', { has: page.getByRole('heading', { name: 'Add an account' }) }));
  await expect(add.getByText('Visitors', { exact: true })).toBeVisible();
  await expect(add.getByText("People and Requests: the visitors' accounts on the sites")).toBeVisible();
  await expect(add.getByText('Protected folders', { exact: true })).toHaveCount(0);
  await expect(add.getByText('Subdomains', { exact: true })).toHaveCount(0);
  await expect(add.getByText(/examples/)).toHaveCount(0);
});
