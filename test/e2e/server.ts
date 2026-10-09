// The whole panel on one port for the browser tests: the app, the website
// folder helper and the gate's admin side, all in this process, over a
// throwaway website and databases (the gate's in a throwaway Postgres container,
// pammy-pg-test-<pid>, removed when it stops).
//   node test/e2e/server.ts        (playwright.config.ts starts it)
// It writes an account manager's setup link to $PAMMY_E2E_STATE/invite.json.
import { createServer } from 'node:http';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanAccess, COMMAND_LINE, createInvite, createUser, getUserByName, setAccess } from '@panel/core/accounts';
import { buildApp } from '@panel/pammy/app';
import type { Config } from '@panel/core/config';
import { siteFacts } from '@panel/core/profile';
import { PROFILE } from '@panel/pammy/profile';
import { migrate } from '@panel/core/pg-migrate';
import { createGateAdminServer, handleAdmin } from '@panel/pammy/gate/admin';
import { buildGateApp } from '@panel/pammy/gate/app';
import { addResponse } from '@panel/forms/gate/forms/responses';
import { formById, setFormSwitches } from '@panel/forms/gate/forms/store';
import { addAccessRequest, addResetRequest, areaById } from '@panel/core/gate/store';
import type { DatabaseFacts, Driver } from '@panel/studio/pammydb/driver';
import type { AccessRole } from '@panel/studio/pammydb/roles';
import { memoryRows, memorySchemas, seedTables } from '../studio-stub.ts';
import { createPammyDbServer } from '@panel/studio/pammydb/service';
import { adoptWordPress } from '@panel/apps/apps/adopt';
import { createOps } from '@panel/apps/apps/ops';
import { createAppsServer } from '@panel/apps/apps/service';
import { createMailServer } from '@panel/mail/mail/service';
import { readKey, readSettings } from '@panel/mail/mail/settings';
import { fakeSystem, wordpressServer } from '../apps-world.ts';
import { startProxy } from '../fake-pammydb.ts';
import { createSiteFsServer } from '@panel/files/sitefs/service';
import { DEFAULT_TOOLS } from '@panel/thumbs/thumbs/make';
import { createThumbsServer } from '@panel/thumbs/thumbs/service';
import { newGate } from '../gate-seed.ts';
import { startPg } from '../pg-harness.ts';

const PORT = Number(process.env.PAMMY_E2E_PORT ?? 3199);
const STATE = process.env.PAMMY_E2E_STATE ?? join(import.meta.dirname, '.state');
const root = new URL('../../', import.meta.url).pathname;
const now = () => Math.floor(Date.now() / 1000);

const dir = mkdtempSync(join(tmpdir(), 'pammy-e2e-'));
const pub = join(dir, 'public');
for (const d of ['recipes', 'family', 'family/photos', 'Old Stuff', 'blog-drafts']) mkdirSync(join(pub, d), { recursive: true });
writeFileSync(join(pub, 'recipes', 'index.html'), '<h1>Recipes</h1>');
writeFileSync(join(pub, 'family', 'index.html'), '<h1>Family</h1>');
mkdirSync(join(dir, 'trash'));

// the guides, as build.sh copies them
const help = join(dir, 'help');
mkdirSync(help);
for (const line of readFileSync(join(root, '../guides.map'), 'utf8').split('\n')) {
  if (!line.trim() || line.trim().startsWith('#')) continue;
  const [src, dst] = line.trim().split(/\s+/);
  copyFileSync(join(root, '..', src!), join(help, dst!));
}
copyFileSync(join(root, '../guides.map'), join(help, 'guides.map'));

const sitefs = createSiteFsServer({ publicDir: pub, trashDir: join(dir, 'trash'), placementFile: join(dir, 'no-placement'), domain: 'pammy.org', siteName: 'pammy.org', folderSubdomains: true, maxUpload: 100 * 1024 * 1024, purgeDays: 30, now: () => new Date() });
await new Promise<void>((r) => sitefs.listen(join(dir, 'sitefs.sock'), r));
const thumbsServer = createThumbsServer({ publicDir: pub, tools: DEFAULT_TOOLS });
await new Promise<void>((r) => thumbsServer.listen(join(dir, 'thumbs.sock'), r));
const pg = await startPg();
const gateLive = await newGate(pg, now);
const gateDb = gateLive.db;
// Her two database engines, stood in for: enough that /databases is a real page
// in the browser tests. test/pammydb.test.ts is what drives the actual engines.
const engineHas: Record<'postgres' | 'mariadb', string[]> = {
  postgres: ['postgres', 'pamela', 'family_recipes'],
  mariadb: ['mysql', 'pamela'],
};
const dbFacts = (engine: 'postgres' | 'mariadb', name: string): DatabaseFacts => ({
  engine, name, bytes: name === 'pamela' ? 8 * 1024 * 1024 : 4096, tables: name === 'pamela' ? 3 : 0,
  owner: engine === 'postgres' ? 'pammy_studio' : null,
  protectedName: ['pamela', 'postgres', 'mysql'].includes(name),
  system: ['postgres', 'mysql'].includes(name),
});
// Logins and their access, for the /databases/users pages.
const engineUsers: Record<'postgres' | 'mariadb', string[]> = {
  postgres: ['postgres', 'pamela', 'recipes_app'],
  mariadb: ['root', 'pamela'],
};
const engineGrants = new Map<string, AccessRole>([['postgres:recipes_app:family_recipes', 'write']]);
// the shape inside each database, in memory, so the designer pages work in the
// browser tests (test/studio-stub.ts)
const engineSchemas = {
  postgres: memorySchemas('postgres', { family_recipes: seedTables() }),
  mariadb: memorySchemas('mariadb', {}),
};
// A few rows, so the generated pages have something to show in the browser
// tests (test/studio-stub.ts memoryRows).
const appRows = memoryRows({
  family_recipes: {
    recipes: [
      { id: 1, title: 'Olivia\u2019s pancakes', servings: 4, tags: null },
      { id: 2, title: 'Sunday roast', servings: 6, tags: null },
      { id: 3, title: 'Lemon drizzle', servings: 8, tags: null },
    ],
  },
});
const engineStub = (engine: 'postgres' | 'mariadb'): Driver => ({
  engine,
  state: async () => ({ engine, ok: true, version: null, message: null }),
  list: async () => engineHas[engine].map((n) => dbFacts(engine, n)),
  create: async (name) => { engineHas[engine].push(name); return dbFacts(engine, name); },
  drop: async (name) => {
    engineHas[engine] = engineHas[engine].filter((n) => n !== name);
    // and everything in it, as on a real engine
    engineSchemas[engine].set(name, []);
    appRows.forget(name);
  },
  size: async (name) => ({ bytes: dbFacts(engine, name).bytes, tables: dbFacts(engine, name).tables ?? 0 }),
  introspect: (database) => engineSchemas[engine].introspect(engine, database),
  apply: (database, steps) => engineSchemas[engine].apply(engine, database, steps),
  listUsers: async () => engineUsers[engine].map((name) => ({
    engine, name, host: engine === 'mariadb' ? '%' : null, canLogin: true,
    reserved: ['postgres', 'pamela', 'root'].includes(name), serverWide: name === 'pamela',
  })),
  createUser: async (name) => {
    engineUsers[engine].push(name);
    return { engine, name, host: engine === 'mariadb' ? '%' : null, canLogin: true, reserved: false, serverWide: false };
  },
  dropUser: async (name) => {
    engineUsers[engine] = engineUsers[engine].filter((n) => n !== name);
    for (const k of [...engineGrants.keys()]) if (k.startsWith(`${engine}:${name}:`)) engineGrants.delete(k);
  },
  setPassword: async () => {},
  accessOf: async (user, databases) => databases
    .map((database) => ({ database, role: engineGrants.get(`${engine}:${user}:${database}`) }))
    .filter((a): a is { database: string; role: AccessRole } => !!a.role),
  grant: async (user, database, role) => { engineGrants.set(`${engine}:${user}:${database}`, role); },
  revoke: async (user, database) => { engineGrants.delete(`${engine}:${user}:${database}`); },
  listRows: (database, q) => appRows.list(database, q),
  getRow: (database, table, columns, where) => appRows.get(database, table, columns, where),
  insertRow: (database, table, values, back) => appRows.insert(database, table, values, back),
  updateRow: (database, table, values, where, back) => appRows.update(database, table, values, where, back),
  deleteRow: (database, table, where) => appRows.remove(database, table, where),
  setLinks: (database, table, here, id, there, ids) => appRows.setLinks(database, table, here, id, there, ids),
  close: async () => {},
});
const pammydb = createPammyDbServer({ postgres: engineStub('postgres'), mariadb: engineStub('mariadb') });
await new Promise<void>((r) => pammydb.listen(join(dir, 'pammydb-real.sock'), r));
// Everything reaches the helper through a proxy, so that one test can have a
// write taken and its answer never sent back (docs/refactor-plan.md phase 2,
// B3): the row is written, the gate never hears, and Responses has to say so.
const helperProxy = await startProxy(join(dir, 'pammydb.sock'), join(dir, 'pammydb-real.sock'));

// The software helper (docs/apps-plan.md), over a folder laid out like the
// server, with the WordPress there adopted -- and the site answering, as far as
// the one request through nginx goes.
const wpServer = wordpressServer(join(dir, 'apps-root'));
wpServer.lay();
await adoptWordPress({ root: join(dir, 'apps-root'), domain: 'pammy.org' }, join(dir, 'apps-state'), now() - 7 * 86400);
const appsServer = createAppsServer(createOps({
  root: join(dir, 'apps-root'), domain: 'pammy.org', nginx: { host: '127.0.0.1', port: 443 },
  probe: async () => ({ status: 200, ms: 83, error: null }), now,
}, join(dir, 'apps-state'), {
  // systemd, podman and nginx played along with (test/apps-world.ts), slowly
  // enough that a job can be seen running
  ...fakeSystem(wpServer, now, { delayMs: 1200 }),
  templates: new URL('../../../wordpress/nginx/templates/', import.meta.url).pathname,
  wpConfig: new URL('../../../wordpress/config/', import.meta.url).pathname,
}));
await new Promise<void>((r) => appsServer.listen(join(dir, 'apps.sock'), r));
// the mail service, reading what the software helper writes, with Resend stood in for
const mailServer = createMailServer({ names: { site: PROFILE.name, panel: PROFILE.panelName },
  settings: () => readSettings(join(dir, 'apps-root/etc/pammy-mail/settings.json')),
  key: () => readKey(join(dir, 'apps-root/etc/pammy-mail/resend.key')),
  fetch: (async () => new Response(JSON.stringify({ id: 'e2e-email' }), { status: 200 })) as unknown as typeof fetch,
  panelOrigin: `http://localhost:${PORT}`, domain: 'pammy.org', now,
});
await new Promise<void>((r) => mailServer.listen(join(dir, 'mail.sock'), r));

const gateAdmin = createGateAdminServer(gateLive, now, () => {}, { publicRoot: pub, domain: 'pammy.org', pammydbSocket: join(dir, 'pammydb.sock') });
await new Promise<void>((r) => gateAdmin.listen(join(dir, 'gate.sock'), r));

// Things that arrive from visitors: a request, a forgotten password, two responses.
const family = await handleAdmin(gateLive, now(), { op: 'area.create', path: 'family' }) as { id: number };
writeFileSync(join(pub, "family", ".pammy-protected"), `pammy-protected ${(await areaById(gateDb, family.id))!.token}\n`);
const jo = await handleAdmin(gateLive, now(), { op: 'visitor.create', username: 'auntie.jo', name: 'Auntie Jo', password: 'correct-horse-battery', contact: '07700 900123' }) as { id: number };
await handleAdmin(gateLive, now(), { op: 'grant', visitorId: jo.id, areaId: family.id, allow: true });
await addAccessRequest(gateDb, now(), (await areaById(gateDb, family.id))!, { name: 'Rose Smith', contact: 'rose@example.com', message: 'It is Rose, your cousin!' }, 'pammy.org', '198.51.100.7');
await addResetRequest(gateDb, now(), (await areaById(gateDb, family.id))!, 'auntie.jo', 'I forgot it again', 'pammy.org', null);
// The converted sample form, switched on, on a page of her website.
await setFormSwitches(gateDb, 1, { enabled: true, approvable: true });
const sample = (await formById(gateDb, 1))!;
writeFileSync(join(pub, 'recipes', 'ask.html'), '<pammy-form name="sample-contact-form"></pammy-form>');
const answersOf = (name: string, email: string, phone: string, about: string, message: string, list: boolean) =>
  ({ 'your-name': name, 'email-address': email, 'phone-number': phone, 'what-is-it-about': about, message, 'add-me-to-the-mailing-list': list });
await addResponse(gateDb, now() - 3600, sample, 'recipes/ask.html', answersOf('Sam Lee', 'sam@example.com', '+44 7700 900456', 'A booking', 'Can I book a cooking class?', true), null, 'pammy.org', null);
await addResponse(gateDb, now() - 60, sample, 'recipes/ask.html', answersOf('Priya', 'priya@example.com', '', '', 'Loved the lemon cake.', false), null, 'pammy.org', null);

// The gate's public side, on its own port: the browser tests point pammy.org at
// it, so the worked examples in their frame are the real thing (13, 14).
const gate = buildGateApp({ publicRoot: pub, domain: 'pammy.org', now, pammydbSocket: join(dir, 'pammydb.sock'), mediaIndex: join(dir, 'media-public', 'index.db'), mediaThumbs: join(dir, 'media-public', 'thumbs') }, gateLive);
await gate.listen({ host: '127.0.0.1', port: PORT - 2 });

const origin = `http://localhost:${PORT}`;
// what deploy/install-panel.sh makes on the server (docs/tutorial-examples-plan.md)
mkdirSync(join(dir, 'tutorial-examples'));
const config: Config = {
  site: siteFacts(PROFILE),
  origin, rpID: 'localhost', rpName: 'pammy.org panel', pgPasswordFile: '', host: '127.0.0.1', port: PORT,
  publicDir: join(root, 'public'), helpDir: help, sitefsSocket: join(dir, 'sitefs.sock'), gateSocket: join(dir, 'gate.sock'),
  thumbsSocket: join(dir, 'thumbs.sock'), thumbsDir: join(dir, 'media-public', 'thumbs'), mediaPublicDir: join(dir, 'media-public'),
  pammydbSocket: join(dir, 'pammydb.sock'), appsSocket: join(dir, 'apps.sock'), mailSocket: join(dir, 'mail.sock'), now,
  // the tutorial examples ask this test's gate (docs/tutorial-examples-plan.md)
  tutorialsDir: new URL('../../tutorials/', import.meta.url).pathname, tutorialExamplesDir: join(dir, 'tutorial-examples'), gateUrl: `http://127.0.0.1:${PORT - 2}`,
};
// the panel's own database, beside the gate's in the same test container
const panelDatabase = pg.freshDatabase();
const owner = pg.connect('owner', panelDatabase, 1);
await migrate(owner);
await owner.end();
const db = pg.connect('panel', panelDatabase, 8);
const manager = await createUser(db, now(), COMMAND_LINE, 'pamela', 'Pamela', 'manager');
mkdirSync(STATE, { recursive: true });
writeFileSync(join(STATE, 'invite.json'), JSON.stringify({ origin, token: (await createInvite(db, now(), COMMAND_LINE, manager)).token }));

// For the tests only, on its own port: things arriving from visitors while a page is open.
const control = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/message') {
    await addResponse(gateDb, now(), sample, 'recipes/ask.html', answersOf('Nadia', 'nadia@example.com', '', '', 'Is the bakery open on Sundays?', false), null, 'pammy.org', null);
  } else if (req.method === 'POST' && req.url === '/swallow-next-write') {
    // the next thing written into one of her databases gets no answer back
    helperProxy.swallow = 1;
  } else if (req.method === 'POST' && req.url === '/request') {
    await addAccessRequest(gateDb, now(), (await areaById(gateDb, family.id))!, { name: 'Tom Baker', contact: 'tom@example.com', message: '' }, 'pammy.org', null);
  } else if (req.method === 'POST' && req.url === '/limited') {
    // an account that only sees recipes (docs/media-plan.md D22), with its setup link
    const u = await getUserByName(db, 'badmon') ?? await createUser(db, now(), COMMAND_LINE, 'badmon', 'Badmon');
    await setAccess(db, now(), COMMAND_LINE, u, cleanAccess(['files', 'media', 'forms', 'responses', 'comments'], ['/recipes']));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ token: (await createInvite(db, now(), COMMAND_LINE, u)).token }));
    return;
  } else if (req.method === 'POST' && req.url === '/wordpress-db-stops') {
    wpServer.container('pammywp-db', false);
  } else if (req.method === 'POST' && req.url === '/wordpress-db-starts') {
    wpServer.container('pammywp-db', true, 122_650_624);
  } else if (req.method === 'POST' && req.url === '/media-outside') {
    // what WinSCP would do: a picture put in by hand, and a file where no media file goes
    mkdirSync(join(pub, 'recipes', 'media', 'images'), { recursive: true });
    writeFileSync(join(pub, 'recipes', 'media', 'images', 'from-winscp.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mP8z8DwnwEIGGEMAB3+Av4U2F1YAAAAAElFTkSuQmCC', 'base64'));
    writeFileSync(join(pub, 'recipes', 'media', 'notes.txt'), 'stray');
  } else {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(204).end();
});
await new Promise<void>((r) => control.listen(PORT - 1, '127.0.0.1', r));

const app = buildApp(config, db);
await app.listen({ host: '127.0.0.1', port: PORT });
console.log(`e2e panel on ${origin} (${dir})`);

const stop = () => {
  void Promise.all([app.close(), gate.close()]).finally(() => {
    sitefs.close();
    thumbsServer.close();
    pammydb.close();
    appsServer.close();
    mailServer.close();
    void helperProxy.stop();
    control.close();
    gateAdmin.close();
    rmSync(dir, { recursive: true, force: true });
  }).then(() => Promise.all([gateDb.end({ timeout: 2 }), db.end({ timeout: 2 })])).finally(() => {
    pg.stop();
    process.exit(0);
  });
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
