// The Access page on a phone (docs/roles-plan.md step 4): the tabs are a list
// that fits, and nothing scrolls sideways.
import { expect, test } from './fixtures.ts';

test('on a phone the Access page and its tabs fit the screen', async ({ page }) => {
  await page.goto('/visitor-settings');
  const sw = page.getByRole('list', { name: 'Visitor settings' }).getByRole('switch', { name: 'Roles and privileges on the Access page', exact: true });
  await sw.click();
  await expect(sw).toBeChecked();

  await page.goto('/protected-folders');
  await page.locator('article', { has: page.getByRole('heading', { name: 'family' }) }).getByRole('link', { name: 'Roles and privileges' }).click();
  await expect(page.getByRole('heading', { name: 'Access to family' })).toBeVisible();
  const tabs = page.getByRole('navigation', { name: 'Access' });
  for (const t of ['Roles', 'People', 'Groups', 'Privileges']) {
    await tabs.getByRole('link', { name: t }).click();
    await expect(tabs.getByRole('link', { name: t })).toHaveAttribute('aria-current', 'page');
    const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(scroll, `${t}: the page does not scroll sideways`).toBeLessThanOrEqual(width);
  }

  await page.goto('/visitor-settings');
  await sw.click();
  await expect(sw).not.toBeChecked();
});
