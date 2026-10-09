// First steps on lfdln's Home (docs/phase9-plan.md 9-3): a second passkey, Start here, and a
// line per part the person can change, linking to its page and guide. Put away from Home,
// brought back from Help.
import { addAuthenticator, expect, test } from './fixtures.ts';

test("the admin's card: one passkey so far, Start here to read, and every part with its page and guide", async ({ page }) => {
  await page.goto('/');
  const card = page.getByTestId('first-steps');
  await expect(card.getByRole('heading', { name: 'First steps' })).toBeVisible();
  await expect(card.getByText('0 of 2 done')).toBeVisible();
  await expect(card.getByTestId('step-passkey')).toHaveAttribute('data-state', 'todo');
  await expect(card.getByTestId('step-read')).toContainText('Read “Start here”');
  const parts = card.getByRole('list', { name: 'What you can change' });
  await expect(parts.getByRole('listitem').first()).toContainText('Accounts');
  await expect(parts).toContainText('Visitors');
  await expect(parts.getByRole('link', { name: 'People' })).toHaveAttribute('href', '/people');
  await parts.getByRole('link', { name: 'Guide: Domains, hosts and routes' }).click();
  await expect(page).toHaveURL('/help/domains-hosts-and-routes');
});

test("I've read it, then put away, and back from Help", async ({ page }) => {
  await page.goto('/');
  const card = page.getByTestId('first-steps');
  await card.getByRole('button', { name: "I've read it" }).click();
  await expect(card.getByTestId('step-read')).toHaveAttribute('data-state', 'done');
  await expect(card.getByText('1 of 2 done')).toBeVisible();
  await card.getByRole('button', { name: 'Not read after all' }).click();
  await expect(card.getByTestId('step-read')).toHaveAttribute('data-state', 'todo');

  await card.getByRole('button', { name: "I'm done with this" }).click();
  await expect(card).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('first-steps')).toHaveCount(0);
  await page.goto('/help');
  await page.getByRole('button', { name: 'Show first steps on Home' }).click();
  await expect(page.getByRole('button', { name: 'Show first steps on Home' })).toHaveCount(0);
  await page.goto('/');
  await expect(page.getByTestId('first-steps')).toBeVisible();
});

test('someone kept to one host: their second passkey ticked, and only Hosts to change', async ({ browser }) => {
  // ericka (03-accounts) gets a second passkey from a new setup link
  const r = await fetch('http://127.0.0.1:3298/kept/docs', { method: 'POST' });
  const { token } = await r.json() as { token: string };
  const context = await browser.newContext();
  const page = await context.newPage();
  await addAuthenticator(page, false);
  await page.goto(`/invite#${token}`);
  await page.getByLabel('Name this passkey').fill('ericka laptop');
  await page.getByRole('button', { name: 'Create passkey' }).click();
  await expect(page).toHaveURL('/passkeys');

  await page.goto('/');
  const card = page.getByTestId('first-steps');
  await expect(card.getByTestId('step-passkey')).toHaveAttribute('data-state', 'done');
  await expect(card.getByTestId('step-passkey')).toContainText('You have 2.');
  const parts = card.getByRole('list', { name: 'What you can change' });
  await expect(parts.getByRole('listitem')).toHaveCount(1);
  await expect(parts).toContainText('Hosts');
  await expect(parts.getByRole('link', { name: 'Guide: Domains, hosts and routes' })).toBeVisible();
  await context.close();
});
