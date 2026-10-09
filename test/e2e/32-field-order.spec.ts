// The order of an app's form in a browser (docs/field-order-plan.md), on the
// blog example: Up and Down (mouse and keyboard), dragging, the form and the
// list following, and "Put back the table's order". Puts the example's own
// order back at the end, for the tests after this one.
import { expect, notice, test } from './fixtures.ts';

const SETTINGS = '/databases/mariadb/example_blog/app/posts';
const API = '/api/databases/mariadb/example_blog/app/posts/order';
const order = (page: import('@playwright/test').Page) =>
  page.getByRole('list', { name: 'The order of the form' }).locator('li[data-name]');
// each field's own label on the form: for="f-<field>" or "m-<many-to-many>"
const formLabels = async (page: import('@playwright/test').Page) => {
  await expect(page.locator('label[for="f-title"]')).toBeVisible();
  return (await page.locator('form label[for^="f-"], form label[for^="m-"]').allTextContents()).map((t) => t.trim());
};

test('the order of the form: Up, Down, drag, and the form follows', async ({ page }) => {
  await page.goto(SETTINGS);
  // the example comes with Title first -- before, its settings put Author above it
  await expect(order(page).first()).toHaveAttribute('data-name', 'title');
  const shipped = await order(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-name')));
  expect(shipped).toContain('many:topics');

  // with the mouse
  await page.getByRole('button', { name: 'Move Body up' }).click();
  await expect(notice(page)).toContainText('Saved.');
  await expect(page.getByText(/Body moved up: now \d+ of \d+/)).toBeAttached();
  // with the keyboard
  await page.getByRole('button', { name: 'Move Body up' }).focus();
  await page.keyboard.press('Enter');
  await expect(order(page).nth(2)).toHaveAttribute('data-name', 'body');
  // dragging a row by its handle, on a computer
  await order(page).filter({ hasText: 'Published' }).first().dragTo(order(page).first());
  await expect(order(page).first()).toHaveAttribute('data-name', /published/);
  // hidden fields are listed, not movable
  await expect(page.getByRole('list', { name: 'The order of the form' })).toContainText('not on the form');

  // the form follows
  await page.goto('/app/mariadb/example_blog/posts/new');
  const labels = await formLabels(page);
  expect(labels.slice(0, 1)).toEqual(['Published']);
  expect(labels.indexOf('Body')).toBeLessThan(labels.indexOf('Author'));
  expect(labels).toContain('Topics');

  // put back the table's own order, then the example's
  await page.goto(SETTINGS);
  await page.getByRole('button', { name: "Put back the table's order" }).click();
  await expect(page.getByRole('button', { name: "Put back the table's order" })).toHaveCount(0);
  const r = await page.request.post(API, { data: { order: shipped.filter((n) => !['id', 'created_at', 'updated_at'].includes(n!)) }, headers: { origin: new URL(page.url()).origin } });
  expect(r.status()).toBe(200);
});
