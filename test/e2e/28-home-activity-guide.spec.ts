// Slice 10 of the studio in a browser (docs/databases-plan.md 16): Home knows
// about her databases, the Activity page says in words what happened to them,
// Review says what a change does to a switched-on app, the programs page names
// its addresses, and guide 14 is on the Help tab.
//
// The world is shared with specs 21-27 (docs: pammy e2e shared world), so every
// test here brings family_recipes to the state it needs, and leaves no drawing
// behind for anything after it.
import { confirmDialog, expect, notice, test } from './fixtures.ts';

// family_recipes looked after and its app switched on, however earlier specs
// left it
const switchedOn = async (page: import('@playwright/test').Page) => {
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
};

test('Home says a change is waiting, Review says what it does to the app, and Home opens the app', async ({ page }) => {
  await switchedOn(page);
  await page.goto('/databases/postgres/family_recipes');
  await expect(page.getByRole('list', { name: 'Tables' })).toBeVisible();
  await page.getByRole('button', { name: 'Add table' }).click();
  await confirmDialog(page).getByRole('textbox').fill('menus');
  await confirmDialog(page).getByRole('button', { name: 'Add it' }).click();
  await expect(notice(page)).toContainText('Nothing has changed in the database yet.');

  // Review: the app is on, and a new table is not added to it by itself
  await page.goto('/databases/postgres/family_recipes/review');
  const affected = page.getByRole('heading', { name: / is switched on$/ });
  await expect(affected).toBeVisible();
  await expect(page.getByText(/^None of these change anything .* already manages\.$/)).toBeVisible();
  await expect(page.getByText(/The new table menus is not added to .* by itself\./)).toBeVisible();
  await expect(page.getByText(/is switched on, so you will be asked for your passkey\./)).toBeVisible();

  // Home: counted against the database, and a way straight to Review
  await page.goto('/');
  const card = page.getByRole('region', { name: 'Databases' });
  const waiting = card.getByRole('link', { name: /^family_recipes: 1 change not applied yet/ });
  await expect(waiting).toHaveAttribute('href', '/databases/postgres/family_recipes/review');
  await expect(waiting).toContainText('is switched on, so applying it changes it too.');

  // and the app itself, starting where the menu starts
  const open = card.getByRole('link', { name: /^Open / });
  await expect(open).toHaveAttribute('href', /^\/app\/postgres\/family_recipes\//);
  await open.click();
  await expect(page).toHaveURL(/\/app\/postgres\/family_recipes\//);

  // leave no drawing behind for the specs after this one
  await page.goto('/databases/postgres/family_recipes');
  await page.getByRole('button', { name: 'Throw them away' }).click();
  await confirmDialog(page).getByRole('button', { name: 'Throw it away' }).click();
  await expect(page.getByText('Not applied yet')).toBeHidden();
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Databases' }).getByRole('link', { name: /not applied yet/ })).toHaveCount(0);
});

test('the programs page says where programs ask', async ({ page }) => {
  await switchedOn(page);
  await page.goto('/databases/postgres/family_recipes/programs');
  const read = page.getByRole('switch', { name: 'Programs may read' });
  await expect(read).toBeVisible();
  // nothing to name while programs are shut out
  await expect(page.getByRole('heading', { name: 'Where programs ask' })).toHaveCount(0);
  await read.click();
  await expect(notice(page)).toContainText('Saved.');
  await expect(page.getByRole('list', { name: 'Addresses for programs' }))
    .toContainText('/_pammy/api/data/postgres/family_recipes/recipes');
  await read.click();
  await expect(read).not.toBeChecked();
});

test('the Activity page says what happened to her databases in words', async ({ page }) => {
  await page.goto('/activity');
  const log = page.getByRole('list', { name: 'Activity' });
  await expect(log.getByText(/switched on the app for family_recipes on Postgres/).first()).toBeVisible();
  await expect(log.getByText(/changed whether programs can reach family_recipes on Postgres \(programs may read\)/).first()).toBeVisible();
  // never the bare action name
  await expect(log.getByText(/database-activated|database-api-changed|schema-applied/)).toHaveCount(0);
});

test('guide 14 is on the Help tab, and Help finds it', async ({ page }) => {
  await page.goto('/help');
  await page.getByRole('link', { name: /Databases in the control panel/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Databases in the control panel', level: 1 })).toBeVisible();
  await expect(page.getByText('The four kinds of access').first()).toBeVisible();
  await page.goto('/help?q=connecting%20table');
  await expect(page.getByText(/^\d+ places? in your guides\.$/)).toBeVisible();
});
