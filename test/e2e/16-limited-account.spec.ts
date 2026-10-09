import { addAuthenticator, expect, notice, test, watchForProblems } from './fixtures.ts';

// An account that only sees one folder (docs/media-plan.md D22-D25): here badmon,
// kept to recipes. test/e2e/server.ts makes it on 3198 and hands over its setup link.
test('an account kept to one folder sees only that folder\'s media, forms and responses', async ({ browser, page: pamela }) => {
  const r = await fetch('http://127.0.0.1:3198/limited', { method: 'POST' });
  const { token } = await r.json() as { token: string };
  const context = await browser.newContext({ storageState: undefined, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const problems = watchForProblems(page);
  await addAuthenticator(page, false);
  await page.goto(`/invite#${token}`);
  await page.getByLabel('Name this passkey').fill('badmon laptop');
  await page.getByRole('button', { name: 'Create passkey' }).click();
  await expect(page).toHaveURL('/passkeys');

  // the menu: only its own things
  await page.getByRole('button', { name: 'Open the menu' }).click();
  const nav = page.getByRole('navigation', { name: 'Sections' });
  await expect(nav.getByRole('link')).toHaveText(['Home', 'Responses', 'Comments', 'File Explorer', 'Tags & categories', 'Media', 'Media examples', 'Forms', 'Passkeys & devices', 'Activity', 'Help']);
  await page.keyboard.press('Escape');

  await page.goto('/');
  await expect(page.getByTestId('limited-to')).toHaveText('You look after recipes: every part of the panel you have shows only what is in it.');
  await expect(page.getByRole('link', { name: /Waiting requests/ })).toHaveCount(0);
  for (const hidden of ['/people', '/subdomains', '/accounts', '/api-keys', '/examples', '/media/folders']) {
    await page.goto(hidden);
    await expect(page).toHaveURL('/');
  }
  // Activity: what it did itself, nobody else's (docs/permissions-plan.md R7)
  await page.goto('/activity');
  await expect(page.getByText('What you have done in the panel, newest first.', { exact: false })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Activity' }).getByRole('listitem').first()).toContainText('badmon');
  await expect(page.getByRole('list', { name: 'Activity' })).not.toContainText('pamela');

  // Help: its own guide and the forms guide, not Pamela's others
  await page.goto('/help');
  await expect(page.getByRole('link', { name: /Looking after one folder/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /^10 Forms/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Your control panel/ })).toHaveCount(0);
  await page.goto('/help/one-folder');
  await expect(page.getByRole('heading', { name: 'Looking after one folder', level: 1 })).toBeVisible();

  // media: recipes only, no "All media folders", no making media folders elsewhere
  await page.goto('/media?folder=*');
  const site = page.locator('#media-site');
  await expect(site.locator('option')).toHaveText(['recipes']);
  await expect(page.locator('summary', { hasText: 'Make a media folder' })).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Files' })).toContainText('cake.png');

  // forms: a new one is recipes'; pamela's everywhere-forms aren't there
  await page.goto('/forms');
  await expect(page.getByText('sample-contact-form')).toHaveCount(0);
  await page.getByRole('button', { name: 'New form' }).click();
  await expect(page.getByText('It works on the pages in recipes.')).toBeVisible();
  await page.getByLabel('Name').fill('recipes-questions');
  await page.getByRole('button', { name: 'Make it' }).click();
  await expect(page).toHaveURL(/\/forms\/\d+$/);
  await page.goto('/forms');
  await expect(page.locator('article').filter({ hasText: 'recipes-questions' }).getByText('only in recipes', { exact: true })).toBeVisible();
  expect(problems).toEqual([]);

  // pamela sees it too, can let it work everywhere, and sees what badmon may use
  await pamela.goto('/forms');
  const card = pamela.locator('article').filter({ hasText: 'recipes-questions' });
  await card.getByLabel('Where "recipes-questions" works').selectOption({ label: 'Works on every page' });
  await expect(card.getByText('only in recipes', { exact: true })).toHaveCount(0);
  await pamela.goto('/accounts');
  const row = pamela.getByRole('listitem').filter({ hasText: '(badmon)' }).first();
  await expect(row).toContainText('only recipes');

  // two places, and protected folders too (docs/permissions-plan.md step 3)
  await row.getByRole('button', { name: 'What they can use' }).click();
  const dialog = pamela.getByRole('dialog', { name: 'What Badmon can use' });
  await expect(dialog.getByRole('checkbox', { name: /^Databases/ })).toBeDisabled();
  await expect(dialog.getByRole('checkbox', { name: /^Databases/ })).toHaveAccessibleName(/Not for someone kept to folders yet/);
  await dialog.getByRole('checkbox', { name: 'family', exact: true }).check();
  await dialog.getByRole('checkbox', { name: /^Protected folders/ }).check();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(notice(pamela)).toHaveText('Saved. Badmon has it from their next click.');
  await expect(row).toContainText('only family, recipes');

  // badmon: no signing in again; the new part is there, with only its places
  await page.goto('/protected-folders');
  await expect(page.getByRole('heading', { name: 'Protected folders', level: 1 })).toBeVisible();
  await expect(page.locator('#area-list, main').getByText('family', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Open the menu' }).click();
  await expect(nav.getByRole('link', { name: 'Protected folders' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Subdomains' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  expect(problems).toEqual([]);
  await context.close();

  // and back to the whole site, with what members always had
  await row.getByRole('button', { name: 'What they can use' }).click();
  await dialog.getByRole('radio', { name: 'The whole site' }).check();
  await dialog.getByRole('checkbox', { name: /^Subdomains/ }).check();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(row).not.toContainText('only recipes');
  await expect(row).toContainText('Subdomains');
});
