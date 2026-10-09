import { confirmDialog, expect, notice, test } from './fixtures.ts';

test('protect a folder, add a person with a password, choose who can open it, stop protecting', async ({ page }) => {
  await page.goto('/protected-folders');
  await expect(page.getByRole('link', { name: 'How protected folders and sign-in pages work' })).toHaveAttribute('href', '/help/protected-folders');
  await page.getByRole('button', { name: 'Protect', exact: true }).click();
  await expect(notice(page, 'error')).toHaveText('Pick a folder to protect.');

  // the folder picker: every folder listed, narrowed as you type, protected ones greyed out
  const box = page.getByRole('combobox', { name: 'Folder' });
  const list = page.getByRole('listbox', { name: 'Folder: folders' });
  await expect(list.getByRole('option', { name: /^family\s*protected$/ })).toHaveAttribute('aria-disabled', 'true');
  await expect(list.getByRole('option', { name: /^family\s*protected$/ })).toContainText('protected');
  const total = await list.getByRole('option').count();
  expect(total).toBeGreaterThanOrEqual(4);
  await expect(page.getByText(`${total} folders`, { exact: true })).toBeVisible();
  await box.fill('ECI');                                               // anywhere in the name, capitals ignored
  await expect(list.getByRole('option')).toHaveText(['recipes']);
  await expect(page.getByText(`1 of ${total} folders`)).toBeVisible();
  await expect(list.locator('span.bg-yellow-200')).toHaveText('eci');
  await box.fill('zzz');
  await expect(list).toContainText('No folders match "zzz".');
  await box.fill('fam');
  await list.getByRole('option', { name: /^family\s*protected$/ }).click({ force: true });
  await expect(box).toHaveValue('fam');                                // a protected folder can't be picked
  await box.fill('');
  await box.press('ArrowDown');
  await box.press('Enter');
  await expect(box).not.toHaveValue('');                               // the arrow keys and Enter pick one
  await box.fill('rec');
  await list.getByRole('option', { name: 'recipes' }).click();
  await expect(box).toHaveValue('recipes');
  await expect(list.getByRole('option', { name: 'recipes' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Protect', exact: true }).click();
  await expect(notice(page)).toHaveText('"recipes" is protected. Starter files put in it, to change as you like: login.html, login-forgot.html, login-invite.html, login-request.html, logout.html, login-files/style.css. Now choose who can open it.');
  const card = page.locator('article').filter({ has: page.getByRole('heading', { name: 'recipes' }) });
  await expect(card).toContainText('Sign-in pages: all its own (login.html, login-forgot.html, login-invite.html, login-request.html, logout.html). Their look: login-files/style.css.');
  await expect(card.getByRole('button', { name: 'Add the missing starter pages' })).toHaveCount(0);
  await expect(page.getByRole('listbox', { name: 'Folder: folders' }).getByRole('option', { name: /^recipes/ })).toHaveAttribute('aria-disabled', 'true');
  await expect(card.getByRole('link', { name: 'recipes.pammy.org/' })).toBeVisible();

  // the "add a person" part is open for a folder just protected
  await card.getByLabel('Username').fill('uncle.bob');
  await card.getByLabel('Name (only you see it)').fill('Uncle Bob');
  await card.getByLabel("I'll set it now").click();
  await card.getByRole('button', { name: 'Make one up' }).click();
  await expect(card.getByLabel('Password', { exact: true })).toHaveValue(/^[a-zA-Z2-9]{4}(-[a-zA-Z2-9]{4}){3}$/);
  await card.getByRole('button', { name: 'Add person' }).click();
  await expect(notice(page)).toHaveText('uncle.bob can open "recipes".');
  const creds = card.getByTestId('credentials');
  await expect(creds).toContainText('Username: uncle.bob');
  await expect(creds).toContainText('Sign in at: https://pammy.org/recipes/');
  await creds.getByRole('button', { name: 'Copy' }).click();
  await expect(notice(page)).toHaveText('Username and password copied.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^Username: uncle\.bob\nPassword: \S+\nSign in at: https:\/\/pammy\.org\/recipes\/$/);
  await creds.getByRole('button', { name: 'Done' }).click();
  await expect(creds).toBeHidden();

  const jo = card.getByRole('checkbox', { name: 'Auntie Jo (auntie.jo)' });
  await expect(jo).not.toBeChecked();
  await jo.click();
  await expect(notice(page)).toHaveText('auntie.jo can now open "recipes".');
  await expect(jo).toBeChecked();

  const requests = card.getByLabel('Let people ask for access');
  await expect(requests).toBeChecked();                    // on, for a newly protected folder
  await requests.click();
  await expect(notice(page)).toHaveText('"recipes" no longer takes requests.');
  await expect(requests).not.toBeChecked();
  await requests.click();
  await expect(notice(page)).toContainText('People can ask for access to "recipes". Requests appear on the Requests page.');
  await expect(requests).toBeChecked();

  await card.getByRole('button', { name: 'Stop protecting' }).click();
  await confirmDialog(page).getByRole('button', { name: 'Stop protecting' }).click();
  await expect(notice(page)).toHaveText('"recipes" is open to everyone again.');
  await expect(card).toBeHidden();
});

test('a folder inside a protected folder: marked, warned about, and a second lock only after saying so', async ({ page }) => {
  await page.goto('/protected-folders');
  const box = page.getByRole('combobox', { name: 'Folder' });
  const photos = page.getByRole('listbox', { name: 'Folder: folders' }).getByRole('option', { name: /^family\/photos/ });
  await expect(photos).toContainText('inside family');
  await expect(photos).not.toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('note')).toHaveCount(0);
  await photos.click();
  await expect(box).toHaveValue('family/photos');
  await expect(page.getByRole('note')).toHaveText(`"family/photos" is already locked, because it's inside the protected folder "family". Protecting it too adds a second lock: people would need to be let into both.`);

  const card = page.locator('article').filter({ has: page.getByRole('heading', { name: /^family\/photos/ }) });
  await page.getByRole('button', { name: 'Protect', exact: true }).click();
  await expect(confirmDialog(page)).toContainText('"family/photos" is already protected');
  await expect(confirmDialog(page)).toContainText('people will need to be let into both "family" and "family/photos"');
  await confirmDialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(card).toHaveCount(0);

  await page.getByRole('button', { name: 'Protect', exact: true }).click();
  await confirmDialog(page).getByRole('button', { name: 'Add a second lock' }).click();
  await expect(notice(page)).toContainText('"family/photos" is protected.');
  await expect(notice(page)).toContainText('They also need to be let into "family".');
  await expect(card).toBeVisible();

  await card.getByRole('button', { name: 'Stop protecting' }).click();
  await confirmDialog(page).getByRole('button', { name: 'Stop protecting' }).click();
  await expect(notice(page)).toHaveText('"family/photos" is open to everyone again.');
  await expect(card).toBeHidden();
});
