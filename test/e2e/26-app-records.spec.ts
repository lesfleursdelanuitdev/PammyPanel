// The generated app in a browser (docs/databases-plan.md 11.6-11.8): switching
// it on, the DataViewer, and the form. The engines are stood in for by
// test/e2e/server.ts, which holds a few recipes in memory.
//
// The claim this file exists to prove is the one that matters most in the whole
// studio: **she did not build these pages.** She ticked a table and they were
// there, showing her own words.
import { confirmDialog, expect, notice, test } from './fixtures.ts';

const rows = (page: import('@playwright/test').Page) => page.getByRole('list', { name: 'Recipes' });

const app = async (page: import('@playwright/test').Page) => {
  await page.goto('/databases');
  await expect(page.getByRole('list', { name: 'Your databases' })).toBeVisible();
  const adopt = page.getByRole('listitem').filter({ hasText: 'family_recipes' })
    .getByRole('button', { name: 'Look after this one' });
  if (await adopt.count()) {
    await adopt.first().click();
    await expect(notice(page)).toContainText('looking after family_recipes');
  }
  await page.goto('/databases/postgres/family_recipes/app');
  await expect(page.getByRole('list', { name: 'Managed' })).toBeVisible();
};

// switched on, so the records pages exist. Needs a passkey just now, which the
// browser tests' virtual authenticator gives without a prompt.
const activate = async (page: import('@playwright/test').Page) => {
  await app(page);
  const on = page.getByRole('button', { name: 'Switch the app on' });
  if (await on.count()) {
    await on.click();
    await expect(notice(page)).toContainText('is switched on');
  }
};

test('switching the app on puts her things in the menu', async ({ page }) => {
  await activate(page);
  await page.getByRole('button', { name: 'Open the menu' }).click();
  // the group is named after the app, one item per thing it manages
  await expect(page.getByRole('link', { name: 'Recipes', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Recipes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Recipes', level: 1 })).toBeVisible();
});

test('the list shows her records in her words, and she did not build it', async ({ page }) => {
  await activate(page);
  await page.goto('/app/postgres/family_recipes/recipes');
  await expect(page.getByRole('heading', { name: 'Recipes', level: 1 })).toBeVisible();
  await expect(page.getByText('3 recipes')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Sunday roast' })).toBeVisible();
  // the column heading is the field's label, not its column name
  await expect(page.getByRole('columnheader', { name: /Title/ })).toBeVisible();
  // and cards are the same records, the other way up
  await page.getByRole('button', { name: 'Show cards' }).click();
  await expect(rows(page)).toContainText('Sunday roast');
  await page.getByRole('button', { name: 'Show a table' }).click();
});

test('she adds one, changes it, and deletes it', async ({ page }) => {
  await activate(page);
  await page.goto('/app/postgres/family_recipes/recipes');
  await page.getByRole('link', { name: /New Recipe/ }).click();
  await expect(page.getByRole('heading', { name: 'New Recipe', level: 1 })).toBeVisible();
  await page.getByLabel('Title').fill('Bread and butter pudding');
  await page.getByLabel('Servings').fill('5');
  await page.getByRole('button', { name: /Add this Recipe/ }).click();
  await expect(notice(page)).toContainText('Recipe added.');
  await expect(page.getByRole('cell', { name: 'Bread and butter pudding' })).toBeVisible();

  const row = page.getByRole('row').filter({ hasText: 'Bread and butter pudding' });
  await row.getByRole('link', { name: 'Change' }).click();
  await expect(page.getByLabel('Title')).toHaveValue('Bread and butter pudding');
  await page.getByLabel('Title').fill('Bread pudding');
  await page.getByRole('button', { name: 'Save the changes' }).click();
  await expect(notice(page)).toContainText('Saved.');
  await expect(page.getByRole('cell', { name: 'Bread pudding' })).toBeVisible();

  await page.getByRole('row').filter({ hasText: 'Bread pudding' }).getByRole('button', { name: 'Delete' }).click();
  await confirmDialog(page).getByRole('button', { name: 'Delete it' }).click();
  await expect(notice(page)).toContainText('is gone.');
  await expect(page.getByRole('cell', { name: 'Bread pudding' })).toHaveCount(0);
});

test('a field she hides is not on the list or the form', async ({ page }) => {
  await activate(page);
  await page.goto('/databases/postgres/family_recipes/app/recipes');
  const servings = page.getByRole('list', { name: 'Fields' }).getByRole('listitem').filter({ hasText: 'servings' });
  await servings.getByRole('switch', { name: /^Show / }).click();
  await expect(notice(page)).toContainText('Saved.');

  await page.goto('/app/postgres/family_recipes/recipes');
  await expect(page.getByRole('columnheader', { name: /Servings/ })).toHaveCount(0);
  await page.goto('/app/postgres/family_recipes/recipes/new');
  await expect(page.getByLabel('Servings')).toHaveCount(0);
  await expect(page.getByLabel('Title')).toBeVisible();

  // put it back for the next test
  await page.goto('/databases/postgres/family_recipes/app/recipes');
  await page.getByRole('list', { name: 'Fields' }).getByRole('listitem').filter({ hasText: 'servings' })
    .getByRole('switch', { name: /^Show / }).click();
  await expect(notice(page)).toContainText('Saved.');
});

test('switching what people may do changes the pages', async ({ page }) => {
  await activate(page);
  await page.goto('/databases/postgres/family_recipes/app/recipes');
  await page.getByRole('switch', { name: 'Add new ones' }).click();
  await expect(notice(page)).toContainText('Saved.');

  await page.goto('/app/postgres/family_recipes/recipes');
  await expect(page.getByRole('link', { name: /New Recipe/ })).toHaveCount(0);

  await page.goto('/databases/postgres/family_recipes/app/recipes');
  await page.getByRole('switch', { name: 'Add new ones' }).click();
  await expect(notice(page)).toContainText('Saved.');
  await page.goto('/app/postgres/family_recipes/recipes');
  await expect(page.getByRole('link', { name: /New Recipe/ })).toBeVisible();
});

test('switching the app off takes the pages away and leaves the data', async ({ page }) => {
  await activate(page);
  await page.goto('/databases/postgres/family_recipes/app');
  await page.getByRole('button', { name: 'Switch the app off' }).click();
  await confirmDialog(page).getByRole('button', { name: 'Switch it off' }).click();
  await expect(notice(page)).toContainText('is switched off');

  // the menu group is gone...
  await page.getByRole('button', { name: 'Open the menu' }).click();
  await expect(page.getByRole('link', { name: 'Recipes', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // ...and switching it on again finds her records exactly where they were
  await page.getByRole('button', { name: 'Switch the app on' }).click();
  await expect(notice(page)).toContainText('is switched on');
  await page.goto('/app/postgres/family_recipes/recipes');
  await expect(page.getByText('3 recipes')).toBeVisible();
});
