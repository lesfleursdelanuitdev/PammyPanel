import { expect, notice, test } from './fixtures.ts';

// Tags and categories on any file of the website, not only media: here a page in
// blog-drafts, a folder with no media folder.
test('a page outside any media folder: tagged, listed on Tags & categories, and found again in File Explorer', async ({ page }) => {
  await page.goto('/files?path=blog-drafts');
  await page.getByRole('button', { name: 'More for garden-party.html' }).click();
  await page.getByRole('menuitem', { name: 'Tags and categories…' }).click();
  const editor = page.getByRole('dialog', { name: 'Tags and categories for "garden-party.html"' });
  await editor.getByRole('combobox', { name: 'Add a tag' }).fill('Party Pages');
  await editor.getByRole('combobox', { name: 'Add a tag' }).press('Enter');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(notice(page)).toHaveText('Saved for "garden-party.html"; made /blog-drafts/t/party-pages.');

  // the old address still works, and lands on the new one
  await page.goto('/media/tags?folder=blog-drafts');
  await expect(page).toHaveURL('/tags?folder=blog-drafts');
  await expect(page.getByRole('heading', { name: 'Tags & categories', level: 1 })).toBeVisible();
  const row = page.getByRole('list', { name: 'Tags' }).getByRole('listitem').filter({ hasText: '#party-pages' });
  await expect(row).toContainText('1 file');
  await page.getByLabel('Show').selectOption('*');
  await expect(page).toHaveURL('/tags?folder=*');
  await expect(page.getByRole('listitem').filter({ hasText: '#party-pages' })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: '#lemons' })).toHaveCount(2);          // recipes' and family's media, from 09
  await page.getByRole('listitem').filter({ hasText: '#party-pages' }).getByRole('button', { name: 'Show files' }).click();
  await expect(page).toHaveURL(/\/files\?path=blog-drafts&tag=\d+/);
  await expect(page.getByRole('button', { name: 'Open garden-party.html' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open style.css' })).toHaveCount(0);

  // a tag made on the page itself, for a folder with no media
  await page.goto('/tags?folder=blog-drafts');
  await page.getByLabel('Name').fill('drafts');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(notice(page)).toHaveText('Made the tag "drafts".');
  await expect(page.getByRole('list', { name: 'Tags' }).getByRole('listitem').filter({ hasText: '#drafts' })).toContainText('0 files');
});
