// The Application tab in a browser (docs/databases-plan.md 11). The engines are
// stood in for by test/e2e/server.ts; what is real here is the distinction the
// whole slice exists to make -- a table is how something is kept, a Resource is
// what it means -- and that nothing on these pages touches her database.
import { confirmDialog, expect, notice, test } from './fixtures.ts';

const managed = (page: import('@playwright/test').Page) => page.getByRole('list', { name: 'Managed' });
const leftOut = (page: import('@playwright/test').Page) => page.getByRole('list', { name: 'Left out' });
const fields = (page: import('@playwright/test').Page) => page.getByRole('list', { name: 'Fields' });

const open = async (page: import('@playwright/test').Page) => {
  await page.goto('/databases');
  await expect(page.getByRole('list', { name: 'Your databases' })).toBeVisible();
  const adopt = page.getByRole('listitem').filter({ hasText: 'family_recipes' })
    .getByRole('button', { name: 'Look after this one' });
  if (await adopt.count()) {
    await adopt.first().click();
    await expect(notice(page)).toContainText('looking after family_recipes');
  }
  await page.goto('/databases/postgres/family_recipes/app');
  await expect(managed(page)).toBeVisible();
};

// Neighbours in this suite apply tables of their own (22 applies `guests`), so
// nothing here may assume family_recipes holds only `recipes`, and nothing may
// assume the drawing is empty when this file starts.
const noDrawing = async (page: import('@playwright/test').Page) => {
  await page.goto('/databases/postgres/family_recipes');
  await expect(page.getByRole('list', { name: 'Tables' })).toBeVisible();
  const throwAway = page.getByRole('button', { name: 'Throw them away' });
  if (await throwAway.count()) {
    await throwAway.click();
    await confirmDialog(page).getByRole('button', { name: 'Throw it away' }).click();
    await expect(notice(page)).toContainText('Back to what the database really has.');
  }
  await expect(page.getByText('Not applied yet')).toBeHidden();
};

// leave her words as this file found them
const startAgain = async (page: import('@playwright/test').Page, table: string) => {
  await page.goto(`/databases/postgres/family_recipes/app/${table}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Start again' }).click();
  await confirmDialog(page).getByRole('button', { name: 'Start it again' }).click();
  await expect(notice(page)).toContainText('Back to what the panel works out.');
};

test('the panel guesses what her tables are, and says it is guessing', async ({ page }) => {
  await open(page);
  const recipes = managed(page).getByRole('listitem').filter({ hasText: 'Recipes' });
  await expect(recipes).toBeVisible();
  await expect(recipes).toContainText("the panel's guess");
  await expect(recipes).toContainText('one is a Recipe');
  // named by something she can read, never the id
  await expect(recipes).toContainText('named by title');
});

test('a table she leaves out stops being part of the app, and can come back', async ({ page }) => {
  await open(page);
  const recipes = managed(page).getByRole('listitem').filter({ hasText: 'Recipes' });
  await recipes.getByRole('button', { name: 'Leave it out' }).click();
  await expect(notice(page)).toContainText('are not part of your app');
  await expect(leftOut(page)).toContainText('recipes');
  // not "Nothing yet": other specs in this suite apply tables of their own, so
  // what matters is that THIS one left the app, not that the app is empty
  await expect(managed(page).getByRole('listitem').filter({ hasText: 'Recipes' })).toHaveCount(0);

  await leftOut(page).getByRole('listitem').filter({ hasText: 'recipes' })
    .getByRole('button', { name: 'Manage this' }).click();
  await expect(notice(page)).toContainText('are part of your app now');
  await expect(managed(page)).toContainText('Recipes');
  await startAgain(page, 'recipes');
});

test('her words win over the guess, and nothing here touches the database', async ({ page }) => {
  await noDrawing(page);
  await open(page);
  await managed(page).getByRole('listitem').filter({ hasText: 'Recipes' })
    .getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Recipes', level: 1 })).toBeVisible();

  await page.getByLabel('One of them').fill('Dish');
  await page.getByLabel('More than one').fill('Dishes');
  await page.getByRole('button', { name: 'Save these words' }).click();
  await expect(notice(page)).toContainText('Saved.');
  await expect(page.getByRole('heading', { name: 'Dishes', level: 1 })).toBeVisible();

  // the drawing is untouched: this was never a change to her database
  await page.goto('/databases/postgres/family_recipes');
  await expect(page.getByText('Not applied yet')).toBeHidden();
  await startAgain(page, 'recipes');
});

test('a field can be hidden, but not the one records are named by', async ({ page }) => {
  await open(page);
  await page.goto('/databases/postgres/family_recipes/app/recipes');
  const servings = fields(page).getByRole('listitem').filter({ hasText: 'servings' });
  await servings.getByRole('switch', { name: /^Show / }).click();
  await expect(notice(page)).toContainText('Saved.');
  await expect(servings).toContainText('hidden');

  // and the title field is refused, in her words, rather than leaving blanks
  const title = fields(page).getByRole('listitem').filter({ hasText: 'kept as Text' }).first();
  await title.getByRole('switch', { name: /^Show / }).click();
  await expect(notice(page, 'error')).toContainText('named by');
  await startAgain(page, 'recipes');
});

test('what people may do is hers to choose, and a copy needs adding', async ({ page }) => {
  await open(page);
  await page.goto('/databases/postgres/family_recipes/app/recipes');
  const may = (name: string) => page.getByRole('switch', { name });

  await expect(may('Delete them')).toBeChecked();
  await may('Delete them').click();
  await expect(notice(page)).toContainText('Saved.');
  await expect(may('Delete them')).not.toBeChecked();

  // duplicate is create plus a copy: without create there is nothing to make
  await may('Add new ones').click();
  await expect(notice(page)).toContainText('Saved.');
  await expect(may('Make a copy')).not.toBeChecked();
  await expect(may('Make a copy')).toBeDisabled();
  await expect(page.getByText('needs “add new ones”')).toBeVisible();
  await startAgain(page, 'recipes');
});
