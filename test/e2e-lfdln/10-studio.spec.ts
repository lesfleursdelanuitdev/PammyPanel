// The Studio on lfdln (docs/phase8-plan.md step 8-4): Postgres on lfdln-appdb (P8-7) and MariaDB
// on lfdln-appmaria (docs/lfdln-mariadb-plan.md), databases of its own made on each, and the
// apps' databases looked inside but never changed (P8-9).
import { expect, notice, test } from './fixtures.ts';

test("Studio: Postgres and MariaDB; databases of its own; an app's database read-only", async ({ page }) => {
  await page.goto('/databases');
  await expect(page.getByRole('heading', { name: 'Your databases', level: 1 })).toBeVisible();
  const apps = page.getByRole('list', { name: "The services' databases" });
  await expect(apps.getByRole('listitem')).toHaveCount(2);
  await expect(apps.getByText('examprep')).toBeVisible();
  // nothing of Pamela's here
  await expect(page.getByText('came with your account')).toHaveCount(0);

  // a new one on each kind
  await page.getByRole('button', { name: 'New database' }).click();
  await page.getByLabel('Name').fill('notebook_db');
  await page.getByLabel('Which kind').selectOption('postgres');
  await page.getByRole('button', { name: 'Make the database' }).click();
  await expect(notice(page)).toContainText('notebook_db is ready.');
  const mine = page.getByRole('list', { name: 'Your databases' });
  await expect(mine.getByRole('listitem').filter({ hasText: 'notebook_db' })).toBeVisible();
  await page.getByRole('button', { name: 'New database' }).click();
  await page.getByLabel('Name').fill('guestbook_db');
  await page.getByLabel('Which kind').selectOption('mariadb');
  await page.getByRole('button', { name: 'Make the database' }).click();
  await expect(notice(page)).toContainText('guestbook_db is ready.');
  await expect(mine.getByRole('listitem').filter({ hasText: 'guestbook_db' })).toBeVisible();

  // an app's: looked inside, read only
  await apps.getByRole('listitem').filter({ hasText: 'examprep' }).getByRole('button', { name: 'Look inside' }).click();
  const ep = mine.getByRole('listitem').filter({ hasText: 'examprep' });
  await expect(ep.getByText("a service's: read only")).toBeVisible();
  await expect(ep.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  await ep.getByRole('link', { name: 'Tables' }).click();
  await expect(page.getByRole('heading', { name: 'This database belongs to a service' })).toBeVisible();
  await expect(page.getByText('topics')).toBeVisible();
  // its logins start with db_ (P8-15), on both servers
  await page.goto('/databases/users');
  await expect(page.getByRole('list', { name: 'MariaDB logins' })).toBeVisible();
  await page.getByRole('button', { name: 'New login' }).click();
  await expect(page.getByText('Starts with db_')).toBeVisible();
  await page.getByLabel('Name').fill('recipes');
  await page.getByRole('button', { name: /Make the login/ }).click();
  await expect(notice(page, 'error')).toContainText('Logins here start with db_');
  await page.goto(`/databases/postgres/examprep`);
  // and the helper says no to a change, whatever the page is asked
  const r = await page.request.get('/api/databases/postgres/examprep/delete');
  expect(r.status()).toBeGreaterThanOrEqual(400);
  // and the panel builds nothing on it: no tags, no comments, no programs (docs/lfdln-mariadb-plan.md finding 8)
  const origin = new URL(page.url()).origin;
  const tags = await page.request.post('/api/databases/postgres/examprep/app/topics/tags', { headers: { origin }, data: { on: true } });
  expect(tags.status()).toBe(403);
  expect((await tags.json()).message).toContain('belongs to a service');
  const comments = await page.request.post('/api/databases/postgres/examprep/app/topics/commentable', { headers: { origin }, data: { on: true } });
  expect(comments.status()).toBe(403);
});
