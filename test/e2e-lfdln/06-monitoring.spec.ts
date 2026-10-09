// Monitoring in the browser (docs/monitoring-plan.md step 1): the page all well; a part
// that answers 500 is down after two rounds, one email says so; quiet for maintenance keeps
// the next change out of the mail; Home's tile. Rounds are run from the control port (the
// panel's own timer is server.ts's).
import { expect, notice, test } from './fixtures.ts';

const control = (path: string, method = 'POST') => fetch(`http://127.0.0.1:3298${path}`, { method });
const round = () => control('/monitor-round');
const sent = async () => (await (await control('/mail-sent', 'GET')).json()) as { subject: string; lines: string[]; link: string }[];

test('Monitoring: all well; a part down after two rounds, emailed; quiet; back', async ({ page }) => {
  await round();
  await page.goto('/monitoring');
  await expect(page.getByRole('heading', { name: 'Monitoring', level: 1 })).toBeVisible();
  await expect(page.getByTestId('monitoring-now')).toHaveText('All well');
  const services = page.getByRole('list', { name: 'Checks: Services' });
  await expect(services.getByRole('listitem').filter({ hasText: 'Demo app / Web' })).toContainText('up');
  const own = page.getByRole('list', { name: "Checks: The panel's own" });
  for (const piece of ["The panel's database (lfdln-pg)", "The apps' database (lfdln-appdb)", "The Studio's MariaDB (lfdln-appmaria)", 'The gate (visitor accounts)', 'The mail service', 'The folder helper', 'The routing helper', 'The services helper']) {
    await expect(own.getByRole('listitem').filter({ hasText: piece }).first()).toContainText('up');
  }

  // the web part answers 500: failed once, then down, and one email
  const before = (await sent()).length;
  await control('/web-broken');
  try {
    await round();
    await page.reload();
    await expect(page.getByTestId('monitoring-now')).toHaveText('All well');
    await expect(services.getByRole('listitem').filter({ hasText: 'Demo app / Web' })).toContainText('failed once');
    await round();
    await page.reload();
    await expect(page.getByTestId('monitoring-now')).toHaveText('1 thing down');
    await expect(page.getByRole('list', { name: 'Down now' })).toContainText('Demo app / Web: answers 500');
    const mails = (await sent()).slice(before);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toBe('lesfleursdelanuit.com: 1 down');
    expect(mails[0]!.lines).toEqual(['Down: Demo app / Web: answers 500']);
    expect(mails[0]!.link).toMatch(/\/monitoring$/);

    await page.goto('/');
    await expect(page.getByTestId('stat-down-now')).toHaveText('1');

    // quiet for maintenance: the service, for an hour
    await page.goto('/monitoring');
    await page.getByLabel('What').selectOption('service:demo');
    await page.getByRole('button', { name: 'Make quiet' }).click();
    await expect(notice(page)).toContainText('The service demo is quiet for 1 hour.');
    await expect(page.getByRole('list', { name: 'Quiet now' })).toContainText('the service demo');
    await expect(services.getByRole('listitem').filter({ hasText: 'Demo app / Web' })).toContainText('quiet');
  } finally {
    await control('/web-fixed');
  }
  // back, but quiet: shown, not emailed
  await round();
  await page.reload();
  await expect(page.getByTestId('monitoring-now')).toHaveText('All well');
  const changes = page.getByRole('list', { name: 'Changes' });
  await expect(changes.getByRole('listitem').filter({ hasText: 'came back' }).first()).toContainText('not emailed (quiet)');
  await expect(changes.getByRole('listitem').filter({ hasText: 'went down' }).first()).toContainText('emailed');
  expect((await sent()).length).toBe(before + 1);

  await page.getByRole('list', { name: 'Quiet now' }).getByRole('button', { name: 'End now' }).click();
  await expect(notice(page)).toContainText('Not quiet any more.');
  await expect(page.getByRole('list', { name: 'Quiet now' })).toHaveCount(0);

  // Check now: a round straight away, then once a minute at most
  await page.getByRole('button', { name: 'Check now' }).click();
  await expect(notice(page)).toContainText('Checked.');
  await expect(page.getByRole('button', { name: 'Check now' })).toBeDisabled();

  // in Activity, as everything is
  await page.goto('/activity');
  await expect(page.getByText('made service:demo quiet for maintenance (for 1 hour)')).toBeVisible();
});

// Step 2: the certificates every round; the backups, the disk and the mail DNS records
// hourly (the first round, and Check now); a record that changed is down until an admin
// keeps it as it is now
test('Monitoring: certificates, backups, disk and DNS records; a changed record kept', async ({ page }) => {
  await control('/monitor-round-all');
  await page.goto('/monitoring');
  await expect(page.getByRole('list', { name: 'Checks: Certificates' }).getByRole('listitem').first()).toContainText('80 day(s) left');
  const backups = page.getByRole('list', { name: 'Checks: Backups' });
  for (const b of ["The panel's database (lfdln-pg)", "The apps' databases (lfdln-appdb)", "pammy.org's panel database (pammy-pg)"]) {
    await expect(backups.getByRole('listitem').filter({ hasText: b })).toContainText('one dump, 1.5 MB, 6 h ago');
  }
  await expect(page.getByRole('list', { name: 'Checks: Disk' }).getByRole('listitem')).toHaveCount(1);
  await expect(page.getByRole('list', { name: 'Checks: Disk' })).toContainText('Disk space: / and /mnt/storage');
  const dns = page.getByRole('list', { name: 'Checks: Mail DNS and nameservers' });
  await expect(dns.getByRole('listitem')).toHaveCount(5);
  const ns = dns.getByRole('listitem').filter({ hasText: 'Nameservers:' });
  await expect(ns).toContainText('ns1.dreamhost.com, ns2.dreamhost.com');

  // the nameservers move: failed once, then down, with what they were
  await control('/nameservers-moved');
  await control('/monitor-round-all');
  await control('/monitor-round-all');
  await page.reload();
  await expect(ns).toContainText('down');
  await expect(ns).toContainText('changed: now ns1.example.net, ns2.example.net; it was ns1.dreamhost.com, ns2.dreamhost.com');
  await ns.getByRole('button', { name: 'Keep as it is now' }).click();
  await expect(notice(page)).toContainText('Kept as it is now.');
  await expect(ns).toContainText('ns1.example.net, ns2.example.net');
  await expect(ns).not.toContainText('down');
  await expect(ns.getByRole('button', { name: 'Keep as it is now' })).toHaveCount(0);

  await page.goto('/activity');
  await expect(page.getByText('kept the DNS record Nameservers: lesfleursdelanuit.com as it is now (monitoring)')).toBeVisible();
});

// Step 3: the addresses outside lfdln's hosts every round (Q5), mailed when down; the
// domain's registration hourly, shown and never mailed (Q4)
test('Monitoring: other addresses and the registration', async ({ page }) => {
  await control('/monitor-round-all');
  await page.goto('/monitoring');
  const other = page.getByRole('list', { name: 'Checks: Other addresses' });
  await expect(other.getByRole('listitem')).toHaveCount(4);
  await expect(other.getByRole('listitem').filter({ hasText: 'https://gonsalvesfamily.com/' })).toContainText('answers 200, certificate: 60 day(s) left');
  await expect(other.getByRole('listitem').filter({ hasText: 'https://panel.pammy.org/login' })).toContainText('answers 200 through Cloudflare');
  await expect(page.getByRole('list', { name: 'Checks: The domain' })).toContainText(/Registration: lesfleursdelanuit\.com.*registered until \d{4}-\d{2}-\d{2} \(\d+ day\(s\)\)/);

  // one goes down after two rounds, with one email; back after one
  const before = (await sent()).length;
  await control('/url-down/admin.gonsalvesfamily.com');
  await control('/monitor-round');
  await control('/monitor-round');
  await page.reload();
  const admin = other.getByRole('listitem').filter({ hasText: 'https://admin.gonsalvesfamily.com/api/health' });
  await expect(admin).toContainText('down');
  await expect(admin).toContainText('answers 502');
  const mails = await sent();
  expect(mails.length).toBe(before + 1);
  expect(JSON.stringify(mails.at(-1))).toContain('admin.gonsalvesfamily.com');
  await control('/urls-up');
  await control('/monitor-round');
  await page.reload();
  await expect(admin).not.toContainText('down');
});
