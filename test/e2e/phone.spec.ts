import { expect, test } from './fixtures.ts';
import { routeGate } from './gate.ts';

const PAGES = ['/', '/subdomains', '/protected-folders', '/people', '/requests', '/forms', '/forms/1', '/examples', '/examples/guestbook', '/responses', '/api-keys', '/files', '/files/edit?path=blog-drafts%2Fgarden-party.html', '/media?folder=recipes', '/tags', '/media/tags', '/media/folders', '/media/examples', '/media/examples/music',
  '/passkeys', '/accounts', '/activity', '/help', '/help/control-panel/part-2', '/getting-started', '/login', '/invite'];

test.beforeEach(async ({ page }) => routeGate(page));

test('on a phone every page fits the screen', async ({ page }) => {
  for (const path of PAGES) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(scroll, `${path} scrolls sideways`).toBeLessThanOrEqual(width);
  }
});

test('on a phone the menu opens and closes', async ({ page }) => {
  await page.goto('/responses');
  await page.getByRole('button', { name: 'Open the menu' }).click();
  const nav = page.getByRole('navigation', { name: 'Sections' });
  await expect(nav).toBeInViewport();
  await nav.getByRole('link', { name: 'Help' }).click();
  await expect(page).toHaveURL('/help');
  await expect(nav).toBeHidden();
});

test('on a phone the editor switches between the code and the page (no side by side)', async ({ page }) => {
  await page.goto('/files/edit?path=blog-drafts%2Fgarden-party.html');
  const show = page.getByRole('radiogroup', { name: 'Show' });
  await expect(show.getByRole('radio')).toHaveText(['Code', 'Preview']);
  await expect(page.locator('.cm-content')).toBeVisible();
  await show.getByRole('radio', { name: 'Preview' }).click();
  await expect(page.locator('.cm-content')).toBeHidden();
  await expect(page.frameLocator('iframe[title="Preview of the page"]').getByRole('heading', { name: 'Theirs' })).toBeVisible();
  await show.getByRole('radio', { name: 'Code' }).click();
  await expect(page.locator('.cm-content')).toBeVisible();
});
