// The order of an app's form on a phone (docs/field-order-plan.md): the Up and
// Down buttons are big enough for a finger and the page fits the screen.
import { expect, test } from './fixtures.ts';

test('on a phone the order of the form is changed with big Up and Down buttons', async ({ page }) => {
  await page.goto('/databases/mariadb/example_blog/app/posts');
  const rows = page.getByRole('list', { name: 'The order of the form' }).locator('li[data-name]');
  await expect(rows.first()).toBeVisible();
  const before = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-name')));
  const down = page.getByRole('button', { name: /^Move .* down$/ }).first();
  const box = (await down.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scroll, 'the page does not scroll sideways').toBeLessThanOrEqual(width);
  await down.tap();
  await expect(rows.nth(1)).toHaveAttribute('data-name', before[0]!);
  // and back again, for anything after this
  await rows.nth(1).getByRole('button', { name: /^Move .* up$/ }).tap();
  await expect(rows.first()).toHaveAttribute('data-name', before[0]!);
});
