// "Save answers in a database" on a phone (docs/form-to-database-plan.md): the
// page fits the screen, and a question's field is picked with the phone's own list.
import { expect, test } from './fixtures.ts';

test('on a phone the form-to-database page fits, and pairs are picked from the phone\'s list', async ({ page }) => {
  await page.goto('/forms');
  const made = await page.request.post('/api/forms', { headers: { origin: new URL(page.url()).origin }, data: { name: 'phone-recipe', title: 'Phone recipe', items: [
    { id: 'new-1', type: 'short-text', label: 'Recipe name', required: true },
  ] } });
  const id = (await made.json()).form.id as number;
  await page.goto(`/forms/${id}/database`);
  await page.getByLabel('Database', { exact: true }).selectOption('postgres/family_recipes');
  await page.getByLabel('Table', { exact: true }).selectOption('recipes');
  await page.getByLabel('Recipe name', { exact: true }).selectOption('title');
  await expect(page.getByText('Every field Recipes needs is filled in.')).toBeVisible();
  const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scroll, 'the page does not scroll sideways').toBeLessThanOrEqual(width);
  const save = await page.getByRole('button', { name: 'Save', exact: true }).boundingBox();
  expect(save!.height).toBeGreaterThanOrEqual(36);
});
