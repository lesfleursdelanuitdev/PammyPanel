// "Show right away" (docs/auto-approve-plan.md): a form whose new responses go up
// as they arrive, and switching it back offers to take down what nobody has
// looked at. The gate is the real one (gate.ts), so sending really does land
// in Responses already approved.
import { routeGate } from './gate.ts';
import { confirmDialog, expect, notice, test } from './fixtures.ts';

test.beforeEach(async ({ page }) => routeGate(page));

// As a visitor on her website would: through the gate, from a page of hers.
const sign = (page: import('@playwright/test').Page, name: string, message: string) => page.evaluate(async ([n, m]) => {
  const res = await fetch('/_pammy/forms/quick-guests', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ page: '/quick.html', answers: { 'your-name': n, message: m } }),
  });
  return res.status;
}, [name, message]);

test('show new responses right away, then go back and take down what nobody looked at', async ({ page }) => {
  // a guest book of her own
  await page.goto('/forms');
  await page.getByRole('button', { name: 'New form' }).click();
  await page.getByText('Guest book', { exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('quick-guests');
  await page.getByRole('button', { name: 'Make it' }).click();
  await expect(page).toHaveURL(/\/forms\/\d+$/);
  const formId = page.url().split('/').pop();

  await page.goto('/forms');
  const card = page.locator('article').filter({ hasText: 'quick-guests' });
  const approving = card.getByRole('switch', { name: 'Responses can be approved' });
  if (!await approving.isChecked()) await approving.click();

  // waiting for her OK is where every form starts
  const wait = card.getByRole('radio', { name: /Wait for my OK/ });
  const now = card.getByRole('radio', { name: /Show right away/ });
  await expect(wait).toBeChecked();
  await expect(card.getByText('no robot check yet')).toBeVisible();
  await now.click();                       // checked once the server says so
  await expect(notice(page)).toHaveText('New responses now show right away.');
  await expect(now).toBeChecked();
  await expect(card.getByText('shown right away', { exact: true })).toBeVisible();

  // a visitor signs it: approved at once, and still unread so she notices
  expect(await sign(page, 'Speedy Sue', 'Up it goes')).toBe(200);
  await page.goto(`/responses?form=${formId}`);
  const sue = page.getByRole('listitem').filter({ hasText: 'Up it goes' });
  await expect(sue.getByText('unread', { exact: true })).toBeVisible();
  await expect(sue.getByText('approved', { exact: true })).toBeVisible();
  await expect(sue).toContainText('approved automatically');
  await expect(sue.getByRole('button', { name: 'Unapprove' })).toBeVisible();

  // back to waiting: she is offered the undo for what went up unseen
  await page.goto('/forms');
  await wait.click();
  await expect(confirmDialog(page)).toContainText('Also hide the 1 response nobody has looked at?');
  await confirmDialog(page).getByRole('button', { name: 'Hide it' }).click();
  await expect(notice(page)).toHaveText('1 response hidden.');
  await expect(card.getByText('shown right away', { exact: true })).toHaveCount(0);

  await page.goto(`/responses?form=${formId}`);
  await expect(sue.getByText('approved', { exact: true })).toHaveCount(0);
  await expect(sue.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();

  // the examples don't offer the choice at all
  await page.goto('/forms');
  await expect(page.locator('article').filter({ hasText: 'example-guest-book' }).getByRole('radio')).toHaveCount(0);
});
