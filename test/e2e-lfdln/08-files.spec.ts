// File Explorer on lfdln (docs/phase8-plan.md step 8-1): a site folder's files, a folder and
// an upload inside it, its address through the host that shows it, and the top kept for
// the Hosts page (P8-1).
import { confirmDialog, expect, notice, test } from './fixtures.ts';

test('File Explorer: inside a site folder anything goes; the top is the Hosts page\'s', async ({ page }) => {
  // a site folder, the way it is always made: on the Hosts page
  await page.goto('/hosts');
  const add = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Add a static folder' }) }).first();
  await add.getByLabel('Name').fill('notebook');
  await add.getByRole('button', { name: 'Add folder' }).click();
  await expect(notice(page)).toContainText('Made. https://notebook.lesfleursdelanuit.com/ shows it now.');

  await page.goto('/files?path=notebook');
  await expect(page.getByRole('heading', { name: 'File Explorer', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open index.html' })).toBeVisible();

  // a folder of its own, and a page put in it
  await page.getByRole('button', { name: 'New folder' }).click();
  await confirmDialog(page).getByLabel('Name').fill('drafts');
  await confirmDialog(page).getByRole('button', { name: 'Make folder' }).click();
  await expect(notice(page)).toHaveText('Folder "drafts" made.');
  await page.goto('/files?path=notebook/drafts');
  await page.locator('input[type="file"]').setInputFiles([{ name: 'page.html', mimeType: 'text/html', buffer: Buffer.from('<h1>A page</h1>') }]);
  await expect(page.getByRole('button', { name: 'Open page.html' })).toBeVisible();

  // opened in the editor; its real page is the host's, not lesfleursdelanuit.com/notebook/...
  await page.getByRole('button', { name: 'Open page.html' }).click();
  await expect(page.getByRole('link', { name: 'Real page' })).toHaveAttribute('href', 'https://notebook.lesfleursdelanuit.com/drafts/page.html');

  // at the top: no new folder (a site folder is made on the Hosts page)
  await page.goto('/files');
  await page.getByRole('button', { name: 'New folder' }).click();
  await confirmDialog(page).getByLabel('Name').fill('sneaky');
  await confirmDialog(page).getByRole('button', { name: 'Make folder' }).click();
  await expect(notice(page, 'error')).toContainText('Hosts page');
  expect((await page.request.get('/api/files/list?dir=sneaky')).status()).toBeGreaterThanOrEqual(400);
});
