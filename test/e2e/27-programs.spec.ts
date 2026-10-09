// Letting programs in, in a browser (docs/databases-plan.md 11.3). The one
// page in the studio that can put her data on the internet, so what this file
// checks is mostly that it does NOT, until she says so twice: switch the app
// on, then switch reading on, then make a key.
import { confirmDialog, expect, notice, test } from './fixtures.ts';

const open = async (page: import('@playwright/test').Page) => {
  await page.goto('/databases');
  await expect(page.getByRole('list', { name: 'Your databases' })).toBeVisible();
  const adopt = page.getByRole('listitem').filter({ hasText: 'family_recipes' })
    .getByRole('button', { name: 'Look after this one' });
  if (await adopt.count()) {
    await adopt.first().click();
    await expect(notice(page)).toContainText('looking after family_recipes');
  }
  await page.goto('/databases/postgres/family_recipes/app');
  await expect(page.getByRole('list', { name: 'Managed' })).toBeVisible();
  const on = page.getByRole('button', { name: 'Switch the app on' });
  if (await on.count()) {
    await on.click();
    await expect(notice(page)).toContainText('is switched on');
  }
  await page.goto('/databases/postgres/family_recipes/programs');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
};

test('switching the app on does not put anything on the internet', async ({ page }) => {
  await open(page);
  await expect(page.getByRole('switch', { name: 'Programs may read' })).not.toBeChecked();
  await expect(page.getByRole('switch', { name: 'Programs may change' })).not.toBeChecked();
  // and writing cannot even be reached until reading is on
  await expect(page.getByRole('switch', { name: 'Programs may change' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'New key' })).toBeDisabled();
});

test('she switches reading on, makes a key, and sees it exactly once', async ({ page }) => {
  await open(page);
  await page.getByRole('switch', { name: 'Programs may read' }).click();
  await expect(notice(page)).toContainText('Saved.');
  await expect(page.getByRole('switch', { name: 'Programs may read' })).toBeChecked();

  await page.getByRole('button', { name: 'New key' }).click();
  await page.getByLabel('What is it for?').fill("Olivia's website");
  await page.getByRole('button', { name: 'Make the key' }).click();
  await expect(notice(page)).toContainText('Copy it now');

  const shown = await page.getByRole('heading', { name: 'Your new key' });
  await expect(shown).toBeVisible();
  const key = await page.locator('code').first().innerText();
  expect(key).toMatch(/^pammy_app_/);

  // it is in the list, by name, and never shown again
  await expect(page.getByRole('list', { name: 'Keys' })).toContainText("Olivia's website");
  await expect(page.getByRole('list', { name: 'Keys' })).toContainText('can only read');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your new key' })).toHaveCount(0);
  expect(await page.content()).not.toContain(key);
});

test('a key can be stopped, and switching the app off stops them all', async ({ page }) => {
  await open(page);
  const keys = page.getByRole('list', { name: 'Keys' });
  await keys.getByRole('button', { name: 'Stop it working' }).first().click();
  await confirmDialog(page).getByRole('button', { name: 'Stop it working' }).click();
  await expect(notice(page)).toContainText('has stopped working');
  await expect(page.getByRole('list', { name: 'Stopped keys' })).toContainText("Olivia's website");

  // switching the app off takes the switches with it
  await page.goto('/databases/postgres/family_recipes/app');
  await page.getByRole('button', { name: 'Switch the app off' }).click();
  await confirmDialog(page).getByRole('button', { name: 'Switch it off' }).click();
  await expect(notice(page)).toContainText('is switched off');

  await page.goto('/databases/postgres/family_recipes/programs');
  await expect(page.getByText('The app is not switched on')).toBeVisible();

  // and switching it back on does not quietly let programs back in
  await page.goto('/databases/postgres/family_recipes/app');
  await page.getByRole('button', { name: 'Switch the app on' }).click();
  await expect(notice(page)).toContainText('is switched on');
  await page.goto('/databases/postgres/family_recipes/programs');
  await expect(page.getByRole('switch', { name: 'Programs may read' })).not.toBeChecked();
});
