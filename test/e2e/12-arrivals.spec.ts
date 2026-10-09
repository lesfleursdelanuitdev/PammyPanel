import { expect, test } from './fixtures.ts';

// test/e2e/server.ts listens on 3198 for "a visitor sent something".
const arrive = async (what: 'message' | 'request') => {
  const r = await fetch(`http://127.0.0.1:3198/${what}`, { method: 'POST' });
  expect(r.status).toBe(204);
};

test('a new message and a new request show on home within a minute, without reloading', async ({ page }) => {
  await page.clock.install();
  await page.goto('/');
  const messages = page.getByTestId('stat-responses');
  const requests = page.getByTestId('stat-requests');
  const before = { m: Number(await messages.textContent()), r: Number(await requests.textContent()) };
  expect(Number.isNaN(before.m) || Number.isNaN(before.r)).toBe(false);

  await arrive('message');
  await arrive('request');
  await page.clock.runFor(61_000);

  await expect(messages).toHaveText(String(before.m + 1));
  await expect(requests).toHaveText(String(before.r + 1));
  await expect(page.getByRole('list', { name: 'New responses' }).getByRole('listitem').first()).toContainText('Is the bakery open on Sundays?');
  await expect(page.getByRole('list', { name: 'Waiting requests' })).toContainText('Tom Baker');
  await expect(page.getByTestId('menu-dot')).toBeVisible();
});
