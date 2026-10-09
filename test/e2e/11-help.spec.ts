import { expect, test } from './fixtures.ts';

test('the guides: listed, searched live, and read part by part', async ({ page }) => {
  await page.goto('/help');
  await expect(page).toHaveTitle('Help · pammy.org panel');
  await expect(page.getByRole('link', { name: /^Start here/ })).toHaveAttribute('href', '/help/control-panel');
  await expect(page.getByRole('link', { name: /^Part 2/ }).first()).toHaveAttribute('href', '/help/control-panel/part-2');
  await expect(page.getByRole('heading', { name: 'More guides' })).toBeVisible();
  await expect(page.getByRole('link', { name: /^07\s*Your blog: WordPress/ })).toBeVisible();

  await page.getByLabel('Search the guides').pressSequentially('turnstile', { delay: 20 });
  await expect(page).toHaveURL('/help?q=turnstile');
  const results = page.getByRole('list', { name: 'Search results' });
  await expect(results.locator('mark').first()).toHaveText(/turnstile/i);
  await results.getByRole('link').first().click();
  await expect(page.getByText('Search words marked: "turnstile".')).toBeVisible();
  await page.getByRole('link', { name: 'Clear' }).click();
  await expect(page).not.toHaveURL(/q=/);

  await page.goto('/help/control-panel/part-2');
  await expect(page.getByText(/^Part 2 of \d+$/)).toBeVisible();
  await expect(page).toHaveTitle(/^Part 2: .* · Help · pammy\.org panel$/);
  await page.getByRole('navigation', { name: 'Previous and next part' }).getByRole('link', { name: /Next/ }).click();
  await expect(page).toHaveURL('/help/control-panel/part-3');
  await page.getByLabel('Go to').selectOption({ label: 'Introduction' });
  await expect(page).toHaveURL('/help/control-panel');
  await expect(page.getByRole('navigation', { name: 'Parts of this guide' })).toBeVisible();

  await page.goto('/help/wordpress');
  await expect(page.getByRole('navigation', { name: 'In this guide' })).toBeVisible();
  await page.goto('/help/no-such-guide');
  await expect(page).toHaveURL('/help');
});
