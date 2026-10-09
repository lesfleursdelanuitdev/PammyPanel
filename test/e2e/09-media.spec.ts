import { confirmDialog, expect, notice, test } from './fixtures.ts';

// a 2 x 1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mP8z8DwnwEIGGEMAB3+Av4U2F1YAAAAAElFTkSuQmCC', 'base64');

test('make a media folder, upload, look at details, rename, move, trash and restore', async ({ page }) => {
  await page.goto('/media');
  await expect(page.getByRole('heading', { name: 'No media folders yet' })).toBeVisible();
  await page.getByRole('link', { name: 'Or somewhere else' }).click();
  await expect(page).toHaveURL('/media/folders');
  await expect(page.getByRole('heading', { name: 'Make media folders', level: 1 })).toBeVisible();
  await page.getByRole('combobox', { name: 'Make a media folder in' }).fill('recipes');
  await page.getByRole('button', { name: 'Make', exact: true }).click();
  await expect(notice(page)).toHaveText('Made a media folder in recipes, with images, files, audio and video in it.');
  const recipesRow = page.getByRole('list', { name: 'Sites and their media folders' }).getByRole('listitem').filter({ hasText: /^recipes/ });
  await expect(recipesRow).toContainText('has a media folder');
  await recipesRow.getByRole('button', { name: 'Open in Media' }).click();
  await expect(page).toHaveURL('/media?folder=recipes');
  const kinds = page.getByRole('navigation', { name: 'Kinds of media' });
  await expect(kinds.getByRole('link', { name: 'All' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('Nothing here yet. Click Upload, or drag files onto this box.')).toBeVisible();

  // browsing images: uploads go here; a text file isn't an image
  await kinds.getByRole('link', { name: 'Images' }).click();
  await expect(page).toHaveURL('/media?folder=recipes&kind=images');
  await page.getByTestId('media-upload').setInputFiles([
    { name: 'lemon-cake.png', mimeType: 'image/png', buffer: PNG },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
  ]);
  const uploads = page.getByRole('list', { name: 'Uploads' });
  await expect(uploads.locator('[data-status="ok"]')).toContainText('done');
  await expect(uploads.locator('[data-status="failed"]')).toContainText('not an image');
  await expect(notice(page, 'error')).toHaveText("1 uploaded; 1 couldn't be (see the list).");

  const files = page.getByRole('list', { name: 'Files' });
  const cake = files.getByRole('listitem').filter({ hasText: 'lemon-cake.png' });
  await expect(cake.locator('img')).toHaveJSProperty('naturalWidth', 2);

  await cake.getByRole('button', { name: 'Open lemon-cake.png' }).click();
  const details = page.getByRole('dialog', { name: 'lemon-cake.png' });
  await expect(details).toContainText('2 × 1 pixels');
  await expect(details).toContainText('Uploaded by pamela');
  await expect(details).toContainText('None yet');
  await expect(details.getByText('https://pammy.org/recipes/media/images/lemon-cake.png', { exact: true })).toBeVisible();
  await expect(details.getByText('https://recipes.pammy.org/media/images/lemon-cake.png', { exact: true })).toBeVisible();
  await details.getByRole('button', { name: 'Copy HTML' }).click();
  await expect(notice(page)).toHaveText('HTML copied.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('<img src="media/images/lemon-cake.png" alt="lemon cake">');
  await expect(details.getByRole('link', { name: 'Download' })).toHaveAttribute('href', '/api/media/file?path=recipes%2Fmedia%2Fimages%2Flemon-cake.png&download=1');

  await details.getByRole('button', { name: 'Rename' }).click();
  await expect(details).toBeHidden();
  await confirmDialog(page).getByLabel('New name').fill('cake.png');
  await confirmDialog(page).getByRole('button', { name: 'Rename' }).click();
  await expect(notice(page)).toHaveText('Renamed to "cake.png".');

  await page.getByRole('button', { name: 'New folder' }).click();
  await confirmDialog(page).getByLabel('Name').fill('2026-trip');
  await confirmDialog(page).getByRole('button', { name: 'Make folder' }).click();
  await expect(notice(page)).toHaveText('Folder "2026-trip" made.');
  const buckets = page.getByRole('list', { name: 'Folders here' });
  await expect(buckets).toContainText('2026-trip0 items');

  // the ⋯ menu on a card
  await page.getByRole('button', { name: 'More for cake.png' }).click();
  await page.getByRole('menuitem', { name: 'Move to…' }).click();
  const move = page.getByRole('dialog', { name: 'Move "cake.png"' });
  await move.getByLabel('Inside').selectOption('2026-trip');
  await move.getByRole('button', { name: 'Move here' }).click();
  await expect(notice(page)).toHaveText('Moved to recipes/media/images/2026-trip/cake.png.');
  await expect(buckets).toContainText('2026-trip1 item');

  await buckets.getByRole('link', { name: /2026-trip/ }).click();
  await expect(page).toHaveURL('/media?folder=recipes&kind=images&in=2026-trip');
  await expect(page.getByRole('navigation', { name: 'Folders' })).toContainText('Images›2026-trip');
  await page.getByRole('button', { name: 'More for cake.png' }).click();
  await page.getByRole('menuitem', { name: 'Move to trash' }).click();
  await expect(confirmDialog(page)).toContainText('Cloudflare may keep showing old copies');
  await confirmDialog(page).getByRole('button', { name: 'Move to trash' }).click();
  await expect(notice(page)).toHaveText('"cake.png" moved to the trash.');
  await expect(page.getByText('Nothing here yet.')).toBeVisible();

  await page.getByRole('link', { name: 'Up' }).click();
  await expect(page).toHaveURL('/media?folder=recipes&kind=images');
  await page.locator('summary', { hasText: 'Trash' }).click();
  const trashed = page.getByRole('list', { name: 'Trashed media' }).getByRole('listitem').filter({ hasText: 'cake.png' });
  await expect(trashed).toContainText('was in recipes/media/images/2026-trip');
  await trashed.getByRole('button', { name: 'Restore' }).click();
  await expect(notice(page)).toHaveText('Restored to recipes/media/images/2026-trip/cake.png.');

  // a folder's own menu
  await buckets.getByRole('button', { name: 'More for 2026-trip' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await confirmDialog(page).getByLabel('New name').fill('trip');
  await confirmDialog(page).getByRole('button', { name: 'Rename' }).click();
  await expect(notice(page)).toHaveText('Renamed to "trip".');
  await expect(buckets).toContainText('trip1 item');

  // with no kind chosen, an upload goes where its type says
  await kinds.getByRole('link', { name: 'All' }).click();
  await expect(page).toHaveURL('/media?folder=recipes');
  await expect(page.getByText('Uploads go to the top of images, audio, video or files, by their type, in recipes.')).toBeVisible();
  await page.getByTestId('media-upload').setInputFiles([{ name: 'menu.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n') }]);
  await expect(notice(page)).toHaveText('1 file uploaded.');
  await expect(files.getByRole('listitem').filter({ hasText: 'menu.pdf' })).toContainText('Files');
  await page.getByRole('button', { name: 'More for menu.pdf' }).click();
  await page.getByRole('menuitem', { name: 'Copy address' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('https://pammy.org/recipes/media/files/menu.pdf');
});

// test/e2e/server.ts listens on 3198 for "someone used WinSCP".
test('files put in outside the panel show up after "Check for changes"; misplaced ones are pointed out', async ({ page }) => {
  await page.goto('/media?folder=recipes&kind=images');
  await expect(page.getByTestId('media-checked')).toHaveText(/^Checked for changes /);
  // the check covers the whole website: first take in what earlier tests put there
  await page.getByRole('button', { name: 'Check for changes' }).click();
  await expect(notice(page)).toHaveText(/^Checked: /);
  const r = await fetch('http://127.0.0.1:3198/media-outside', { method: 'POST' });
  expect(r.status).toBe(204);
  const files = page.getByRole('list', { name: 'Files' });
  await expect(page.getByRole('button', { name: 'Open from-winscp.png' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Check for changes' }).click();
  // the picture, and notes.txt: out of place in a media folder, but still a file of the website
  await expect(notice(page)).toHaveText('Checked: 2 new.');
  await expect(files.getByRole('button', { name: 'Open from-winscp.png' })).toBeVisible();
  const note = page.getByRole('note');
  await expect(note).toContainText("One thing is where the panel can't use it:");
  await expect(note).toContainText('recipes/media/notes.txt');
  await files.getByRole('button', { name: 'Open from-winscp.png' }).click();
  const details = page.getByRole('dialog', { name: 'from-winscp.png' });
  await expect(details).toContainText("Put here outside the panel (with WinSCP or Claude), so the panel doesn't know who.");
  await page.keyboard.press('Escape');
  await expect(details).toBeHidden();
  await page.getByRole('button', { name: 'Check for changes' }).click();
  await expect(notice(page)).toHaveText('Checked: nothing has changed.');
});

test('tags and categories, filters, the table, several files at once, and every media folder together', async ({ page }) => {
  await page.goto('/media?folder=recipes');
  await expect(page.getByText('3 files in recipes')).toBeVisible();

  // one file's tags and categories ("Summer 2026" becomes summer-2026)
  await page.getByRole('button', { name: 'More for from-winscp.png' }).click();
  await page.getByRole('menuitem', { name: 'Tags and categories…' }).click();
  const editor = page.getByRole('dialog', { name: 'Tags and categories for "from-winscp.png"' });
  await editor.getByRole('combobox', { name: 'Add a category' }).fill('Summer 2026');
  await expect(editor).toContainText('Will be added as "summer-2026".');
  await editor.getByRole('region', { name: 'Categories' }).getByRole('button', { name: 'Add' }).click();
  await editor.getByRole('combobox', { name: 'Add a tag' }).fill('lemon');
  await editor.getByRole('combobox', { name: 'Add a tag' }).press('Enter');
  await expect(editor.getByRole('region', { name: 'Tags' })).toContainText('#lemon');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(notice(page)).toHaveText('Saved for "from-winscp.png"; made /recipes/t/lemon, /recipes/c/summer-2026.');
  const card = page.getByRole('list', { name: 'Files' }).getByRole('listitem').filter({ hasText: 'from-winscp.png' });
  await expect(card).toContainText('summer-2026');
  await expect(card).toContainText('#lemon');

  // filtering by a tag, then by name
  await page.getByRole('button', { name: 'Tag' }).click();
  await page.getByRole('menu').getByRole('checkbox', { name: '#lemon' }).click();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/tag=\d+/);
  await expect(page.getByText('1 file in recipes')).toBeVisible();
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page).toHaveURL('/media?folder=recipes');
  await page.getByRole('searchbox', { name: 'Find by name' }).fill('cake');
  await expect(page).toHaveURL('/media?folder=recipes&q=cake');
  await expect(page.getByText('1 file in recipes matching "cake"')).toBeVisible();
  await page.getByRole('button', { name: 'Clear' }).click();

  // the table, remembered in this browser
  await page.getByRole('radio', { name: 'Table' }).click();
  const table = page.getByRole('table', { name: 'Files' });
  await expect(table.getByRole('row')).toHaveCount(4);
  await table.getByRole('button', { name: 'Size' }).click();
  await expect(page).toHaveURL('/media?folder=recipes&sort=size&order=desc');
  await expect(table.getByRole('columnheader', { name: 'Size' })).toHaveAttribute('aria-sort', 'descending');
  await page.reload();
  await expect(page.getByRole('radio', { name: 'Table' })).toHaveAttribute('aria-checked', 'true');

  // several files at once
  await table.getByRole('checkbox', { name: 'Select cake.png' }).click();
  await table.getByRole('checkbox', { name: 'Select menu.pdf' }).click();
  const bar = page.getByRole('region', { name: 'Chosen files' });
  await expect(bar).toContainText('2 chosen');
  await bar.getByRole('button', { name: 'Tags…' }).click();
  const bulk = page.getByRole('dialog', { name: 'Tags and categories for 2 files' });
  await bulk.getByRole('combobox', { name: 'Add a tag' }).fill('Menu Card');
  await bulk.getByRole('button', { name: 'Save' }).click();         // typed but not added: still counts
  await expect(notice(page)).toHaveText('Changed 2 files; made /recipes/t/menu-card.');
  await expect(bar).toContainText('2 chosen', { timeout: 1000 });      // still chosen, to move them next if wanted
  await bar.getByRole('button', { name: 'Unchoose all' }).click();
  await expect(bar).toBeHidden();

  // the "Tags & categories" page: rename one, delete another
  await page.goto('/media/tags?folder=recipes');
  await expect(page.getByRole('heading', { name: 'Tags & categories', level: 1 })).toBeVisible();
  const tags = page.getByRole('list', { name: 'Tags' });
  await tags.getByRole('listitem').filter({ hasText: '#lemon' }).getByRole('button', { name: 'Rename' }).click();
  await confirmDialog(page).getByLabel('New name').fill('Lemons');
  await confirmDialog(page).getByRole('button', { name: 'Rename' }).click();
  await expect(notice(page)).toHaveText('Renamed to "lemons".');
  await tags.getByRole('listitem').filter({ hasText: '#menu-card' }).getByRole('button', { name: 'Delete' }).click();
  await expect(confirmDialog(page)).toContainText('It comes off 2 files.');
  await confirmDialog(page).getByRole('button', { name: 'Delete' }).click();
  await expect(notice(page)).toHaveText('Deleted "menu-card".');

  // into another media folder: its tags go too, made there first (and the dialog says so)
  await page.goto('/media/folders');
  await page.getByRole('list', { name: 'Sites and their media folders' }).getByRole('listitem').filter({ hasText: /^family/ })
    .getByRole('button', { name: 'Make one' }).click();
  await expect(notice(page)).toContainText('Made a media folder in family');
  await page.goto('/media?folder=recipes');
  await page.getByRole('button', { name: 'More for from-winscp.png' }).click();
  await page.getByRole('menuitem', { name: 'Move to…' }).click();
  const move = page.getByRole('dialog', { name: 'Move "from-winscp.png"' });
  await move.getByLabel('Media folder').selectOption('family');
  await expect(move.getByTestId('labels-made')).toHaveText("family doesn't have these yet, so they'll be made there: /family/t/lemons, /family/c/summer-2026");
  await move.getByRole('button', { name: 'Move here' }).click();
  await expect(notice(page)).toHaveText('Moved to family/media/images/from-winscp.png.');

  // every media folder together, with where each file is
  await page.locator('#media-site').selectOption({ label: 'All media folders' });
  await expect(page).toHaveURL('/media?folder=*');
  await expect(page.getByText('3 files in all media folders')).toBeVisible();
  await expect(table.getByRole('row').filter({ hasText: 'from-winscp.png' })).toContainText('#lemons');
  await page.getByRole('button', { name: 'Tag' }).click();
  await expect(page.getByRole('menu').getByRole('checkbox', { name: '/family/t/lemons' })).toHaveCount(1);
  await page.keyboard.press('Escape');

  // several into the trash at once
  await table.getByRole('checkbox', { name: 'Select every file on this page' }).click();
  await expect(bar).toContainText('3 chosen');
  await bar.getByRole('button', { name: 'Move to trash' }).click();
  await expect(confirmDialog(page)).toHaveAccessibleName('Move 3 files to the trash?');
  await confirmDialog(page).getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('radio', { name: 'Grid' }).click();
});
