// Visitor settings (docs/accounts-plan.md steps 1 and 4), in a browser: Settings > Visitors
// in the menu (docs/roles-plan.md step 1), every switch off, and each that can't be
// turned on says why. pammy.org's gate has no door to the mail service, so emailed
// links (and registering, which needs them) stay off here, and so does "Open with
// accounts" (roles step 5), which needs registering.
import { expect, test } from './fixtures.ts';

test('every visitor setting is off, and each says why it cannot be turned on yet', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open the menu' }).click();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Visitors', exact: true }).click();
  await expect(page).toHaveURL('/visitor-settings');
  await expect(page.getByRole('heading', { name: 'Visitor settings' })).toBeVisible();
  const list = page.getByRole('list', { name: 'Visitor settings' });
  for (const name of ['Emailed links', 'People can register themselves', 'People can change their own password', 'People can delete their own account', '"Open with accounts" areas']) {
    await expect(list.getByRole('switch', { name, exact: true })).not.toBeChecked();
  }
  for (const name of ['Emailed links', 'People can register themselves', '"Open with accounts" areas']) {
    await expect(list.getByRole('switch', { name, exact: true })).toBeDisabled();
  }
  await expect(list.getByText("Mail isn't set up for visitors on this site.")).toHaveCount(1);
  await expect(list.getByText('Needs "Emailed links" on first.')).toHaveCount(1);
  await expect(list.getByText('Needs "People can register themselves" on first.')).toHaveCount(1);
  await expect(list.getByText('This comes in a later release of the panel.')).toHaveCount(0);
  // the two that need nothing can be turned on (and are left off)
  for (const name of ['People can change their own password', 'People can delete their own account']) {
    await expect(list.getByRole('switch', { name, exact: true })).toBeEnabled();
  }
  await expect(list.getByText('Off: A forgotten password goes to Requests, and you pass a link on yourself.')).toBeVisible();
});
