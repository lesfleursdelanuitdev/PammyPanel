// The site profile (docs/packaging-plan.md step 5): pammy.org's facts are in
// sites/pammy/src/profile.ts, and panel.env and the units say many of them again
// (the environment wins, and a rollback keeps the units). These check that the
// two say the same, so neither can drift from the other unnoticed.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '@panel/core/config';
import { REGISTRY } from '@panel/modules/index';
import { PROFILE } from '@panel/pammy/profile';
import { PROFILE as LFDLN } from '@panel/lfdln/profile';

const ROOT = join(import.meta.dirname, '..');
const DEPLOY = join(ROOT, 'deploy');

// KEY=value lines, as systemd's EnvironmentFile= and Environment= read them
const envFile = (text: string) => Object.fromEntries(text.split('\n')
  .map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const unitEnv = (unit: string) => envFile(readFileSync(join(DEPLOY, unit), 'utf8').split('\n')
  .filter((l) => l.startsWith('Environment=')).map((l) => l.slice('Environment='.length)).join('\n'));

describe('the site profile', () => {
  it('gives the panel what panel.env gives it', () => {
    const env = envFile(readFileSync(join(DEPLOY, 'panel.env'), 'utf8'));
    const withEnv = loadConfig(PROFILE, REGISTRY, env);
    // the profile alone: only the origin is required of the environment
    const alone = loadConfig(PROFILE, REGISTRY, { PANEL_ORIGIN: PROFILE.panelOrigin });
    const { now: _a, ...a } = withEnv;
    const { now: _b, ...b } = alone;
    assert.deepEqual(b, a);
    assert.equal(env.PANEL_ORIGIN, PROFILE.panelOrigin);
  });

  it('says what the units say', () => {
    const sv = PROFILE.services;
    const expect: Record<string, Record<string, string>> = {
      'pammy-gate.service': {
        GATE_PG_HOST: sv.pg.host, GATE_PG_PORT: String(sv.pg.port), GATE_PG_DATABASE: sv.pg.database,
        GATE_AREAS_SNAPSHOT: sv.gate.snapshot, GATE_PUBLIC: PROFILE.website.public, GATE_DOMAIN: PROFILE.domain,
        GATE_HOST: sv.gate.host, GATE_PORT: String(sv.gate.port),
        GATE_MEDIA_INDEX: join(sv.mediaPublic, 'index.db'), GATE_MEDIA_THUMBS: join(sv.mediaPublic, 'thumbs'),
        // S2: the gate's own door to the database helper (row ops only)
        GATE_PAMMYDB_SOCKET: sv.sockets.pammydbGate,
      },
      'pammy-sitefs.service': {
        SITEFS_PUBLIC: PROFILE.website.public, SITEFS_TRASH: PROFILE.website.trash,
        SITEFS_PLACEMENT: sv.wordpressPlacement, SITEFS_PURGE_DAYS: String(sv.trashDays),
      },
      'pammy-thumbs.service': { THUMBS_PUBLIC: PROFILE.website.public },
      'pammy-mail.service': { MAIL_SETTINGS: sv.mailSettings, MAIL_PANEL_ORIGIN: PROFILE.panelOrigin },
    };
    for (const [unit, want] of Object.entries(expect)) assert.deepEqual(unitEnv(unit), want, unit);
    // the sitefs helper runs as her
    assert.match(readFileSync(join(DEPLOY, 'pammy-sitefs.service'), 'utf8'), new RegExp(`^User=${PROFILE.owner.user}$`, 'm'));
  });

  it('names the sockets the socket units listen on', () => {
    const listen = (unit: string) => /^ListenStream=(.+)$/m.exec(readFileSync(join(DEPLOY, unit), 'utf8'))?.[1];
    const s = PROFILE.services.sockets;
    assert.equal(listen('pammy-sitefs.socket'), s.sitefs);
    assert.equal(listen('pammy-gate-admin.socket'), s.gateAdmin);
    assert.equal(listen('pammy-thumbs.socket'), s.thumbs);
    assert.equal(listen('pammy-pammydb.socket'), s.pammydb);
    assert.equal(listen('pammy-pammydb-gate.socket'), s.pammydbGate);
    assert.equal(listen('pammy-apps.socket'), s.apps);
    assert.equal(listen('pammy-mail.socket'), s.mail);
  });

  it("puts nginx's files where the installer says, with the certificate it checks for", () => {
    const sh = readFileSync(join(DEPLOY, 'install-panel.sh'), 'utf8');
    const v = (name: string) => new RegExp(`^${name}=(.+)$`, 'm').exec(sh)?.[1];
    assert.equal(v('NGX'), PROFILE.nginx.panelDir);
    assert.equal(v('GATE_NGX'), PROFILE.nginx.gateDir);
    assert.equal(v('SITE'), `/etc/nginx/sites-available/${PROFILE.nginx.panel}`);
    assert.ok(sh.includes(`-f ${PROFILE.tls.panel.cert} && -f ${PROFILE.tls.panel.key} ]]`), 'the installer checks for the panel certificate');
  });

  // which modules exist and what each needs: test/modules.test.ts (C1)
});

// lfdln's (docs/lfdln-standup-plan.md): its own panel.env and units, in deploy/lfdln/
describe("lfdln's profile", () => {
  const LD = join(DEPLOY, 'lfdln');
  const unitEnvL = (unit: string) => envFile(readFileSync(join(LD, unit), 'utf8').split('\n')
    .filter((l) => l.startsWith('Environment=')).map((l) => l.slice('Environment='.length)).join('\n'));
  const unitOf = (unit: string) => readFileSync(join(LD, unit), 'utf8');

  it('gives the panel what its panel.env gives it', () => {
    const env = envFile(readFileSync(join(LD, 'panel.env'), 'utf8'));
    const { now: _a, ...a } = loadConfig(LFDLN, REGISTRY, env);
    const { now: _b, ...b } = loadConfig(LFDLN, REGISTRY, { PANEL_ORIGIN: LFDLN.panelOrigin });
    assert.deepEqual(b, a);
    assert.equal(env.PANEL_ORIGIN, LFDLN.panelOrigin);
  });

  it('says what its units say', () => {
    const sv = LFDLN.services;
    assert.deepEqual(unitEnvL('lfdln-sitefs.service'), {
      SITEFS_PUBLIC: LFDLN.website.public, SITEFS_TRASH: LFDLN.website.trash, SITEFS_PURGE_DAYS: String(sv.trashDays),
    });
    assert.equal(/^ListenStream=(.+)$/m.exec(unitOf('lfdln-sitefs.socket'))?.[1], sv.sockets.sitefs);
    // the thumbnail service (docs/phase8-plan.md step 8-1): what it reads, and its door
    assert.deepEqual(unitEnvL('lfdln-thumbs.service'), { THUMBS_PUBLIC: LFDLN.website.public });
    assert.equal(/^ListenStream=(.+)$/m.exec(unitOf('lfdln-thumbs.socket'))?.[1], sv.sockets.thumbs);
    assert.match(unitOf('lfdln-panel.service'), new RegExp(`^ReadWritePaths=.* ${sv.mediaPublic}$`, 'm'));
    assert.equal(/^ListenStream=(.+)$/m.exec(readFileSync(join(ROOT, 'packages/hosts/deploy/lfdln-routes.socket'), 'utf8'))?.[1], sv.sockets.routes);
    // the projects helper (docs/phase8b-plan.md): its door, and the state folder it may write
    assert.equal(/^ListenStream=(.+)$/m.exec(readFileSync(join(ROOT, 'packages/projects/deploy/lfdln-projects.socket'), 'utf8'))?.[1], sv.sockets.projects);
    assert.match(readFileSync(join(ROOT, 'packages/projects/deploy/lfdln-projects.service'), 'utf8'), /^ReadWritePaths=\/var\/lib\/lfdln-projects \/run\/lfdln-projects$/m);
    // PHP's socket is where the hosts' nginx files send .php requests
    assert.match(unitOf('lfdln-php.service'), new RegExp(`^RuntimeDirectory=${sv.phpRun.replace('/run/', '')}$`, 'm'));
    assert.match(readFileSync(join(LD, 'php/php-fpm.conf'), 'utf8'), new RegExp(`^listen = ${sv.phpRun}/fpm.sock$`, 'm'));
    // the database's port and name, as its install and Quadlet have them
    const lib = readFileSync(join(LD, 'pg/lib-pg.sh'), 'utf8');
    assert.match(lib, new RegExp(`^PG_PORT=${sv.pg.port}$`, 'm'));
    assert.match(lib, new RegExp(`^PG_DB=${sv.pg.database}$`, 'm'));
    assert.match(readFileSync(join(LD, 'pg/quadlet/lfdln-pg.container'), 'utf8'), new RegExp(`^PublishPort=127\\.0\\.0\\.1:${sv.pg.port}:5432$`, 'm'));
    // its gate (docs/accounts-plan.md step 3): where the panel and nginx look for it
    const gate = LFDLN.services.gate!;
    assert.deepEqual(unitEnvL('lfdln-gate.service'), {
      GATE_PG_HOST: sv.pg.host, GATE_PG_PORT: String(sv.pg.port), GATE_PG_DATABASE: sv.pg.database,
      GATE_AREAS_SNAPSHOT: gate.snapshot, GATE_PUBLIC: LFDLN.website.public, GATE_DOMAIN: LFDLN.domain,
      GATE_HOST: gate.host, GATE_PORT: String(gate.port), GATE_PAMMYDB_SOCKET: sv.sockets.pammydbGate,
    });
    // the Studio's helper (docs/phase8-plan.md step 8-4): its door, and PHP's door to the gate's API
    assert.equal(/^ListenStream=(.+)$/m.exec(unitOf('lfdln-pammydb.socket'))?.[1], sv.sockets.pammydb);
    assert.equal(/^ListenStream=(.+)$/m.exec(unitOf('lfdln-pammydb-gate.socket'))?.[1], sv.sockets.pammydbGate);
    assert.match(readFileSync(join(LD, 'php/php-fpm.conf'), 'utf8'), new RegExp(`^env\\[PAMMY_API_SOCKET\\] = ${/^ListenStream=(.+)$/m.exec(unitOf('lfdln-gate-php.socket'))![1]}$`, 'm'));
    assert.equal(/^ListenStream=(.+)$/m.exec(unitOf('lfdln-gate-admin.socket'))?.[1], sv.sockets.gateAdmin);
    assert.equal(gate.cookie, '__Host-lfdln_visitor');
    // every unit runs this release's code, from the entry its site names
    for (const u of ['lfdln-panel.service', 'lfdln-sitefs.service', 'lfdln-thumbs.service', 'lfdln-gate.service']) {
      const exec = /^ExecStart=\S+ \S+ (\S+)$/m.exec(unitOf(u))?.[1] ?? '';
      assert.ok(exec.startsWith('/opt/lfdln-panel/sites/lfdln/src/') && existsSync(join(ROOT, exec.replace('/opt/lfdln-panel/', ''))), `${u}: ${exec}`);
    }
    for (const u of ['hosts/deploy/lfdln-routes.service', 'services/deploy/lfdln-services.service']) {
      const exec = /^ExecStart=\S+ \S+ (\S+)$/m.exec(readFileSync(join(ROOT, 'packages', u), 'utf8'))?.[1] ?? '';
      assert.ok(existsSync(join(ROOT, exec.replace('/opt/lfdln-panel/', ''))), exec);
    }
    // the services helper's door (docs/adopt-plan.md V7)
    assert.equal(/^ListenStream=(.+)$/m.exec(readFileSync(join(ROOT, 'packages/services/deploy/lfdln-services.socket'), 'utf8'))?.[1], sv.sockets.services);
  });

  it("puts nginx's file where the installer says, with the certificate it checks for", () => {
    const sh = readFileSync(join(LD, 'install-lfdln.sh'), 'utf8');
    const v = (name: string) => new RegExp(`^${name}=(.+)$`, 'm').exec(sh)?.[1];
    assert.equal(v('NGX_SITE'), `/etc/nginx/sites-available/${LFDLN.nginx.panel}`);
    assert.equal(`${v('CERT')}/fullchain.pem`, LFDLN.tls.panel.cert);
    assert.equal(`${v('CERT')}/privkey.pem`, LFDLN.tls.panel.key);
    assert.equal(v('PORT'), String(LFDLN.services.panel.port));
    assert.equal(v('SITES'), LFDLN.website.public);
    assert.equal(`${v('SITES')}/.trash`, LFDLN.website.trash);
  });
});
