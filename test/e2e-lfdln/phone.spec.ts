// lfdln's pages on a phone: nothing wider than the screen, the menu behind its button.
import { expect, test } from './fixtures.ts';

for (const path of ['/', '/hosts', '/hosts/add-domain', '/services', '/projects', '/files', '/tags', '/catalog', '/monitoring', '/accounts', '/activity', '/passkeys', '/people', '/requests', '/visitor-settings']) {
  test(`${path} fits a phone's width`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator('main')).toBeVisible();
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(wide).toBeLessThanOrEqual(0);
  });
}

test('in the dark too', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/hosts');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe('rgb(15, 19, 27)');
});

test('Services on a phone, in the dark, with a log open', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/services');
  const web = page.getByRole('list', { name: 'Parts of Demo app' }).getByRole('listitem').filter({ hasText: 'demo-web.service' });
  await web.getByRole('button', { name: 'Log' }).click();
  await expect(page.getByLabel('The log of Web')).toBeVisible();
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(wide).toBeLessThanOrEqual(0);
});
