// The Studio on lfdln (docs/phase8-plan.md step 8-4): what the helper is told and what the
// appdb installer grants must name the same apps' databases, and nothing of Pamela's.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { APP_DATABASES, APPDB_PORT, LFDLN_HELPER } from '@panel/lfdln/studio-site';
import { PROFILE } from '@panel/lfdln/profile';
import { PAMMY_HELPER } from '@panel/studio/pammydb/config';

const lib = readFileSync(new URL('../deploy/lfdln/appdb/lib-appdb.sh', import.meta.url), 'utf8');
const hba = readFileSync(new URL('../deploy/lfdln/appdb/pg_hba.conf', import.meta.url), 'utf8');

describe("lfdln's Studio", () => {
  it("the appdb installer grants the Studio read on exactly the helper's apps' databases", () => {
    const m = /APPDB_STUDIO_READS=\(([^)]*)\)/.exec(lib);
    assert.ok(m);
    assert.deepEqual(Object.fromEntries(m[1]!.trim().split(/\s+/).map((e) => e.split(':'))), APP_DATABASES);
  });

  it("the apps' logins are all reserved, and the helper never reaches another site's engine", () => {
    const roles = [/APPDB_ROLES=\(([^)]*)\)/, /APPDB_APP_ROLES=\(([^)]*)\)/].flatMap((re) => re.exec(lib)![1]!.trim().split(/\s+/));
    for (const r of roles) assert.ok(LFDLN_HELPER.rules!.postgres!.reservedUsers.includes(r), r);
    // and lfdln-appmaria, the Studio's own MariaDB (docs/lfdln-mariadb-plan.md M4), never Pamela's 3307
    assert.deepEqual(Object.keys(LFDLN_HELPER.engines), ['postgres', 'mariadb']);
    assert.equal(LFDLN_HELPER.engines.postgres!.port, APPDB_PORT);
    assert.equal(LFDLN_HELPER.engines.mariadb!.port, 3308);
    assert.match(readFileSync(new URL('../deploy/lfdln/appmaria/lib-appmaria.sh', import.meta.url), 'utf8'), /^APPMARIA_PORT=3308$/m);
    assert.match(readFileSync(new URL('../deploy/lfdln/appmaria/quadlet/lfdln-appmaria.container', import.meta.url), 'utf8'), /^PublishPort=127\.0\.0\.1:3308:3306$/m);
    for (const p of [5432, 5433, 5434, 5435, 3307]) assert.ok(LFDLN_HELPER.forbiddenPorts.includes(p), String(p));
    for (const p of Object.values(PAMMY_HELPER.engines)) assert.ok(LFDLN_HELPER.forbiddenPorts.includes(p!.port));
    assert.equal(PROFILE.services.studioPorts?.postgres, APPDB_PORT);
    assert.equal(PROFILE.services.studioPorts?.mariadb, 3308);
  });

  it("pg_hba lets the Studio's login in before the rejects, with a password", () => {
    const lines = hba.split('\n').filter((l) => /^(local|host)/.test(l));
    const at = lines.findIndex((l) => /\bpammy_studio\b/.test(l));
    assert.ok(at >= 0 && /scram-sha-256$/.test(lines[at]!));
    assert.ok(at < lines.findIndex((l) => /\breject$/.test(l)));
  });

  it("the Studio's own logins (db_..., P8-15): admitted, but never to an app's database", () => {
    const lines = hba.split('\n').filter((l) => /^(local|host)/.test(l));
    const allow = lines.findIndex((l) => /\/\^db_\[a-z0-9_\]\+\$\s+all\s+scram-sha-256$/.test(l));
    const deny = lines.findIndex((l) => /\/\^db_\s+all\s+reject$/.test(l));
    assert.ok(deny >= 0 && allow > deny, 'the rejects come first');
    const denied = lines[deny]!.trim().split(/\s+/)[1]!.split(',');
    for (const db of [...Object.keys(APP_DATABASES), 'postgres']) assert.ok(denied.includes(db), db);
    assert.equal(LFDLN_HELPER.rules!.postgres!.userPrefix, 'db_');
    assert.equal(PROFILE.services.studioUserPrefix, 'db_');
  });
});
