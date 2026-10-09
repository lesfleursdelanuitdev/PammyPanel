// Forms into a database in a browser (docs/form-to-database-plan.md): a form
// of hers connected to family_recipes' Recipes (switched on by 26), a response
// sent from a page, approved, and the recipe in the app; the Responses line;
// and the table's page saying which form fills it in.
import type { Page } from '@playwright/test';
import { expect, notice, test } from './fixtures.ts';
import { routeGate } from './gate.ts';

const origin = (page: Page) => ({ origin: new URL(page.url()).origin });

test('a form saves its answers into a table: set up, approved, and there in the app', async ({ page }) => {
  await routeGate(page);
  await page.goto('/forms');
  const made = await page.request.post('/api/forms', { headers: origin(page), data: { name: 'share-a-recipe', title: 'Share a recipe', items: [
    { id: 'new-1', type: 'short-text', label: 'Recipe name', required: true },
    { id: 'new-2', type: 'number', label: 'Servings' },
    { id: 'new-3', type: 'email', label: 'Your email' },
  ] } });
  expect(made.status()).toBe(200);
  const form = (await made.json()).form as { id: number };
  expect((await page.request.post(`/api/forms/${form.id}/switches`, { headers: origin(page), data: { approvable: true } })).status()).toBe(200);

  // from the Forms list to its own page
  await page.goto('/forms');
  await page.getByRole('article').filter({ hasText: 'Share a recipe' }).getByRole('link', { name: 'Save answers in a database' }).click();
  await expect(page).toHaveURL(`/forms/${form.id}/database`);
  await page.getByLabel('Database', { exact: true }).selectOption('postgres/family_recipes');
  await page.getByLabel('Table', { exact: true }).selectOption('recipes');
  // the panel's guess, and what she picks
  await expect(page.getByLabel('Servings', { exact: true })).toHaveValue('servings');
  await expect(page.getByText(/^Title has to be filled in: pair it/)).toBeVisible();
  await page.getByLabel('Recipe name', { exact: true }).selectOption('title');
  await expect(page.getByText('Every field Recipes needs is filled in.')).toBeVisible();
  // an email can't go into a number, so it is not offered there
  await expect(page.getByLabel('Your email', { exact: true }).locator('option[value="servings"]')).toHaveCount(0);
  await expect(page.getByLabel('When I approve a response')).toBeChecked();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(notice(page)).toContainText('New answers now go into Recipes as well.');
  await expect(page.getByText(/Saves into recipes \(family_recipes\) when you approve a response/)).toBeVisible();

  // a visitor sends it (the gate's own route, as a page would)
  const sent = await page.evaluate(() => fetch('/_pammy/forms/share-a-recipe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page: '/share.html', answers: { 'recipe-name': 'Cheese scones', servings: 8, 'your-email': 'rose@example.org' } }),
  }).then(async (r) => `${r.status} ${await r.text()}`));
  expect(sent).toMatch(/^200/);

  // it waits for her OK, then goes in when she gives it
  await page.goto('/responses');
  const row = page.getByRole('listitem').filter({ hasText: 'Cheese scones' }).first();
  await row.getByRole('button', { name: 'Approve' }).click();
  await expect(notice(page)).toContainText('Approved, and saved in Recipes as Cheese scones.');
  await expect(row.getByRole('link', { name: 'Cheese scones' })).toBeVisible();
  await row.getByRole('link', { name: 'Cheese scones' }).click();
  await expect(page.getByLabel('Title')).toHaveValue('Cheese scones');
  await expect(page.getByLabel('Servings')).toHaveValue('8');

  // the table's page says which form fills it in
  await page.goto('/databases/postgres/family_recipes/app/recipes');
  await expect(page.getByRole('link', { name: 'Share a recipe' })).toBeVisible();

  // A write her database takes and never answers (docs/refactor-plan.md phase 2,
  // B3): the recipe is there, the panel never heard so, and Responses says
  // exactly that instead of pretending -- pressing Try again would make a second one.
  const second = await page.evaluate(() => fetch('/_pammy/forms/share-a-recipe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page: '/share.html', answers: { 'recipe-name': 'Bara brith', servings: 6, 'your-email': 'ann@example.org' } }),
  }).then((r) => r.status));
  expect(second).toBe(200);
  expect((await fetch('http://127.0.0.1:3198/swallow-next-write', { method: 'POST' })).status).toBe(204);
  await page.goto('/responses');
  const lost = page.getByRole('listitem').filter({ hasText: 'Bara brith' }).first();
  await lost.getByRole('button', { name: 'Approve' }).click();
  await expect(lost).toContainText('Not sure whether this was saved');
  await expect(lost).toContainText('It may already be in Recipes: look there before you press Try again.');
  // and it really is there, which is the point of saying so
  await page.goto('/app/postgres/family_recipes/recipes');
  await expect(page.getByRole('cell', { name: 'Bara brith' })).toBeVisible();

  // and it can be let go of again
  await page.goto(`/forms/${form.id}/database`);
  await page.getByRole('button', { name: 'Stop saving' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Stop' }).click();
  await expect(notice(page)).toContainText('no longer saves its answers');
});
