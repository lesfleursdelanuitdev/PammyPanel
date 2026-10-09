// Tags and categories on her records (docs/catalog-plan.md step 4), in a browser: the
// switch on a table's settings, a record's tags on its page, the list's Tags column and
// its filter, labels that go everywhere on the Tags page, and switching it off again.
// The recipes are test/e2e/server.ts's, in memory.
import { confirmDialog, expect, notice, test } from './fixtures.ts';

type Page = import('@playwright/test').Page;

const activate = async (page: Page) => {
  await page.goto('/databases');
  await expect(page.getByRole('list', { name: 'Your databases' })).toBeVisible();
  const adopt = page.getByRole('listitem').filter({ hasText: 'family_recipes' }).getByRole('button', { name: 'Look after this one' });
  if (await adopt.count()) {
    await adopt.first().click();
    await expect(notice(page)).toContainText('looking after family_recipes');
  }
  await page.goto('/databases/postgres/family_recipes/app');
  await expect(page.getByRole('list', { name: 'Managed' })).toBeVisible();
  const on = page.getByRole('button', { name: 'Switch the app on' });
  if (await on.count()) {
    await on.click();
    await expect(notice(page)).toContainText('is switched on');
  }
};
const settings = (page: Page) => page.goto('/databases/postgres/family_recipes/app/recipes');
const tagSwitch = (page: Page) => page.getByRole('switch', { name: 'Let me tag recipes' });

test('she switches tags on for recipes, tags one, and finds it again by its tag', async ({ page }) => {
  await activate(page);
  await settings(page);
  await expect(page.getByRole('heading', { name: 'Tags and categories' })).toBeVisible();
  if (!(await tagSwitch(page).isChecked())) {
    await tagSwitch(page).click();
    await expect(notice(page)).toContainText('Tags are on for recipes.');
  }
  await expect(tagSwitch(page)).toBeChecked();
  await expect(page.getByText(/with tags/)).toBeVisible();

  // a record's page: its tags, typed in (made in the table's own)
  await page.goto('/app/postgres/family_recipes/recipes');
  await page.getByRole('row').filter({ hasText: 'Sunday roast' }).getByRole('link', { name: 'Change' }).click();
  await expect(page.getByRole('heading', { name: 'Tags and categories' })).toBeVisible();
  await page.getByLabel('Add a category').fill('Mains');
  await page.getByLabel('Add a tag').fill('sunday');
  await page.getByRole('button', { name: 'Save the tags' }).click();
  await expect(notice(page)).toContainText('Saved; made @recipes/t/sunday, @recipes/c/mains.');

  // the list: a Tags & categories column (the recipes' own Tags, a many-to-many, are another), and only the ones with a tag
  await page.goto('/app/postgres/family_recipes/recipes');
  await expect(page.getByRole('columnheader', { name: 'Tags & categories' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Sunday roast' })).toContainText('mains, #sunday');
  await page.getByRole('combobox', { name: 'Only the ones with this tag or category' }).selectOption({ label: '#sunday' });
  await expect(page.getByText('1 of them match')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Sunday roast' })).toBeVisible();

  // the table's own labels, with how many have each
  await settings(page);
  await expect(page.getByRole('list', { name: 'Tags of recipes' })).toContainText('#sunday');
  await expect(page.getByRole('list', { name: 'Categories of recipes' })).toContainText('mains');
});

test('a tag that goes everywhere is made on the Tags page and used on a record', async ({ page }) => {
  await activate(page);
  await page.goto('/tags?folder=everywhere%2F');
  await expect(page.getByRole('combobox', { name: 'Show' })).toHaveValue('everywhere/');
  const list = page.getByRole('list', { name: 'Tags everywhere' });
  if (!(await list.getByText('#featured').count())) {
    await page.getByLabel('Name').fill('featured');
    await page.getByRole('button', { name: 'Add' }).click();
    await expect(notice(page)).toContainText('Made the tag "featured".');
  }
  await expect(list).toContainText('#featured');

  await page.goto('/app/postgres/family_recipes/recipes');
  await page.getByRole('row').filter({ hasText: 'Sunday roast' }).getByRole('link', { name: 'Change' }).click();
  await page.getByLabel('Add a tag').fill('featured');
  await page.getByRole('button', { name: 'Save the tags' }).click();
  // Everywhere's own, not a new one in the table
  await expect(notice(page)).toHaveText(/^Saved\.$/);
  await page.goto('/tags?folder=everywhere%2F');
  await expect(list.getByRole('listitem').filter({ hasText: '#featured' })).toContainText('1 thing');
});

test('a label can be shown on her pages: "Anyone can see it" (step 4b)', async ({ page }) => {
  await activate(page);
  await settings(page);
  const row = page.getByRole('list', { name: 'Tags of recipes' }).getByRole('listitem').filter({ hasText: '#sunday' });
  await row.getByRole('switch', { name: 'Anyone can see @recipes/t/sunday' }).click();
  await expect(notice(page)).toContainText('Anyone reading recipes on your pages can now see "sunday".');
  await expect(row).toContainText('anyone can see it');
  await page.goto('/tags?folder=everywhere%2F');
  const featured = page.getByRole('list', { name: 'Tags everywhere' }).getByRole('listitem').filter({ hasText: '#featured' });
  await featured.getByRole('switch', { name: 'Anyone can see */t/featured' }).click();
  await expect(notice(page)).toContainText('can now see "featured"');
  await featured.getByRole('switch', { name: 'Anyone can see */t/featured' }).click();
  await expect(notice(page)).toContainText('Only keys (and the panel) can see "featured" now.');
});

test('switching tags off asks first, and takes the table\'s tags away', async ({ page }) => {
  await activate(page);
  await settings(page);
  await expect(tagSwitch(page)).toBeChecked();
  await tagSwitch(page).click();
  await expect(confirmDialog(page)).toContainText('come off 1 recipe');
  await confirmDialog(page).getByRole('button', { name: 'Switch off' }).click();
  await expect(notice(page)).toContainText('Tags are off for recipes.');
  await expect(tagSwitch(page)).not.toBeChecked();
  // the record page has no tags part any more; the list no Tags column
  await page.goto('/app/postgres/family_recipes/recipes');
  await expect(page.getByRole('cell', { name: 'Sunday roast' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Tags & categories' })).toHaveCount(0);
  // Everywhere's label stays, on nothing now
  await page.goto('/tags?folder=everywhere%2F');
  await expect(page.getByRole('list', { name: 'Tags everywhere' }).getByRole('listitem').filter({ hasText: '#featured' })).toContainText('0 things');
});
