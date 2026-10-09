import { readFileSync } from 'node:fs';
import { expect, notice, test } from './fixtures.ts';

// pammy.org itself isn't part of this test server: its example pages and login.js
// come straight from public-gate/, as the gate serves them.
const gateFile = (path: string) => readFileSync(new URL(`../../public-gate/${path}`, import.meta.url));

test.beforeEach(async ({ page }) => {
  await page.route('https://pammy.org/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const m = /^\/_pammy\/examples\/(garden|evening|postcard)\/([a-z-]+\.html|login-files\/style\.css)$/.exec(path);
    if (path === '/_pammy/login.js') return route.fulfill({ contentType: 'text/javascript', body: gateFile('login.js') });
    if (m) return route.fulfill({ contentType: m[2]!.endsWith('.css') ? 'text/css' : 'text/html', body: gateFile(`examples/${m[1]}/${m[2]}`) });
    return route.fulfill({ status: 404, body: 'not here' });
  });
});

test('each example look has its code to copy and a working preview', async ({ page }) => {
  await page.goto('/help/protected-folders/part-9');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Example look: Garden');
  const previews = page.getByTestId('example-preview');
  await expect(previews).toHaveCount(6);                            // the whole look, then each of the five pages

  // copy the style file exactly
  const style = page.locator('pre').filter({ hasText: 'Example look: Garden' });
  await style.locator('..').getByRole('button', { name: 'Copy' }).click();
  await expect(notice(page)).toHaveText('Code copied.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(gateFile('examples/garden/login-files/style.css').toString().trimEnd());

  // the sign-in page, in its frame: the look, the links, and a sign-in that only pretends
  await previews.first().getByRole('button', { name: 'Show preview' }).click();
  const frame = page.frameLocator('iframe[title="Preview of garden / login.html"]');
  await expect(frame.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await expect(frame.getByText('Family photos')).toBeVisible();
  await frame.getByLabel('Username').fill('auntie.jo');
  await frame.getByLabel('Password').fill('anything-at-all');
  await frame.getByRole('button', { name: 'Come in' }).click();
  await expect(frame.getByRole('alert')).toContainText('This is a preview, so nobody can sign in here.');
  expect(await frame.locator('body').evaluate((b) => getComputedStyle(b).backgroundColor)).toBe('rgb(243, 238, 228)');   // its style file applied

  // the bar goes between the five pages; the forgot page says thanks
  await page.locator('iframe').scrollIntoViewIfNeeded();
  const bar = frame.getByRole('navigation', { name: 'The example pages' });
  await bar.getByRole('link', { name: 'Forgot password' }).click();
  await expect(frame.getByRole('heading', { name: 'Forgotten your password?' })).toBeVisible();
  await frame.getByLabel('Username').fill('auntie.jo');
  await frame.getByRole('button', { name: 'Send' }).click();
  await expect(frame.getByRole('status')).toContainText("Thanks, that's been passed on.");
  await bar.getByRole('link', { name: 'Choose a password' }).click();
  await expect(frame.getByText('Your username is auntie.jo')).toBeVisible();
  await bar.getByRole('link', { name: 'Ask for access' }).click();
  await expect(frame.getByText("Tell me who you are, and I'll let you in.")).toBeVisible();
  await bar.getByRole('link', { name: 'Signed out' }).click();
  await expect(frame.getByRole('heading', { name: 'See you soon' })).toBeVisible();
  await expect(frame.getByRole('link', { name: 'Sign in again' })).toHaveAttribute('href', 'login.html');
  await previews.first().getByRole('button', { name: 'Hide preview' }).click();
  await expect(page.locator('iframe')).toHaveCount(0);

  // the other two looks
  for (const [part, name, look, heading] of [[10, 'Evening', 'evening', 'Good evening'], [11, 'Postcard', 'postcard', 'Sign in']] as const) {
    await page.goto(`/help/protected-folders/part-${part}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Example look: ${name}`);
    await page.getByTestId('example-preview').nth(1).getByRole('button', { name: 'Show preview' }).click();
    await expect(page.frameLocator(`iframe[title="Preview of ${look} / login.html"]`).getByRole('heading', { name: heading })).toBeVisible();
    await expect(page.getByTestId('example-preview').nth(1).getByRole('link', { name: 'Open in a new tab' }))
      .toHaveAttribute('href', `https://pammy.org/_pammy/examples/${look}/login.html`);
  }
});
