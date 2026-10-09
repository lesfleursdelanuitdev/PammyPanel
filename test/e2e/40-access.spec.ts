// The Access page (docs/roles-plan.md step 4), in a browser: roles switched on
// in Settings > Visitors, "family" copied to roles of its own, a resource and a
// role made, Auntie Jo given it and back, and the folder back on the built-in
// roles, so the specs after this one see "family" as it was.
import { expect, test } from './fixtures.ts';

const rolesSwitch = 'Roles and privileges on the Access page';

test('a folder gets roles of its own, a person one of them, and goes back', async ({ page }) => {
  // off: no link from the folder, and the page says how to turn them on
  await page.goto('/protected-folders');
  const card = page.locator('article', { has: page.getByRole('heading', { name: 'family' }) });
  await expect(card.getByRole('link', { name: 'Roles and privileges' })).toHaveCount(0);

  await page.goto('/visitor-settings');
  const sw = page.getByRole('list', { name: 'Visitor settings' }).getByRole('switch', { name: rolesSwitch, exact: true });
  await expect(sw).toBeEnabled();
  await sw.click();
  await expect(sw).toBeChecked();

  await page.goto('/protected-folders');
  await card.getByRole('link', { name: 'Roles and privileges' }).click();
  await expect(page).toHaveURL(/\/access\/\d+$/);
  await expect(page.getByRole('heading', { name: 'Access to family' })).toBeVisible();
  await expect(page.getByText('built in', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Copy to change' }).click();
  await expect(page.getByText('This folder has roles of its own now. Change them below.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to the built-in roles' })).toBeVisible();

  // Privileges: a resource with an owner
  const tabs = page.getByRole('navigation', { name: 'Access' });
  await tabs.getByRole('link', { name: 'Privileges' }).click();
  const add = page.locator('section', { has: page.getByRole('heading', { name: 'Add a resource' }) });
  await add.getByLabel('Name').fill('Notes');
  await add.getByRole('checkbox', { name: 'change (update)' }).click();
  await add.getByRole('switch', { name: /Has an owner/ }).click();
  await add.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText('Saved "Notes".')).toBeVisible();

  // Roles: a new role that may open the pages and change its own notes
  await tabs.getByRole('link', { name: 'Roles' }).click();
  await page.getByLabel('Its name').fill('Editor');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Added "Editor".')).toBeVisible();
  const editor = page.locator('details', { has: page.locator('summary', { hasText: 'Editor' }) });
  await editor.locator('summary').click();
  await editor.getByRole('checkbox', { name: 'Open the pages' }).click();
  await editor.getByRole('checkbox', { name: 'Notes: change (their own)' }).click();
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved "Editor".')).toBeVisible();
  await expect(editor.getByText(/Can: .*notes: change \(their own\)/)).toBeVisible();

  // People: Auntie Jo is Editor, then Member again
  await tabs.getByRole('link', { name: 'People' }).click();
  const jo = page.getByLabel(/auntie\.jo/);
  await jo.selectOption({ label: 'Editor' });
  await expect(page.getByText('auntie.jo is Editor here now.')).toBeVisible();
  await jo.selectOption({ label: 'Member' });
  await expect(page.getByText('auntie.jo is Member here now.')).toBeVisible();

  // roles can't be switched off while the folder has its own
  await page.goto('/visitor-settings');
  await sw.click();
  await expect(page.getByText('First put "family" back on the built-in roles (Access, Roles).')).toBeVisible();

  await page.goto('/protected-folders');
  await card.getByRole('link', { name: 'Roles and privileges' }).click();
  await page.getByRole('button', { name: 'Back to the built-in roles' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Go back' }).click();
  await expect(page.getByText('Back on the built-in roles.')).toBeVisible();
  await expect(page.getByText('built in', { exact: true })).toBeVisible();

  await page.goto('/visitor-settings');
  await sw.click();
  await expect(sw).not.toBeChecked();
});
