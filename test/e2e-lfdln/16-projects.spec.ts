// Projects (docs/phase8b-plan.md). 8b-1: the build environment and its check, as a job with
// its log. 8b-2: New project, Rebuild, Roll back. 8b-3: the dev branch and its preview host
// (only people let in), Put dev live, owners. (svc-lfdln-apps, the build image and git are
// stood in for by test/e2e-lfdln/server.ts.)
import { expect, test } from './fixtures.ts';

test('Projects: the build environment, checked as a job, with its log', async ({ page }) => {
  await page.goto('/projects');
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
  const env = page.getByTestId('build-environment');
  await expect(env).toContainText('svc-lfdln-apps');
  await expect(env).toContainText('localhost/lfdln-build-node:current');
  await expect(page.getByTestId('last-check')).toHaveText('Not checked yet.');
  await expect(page.getByRole('list', { name: 'Projects' })).toContainText('No projects yet.');

  await page.getByRole('button', { name: 'Check the build environment' }).click();
  await expect(page.getByTestId('last-check')).toContainText('Node v24.21.0, npm 11.19.0, pnpm 12.9.1, git 2.39.5');
  const job = page.getByRole('list', { name: 'Jobs' }).getByRole('listitem').first();
  await expect(job).toContainText('Check the build environment');
  await expect(job).toContainText('done');
  await job.getByRole('button', { name: 'Log' }).click();
  await expect(job.getByTestId('job-log')).toContainText('node v24.21.0, npm 11.19.0, pnpm 12.9.1, git 2.39.5');
});

test('New project: made and built (stood in for), shown at its own host and its preview, rebuilt, rolled back, deleted', async ({ page }) => {
  await page.goto('/projects');
  await page.getByRole('button', { name: 'New project' }).click();
  const form = page.getByRole('form', { name: 'New project' });
  await form.getByLabel('Name', { exact: true }).fill('shop-dev');
  await expect(form.getByText('Not ending in -dev')).toBeVisible();
  await expect(form.getByRole('button', { name: 'Make it' })).toBeDisabled();
  await form.getByLabel('Name', { exact: true }).fill('shop');
  await expect(form.getByText('shop.lesfleursdelanuit.com').first()).toBeVisible();
  await form.getByLabel('Kind').selectOption('svelte');
  await form.getByLabel('Package manager').selectOption('pnpm');
  await expect(form.getByLabel('Dev branch: try changes on a preview before they go live')).toBeChecked();
  await expect(form).toContainText('its preview at shop-dev.lesfleursdelanuit.com (only people let in)');
  await form.getByRole('button', { name: 'Make it' }).click();

  const row = page.getByRole('list', { name: 'Projects' }).getByRole('listitem').filter({ hasText: 'shop' });
  await expect(row).toContainText('Svelte');
  await expect(row).toContainText(/live: release [0-9]{14}/);
  await expect(row.getByRole('link', { name: 'https://shop.lesfleursdelanuit.com/', exact: true })).toBeVisible();
  await expect(row.getByRole('link', { name: 'https://shop-dev.lesfleursdelanuit.com/ (preview)' })).toBeVisible();
  await expect(row).toContainText('dev branch');
  const jobs = page.getByRole('list', { name: 'Jobs' });
  await expect(jobs.getByRole('listitem').first()).toContainText('Make: shop');
  await jobs.getByRole('listitem').first().getByRole('button', { name: 'Log' }).click();
  await expect(jobs.getByTestId('job-log')).toContainText('create-vite');

  // the Hosts page has its host, showing it
  await page.goto('/hosts');
  await expect(page.getByRole('list', { name: 'Hosts' })).toContainText('shows the project shop');
  // the preview's route: only people let in
  await expect(page.getByRole('list', { name: 'Routes of shop-dev' }).getByLabel('Accounts')).toHaveValue('private');

  // rebuilt: two releases; the first put back live
  await page.goto('/projects');
  await row.getByRole('button', { name: 'Rebuild' }).click();
  await row.getByRole('button', { name: 'Details' }).click();
  const releases = row.getByRole('list', { name: 'Releases of shop', exact: true });
  await expect(releases.getByRole('listitem')).toHaveCount(2);
  await releases.getByRole('listitem').nth(1).getByRole('button', { name: 'Put this live' }).click();
  await expect(releases.getByRole('listitem').nth(1)).toContainText('live');

  // deleting it while a route shows it says so
  await row.getByRole('button', { name: 'Delete shop' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('remove those routes on the Hosts page first');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
});

test('the dev branch: Put dev live, off refused while its preview is shown; owners; the clone address', async ({ page }) => {
  await page.goto('/projects');
  const row = page.getByRole('list', { name: 'Projects' }).getByRole('listitem').filter({ hasText: 'shop' });
  await row.getByRole('button', { name: 'Details' }).click();
  await expect(row.getByRole('list', { name: 'Releases of shop (dev)' }).getByRole('listitem')).toHaveCount(1);

  await row.getByRole('button', { name: 'Put dev live' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Put dev live' }).click();
  const jobs = page.getByRole('list', { name: 'Jobs' });
  await expect(jobs.getByRole('listitem').first()).toContainText('Put dev live: shop');
  await expect(jobs.getByRole('listitem').first()).toContainText('done');
  await jobs.getByRole('listitem').first().getByRole('button', { name: 'Log' }).click();
  await expect(jobs.getByTestId('job-log')).toContainText('main: 8c1532670916 -> dddddddddddd');

  // off is refused while the -dev host shows it
  await row.getByRole('button', { name: 'Turn the dev branch off' }).click();
  await expect(page.getByText("shop's dev branch is still shown at https://shop-dev.lesfleursdelanuit.com/")).toBeVisible();

  // owners: the maker; never none
  const owners = row.getByRole('list', { name: 'Owners of shop' });
  await expect(owners.getByRole('listitem')).toHaveCount(1);
  await expect(owners.getByRole('button', { name: /^Remove / })).toBeDisabled();
  // the HTTPS address for everyone (8b-7); no Unix account here, so no SSH address of one's own
  await expect(row.getByTestId('clone-https')).toHaveText('git clone https://git.lesfleursdelanuit.com/shop.git shop');
  await expect(row.getByTestId('clone')).toHaveCount(0);
});

test('a Next.js server: made, running on its port, stopped and started again, its log', async ({ page }) => {
  await page.goto('/projects');
  await page.getByRole('button', { name: 'New project' }).click();
  const form = page.getByRole('form', { name: 'New project' });
  // (api is a host name the site keeps for itself)
  await form.getByLabel('Name', { exact: true }).fill('api');
  await expect(form.getByText('api.lesfleursdelanuit.com is kept for the site itself')).toBeVisible();
  await expect(form.getByRole('button', { name: 'Make it' })).toBeDisabled();
  await form.getByLabel('Name', { exact: true }).fill('backend');
  await form.getByLabel('Kind').selectOption('next');
  await expect(form).toContainText('built into a container, which runs it');
  await form.getByLabel('Dev branch: try changes on a preview before they go live').uncheck();
  await form.getByRole('button', { name: 'Make it' }).click();

  const row = page.getByRole('list', { name: 'Projects' }).getByRole('listitem').filter({ hasText: 'backend' }).first();
  await expect(row).toContainText('Next.js (a server)');
  await expect(row).toContainText(/live: release [0-9]{14}/);
  await row.getByRole('button', { name: 'Details' }).click();
  const servers = row.getByRole('list', { name: 'Servers of backend' });
  await expect(servers).toContainText('Live (main)');
  await expect(servers).toContainText('running');
  await expect(servers).toContainText(/port 42[0-9]{2}/);

  await servers.getByRole('button', { name: 'Stop' }).click();
  await expect(servers.getByRole('button', { name: 'Start' })).toBeVisible();
  await expect(servers).toContainText('stopped');
  await servers.getByRole('button', { name: 'Start' }).click();
  await expect(servers.getByRole('button', { name: 'Restart' })).toBeVisible();

  await servers.getByRole('button', { name: 'Server log' }).click();
  await expect(servers.getByTestId('server-log')).toContainText('Next.js ready');

  // its route on the Hosts page goes to its server
  await page.goto('/hosts');
  await expect(page.getByRole('list', { name: 'Hosts' })).toContainText('shows the project backend');
});

test('a server\'s environment (8b-4b): names shown, values hidden until a fresh passkey; what a change takes; removed', async ({ page }) => {
  await page.goto('/projects');
  const row = page.getByRole('list', { name: 'Projects' }).getByRole('listitem').filter({ hasText: 'backend' }).first();
  await row.getByRole('button', { name: 'Details' }).click();
  const env = row.getByRole('list', { name: 'Environment of backend' });
  await expect(env).toContainText('Nothing set yet.');
  const form = row.getByRole('form', { name: 'Set a variable' });
  await form.getByLabel('Name').fill('port');
  await expect(form).toContainText("PORT is the panel's");
  await expect(form.getByRole('button', { name: 'Add it' })).toBeDisabled();
  await form.getByLabel('Name').fill('database_url');
  await expect(form.getByLabel('Name')).toHaveValue('DATABASE_URL');
  await form.getByLabel('Value').fill('postgres://app:pw@127.0.0.1:5436/app');
  await form.getByRole('button', { name: 'Add it' }).click();
  await expect(page.getByText('DATABASE_URL saved: restart its server (main) to use it.')).toBeVisible();
  await expect(env).toContainText('DATABASE_URL');
  await expect(env.getByTestId('env-value')).toHaveText('••••••••');
  await expect(env).not.toContainText('postgres://');

  await form.getByLabel('Name').fill('NEXT_PUBLIC_TITLE');
  await expect(form).toContainText('never put a secret in one');
  await form.getByLabel('Value').fill('Backend');
  await form.getByRole('button', { name: 'Add it' }).click();
  await expect(page.getByText('NEXT_PUBLIC_TITLE saved: rebuild backend to use it (it is built into the pages).')).toBeVisible();
  await expect(env.getByRole('listitem').filter({ hasText: 'NEXT_PUBLIC_TITLE' })).toContainText('in the pages: not secret');

  // S1f (b): 10.0.2.2 reaches nothing from a project on pasta -- said while typing, and after
  await form.getByLabel('Name').fill('CACHE_URL');
  await form.getByLabel('Value').fill('redis://10.0.2.2:6379');
  await expect(form).toContainText('10.0.2.2 reaches nothing from a project');
  await form.getByRole('button', { name: 'Add it' }).click();
  await expect(env.getByRole('listitem').filter({ hasText: 'CACHE_URL' })).toContainText('names 10.0.2.2: reaches nothing');
  await expect(env.getByRole('listitem').filter({ hasText: 'DATABASE_URL' })).not.toContainText('names 10.0.2.2');
  await expect(row.getByRole('note').filter({ hasText: 'names 10.0.2.2' })).toContainText('Change it to 127.0.0.1, then Restart.');
  await env.getByRole('button', { name: 'Remove CACHE_URL' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
  await expect(env).not.toContainText('CACHE_URL');
  await expect(row.getByRole('note').filter({ hasText: 'names 10.0.2.2' })).toHaveCount(0);

  await row.getByRole('button', { name: 'Show the values' }).click();
  await expect(env).toContainText('postgres://app:pw@127.0.0.1:5436/app');
  await row.getByRole('button', { name: 'Hide the values' }).click();
  await expect(env).not.toContainText('postgres://');

  await env.getByRole('button', { name: 'Remove NEXT_PUBLIC_TITLE' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
  await expect(env).not.toContainText('NEXT_PUBLIC_TITLE');

  // Activity has which, never what
  await page.goto('/activity');
  await expect(page.getByText(/set a variable in backend's environment \(main: DATABASE_URL\)/)).toBeVisible();
  await expect(page.getByText(/showed the values of backend's environment/)).toBeVisible();
  await expect(page.locator('body')).not.toContainText('postgres://');
});

test('a server\'s database (8b-5): made, its connections in the environment, read-only in the Studio; the preview using the live one', async ({ page }) => {
  await page.goto('/projects');
  const row = page.getByRole('list', { name: 'Projects' }).getByRole('listitem').filter({ hasText: 'backend' }).first();
  await row.getByRole('button', { name: 'Details' }).click();
  const dbs = row.getByRole('list', { name: 'Databases of backend' });
  await expect(dbs).toContainText('no database');
  await dbs.getByRole('button', { name: 'Make a Postgres database' }).click();
  await expect(page.getByText('backend has its Postgres database: restart its server (main) to use it.')).toBeVisible();
  await expect(dbs).toContainText('proj_backend');
  await expect(dbs).toContainText('db_proj_backend_owner');
  await expect(dbs).toContainText('db_proj_backend_app');
  const env = row.getByRole('list', { name: 'Environment of backend' });
  await expect(env).toContainText('DATABASE_URL');
  await expect(env).toContainText('DATABASE_OWNER_URL');
  await row.getByRole('button', { name: 'Show the values' }).click();
  await expect(env).toContainText(/postgres:\/\/db_proj_backend_app:[A-Za-z0-9]{32}@127\.0\.0\.1:5436\/proj_backend/);
  await expect(env).toContainText(/postgres:\/\/db_proj_backend_owner:[A-Za-z0-9]{32}@127\.0\.0\.1:5436\/proj_backend/);
  await expect(dbs.getByRole('button', { name: /Make a/ })).toHaveCount(0);

  // the Studio shows it as the project's, and never changes it
  await dbs.getByRole('link', { name: 'In the Studio' }).click();
  await expect(page).toHaveURL(/\/databases\/postgres\/proj_backend$/);
  await expect(page.getByText('This database belongs to a project')).toBeVisible();

  // a server with a dev branch: MariaDB for live, and the preview using it for a while
  await page.goto('/projects');
  await page.getByRole('button', { name: 'New project' }).click();
  const form = page.getByRole('form', { name: 'New project' });
  await form.getByLabel('Name', { exact: true }).fill('orders');
  await form.getByLabel('Kind').selectOption('next');
  await form.getByRole('button', { name: 'Make it' }).click();
  const orders = page.getByRole('list', { name: 'Projects' }).getByRole('listitem').filter({ hasText: 'orders' }).first();
  await expect(orders).toContainText(/dev: /);
  await orders.getByRole('button', { name: 'Details' }).click();
  const odbs = orders.getByRole('list', { name: 'Databases of orders' });
  const live = odbs.getByRole('listitem').filter({ hasText: 'Live (main)' });
  const preview = odbs.getByRole('listitem').filter({ hasText: 'Preview (dev)' });
  await expect(preview.getByRole('button', { name: 'Use the live database' })).toHaveCount(0);
  await live.getByRole('button', { name: 'Make a MariaDB database' }).click();
  await expect(live).toContainText('proj_orders');
  await preview.getByRole('button', { name: 'Use the live database' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('live data changes with it');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Use the live database' }).click();
  await expect(preview).toContainText('the live database');
  await expect(preview).toContainText('proj_orders');
  await orders.getByRole('button', { name: 'Show the values' }).nth(1).click();
  await expect(orders.getByRole('list', { name: 'Environment of orders (dev)' })).toContainText(/mysql:\/\/db_proj_orders_app:[A-Za-z0-9]{32}@127\.0\.0\.1:3308\/proj_orders/);
  await preview.getByRole('button', { name: 'Stop using the live database' }).click();
  await expect(preview).toContainText('no database');
  await expect(orders.getByRole('list', { name: 'Environment of orders (dev)' })).not.toContainText('DATABASE_URL');
  await preview.getByRole('button', { name: 'Make a Postgres database' }).click();
  await expect(preview).toContainText('proj_orders_dev');

  await page.goto('/activity');
  await expect(page.getByText(/gave orders a database \(dev: Postgres proj_orders_dev\)/)).toBeVisible();
  await expect(page.getByText(/let orders's dev branch use the live database/)).toBeVisible();
});

test('packages (8b-8a): checked, a package looked at (warnings) and added, updates and advisories, a script run', async ({ page }) => {
  await page.goto('/projects');
  const row = page.getByRole('list', { name: 'Projects' }).getByRole('listitem').filter({ hasText: 'backend' }).first();
  await row.getByRole('link', { name: 'Packages' }).click();
  await expect(page).toHaveURL(/\/projects\/backend\/packages$/);
  await expect(page.getByRole('heading', { name: 'Packages: backend', level: 1 })).toBeVisible();
  // its address is a page of the panel: opened again from the address bar (8b-7 found it 404)
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Packages: backend', level: 1 })).toBeVisible();
  await expect(page.getByText('A change is committed to main (live), then built')).toBeVisible();
  const installed = page.getByRole('list', { name: 'Installed packages' });
  await expect(installed).toContainText('Check its packages to see them here.');
  await page.getByRole('button', { name: 'Check packages' }).click();
  const next = installed.getByRole('listitem').filter({ hasText: /^next/ });
  await expect(next).toContainText('16.0.1 available');
  await expect(next).toContainText('security: moderate');
  await expect(page.getByTestId('audit')).toContainText('Security issues: 1 moderate.');
  await expect(page.getByRole('button', { name: 'Fix security issues' })).toBeVisible();

  // a look-alike, with what to know; then the real one, picked and installed
  await page.getByLabel('Search the npm registry').fill('zod');
  await page.getByRole('button', { name: 'Search' }).click();
  const results = page.getByRole('list', { name: 'Search results' });
  await results.getByRole('listitem').filter({ hasText: 'zood' }).getByRole('button', { name: 'Look at it' }).click();
  const warns = page.getByRole('list', { name: 'What to know about zood' });
  await expect(warns).toContainText('one letter away from zod');
  await expect(warns).toContainText('runs its own scripts when installed');
  const zod = results.getByRole('listitem').filter({ hasText: /^zod/ });
  await zod.getByRole('button', { name: 'Look at it' }).click();
  await expect(zod.getByTestId('about-package')).toContainText('Nothing to warn about.');
  await expect(zod.getByTestId('about-package')).toContainText('its own types');
  await zod.getByRole('button', { name: 'Pick it' }).click();
  await expect(page.getByRole('list', { name: 'Packages to add' })).toContainText('zod@latest');
  await page.getByRole('button', { name: 'Install it' }).click();
  await expect(installed).toContainText('zod');
  await expect(page.getByRole('list', { name: 'Packages to add' })).toHaveCount(0);

  // scripts: lint runs (its output in the job's log), dev is never run here
  const scripts = page.getByRole('list', { name: 'Scripts' });
  await expect(scripts.getByRole('listitem').filter({ hasText: /^dev/ })).toContainText('serves, never finishes');
  await scripts.getByRole('listitem').filter({ hasText: /^lint/ }).getByRole('button', { name: 'Run' }).click();
  const job = page.getByRole('list', { name: 'Jobs' }).getByRole('listitem').filter({ hasText: 'Run a script' }).first();
  await expect(job).toContainText('done');
  await job.getByRole('button', { name: 'Log' }).click();
  await expect(job.getByTestId('job-log')).toContainText('all clean');

  await page.goto('/activity');
  await expect(page.getByText(/changed backend's packages \(add zod\)/)).toBeVisible();
  await expect(page.getByText(/ran a script of backend's \(lint\)/)).toBeVisible();
});

test('updates (8b-8b): the Projects list says what the last check found; a new Next.js major upgraded with its companions; updated each night or not', async ({ page }) => {
  await page.goto('/projects');
  const row = page.getByRole('list', { name: 'Projects' }).getByRole('listitem').filter({ hasText: 'backend' }).first();
  await expect(row).toContainText('security: 1');
  await expect(row).toContainText('1 update');
  await row.getByRole('link', { name: 'Packages' }).click();
  const majors = page.getByRole('list', { name: 'New major versions' });
  await expect(majors).toContainText('Next.js 16 is out (it has 15.5.0)');
  await expect(majors).toContainText('next, react');
  await expect(majors).not.toContainText('React 20');
  await majors.getByRole('button', { name: 'Upgrade Next.js to 16' }).click();
  await expect(page.getByText('Upgrading Next.js to 16 on main: then it is built.')).toBeVisible();
  const auto = page.getByLabel(/Each night, update its packages within their versions/);
  await expect(auto).not.toBeChecked();
  await expect(page.getByText('It has no dev branch, so that goes live.')).toBeVisible();
  await auto.click();
  await expect(page.getByText("backend's packages are updated each night.")).toBeVisible();
  await expect(auto).toBeChecked();
  await page.goto('/activity');
  await expect(page.getByText(/changed backend's packages \(update next, react\)/)).toBeVisible();
  await expect(page.getByText("had backend's packages updated each night")).toBeVisible();
});

test('git tokens (8b-7): made after a passkey, shown once; nginx\'s check lets the token in to read and push, nothing else; revoked', async ({ page }) => {
  const project = ((await (await page.request.get('/api/projects')).json()) as { projects: { id: string }[] }).projects[0]!.id;
  await page.goto('/projects');
  await page.getByRole('link', { name: 'Your git tokens' }).click();
  await expect(page).toHaveURL(/\/projects\/git-tokens$/);
  const list = page.getByRole('list', { name: 'Your git tokens' });
  await expect(list).toContainText('No tokens yet.');
  const form = page.getByRole('form', { name: 'Make a git token' });
  await expect(form.getByLabel('Lasts')).toHaveValue('90');
  await form.getByLabel('Name').fill('my laptop');
  await form.getByRole('button', { name: 'Make a token' }).click();
  const shown = page.getByTestId('new-token');
  await expect(shown).toHaveText(/^lfdln_git_[A-Za-z0-9_-]{43}$/);
  const token = (await shown.textContent())!;
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(list).toContainText('my laptop');
  await expect(list).toContainText(`lfdln_git_${token.slice(10, 14)}…`);
  await expect(list).toContainText('not used yet');
  await page.getByRole('button', { name: "I've kept it" }).click();
  await expect(shown).toHaveCount(0);

  // what nginx asks (packages/projects/nginx/git.conf): the request's path and git's Basic header
  const me = ((await (await page.request.get('/api/projects/git-tokens')).json()) as { me: string }).me;
  const check = async (uri: string, user = me, secret = token) => {
    const r = await page.request.get('/api/projects/git-auth', { headers: { 'x-original-uri': uri, authorization: `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}` } });
    return { status: r.status(), user: r.headers()['x-lfdln-git-user'] };
  };
  expect(await check(`/${project}.git/info/refs?service=git-upload-pack`)).toEqual({ status: 204, user: me });
  expect(await check(`/${project}.git/git-upload-pack`)).toEqual({ status: 204, user: me });
  // an admin may push to any project
  expect(await check(`/${project}.git/info/refs?service=git-receive-pack`)).toEqual({ status: 204, user: me });
  expect((await check(`/${project}.git/info/refs?service=git-upload-pack`, 'someone-else')).status).toBe(401);
  expect((await check(`/${project}.git/info/refs?service=git-upload-pack`, me, `lfdln_git_${'A'.repeat(43)}`)).status).toBe(401);
  expect((await check(`/${project}.git/info/refs?service=git-upload-pack`, me, 'my-password')).status).toBe(401);
  expect((await check('/no-such-project.git/info/refs?service=git-upload-pack')).status).toBe(403);
  // not git's smart HTTP: refused, whoever asks
  expect((await check(`/${project}.git/HEAD`)).status).toBe(403);
  expect((await check(`/${project}.git/info/refs`)).status).toBe(403);
  const panelRes = await page.request.get('/api/projects/git-auth');
  expect(panelRes.status()).toBe(403);

  await page.reload();
  await expect(list).not.toContainText('not used yet');
  await expect(list).toContainText('last used');

  await list.getByRole('button', { name: 'Revoke' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByText('Revoked “my laptop”.')).toBeVisible();
  await expect(list).toContainText('No tokens yet.');
  expect((await check(`/${project}.git/info/refs?service=git-upload-pack`)).status).toBe(401);
});
