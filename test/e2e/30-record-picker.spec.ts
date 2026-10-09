// The record picker in a browser (docs/record-picker-plan.md), on the recipe
// book example that 29-db-examples set up: an ingredient's recipe picked by
// name, filtered by field, with the keyboard; a recipe's tags ticked and saved.
import { expect, notice, test } from './fixtures.ts';

const APP = '/app/postgres/example_recipes';

test('an ingredient\'s recipe is picked by name, never typed in as an id', async ({ page }) => {
  await page.goto(`${APP}/ingredients/new`);
  const recipe = page.getByRole('combobox', { name: 'Recipe' });
  await expect(recipe).toBeVisible();
  const list = page.getByRole('listbox', { name: /recipes/i });
  // every recipe, before she types anything, each with what tells it apart
  await expect(list.getByRole('option')).toHaveCount(8);
  await expect(list.getByRole('option', { name: /Chickpea curry/ })).toContainText('Sam');
  // in words that say what they are: "Vegetarian", "Servings: 4" -- not "Yes", "4"
  await expect(list.getByRole('option', { name: /Chickpea curry/ })).toContainText('Vegetarian');
  await expect(list.getByRole('option', { name: /Spaghetti bolognese/ })).not.toContainText('Vegetarian');

  // as she types, the list narrows
  await recipe.fill('lemon');
  await expect(list.getByRole('option')).toHaveCount(1);
  // the keyboard: down, then Enter picks (and does not send the form)
  await recipe.press('ArrowDown');
  await recipe.press('Enter');
  await expect(page.getByLabel('Chosen recipes')).toContainText('Lemon drizzle loaf');
  await expect(list.getByRole('option', { name: /Lemon drizzle loaf/ })).toHaveAttribute('aria-selected', 'true');

  await page.getByLabel('Item').fill('icing sugar');
  await page.getByRole('button', { name: /^Add this/ }).click();
  await expect(notice(page)).toContainText('added');
  // and the list says which recipe, by name
  await page.getByRole('searchbox', { name: /Search/ }).or(page.getByLabel(/Search Ingredients/)).first().fill('icing sugar');
  await expect(page.getByRole('row', { name: /icing sugar/ }).first()).toContainText('Lemon drizzle loaf');
});

test('filter by several fields at once: Sam\'s recipes that are vegetarian', async ({ page }) => {
  await page.goto(`${APP}/ingredients/new`);
  const list = page.getByRole('listbox', { name: /recipes/i });
  await expect(list.getByRole('option')).toHaveCount(8);

  await page.getByRole('button', { name: 'Filter by field' }).click();
  await page.getByLabel('Which field').selectOption({ label: 'Cook' });
  // a connection is filtered by its own small picker
  const cooks = page.getByRole('listbox', { name: /cook/i });
  await cooks.getByRole('option', { name: /^Sam/ }).click();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByLabel('Filters')).toContainText('Cook: Sam');
  await expect(list.getByRole('option')).toHaveCount(2);

  await page.getByRole('button', { name: 'Filter by field' }).click();
  await page.getByLabel('Which field').selectOption({ label: 'Vegetarian' });
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByLabel('Filters')).toContainText('Vegetarian: yes');
  await expect(list.getByRole('option')).toHaveCount(2);

  // a chip comes off, and the list widens again
  await page.getByRole('button', { name: 'Remove the filter Cook: Sam' }).click();
  await expect(list.getByRole('option')).toHaveCount(7, { timeout: 7_000 });
});

test('a recipe\'s tags are ticked, saved with it, and there when it is opened again', async ({ page }) => {
  const recipes = await (await page.request.get(`/api/app/postgres/example_recipes/recipes?search=brownies`)).json();
  const id = recipes.items[0].id;
  await page.goto(`${APP}/recipes/edit?id=${id}`);
  const chosen = page.getByLabel('Chosen tags');
  await expect(chosen).toContainText('weekend');
  // a yes is shown as a yes when the record is opened (it used to open as a no,
  // and saving then quietly made it one)
  await expect(page.getByRole('switch', { name: 'Vegetarian' })).toBeChecked();
  const tags = page.getByRole('listbox', { name: /tags/i });
  await tags.getByRole('option', { name: 'summer' }).click();
  await chosen.getByRole('button', { name: 'Take weekend off' }).click();
  await expect(chosen).toContainText('summer');
  await expect(chosen).not.toContainText('weekend');
  await page.getByRole('button', { name: 'Save the changes' }).click();
  await expect(notice(page)).toContainText('Saved.');

  await page.goto(`${APP}/recipes/edit?id=${id}`);
  await expect(page.getByLabel('Chosen tags')).toContainText('summer');
  await expect(page.getByRole('switch', { name: 'Vegetarian' })).toBeChecked();
  await expect(page.getByLabel('Chosen tags')).not.toContainText('weekend');
  // and the list of recipes shows them by name
  await page.goto(`${APP}/recipes?search=brownies`);
  await expect(page.getByRole('row', { name: /Chocolate brownies/ })).toContainText('summer');
});

test('the app\'s own lists filter by field too, and the filters stay in the address', async ({ page }) => {
  await page.goto(`${APP}/recipes`);
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(8);
  await page.getByRole('button', { name: 'Filter by field' }).click();
  await page.getByLabel('Which field').selectOption({ label: 'Vegetarian' });
  await page.getByLabel('Vegetarian', { exact: true }).selectOption({ label: 'No' });
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Spaghetti bolognese');
  await expect(page).toHaveURL(/filters=/);
  // Back and a reload keep them
  await page.reload();
  await expect(page.getByLabel('Filters')).toContainText('Vegetarian: no');
  await expect(rows).toHaveCount(1);
  await page.getByRole('button', { name: 'Remove the filter Vegetarian: no' }).click();
  await expect(rows).toHaveCount(8);
});
