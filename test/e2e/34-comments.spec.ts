// Comments in a browser (docs/comments-plan.md): a comment area made on the
// Comments tab, put on a real page of the website (recipes/index.html, served
// here with the two lines in it), a comment sent from it, waiting, approved in
// the panel, and then on the page. The gate is the real one (routeGate).
import type { Page } from '@playwright/test';
import { expect, notice, test } from './fixtures.ts';
import { routeGate } from './gate.ts';

const PAGE = '/recipes/index.html';
const onHerPage = (page: Page, name: string) => page.route(`**${PAGE}`, (route) => route.fulfill({
  contentType: 'text/html; charset=utf-8',
  body: `<!doctype html><html><head><title>Recipes</title></head><body><h1>Recipes</h1>
    <script src="/_pammy/comments.js" defer></script>
    <pammy-comments name="${name}"></pammy-comments></body></html>`,
}));

test('comments: an area made, a comment sent from a page, waiting, approved, and shown', async ({ page }) => {
  await routeGate(page);
  await page.goto('/comments');
  await page.getByLabel('Name for the page').fill('recipe-page-comments');
  await page.getByLabel('Title (for you)').fill('Comments on the recipes page');
  await page.getByRole('button', { name: 'Make the comment area' }).click();
  await expect(notice(page)).toContainText('is ready');
  await expect(page.getByRole('button', { name: 'Code for a page' }).first()).toBeVisible();

  // on her page
  await onHerPage(page, 'recipe-page-comments');
  await page.goto(PAGE);
  const box = page.locator('pammy-comments');
  await expect(box.locator('.pammy-comment-count')).toHaveText('No comments yet.');
  await box.getByLabel('Your name').fill('Rose');
  await box.getByLabel('Your comment').fill('The lemon loaf is wonderful.\nThank you!');
  await box.getByRole('button', { name: 'Send' }).click();
  await expect(box.locator('.pammy-sent')).toContainText('once it has been approved');
  await expect(box.locator('.pammy-comment')).toHaveCount(0);

  // waiting in the panel, with the page it is on
  await page.goto('/comments');
  const row = page.getByRole('listitem').filter({ hasText: 'The lemon loaf is wonderful.' });
  await expect(row).toContainText('Rose');
  await expect(row).toContainText('on /recipes/');
  await row.getByRole('button', { name: 'Approve' }).click();
  await expect(notice(page)).toContainText('on your page now');

  // and on the page
  await page.goto(PAGE);
  await expect(box.locator('.pammy-comment-count')).toHaveText('1 comment');
  await expect(box.locator('.pammy-comment-author')).toHaveText('Rose');
  await expect(box.locator('.pammy-comment-body')).toHaveText('The lemon loaf is wonderful.\nThank you!');
});

test('comment areas live on Comments, not in Forms or Responses', async ({ page }) => {
  await page.goto('/forms');
  await expect(page.getByText('Comment areas live in')).toBeVisible();
  await expect(page.getByRole('article').filter({ hasText: 'Comments on the recipes page' })).toHaveCount(0);
  await page.goto('/responses');
  await expect(page.getByRole('listitem').filter({ hasText: 'The lemon loaf is wonderful.' })).toHaveCount(0);
});
