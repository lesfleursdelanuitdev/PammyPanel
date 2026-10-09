import { confirmDialog, expect, notice, test } from './fixtures.ts';

test('File Explorer: the whole website, a new folder, an upload, a rename, the Pages filter and the trash', async ({ page }) => {
  await page.goto('/files?path=recipes');
  await expect(page.getByRole('heading', { name: 'File Explorer', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open index.html' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Folders' })).toContainText('recipes');

  // a folder of its own, and a page put in it (a server program is refused)
  await page.getByRole('button', { name: 'New folder' }).click();
  await confirmDialog(page).getByLabel('Name').fill('blog');
  await confirmDialog(page).getByRole('button', { name: 'Make folder' }).click();
  await expect(notice(page)).toHaveText('Folder "blog" made.');
  await page.goto('/files?path=recipes/blog');
  await page.locator('input[type="file"]').setInputFiles([
    { name: 'post.html', mimeType: 'text/html', buffer: Buffer.from('<h1>A post</h1>') },
    { name: 'run.php', mimeType: 'text/plain', buffer: Buffer.from('<?php echo 1;') },
  ]);
  await expect(notice(page, 'error')).toHaveText("1 uploaded; 1 couldn't be (see the list).");
  await expect(page.getByRole('button', { name: 'Open post.html' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open run.php' })).toHaveCount(0);

  // renamed, and still the same page
  await page.getByRole('button', { name: 'More for post.html' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await confirmDialog(page).getByLabel('New name').fill('first-post.html');
  await confirmDialog(page).getByRole('button', { name: 'Rename' }).click();
  await expect(notice(page)).toHaveText('Renamed to "first-post.html".');
  const got = await page.request.get('/api/files/file?path=recipes%2Fblog%2Ffirst-post.html&download=1');
  expect(got.status()).toBe(200);
  expect(await got.text()).toBe('<h1>A post</h1>');

  // every page in the website, from the top
  await page.goto('/files?kind=pages');
  await expect(page.getByRole('button', { name: 'Open first-post.html' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open index.html' }).first()).toBeVisible();

  // into the trash
  await page.getByRole('button', { name: 'More for first-post.html' }).click();
  await page.getByRole('menuitem', { name: 'Move to trash' }).click();
  await confirmDialog(page).getByRole('button', { name: 'Move to trash' }).click();
  await expect(notice(page)).toHaveText('"first-post.html" moved to the trash.');
  await expect(page.getByRole('button', { name: 'Open first-post.html' })).toHaveCount(0);
  expect((await page.request.get('/api/files/file?path=recipes%2Fblog%2Ffirst-post.html')).status()).toBe(404);

  // nothing outside the website, and no hidden names
  for (const path of ['..%2Fetc', '.git', 'recipes%2F..%2F..']) {
    expect((await page.request.get(`/api/files/list?dir=${path}`)).status(), path).toBeGreaterThanOrEqual(400);
  }
});

test('full screen on File Explorer and the Media tab: on, still there while moving about, Escape closes a menu first, then it', async ({ page }) => {
  for (const [url, label] of [['/files?path=recipes', 'Website files'], ['/media?folder=recipes', 'Media files']] as const) {
    await page.goto(url);
    const area = page.getByRole('region', { name: label });
    const toggle = page.getByRole('button', { name: 'Full screen', exact: true });
    await toggle.click();
    await expect(area).toHaveAttribute('data-full-screen', 'true');
    const box = (await area.boundingBox())!;
    const size = page.viewportSize()!;
    expect([Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)]).toEqual([0, 0, size.width, size.height]);
    await expect(page.getByRole('button', { name: 'Exit full screen' })).toHaveAttribute('aria-pressed', 'true');
    // a menu open on top: the first Escape closes only the menu
    await page.getByRole('button', { name: 'Tag', exact: true }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toBeHidden();
    await expect(area).toHaveAttribute('data-full-screen', 'true');
    await page.keyboard.press('Escape');
    await expect(area).not.toHaveAttribute('data-full-screen');
    // and the button switches it off too
    await toggle.click();
    await page.getByRole('button', { name: 'Exit full screen' }).click();
    await expect(area).not.toHaveAttribute('data-full-screen');
  }
  // it stays on while going to another folder
  await page.goto('/files');
  await page.getByRole('button', { name: 'Full screen', exact: true }).click();
  await page.getByRole('textbox', { name: 'Folder address' }).fill('recipes');
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await expect(page).toHaveURL('/files?path=recipes');
  await expect(page.getByRole('button', { name: 'Open index.html' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Website files' })).toHaveAttribute('data-full-screen', 'true');
});
