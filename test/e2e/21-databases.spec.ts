// Your databases (docs/databases-plan.md 5), in a browser. The engines are stood
// in for by test/e2e/server.ts; what is real here is the page: the three kinds of
// card, the name rules as she types them, and that deleting asks for the name.
import { confirmDialog, expect, notice, test } from './fixtures.ts';

const mine = (page: import('@playwright/test').Page) => page.getByRole('list', { name: 'Your databases' });
const hers = (page: import('@playwright/test').Page) => page.getByRole('list', { name: 'Databases you made yourself' });

test('make a database, name its app, and delete it', async ({ page }) => {
  await page.goto('/databases');
  await expect(page.getByRole('heading', { name: 'Your databases', level: 1 })).toBeVisible();
  await expect(mine(page)).toContainText('None yet');

  await page.getByRole('button', { name: 'New database' }).click();
  await page.getByLabel('Name').fill('cake_orders');
  await page.getByLabel('What the app will be called').fill('Cake orders');
  await page.getByRole('button', { name: 'Make the database' }).click();
  await expect(notice(page)).toContainText('cake_orders is ready.');

  const card = mine(page).getByRole('listitem').filter({ hasText: 'cake_orders' });
  await expect(card).toContainText('Cake orders');
  await expect(card).toContainText('Postgres');

  // the app name is hers to change, and to clear
  await card.getByRole('button', { name: 'App name' }).click();
  const ask = page.getByRole('alertdialog');
  await ask.getByRole('textbox').fill('Orders');
  await ask.getByRole('button', { name: 'Save' }).click();
  await expect(notice(page)).toHaveText('Saved.');
  await expect(card).toContainText('Orders');

  // deleting needs the name typed out, and the wrong name deletes nothing
  await card.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('everything in it');
  await page.getByRole('alertdialog').getByRole('textbox').fill('cake_order');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete it' }).click();
  await expect(notice(page, 'error')).toContainText('not the same name');
  await expect(card).toBeVisible();

  await card.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('alertdialog').getByRole('textbox').fill('cake_orders');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete it' }).click();
  await expect(notice(page)).toContainText('cake_orders is gone.');
  await expect(card).toBeHidden();
});

test('a name the database would not take is explained, not accepted', async ({ page }) => {
  await page.goto('/databases');
  await page.getByRole('button', { name: 'New database' }).click();
  await page.getByLabel('Name').fill('My Recipes');
  await page.getByRole('button', { name: 'Make the database' }).click();
  await expect(notice(page, 'error')).toContainText('lowercase');
  await expect(mine(page)).toContainText('None yet');
});

test('databases she made herself can be picked up, and the servers own are left alone', async ({ page }) => {
  await page.goto('/databases');
  // family_recipes is on her Postgres but the panel does not look after it yet
  const theirs = hers(page).getByRole('listitem').filter({ hasText: 'family_recipes' });
  await expect(theirs).toBeVisible();
  await theirs.getByRole('button', { name: 'Look after this one' }).click();
  await expect(notice(page)).toContainText('looking after family_recipes now');
  await expect(mine(page).getByRole('listitem').filter({ hasText: 'family_recipes' })).toBeVisible();

  // hers from the start: workable, but never deleted from here
  const pamela = hers(page).getByRole('listitem').filter({ hasText: /^pamela/ }).first();
  await expect(pamela).toContainText('came with your account');
  await expect(pamela.getByRole('button', { name: 'Delete' })).toHaveCount(0);

  // the engines' own are one quiet line, not cards
  await expect(page.getByText(/Each server keeps a few databases of its own/)).toContainText('postgres');
  await expect(mine(page)).not.toContainText('mysql');

  // and stopping leaves the database alone
  const card = mine(page).getByRole('listitem').filter({ hasText: 'family_recipes' });
  await card.getByRole('button', { name: 'Stop looking after' }).click();
  await expect(confirmDialog(page)).toContainText('stays exactly as it is');
  await confirmDialog(page).getByRole('button', { name: 'Stop looking after it' }).click();
  await expect(notice(page)).toContainText('no longer on this page');
  await expect(hers(page).getByRole('listitem').filter({ hasText: 'family_recipes' })).toBeVisible();
});
