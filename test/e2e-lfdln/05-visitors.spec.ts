// Visitors on lfdln (docs/roles-plan.md step 6): People, Requests and Settings > Visitors in
// the menu, and a route's accounts on the Hosts page with its Access page. The gate is the
// real one (its admin door, over the same throwaway database); there is no mail here.
import { confirmDialog, expect, notice, row, test } from './fixtures.ts';

test('People, Requests and the visitor settings are in the menu, every switch off', async ({ page }) => {
  await page.goto('/visitor-settings');
  await expect(page.getByRole('heading', { name: 'Visitor settings' })).toBeVisible();
  const list = page.getByRole('list', { name: 'Visitor settings' });
  for (const name of ['Emailed links', 'People can register themselves', '"Open with accounts" areas']) {
    await expect(list.getByRole('switch', { name, exact: true })).not.toBeChecked();
    await expect(list.getByRole('switch', { name, exact: true })).toBeDisabled();
  }
  await expect(list.getByText("Mail isn't set up for visitors on this site.")).toHaveCount(1);
  await page.goto('/people');
  await expect(page.getByRole('heading', { name: 'People', level: 1 })).toBeVisible();
  // the list loads (it once asked for protected folders, which lfdln hasn't: "Request failed")
  await expect(page.getByRole('list', { name: 'People' })).toBeVisible();
  await page.getByLabel('Username').fill('lf.person');
  await page.getByText("I'll set it now").click();
  await page.getByLabel('Password', { exact: true }).fill('a-long-enough-pass-9');
  await page.getByRole('button', { name: 'Add person' }).click();
  await expect(page.getByTestId('credentials')).toContainText('Username: lf.person');
  await expect(row(page, 'lf.person')).toBeVisible();
  // no folders to tick: roles are given on each route's Access page
  await expect(page.getByText('Can open', { exact: true })).toHaveCount(0);
  await page.goto('/requests');
  await expect(page.getByRole('heading', { name: 'Requests', level: 1 })).toBeVisible();
  // no protected folders here: lfdln's accounts are on routes
  await page.goto('/protected-folders');
  await expect(page).toHaveURL('/');
});

test("a route's accounts: Only people let in, its Access page, and open to anyone again", async ({ page }) => {
  await page.goto('/hosts');
  const add = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Add a static folder' }) }).first();
  await add.getByLabel('Name').fill('club');
  await add.getByRole('button', { name: 'Add folder' }).click();
  await expect(notice(page)).toContainText('Made. https://club.lesfleursdelanuit.com/ shows it now.');
  const routes = page.getByRole('list', { name: 'Routes of club' });
  const accounts = routes.getByLabel('Accounts');
  await expect(accounts).toHaveValue('none');
  // "Open with accounts" waits for its switch
  await expect(accounts.locator('option[value="open"]')).toBeDisabled();
  await accounts.selectOption('private');
  await expect(notice(page)).toContainText('/: only people let in.');
  await routes.getByRole('link', { name: 'Who may use it' }).click();
  await expect(page.getByRole('heading', { name: 'Access to club.lesfleursdelanuit.com/', level: 1 })).toBeVisible();
  await expect(page.getByText('Who may do what at this address.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Roles and privileges are switched off' })).toBeVisible();
  // a reload is a page of the panel too
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Access to club.lesfleursdelanuit.com/', level: 1 })).toBeVisible();
  await page.getByRole('link', { name: 'Hosts' }).first().click();
  await expect(page).toHaveURL('/hosts');
  // nothing with accounts is deleted by accident
  await row(page, /^club/).first().getByRole('button', { name: 'Delete' }).first().click();
  await confirmDialog(page).getByRole('button', { name: 'Delete' }).click();
  await expect(notice(page, 'error')).toContainText('has accounts: set it to "Open to anyone" first');
  await routes.getByLabel('Accounts').selectOption('none');
  await confirmDialog(page).getByRole('button', { name: 'Open to anyone' }).click();
  await expect(notice(page)).toContainText('/: open to anyone.');
  await expect(routes.getByRole('link', { name: 'Who may use it' })).toHaveCount(0);
});
