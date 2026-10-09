// Services in the browser (docs/adopt-plan.md V9): what runs, Stop (and what stops with
// it), Start, Restart, the log, and a host sending visitors to a service. systemd is
// stood in for (test/e2e-lfdln/server.ts: a demo service of two parts); the services
// helper and the routing helper are the real ones.
import { confirmDialog, expect, notice, row, test } from './fixtures.ts';

test('what runs: each part, running and answering', async ({ page }) => {
  await page.goto('/services');
  await expect(page.getByRole('heading', { name: 'Services', level: 1 })).toBeVisible();
  const demo = row(page, /^Demo app/).first();
  await expect(demo).toContainText('running');
  await expect(demo).toContainText('runs as svc-demo');
  const parts = page.getByRole('list', { name: 'Parts of Demo app' });
  await expect(parts).toContainText('demo-api.service');
  await expect(parts).toContainText('/health: 200');
  await expect(parts).toContainText('127.0.0.1:3295');
});

test('stopping the API stops the web part too, and it says so; Start all brings both back', async ({ page }) => {
  await page.goto('/services');
  const api = page.getByRole('list', { name: 'Parts of Demo app' }).getByRole('listitem').filter({ hasText: 'demo-api.service' });
  await api.getByRole('button', { name: 'Stop' }).click();
  await expect(confirmDialog(page)).toContainText("Web can't run without it, so it stops too.");
  await confirmDialog(page).getByRole('button', { name: 'Stop' }).click();
  await expect(notice(page)).toContainText('API is stopped.');
  const parts = page.getByRole('list', { name: 'Parts of Demo app' });
  await expect(parts.getByText('stopped')).toHaveCount(2);
  await expect(row(page, /^Demo app/).first().getByText('stopped').first()).toBeVisible();

  await page.getByRole('button', { name: 'Start all', exact: true }).click();
  await expect(notice(page)).toContainText('Demo app started, and answering.');
  await expect(parts.getByText('stopped')).toHaveCount(0);
  await expect(row(page, /^Demo app/).first().getByText('running').first()).toBeVisible();
});

test('restart one part, and read its log', async ({ page }) => {
  await page.goto('/services');
  const web = page.getByRole('list', { name: 'Parts of Demo app' }).getByRole('listitem').filter({ hasText: 'demo-web.service' });
  await web.getByRole('button', { name: 'Restart' }).click();
  await expect(notice(page)).toContainText('Web restarted.');
  await web.getByRole('button', { name: 'Log' }).click();
  await expect(page.getByLabel('The log of Web')).toContainText('listening on demo-web.service');
  await web.getByRole('button', { name: 'Hide the log' }).click();
  await expect(page.getByLabel('The log of Web')).toHaveCount(0);

  await page.goto('/activity');
  await expect(page.getByRole('main')).toContainText('restarted Demo app (Web)');
  await expect(page.getByRole('main')).toContainText('stopped Demo app (API)');
});

test('a host sending visitors to a service: its route, and the service showing where it is', async ({ page }) => {
  await page.goto('/hosts');
  const addHost = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Add a host' }) }).first();
  await addHost.getByLabel('Name').fill('demo');
  await addHost.getByRole('button', { name: 'Add host' }).click();
  await expect(notice(page)).toContainText('Made. https://demo.lesfleursdelanuit.com/');
  const host = row(page, /^demo/).first();
  await host.getByRole('button', { name: 'Add a route' }).click();
  await host.getByLabel('What it does').selectOption('service');
  await host.getByLabel('Service').selectOption({ label: 'Demo app: Web (:3295)' });
  await host.getByLabel('Largest upload, MB').fill('25');
  await host.getByLabel('Sign-in paths').fill('/api/auth/sign-in');
  await host.getByRole('button', { name: 'Add route' }).click();
  await expect(notice(page)).toContainText('Route added.');
  const r = page.getByRole('list', { name: 'Routes of demo' });
  await expect(r).toContainText('goes to Demo app: Web (127.0.0.1:3295)');
  await expect(r).toContainText('uploads up to 25 MB');
  await expect(r).toContainText('sign-in limited: /api/auth/sign-in');

  await page.goto('/services');
  await expect(page.getByRole('list', { name: 'Parts of Demo app' })).toContainText('https://demo.lesfleursdelanuit.com/');
});
