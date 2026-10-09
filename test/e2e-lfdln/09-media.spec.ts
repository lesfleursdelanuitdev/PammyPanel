// Media folders and API keys on lfdln (docs/phase8-plan.md step 8-3): a media folder is made
// inside a site folder (no main site's, P8-5), and a key can read media folders.
import { expect, notice, test } from './fixtures.ts';

test('Media: a media folder inside a site folder, never at the top; a key that reads it', async ({ page }) => {
  await page.goto('/hosts');
  const add = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Add a static folder' }) }).first();
  await add.getByLabel('Name').fill('gallery');
  await add.getByRole('button', { name: 'Add folder' }).click();
  await expect(notice(page)).toContainText('Made. https://gallery.lesfleursdelanuit.com/ shows it now.');

  await page.goto('/media/folders');
  await expect(page.getByText('Each site folder can have one')).toBeVisible();
  const sites = page.getByRole('list', { name: 'Sites and their media folders' });
  await expect(sites.getByText('Main site')).toHaveCount(0);
  await sites.getByRole('listitem').filter({ hasText: 'gallery' }).getByRole('button', { name: 'Make one' }).click();
  await expect(notice(page)).toContainText('Made a media folder in gallery');
  await expect(sites.getByRole('listitem').filter({ hasText: 'gallery' }).getByText('has a media folder')).toBeVisible();
  // nothing offers the top: "Make" with no site folder chosen only asks for one
  await page.getByRole('button', { name: 'Make', exact: true }).click();
  await expect(notice(page)).toContainText('Choose a site folder first.');

  await page.goto('/media?folder=gallery');
  await expect(page.getByRole('heading', { name: 'Media', level: 1 })).toBeVisible();
  await expect(page.getByLabel('Media folder')).toHaveValue('gallery');

  // no media examples here (P8-12)
  expect((await page.request.get('/api/media/examples')).status()).toBe(404);

  // a key for every media folder
  await page.goto('/api-keys');
  await page.getByRole('button', { name: 'New key' }).click();
  await page.getByLabel('What it is for').fill('Gallery page');
  await page.getByLabel('Which media folders').selectOption('all');
  await page.getByRole('button', { name: 'Make the key' }).click();
  await expect(page.getByTestId('new-api-key')).toContainText('pammy_');
  await expect(page.getByRole('list', { name: 'API keys' }).getByText('every media folder')).toBeVisible();
});
