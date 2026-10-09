// Comments on a phone: the Comments tab fits the screen.
import { expect, test } from './fixtures.ts';

test('on a phone the Comments tab fits the screen', async ({ page }) => {
  await page.goto('/comments');
  await expect(page.getByRole('heading', { name: 'Comment areas' })).toBeVisible();
  const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scroll, 'the page does not scroll sideways').toBeLessThanOrEqual(width);
});
