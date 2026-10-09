// Help on lfdln (docs/phase9-plan.md 9-1): its own guides, its own words, no Getting started,
// and no links into guides it doesn't have.
import { expect, test } from './fixtures.ts';

test("Help lists lfdln's guides in its own words, opens one, and searches them", async ({ page }) => {
  await page.goto('/help');
  await expect(page).toHaveTitle('Help · lesfleursdelanuit.com panel');
  await expect(page.getByText("The panel's guides: plain words first, with parts for programmers.")).toBeVisible();
  await expect(page.getByText(/instructions folder/)).toHaveCount(0);
  // Getting started is pammy.org's: no card here, and no page
  await expect(page.getByText(/Getting started/)).toHaveCount(0);
  await expect(page.getByPlaceholder('e.g. route, passkey, open with accounts, deletion hook')).toBeVisible();
  await expect(page.getByRole('link', { name: /Start here/ })).toBeVisible();
  await page.getByRole('link', { name: /Visitors: accounts, roles and access/ }).click();
  await expect(page).toHaveURL('/help/visitors');
  await expect(page.getByRole('heading', { name: /Visitors: accounts, roles and access/, level: 1 })).toBeVisible();
  await page.goto('/help?q=deletion%20hook');
  await expect(page.getByRole('list', { name: 'Search results' }).getByRole('link').first()).toContainText('Visitors: accounts, roles and access');
  await page.goto('/getting-started');
  await expect(page).toHaveURL('/');
});

test('links into Help only for guides lfdln has: Forms and the databases, but no "Form or database?"', async ({ page }) => {
  await page.goto('/forms');
  await expect(page.getByRole('heading', { name: 'Forms', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Form or database?' })).toHaveCount(0);
  await page.getByRole('link', { name: 'How forms work' }).click();
  await expect(page).toHaveURL('/help/forms-and-comments');
  await expect(page.getByRole('heading', { name: 'Forms, responses and comments', level: 1 })).toBeVisible();
  await page.goto('/databases');
  await expect(page.getByRole('link', { name: 'Form or database?' })).toHaveCount(0);
  await page.getByRole('link', { name: 'About databases' }).click();
  await expect(page).toHaveURL('/help/databases');
  await expect(page.getByRole('heading', { name: 'Databases', level: 1 })).toBeVisible();
});

test('the Hosts page links to its guide, and the guide is there', async ({ page }) => {
  await page.goto('/hosts');
  await page.getByRole('link', { name: 'How hosts work' }).click();
  await expect(page).toHaveURL('/help/domains-hosts-and-routes');
  await expect(page.getByRole('heading', { name: 'Domains, hosts and routes', level: 1 })).toBeVisible();
});
