// Form links and Comments on lfdln (docs/phase8-plan.md step 8-6): a comment area made on
// Comments, the Inbox with its counts, and a form's "Save answers in a database" page.
import { expect, notice, test } from './fixtures.ts';

test('Comments: a comment area made; the Inbox; a form can save into a database', async ({ page }) => {
  await page.goto('/comments');
  await page.getByLabel('Name for the page').fill('site-talk');
  await page.getByLabel('Title (for you)').fill('Talk on my pages');
  await page.getByRole('button', { name: 'Make the comment area' }).click();
  await expect(notice(page)).toContainText('The comment area "Talk on my pages" is ready.');
  await expect(page.getByText('<pammy-comments name="site-talk"')).toBeVisible();
  // the counts behind the Inbox answer here
  const waiting = await page.request.get('/api/responses/unread');
  expect(waiting.status()).toBe(200);
  expect(await waiting.json()).toMatchObject({ comments: 0 });

  // a form (11-forms made say-hello) can save its answers into a database of the Studio's
  await page.goto('/forms');
  await page.locator('li, section').filter({ has: page.getByRole('heading', { name: /^say-hello/ }) }).getByRole('link', { name: 'Save answers in a database' }).first().click();
  await expect(page).toHaveURL(/\/forms\/\d+\/database$/);
  await expect(page.getByRole('heading', { name: 'Save answers in a database' })).toBeVisible();
});
