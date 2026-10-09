import type { Page } from '@playwright/test';
import { confirmDialog, expect, notice, test } from './fixtures.ts';

// The file editor (docs/editor-plan.md), on pages of its own in blog-drafts.
const editor = (page: Page) => page.locator('.cm-content');
const replaceText = async (page: Page, text: string) => {
  await editor(page).click();
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText(text);
};
const onDisk = async (page: Page, path: string) => {
  const r = await page.request.get(`/api/files/file?path=${encodeURIComponent(path)}&download=1`);
  expect(r.status()).toBe(200);
  return r.text();
};
const preview = (page: Page) => page.frameLocator('iframe[title="Preview of the page"]');

test('a new page: made from the starter, edited, previewed side by side while typing, saved with Ctrl+S', async ({ page }) => {
  await page.goto('/files?path=blog-drafts');
  await page.getByRole('button', { name: 'New file' }).click();
  const dialog = page.getByRole('dialog', { name: 'New file' });
  await dialog.getByLabel('Name').fill('garden-party');
  await expect(dialog).toContainText('It will be called garden-party.html.');
  await dialog.getByRole('button', { name: 'Make and open' }).click();
  await expect(page).toHaveURL('/files/edit?path=blog-drafts%2Fgarden-party.html');
  await expect(page.getByRole('heading', { name: 'garden-party.html', level: 1 })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Side by side' })).toHaveAttribute('aria-checked', 'true');
  await expect(preview(page).getByRole('heading', { name: 'garden party' })).toBeVisible();
  expect(await onDisk(page, 'blog-drafts/garden-party.html')).toContain('<title>garden party</title>');

  // the preview follows what's typed, before it's saved
  await replaceText(page, '<!doctype html>\n<h1>Garden party</h1>\n<p>Bring a cake.</p>\n<pammy-form name="rsvp"></pammy-form>\n');
  await expect(page.getByText('Not saved', { exact: true })).toBeVisible();
  await expect(preview(page).getByRole('heading', { name: 'Garden party' })).toBeVisible();
  await expect(preview(page).locator('pammy-form')).toBeVisible();              // the gate's tag: a labelled box
  expect(await onDisk(page, 'blog-drafts/garden-party.html')).toContain('<title>garden party</title>');

  // the page runs sandboxed, in an origin of its own
  const frame = page.frames().find((f) => f.url().includes('/api/files/view/'))!;
  expect(await frame.evaluate(() => origin)).toBe('null');
  expect(await frame.evaluate(() => { try { return String(window.parent.document.title); } catch { return 'blocked'; } })).toBe('blocked');

  await page.keyboard.press('Control+s');
  await expect(notice(page)).toHaveText('Saved.');
  await expect(page.getByText('Not saved', { exact: true })).toHaveCount(0);
  expect(await onDisk(page, 'blog-drafts/garden-party.html')).toBe('<!doctype html>\n<h1>Garden party</h1>\n<p>Bring a cake.</p>\n<pammy-form name="rsvp"></pammy-form>\n');

  // Code only, Preview only
  await page.getByRole('radio', { name: 'Code' }).click();
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect(editor(page)).toBeVisible();
  await page.getByRole('radio', { name: 'Preview' }).click();
  await expect(editor(page)).toBeHidden();
  await expect(preview(page).getByRole('heading', { name: 'Garden party' })).toBeVisible();
  await page.getByRole('radio', { name: 'Side by side' }).click();

  // clicking a text file in the File Explorer opens it here; its menu still has Details
  await page.goto('/files?path=blog-drafts');
  await page.getByRole('button', { name: 'More for garden-party.html' }).click();
  await expect(page.getByRole('menuitem', { name: 'Details' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Open garden-party.html' }).click();
  await expect(page).toHaveURL('/files/edit?path=blog-drafts%2Fgarden-party.html');
});

test('unsaved changes: asked before leaving, and offered back after the tab is closed', async ({ page, context }) => {
  await page.goto('/files/edit?path=blog-drafts%2Fgarden-party.html');
  await replaceText(page, '<h1>Half-written</h1>\n');
  await page.getByRole('link', { name: 'blog-drafts' }).click();
  await expect(confirmDialog(page)).toContainText('Leave without saving?');
  await confirmDialog(page).getByRole('button', { name: 'Stay' }).click();
  await expect(page).toHaveURL(/\/files\/edit/);
  await page.waitForTimeout(1200);                                  // the browser keeps it after 0.8 s

  const again = await context.newPage();
  await again.goto('/files/edit?path=blog-drafts%2Fgarden-party.html');
  await expect(again.getByRole('status').filter({ hasText: 'never saved to your website' })).toBeVisible();
  await again.getByRole('button', { name: 'Bring them back' }).click();
  await expect(again.getByText('Not saved', { exact: true })).toBeVisible();
  await expect(again.locator('.cm-content')).toContainText('Half-written');
  await again.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(notice(again)).toHaveText('Saved.');
  expect(await onDisk(again, 'blog-drafts/garden-party.html')).toBe('<h1>Half-written</h1>\n');
  await again.close();

  // leaving now is fine: nothing unsaved
  await page.reload();
  await page.getByRole('link', { name: 'blog-drafts' }).click();
  await expect(page).toHaveURL('/files?path=blog-drafts');
});

test('changed by someone else meanwhile: keep mine, then an earlier version compared and put back', async ({ page }) => {
  await page.goto('/files/edit?path=blog-drafts%2Fgarden-party.html');
  await expect(page.locator('.cm-content')).toContainText('Half-written');
  // someone else saves it (another window, or WinSCP)
  const cur = await (await page.request.get('/api/files/text?path=blog-drafts%2Fgarden-party.html')).json() as { hash: string };
  const other = await page.request.post('/api/files/save', {
    data: { path: 'blog-drafts/garden-party.html', text: '<h1>Theirs</h1>\n', expect: cur.hash }, headers: { origin: new URL(page.url()).origin },
  });
  expect(other.status()).toBe(200);

  await replaceText(page, '<h1>Mine</h1>\n');
  await page.keyboard.press('Control+s');
  const dialog = page.getByRole('dialog', { name: /was changed since you opened it/ });
  await expect(dialog).toBeVisible();
  expect(await onDisk(page, 'blog-drafts/garden-party.html')).toBe('<h1>Theirs</h1>\n');
  await dialog.getByRole('button', { name: /Keep mine/ }).click();
  await expect(notice(page)).toHaveText('Saved. What was there is kept as an earlier version.');
  expect(await onDisk(page, 'blog-drafts/garden-party.html')).toBe('<h1>Mine</h1>\n');

  // theirs is an earlier version: compare, then put it back
  await page.getByRole('button', { name: 'Earlier versions' }).click();
  const versions = page.getByRole('dialog', { name: 'Earlier versions of "garden-party.html"' });
  await expect(versions.getByRole('listitem').first()).toContainText('Replaced when pamela saved');
  await versions.getByRole('listitem').first().getByRole('button', { name: 'Compare' }).click();
  await expect(page.getByRole('dialog')).toContainText('Theirs');
  await page.getByRole('button', { name: 'Put this one back' }).click();
  await confirmDialog(page).getByRole('button', { name: 'Put it back' }).click();
  await expect(notice(page)).toHaveText('The earlier version is back. What was there before is kept as an earlier version too.');
  await expect(page.locator('.cm-content')).toContainText('Theirs');
  expect(await onDisk(page, 'blog-drafts/garden-party.html')).toBe('<h1>Theirs</h1>\n');
});

test('style sheets open in the editor too (no preview), with the Cloudflare note', async ({ page }) => {
  await page.goto('/files?path=blog-drafts');
  await page.getByRole('button', { name: 'New file' }).click();
  const dialog = page.getByRole('dialog', { name: 'New file' });
  await dialog.getByRole('radio', { name: /A style sheet/ }).check();
  await dialog.getByLabel('Name').fill('style');
  await dialog.getByRole('button', { name: 'Make and open' }).click();
  await expect(page).toHaveURL('/files/edit?path=blog-drafts%2Fstyle.css');
  await expect(page.getByRole('radiogroup', { name: 'Show' })).toHaveCount(0);
  await expect(page.getByText(/Cloudflare may keep showing visitors the old copy/)).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('max-width: 42rem;');
  // a name that's already there is refused, not overwritten
  await page.goto('/files?path=blog-drafts');
  await page.getByRole('button', { name: 'New file' }).click();
  await dialog.getByRole('radio', { name: /A style sheet/ }).check();
  await dialog.getByLabel('Name').fill('style.css');
  await dialog.getByRole('button', { name: 'Make and open' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('There\'s already something called "style.css" here. Choose another name.');
});
