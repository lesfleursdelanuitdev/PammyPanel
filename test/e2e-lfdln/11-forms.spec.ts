// Forms on lfdln (docs/phase8-plan.md step 8-5): a form kept to a site folder (P8-10), its
// starters without the examples, and Settings > Email saying which notices go out (the key
// and addresses are the installer's here).
import { expect, notice, test } from './fixtures.ts';

test('Forms: a form kept to a site folder; Email says which notices go out', async ({ page }) => {
  await page.goto('/hosts');
  const add = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Add a static folder' }) }).first();
  await add.getByLabel('Name').fill('contact');
  await add.getByRole('button', { name: 'Add folder' }).click();
  await expect(notice(page)).toContainText('Made. https://contact.lesfleursdelanuit.com/ shows it now.');

  await page.goto('/forms');
  await page.getByRole('button', { name: 'New form' }).click();
  // the forms module's own starters, with no examples module here
  await expect(page.getByRole('group', { name: 'What kind of form' }).getByRole('radio')).not.toHaveCount(1);
  await page.getByRole('textbox', { name: 'Name' }).fill('say-hello');
  await page.getByLabel('Works on').selectOption('contact');
  await page.getByRole('button', { name: 'Make it' }).click();
  await expect(page).toHaveURL(/\/forms\/\d+$/);
  await page.goto('/forms');
  await expect(page.getByRole('heading', { name: 'say-hello only in contact' })).toBeVisible();
  expect((await page.request.get('/api/examples')).status()).toBe(404);

  await page.goto('/email');
  await expect(page.getByText('set on the server, by its installer')).toBeVisible();
  await expect(page.getByLabel('Resend API key')).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'New responses to' }).getByText('say-hello')).toBeVisible();
});
