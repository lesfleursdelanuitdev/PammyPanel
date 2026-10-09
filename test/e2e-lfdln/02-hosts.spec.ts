// Hosts, routes and site folders in the browser (docs/hosts-plan.md step 3, put off to
// phase 5: docs/lfdln-standup-plan.md L9). nginx is stood in for; the routing helper and
// the folder helper are the real ones.
import { expect, notice, row, test, confirmDialog } from './fixtures.ts';

const control = (path: string) => fetch(`http://127.0.0.1:3298${path}`, { method: 'POST' });

test('Add a static folder: made, at its own host, on Home too', async ({ page }) => {
  await page.goto('/hosts');
  await expect(page.getByRole('heading', { name: 'Hosts', level: 1 })).toBeVisible();
  const add = page.getByRole('region', { name: 'Add a static folder' }).or(page.locator('section').filter({ has: page.getByRole('heading', { name: 'Add a static folder' }) })).first();
  await add.getByLabel('Name').fill('Docs!');
  await expect(add.getByText('Lowercase letters, digits and hyphens')).toBeVisible();
  await add.getByLabel('Name').fill('panel');
  await expect(add.getByText('panel is kept for the server itself.')).toBeVisible();
  await add.getByLabel('Name').fill('webmail');
  await expect(add.getByText('webmail has a DNS record of its own at DreamHost')).toBeVisible();
  await add.getByLabel('Name').fill('docs');
  await expect(add.getByText('It will be at https://docs.lesfleursdelanuit.com/')).toBeVisible();
  await add.getByRole('button', { name: 'Add folder' }).click();
  await expect(notice(page)).toContainText('Made. https://docs.lesfleursdelanuit.com/ shows it now.');
  const hosts = page.getByRole('list', { name: 'Hosts' });
  await expect(row(page, /^docs/).first()).toBeVisible();
  await expect(hosts.getByRole('list', { name: 'Routes of docs' })).toContainText('shows docs');

  await page.goto('/');
  await expect(page.getByTestId('stat-hosts-on')).toHaveText('1');
  await expect(page.getByTestId('stat-site-folders')).toHaveText('1');
  await expect(page.getByRole('list', { name: 'Hosts' })).toContainText('docs.lesfleursdelanuit.com');
});

test('nginx saying no: the panel says so, and nothing changed', async ({ page }) => {
  await page.goto('/hosts');
  // (a host with no routes writes no file, so nginx isn't asked: a folder shown at its host is)
  await control('/nginx-says-no');
  try {
    const add = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Add a static folder' }) }).first();
    await add.getByLabel('Name').fill('shop');
    await add.getByRole('button', { name: 'Add folder' }).click();
    await expect(notice(page, 'error')).toBeVisible();
  } finally {
    await control('/nginx-says-yes');
  }
  await page.reload();
  await expect(page.getByRole('list', { name: 'Hosts' })).not.toContainText('shop');
  await expect(page.getByRole('list', { name: 'Site folders' })).not.toContainText('shop');
});

test('while the DreamHost zone cannot be read, no new host is made', async ({ page }) => {
  await control('/zone-down');
  try {
    await page.goto('/hosts');
    await expect(page.getByText('No new host can be made until then.')).toBeVisible();
  } finally {
    await control('/zone-up');
  }
});

test('a redirect route, switched off and on, then the host deleted (its folder stays)', async ({ page }) => {
  await page.goto('/hosts');
  const add = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Add a host' }) }).first();
  await add.getByLabel('Name').fill('old');
  await add.getByRole('button', { name: 'Add host' }).click();
  await expect(notice(page)).toContainText('Made. https://old.lesfleursdelanuit.com/');
  const old = row(page, /^old/).first();
  await old.getByRole('button', { name: 'Add a route' }).click();
  await old.getByLabel('What it does').selectOption('redirect');
  await old.getByRole('textbox', { name: 'To' }).fill('https://docs.lesfleursdelanuit.com/');
  await old.getByRole('button', { name: 'Add route' }).click();
  await expect(notice(page)).toContainText('Route added. nginx has it now.');
  await expect(page.getByRole('list', { name: 'Routes of old' })).toContainText('redirects (302) to https://docs.lesfleursdelanuit.com/');

  await old.getByRole('button', { name: 'Switch off' }).click();
  await expect(notice(page)).toContainText('old is switched off');
  await expect(old.getByText('switched off')).toBeVisible();
  await old.getByRole('button', { name: 'Switch on' }).click();
  await expect(notice(page)).toContainText('old is switched on.');

  await old.getByRole('button', { name: 'Delete' }).click();
  await confirmDialog(page).getByRole('button', { name: 'Delete' }).click();
  await expect(notice(page)).toContainText('old is deleted.');
  await expect(page.getByRole('list', { name: 'Hosts' })).not.toContainText(/^old/);
  await expect(page.getByRole('list', { name: 'Site folders' })).toContainText('docs');
});

// docs/domains-hosts-plan.md step 3: each host's checks, and Check again
test('each host shows its checks: DNS, the certificate, the answer', async ({ page }) => {
  await page.goto('/hosts');
  const docs = row(page, /^docs/).first();
  await expect(docs.getByRole('list', { name: 'Checks' })).toContainText('✓ DNS');
  await expect(docs.getByRole('list', { name: 'Checks' })).toContainText('✓ certificate, 80 days');
  await expect(docs.getByRole('list', { name: 'Checks' })).toContainText('✓ answers 200');
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(notice(page)).toContainText('Checked again.');
});

// Domains and the setup guide (docs/domains-hosts-plan.md step 4)
test('Domains: the panel\'s own, every check green', async ({ page }) => {
  await page.goto('/hosts');
  const own = page.getByRole('list', { name: 'Domains' }).getByRole('listitem').filter({ hasText: 'lesfleursdelanuit.com' }).first();
  await expect(own.getByText("this panel's own")).toBeVisible();
  await expect(own.getByText('DNS at DreamHost')).toBeVisible();
  const needs = own.getByRole('list', { name: 'What it needs' });
  await expect(needs.getByRole('listitem').first()).toBeVisible();
  await expect(needs.getByText('✗')).toHaveCount(0);
  await expect(own.getByRole('button', { name: 'Remove' })).toHaveCount(0);
});

test('Add a domain: one question a page, each checked; Turn on, then removed again', async ({ page }) => {
  await page.goto('/hosts');
  await page.getByRole('link', { name: 'Add a domain' }).click();
  await expect(page.getByRole('heading', { name: 'Add a domain', level: 1 })).toBeVisible();
  const go = page.getByRole('button', { name: 'Check and go on' });

  // 1. the name: one that is a domain here already stops here
  await page.getByLabel('Its name').fill('lesfleursdelanuit.com');
  await go.click();
  await expect(page.getByText('lesfleursdelanuit.com is a domain here already')).toBeVisible();
  await expect(page.locator('[aria-current="step"]')).toContainText('The domain');
  await page.getByLabel('Its name').fill('example.org');
  await go.click();
  // 2-4: DNS elsewhere, nothing in front, a * record
  await expect(page.locator('[aria-current="step"]')).toContainText('Who keeps its DNS?');
  await page.getByLabel(/Somewhere else/).check();
  await go.click();
  await expect(page.locator('[aria-current="step"]')).toContainText("What's in front?");
  await page.getByLabel(/Directly/).check();
  await go.click();
  await expect(page.locator('[aria-current="step"]')).toContainText('New names');
  await go.click();
  // 5. the certificate: suggested from the answers; one that can't be read stops here
  await expect(page.locator('[aria-current="step"]')).toContainText('Certificate');
  await expect(page.getByLabel('Certificate file')).toHaveValue('/etc/letsencrypt/live/wildcard.example.org/fullchain.pem');
  await page.getByLabel('Certificate file').fill('/etc/ssl/missing/example.org.pem');
  await go.click();
  await expect(page.getByText("can't be read as a certificate")).toBeVisible();
  await expect(page.locator('[aria-current="step"]')).toContainText('Certificate');
  await page.getByLabel('Certificate file').fill('/etc/letsencrypt/live/wildcard.example.org/fullchain.pem');
  await go.click();
  // 6. folder hosts: not yet (pammy.org's move)
  await expect(page.locator('[aria-current="step"]')).toContainText('Folder hosts');
  await expect(page.getByLabel(/Every top-level folder its own host/)).toBeDisabled();
  await go.click();
  // 7. the summary: every requirement listed (the certificate page checked them all)
  await expect(page.locator('[aria-current="step"]')).toContainText('Summary');
  const on = page.getByRole('button', { name: 'Turn on' });
  await page.getByRole('button', { name: 'Check everything again' }).click();
  await expect(page.getByRole('list', { name: 'What it needs' })).toContainText('The certificate covers example.org and *.example.org');
  await expect(on).toBeEnabled();
  await on.click();
  await expect(notice(page)).toContainText('example.org is on.');
  await expect(page).toHaveURL(/\/hosts$/);

  const added = page.getByRole('list', { name: 'Domains' }).getByRole('listitem').filter({ hasText: 'example.org' }).first();
  await expect(added.getByText('DNS kept elsewhere')).toBeVisible();
  await expect(added.getByText('0 hosts')).toBeVisible();

  // hosts on it from Add a host (7-6): "@" with www beside it, and a name under it
  const add = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Add a host' }) }).first();
  await add.getByLabel('Domain').selectOption('example.org');
  await add.getByLabel('Name').fill('www');
  await expect(add.getByText('www is never a host of its own')).toBeVisible();
  await add.getByLabel('Name').fill('@');
  await expect(add.getByText('It will be at https://example.org/ and https://www.example.org/')).toBeVisible();
  await expect(add.getByLabel('www.example.org too')).toBeChecked();
  await add.getByRole('button', { name: 'Add host' }).click();
  await expect(notice(page)).toContainText('Made. https://example.org/');
  await expect(row(page, /^example\.org and www\.example\.org/).first()).toBeVisible();
  await add.getByLabel('Name').fill('shop');
  await expect(add.getByText('It will be at https://shop.example.org/')).toBeVisible();
  await add.getByRole('button', { name: 'Add host' }).click();
  await expect(notice(page)).toContainText('Made. https://shop.example.org/');
  // the domain can't go while they are there; deleted, it can
  for (const name of ['shop.example.org', 'example.org']) {
    await page.getByRole('list', { name: 'Hosts' }).getByRole('listitem').filter({ hasText: new RegExp(`^${name.replace(/\./g, '\\.')}`) }).first()
      .getByRole('button', { name: 'Delete' }).click();
    await confirmDialog(page).getByRole('button', { name: 'Delete' }).click();
    await expect(notice(page)).toContainText(`${name} is deleted.`);
  }
  await added.getByRole('button', { name: 'Remove' }).click();
  await confirmDialog(page).getByRole('button', { name: 'Remove' }).click();
  await expect(notice(page)).toContainText('example.org is removed.');
  await expect(page.getByRole('list', { name: 'Domains' })).not.toContainText('example.org');
});
