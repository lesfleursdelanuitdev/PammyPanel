// lfdln-offsite (docs/recovery-plan.md, R1) with a restic that stands in for the real one:
// it records every call (with the target's repository and region) and plays its part (a
// backup prints a summary, a restore writes files). What the real restic does with the same
// calls is test/run-offsite-test.sh's to check, against a throwaway MinIO with two targets.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const SCRIPT = new URL('../deploy/recovery/lfdln-offsite', import.meta.url).pathname;
const SOURCES = new URL('../deploy/recovery/sources.conf', import.meta.url).pathname;
const R2 = 's3:https://acct123.r2.cloudflarestorage.com/lfdln-offsite/vps';
const B2 = 's3:https://s3.us-west-004.backblazeb2.com/lfdln-offsite-momo/vps';

// one line per call: "<repository> <region> | <args>"
const FAKE_RESTIC = `#!/usr/bin/env bash
printf '%s %s | %s\\n' "$RESTIC_REPOSITORY" "\${AWS_DEFAULT_REGION:-none}" "$*" >> "$FAKE_LOG"
env | grep -E '^(AWS_|RESTIC_)' | sort >> "$FAKE_LOG.env"
if [[ -n $FAKE_FAIL && "$RESTIC_REPOSITORY $*" == *$FAKE_FAIL* ]]; then echo "fake restic: fails" >&2; exit 1; fi
case $1 in
  backup) for a in "$@"; do [[ $prev == --files-from-verbatim ]] && cp "$a" "$FAKE_LOG.list"; prev=$a; done
          echo '{"message_type":"status","percent_done":1}'
          echo '{"message_type":"summary","snapshot_id":"abc123","total_files_processed":7,"total_bytes_processed":4096,"data_added":1024}' ;;
  stats)  echo '{"total_size":99999}' ;;
  ls)     cat "$FAKE_LS" ;;
  restore) for a in "$@"; do [[ $prev == --target ]] && t=$a; prev=$a; done
          cp -a "$FAKE_TREE/." "$t/" ;;
esac
exit 0
`;

let dir: string;
let etc: string;
let state: string;
let log: string;

function run(args: string[], env: Record<string, string> = {}) {
    const r = spawnSync('bash', [SCRIPT, ...args], {
        encoding: 'utf8',
        env: {
            PATH: `${join(dir, 'bin')}:/usr/bin:/bin`,
            OFFSITE_ETC: etc, OFFSITE_STATE: state, OFFSITE_LOCK: join(dir, 'lock'),
            RESTIC: join(dir, 'bin', 'restic'), FAKE_LOG: log, ...env,
        },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
}
const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
const callsTo = (repo: string) => calls().filter((c) => c.startsWith(`${repo} `)).map((c) => c.split(' | ')[1] ?? '');
const json = (f: string) => JSON.parse(readFileSync(join(state, f), 'utf8'));

function keys(t: string, id = 'AKID', secret = 'SECRETKEY') {
    mkdirSync(join(etc, 'credentials', t), { recursive: true });
    writeFileSync(join(etc, 'credentials', t, 's3-access-key-id'), `${id}-${t}`);
    writeFileSync(join(etc, 'credentials', t, 's3-secret-access-key'), `${secret}-${t}`);
}
function configure(extra = '', targets = ['r2', 'b2']) {
    writeFileSync(join(etc, 'offsite.conf'), [
        'TARGETS="r2 b2"', `RESTIC_REPOSITORY_r2='${R2}?secret=no'`, `RESTIC_REPOSITORY_b2='${B2}'`,
        'HOST_TAG=testhost', 'HOST_PG=off', extra,
    ].join('\n'));
    writeFileSync(join(etc, 'credentials', 'restic-password'), 'pw');
    for (const t of targets) keys(t);
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'offsite-'));
    etc = join(dir, 'etc'); state = join(dir, 'state'); log = join(dir, 'calls');
    mkdirSync(join(etc, 'credentials'), { recursive: true });
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'restic'), FAKE_RESTIC); chmodSync(join(dir, 'bin', 'restic'), 0o755);
    for (const d of ['src/a', 'src/svc-one/backups', 'src/svc-two/backups']) mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(etc, 'sources.conf'), [
        '# a comment', '', `${dir}/src/a   # trailing comment`, `${dir}/src/svc-*/backups`, `${dir}/src/not-there`,
        'relative/path',
    ].join('\n'));
    writeFileSync(join(etc, 'excludes.conf'), '*.part\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('lfdln-offsite: targets', () => {
    it('does nothing without a configured target: exit 3, each target says what it lacks', () => {
        writeFileSync(join(etc, 'offsite.conf'), 'TARGETS="r2 b2"\nHOST_PG=off\n');
        const r = run(['backup']);
        assert.equal(r.code, 3);
        assert.match(r.err, /r2: not configured: missing RESTIC_REPOSITORY_r2 .*credentials\/r2\/s3-access-key-id.*restic-password/);
        assert.match(r.err, /b2: not configured/);
        const s = json('status.json');
        assert.equal(s.state, 'not-configured');
        assert.equal(s.targets.r2.state, 'not-configured');
        assert.deepEqual(calls(), [], 'restic never called');
    });

    it('backs up to each target in turn, each with its own repository, key and region', () => {
        configure();
        const r = run(['backup']);
        assert.equal(r.code, 0, r.err);
        for (const [repo, region] of [[R2, 'auto'], [B2, 'us-west-004']] as const) {
            const c = callsTo(`${repo}${repo === R2 ? '?secret=no' : ''} ${region}`);
            assert.match(c[0] ?? '', /^backup --json --quiet --tag nightly --host testhost --files-from-verbatim .* --exclude-file .*excludes.conf --exclude-caches$/);
            assert.equal(c[1], 'forget --quiet --host testhost --tag nightly --group-by host,tags --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune');
            assert.equal(c[2], 'check --quiet');
            assert.equal(c[3], 'stats --json --mode raw-data');
        }
        // one after the other: all of r2's calls before b2's
        const order = calls().map((c) => (c.includes('r2.cloudflarestorage') ? 'r2' : 'b2'));
        assert.deepEqual(order, [...Array(4).fill('r2'), ...Array(4).fill('b2')]);
        const env = readFileSync(`${log}.env`, 'utf8');
        assert.match(env, /AWS_SECRET_ACCESS_KEY=SECRETKEY-r2/);
        assert.match(env, /AWS_SECRET_ACCESS_KEY=SECRETKEY-b2/);
        assert.match(env, /RESTIC_CACHE_DIR=.*\/cache\/r2/);
        assert.match(env, new RegExp(`RESTIC_PASSWORD_FILE=${etc}/credentials/restic-password`));
        assert.doesNotMatch(env, /RESTIC_PASSWORD=/, 'the password goes by file, never by environment');
        // globs expanded, comments gone, missing and relative ones left out
        assert.deepEqual(readFileSync(`${log}.list`, 'utf8').trim().split('\n'),
            [`${dir}/src/a`, `${dir}/src/svc-one/backups`, `${dir}/src/svc-two/backups`]);
        assert.match(r.err, /not an absolute path: relative\/path/);
        const s = json('status.json');
        assert.equal(s.state, 'ok');
        assert.equal(s.targets.r2.snapshot, 'abc123');
        assert.equal(s.targets.b2.repository_bytes, 99999);
        assert.deepEqual(s.targets.r2.missing, [`${dir}/src/not-there`]);
        assert.equal(s.targets.r2.repository, R2, 'nothing after the ? is shown');
        assert.equal(json('status-b2.json').state, 'ok');
        assert.equal(statSync(join(state, 'status.json')).mode & 0o777, 0o644, 'Monitoring reads it');
        const raw = readFileSync(join(state, 'status.json'), 'utf8') + readFileSync(join(state, 'status-r2.json'), 'utf8');
        assert.ok(!raw.includes('SECRETKEY') && !raw.includes('AKID'), 'no key in the status');
    });

    it('one target failing does not stop the next; the run fails and says which', () => {
        configure();
        const r = run(['backup'], { FAKE_FAIL: 'r2.cloudflarestorage.com/lfdln-offsite/vps?secret=no backup' });
        assert.notEqual(r.code, 0);
        assert.match(r.err, /r2: failed at: restic backup/);
        assert.equal(json('status-r2.json').state, 'failed');
        assert.equal(json('status-b2.json').state, 'ok', 'b2 still backed up');
        assert.equal(callsTo(`${B2} us-west-004`).length, 4);
        assert.equal(json('status.json').state, 'failed');
    });

    it('a target without keys is skipped; the others run, and the run succeeds', () => {
        configure('', ['b2']);
        const r = run(['backup']);
        assert.equal(r.code, 0, r.err);
        assert.match(r.err, /r2: not configured: missing .*credentials\/r2\/s3-access-key-id/);
        assert.equal(json('status-r2.json').state, 'not-configured');
        assert.equal(json('status-b2.json').state, 'ok');
        assert.equal(json('status.json').state, 'ok');
        assert.equal(callsTo(`${R2}?secret=no auto`).length, 0);
    });

    it('a region set in offsite.conf wins over the one found from the address', () => {
        configure('REGION_b2=eu-central-003');
        assert.equal(run(['backup', 'b2']).code, 0);
        assert.equal(callsTo(`${B2} eu-central-003`).length, 4);
        assert.equal(callsTo(`${R2}?secret=no auto`).length, 0, 'only the target asked for');
    });

    it('keeps what offsite.conf says, and reads part of the data back when asked', () => {
        configure('KEEP_DAILY=3\nKEEP_WEEKLY=2\nKEEP_MONTHLY=12\nCHECK_SUBSET=2%');
        assert.equal(run(['backup', 'r2']).code, 0);
        const c = callsTo(`${R2}?secret=no auto`);
        assert.match(c[1] ?? '', /--keep-daily 3 --keep-weekly 2 --keep-monthly 12 --prune/);
        assert.equal(c[2], 'check --quiet --read-data-subset=2%');
    });

    it('check: each target, its result in check-<t>.json, one failing does not stop the next', () => {
        configure();
        const r = run(['check', '5%'], { FAKE_FAIL: 'backblazeb2.com/lfdln-offsite-momo/vps check' });
        assert.notEqual(r.code, 0);
        assert.equal(json('check-r2.json').result, 'ok');
        assert.equal(json('check-r2.json').data_read, '5%');
        assert.equal(json('check-b2.json').result, 'failed');
    });

    it('lists the targets with their state and region', () => {
        configure('', ['r2']);
        const r = run(['targets']);
        assert.match(r.out, /^r2 +configured +s3:https:\/\/acct123\.r2\.cloudflarestorage\.com\/lfdln-offsite\/vps \(region auto\)$/m);
        assert.match(r.out, /^b2 +not-configured: missing .*credentials\/b2\/s3-access-key-id/m);
    });

    it('an address without s3:https:// or its folder is not configured (2026-10-08: r2 had neither)', () => {
        configure("RESTIC_REPOSITORY_r2='https://acct123.r2.cloudflarestorage.com/lfdln-offsite'");
        const r = run(['targets']);
        assert.match(r.out, /^r2 +not-configured: missing RESTIC_REPOSITORY_r2 as s3:https:\/\/<host>\/<bucket>\/<folder>/m);
        assert.match(r.out, /^b2 +configured/m);
    });

    it('plain http only to 127.0.0.1 (the full-tier MinIO), never to another host', () => {
        configure("RESTIC_REPOSITORY_r2='s3:http://127.0.0.1:19900/offsite-test-r2/vps'\nRESTIC_REPOSITORY_b2='s3:http://example.com/b/vps'");
        const r = run(['targets']);
        assert.match(r.out, /^r2 +configured/m);
        assert.match(r.out, /^b2 +not-configured: missing RESTIC_REPOSITORY_b2 as s3:https:/m);
    });

    it("reads the keys from systemd's credentials folder (offsite_<target>_<file>)", () => {
        configure();
        const cd = join(dir, 'creds');
        mkdirSync(cd);
        writeFileSync(join(cd, 'offsite_restic-password'), 'pw');
        writeFileSync(join(cd, 'offsite_b2_s3-access-key-id'), 'FROMSYSTEMD');
        writeFileSync(join(cd, 'offsite_b2_s3-secret-access-key'), 'FROMSYSTEMD-SECRET');
        const r = run(['backup'], { CREDENTIALS_DIRECTORY: cd });
        assert.equal(r.code, 0, r.err);
        assert.equal(json('status-r2.json').state, 'not-configured', 'r2 has no files there');
        assert.match(readFileSync(`${log}.env`, 'utf8'), /AWS_SECRET_ACCESS_KEY=FROMSYSTEMD-SECRET/);
    });

    it('refuses a target name that could reach outside its folder', () => {
        writeFileSync(join(etc, 'offsite.conf'), 'TARGETS="../x"\nHOST_PG=off\n');
        const r = run(['backup']);
        assert.equal(r.code, 3);
        assert.match(r.err, /a name of a-z and 0-9 only/);
    });

    it('waits for the lock, and gives up when told not to wait', () => {
        configure();
        const held = spawnSync('bash', ['-c', `exec 8>>"${join(dir, 'lock')}"; flock 8; OFFSITE_LOCK_WAIT=0 OFFSITE_ETC=${etc} OFFSITE_STATE=${state} OFFSITE_LOCK=${join(dir, 'lock')} RESTIC=${join(dir, 'bin', 'restic')} FAKE_LOG=${log} bash ${SCRIPT} backup; rc=$?; exit $rc`], { encoding: 'utf8' });
        assert.equal(held.status, 4);
        assert.match(held.stderr, /another lfdln-offsite run holds/);
        assert.deepEqual(calls(), []);
    });
});

describe("lfdln-offsite: the server's own Postgres", () => {
    function fakePg(dump = 'echo "PGDMP $3"', restore = 'exit 0') {
        const bin = join(dir, 'bin');
        writeFileSync(join(bin, 'psql'), '#!/bin/sh\nprintf "app\\napp_test\\nshop\\nshop_shadow\\n"\n');
        writeFileSync(join(bin, 'pg_dump'), `#!/bin/sh\n${dump}\n`);
        writeFileSync(join(bin, 'pg_restore'), `#!/bin/sh\n${restore}\n`);
        writeFileSync(join(bin, 'pg_dumpall'), '#!/bin/sh\necho "CREATE ROLE x;"\n');
        for (const f of ['psql', 'pg_dump', 'pg_restore', 'pg_dumpall']) chmodSync(join(bin, f), 0o755);
    }

    it('dumps every database but *_test and *_shadow, with no target at all, and keeps 7 days', () => {
        writeFileSync(join(etc, 'offsite.conf'), 'TARGETS="r2 b2"\n');      // nothing configured
        fakePg();
        const d = join(state, 'dumps', 'host-pg');
        mkdirSync(d, { recursive: true });
        writeFileSync(join(d, 'old--20260901T053000Z.dump'), 'old');
        spawnSync('touch', ['-d', '10 days ago', join(d, 'old--20260901T053000Z.dump')]);
        writeFileSync(join(d, 'recent--20261004T053000Z.dump'), 'recent');
        const r = run(['dump-host-pg'], { OFFSITE_AS_PG: 'env' });
        assert.equal(r.code, 0, r.err);
        const files = spawnSync('ls', [d], { encoding: 'utf8' }).stdout.trim().split('\n');
        assert.ok(files.some((f) => /^app--\d{8}T\d{6}Z\.dump$/.test(f)), files.join(' '));
        assert.ok(files.some((f) => /^shop--.*\.dump$/.test(f)));
        assert.ok(files.some((f) => /^roles--.*\.sql$/.test(f)));
        assert.ok(!files.some((f) => f.startsWith('app_test') || f.startsWith('shop_shadow')), 'skip patterns');
        assert.ok(!files.includes('old--20260901T053000Z.dump'), 'older than 7 days: gone');
        assert.ok(files.includes('recent--20261004T053000Z.dump'), 'younger: kept');
        assert.equal(json('host-pg.json').databases, 2);
        assert.equal(json('status.json').host_pg.state, 'ok', 'Monitoring sees it in status.json too');
        assert.deepEqual(calls(), [], 'no restic');
    });

    it('a dump pg_restore cannot read fails the run and says which database', () => {
        writeFileSync(join(etc, 'offsite.conf'), '');
        fakePg('echo junk', 'exit 1');
        const r = run(['dump-host-pg'], { OFFSITE_AS_PG: 'env' });
        assert.notEqual(r.code, 0);
        assert.equal(json('host-pg.json').state, 'failed');
        assert.match(json('host-pg.json').message, /failed at app/);
    });
});

describe('lfdln-offsite: restore test', () => {
    function world() {
        const ls = [
            { struct_type: 'snapshot' },
            { struct_type: 'node', type: 'file', path: '/var/lib/svc-x/backups/x-1-nightly.dump', mtime: '2026-10-01T04:00:00Z' },
            { struct_type: 'node', type: 'file', path: '/var/lib/svc-x/backups/x-2-nightly.dump', mtime: '2026-10-02T04:00:00Z' },
            { struct_type: 'node', type: 'file', path: '/var/lib/svc-x/backups/x-2-nightly.roles.sql', mtime: '2026-10-02T04:00:00Z' },
            { struct_type: 'node', type: 'file', path: '/srv/pamela-db/backups/mariadb-1.sql.gz', mtime: '2026-10-02T04:00:00Z' },
            { struct_type: 'node', type: 'file', path: '/srv/pamela-db/backups/postgres-1.sql.gz', mtime: '2026-10-02T04:00:00Z' },
            { struct_type: 'node', type: 'file', path: '/srv/pamela-db/backups/postgres-0.sql.gz', mtime: '2026-10-01T04:00:00Z' },
            { struct_type: 'node', type: 'file', path: '/var/lib/lfdln-offsite/dumps/host-pg/app2--20261002T053000Z.dump', mtime: '2026-10-02T05:30:00Z' },
            { struct_type: 'node', type: 'file', path: '/var/lib/lfdln-offsite/dumps/host-pg/app2--20261001T053000Z.dump', mtime: '2026-10-01T05:30:00Z' },
            { struct_type: 'node', type: 'file', path: '/var/lib/lfdln-offsite/dumps/host-pg/app--20261002T053000Z.dump', mtime: '2026-10-02T05:30:00Z' },
            { struct_type: 'node', type: 'file', path: '/etc/lfdln-panel/db', mtime: '2026-10-02T04:00:00Z' },
        ].map((o) => JSON.stringify(o)).join('\n');
        writeFileSync(join(dir, 'ls.json'), ls);
        const tree = join(dir, 'tree');
        mkdirSync(join(tree, 'var/lib/svc-x/backups'), { recursive: true });
        mkdirSync(join(tree, 'srv/pamela-db/backups'), { recursive: true });
        writeFileSync(join(tree, 'var/lib/svc-x/backups/x-2-nightly.dump'), 'PGDMP newer than the host can read');
        spawnSync('sh', ['-c', `echo hi | gzip > ${tree}/srv/pamela-db/backups/mariadb-1.sql.gz`]);
        writeFileSync(join(dir, 'bin', 'pg_restore'), '#!/bin/sh\necho "pg_restore: error: unsupported version (1.16) in file header" >&2; exit 1\n');
        chmodSync(join(dir, 'bin', 'pg_restore'), 0o755);
        return { FAKE_LS: join(dir, 'ls.json'), FAKE_TREE: tree };
    }

    it('brings back the newest file of each kind from every target, and checks each file', () => {
        configure();
        const r = run(['restore-test'], world());
        assert.equal(r.code, 0, r.err);
        for (const t of ['r2', 'b2']) {
            const repo = t === 'r2' ? `${R2}?secret=no auto` : `${B2} us-west-004`;
            const restore = callsTo(repo).find((c) => c.startsWith('restore '))!;
            assert.match(restore, /--include \/var\/lib\/svc-x\/backups\/x-2-nightly\.dump/);
            assert.doesNotMatch(restore, /x-1-nightly/, 'only the newest of a kind');
            assert.match(restore, /--include \/var\/lib\/svc-x\/backups\/x-2-nightly\.roles\.sql/);
            assert.match(restore, /mariadb-1\.sql\.gz/);
            assert.match(restore, /postgres-1\.sql\.gz/, 'each kind in a folder');
            assert.doesNotMatch(restore, /postgres-0/);
            assert.match(restore, /host-pg\/app2--20261002T053000Z\.dump/, 'host dumps: kind = the name before --');
            assert.match(restore, /host-pg\/app--20261002T053000Z\.dump/, 'app and app2 are two kinds');
            assert.doesNotMatch(restore, /app2--20261001/);
            const tr = json(`restore-test-${t}.json`);
            assert.deepEqual([tr.result, tr.files, tr.unreadable, tr.header_only], ['ok', 2, 0, 1]);
        }
        assert.ok(!existsSync(join(state, 'restore-test', 'r2')), 'the scratch folder is gone');
    });

    it('fails on a broken file', () => {
        configure('', ['b2']);
        writeFileSync(join(dir, 'ls.json'), '');
        const tree = join(dir, 'tree');
        mkdirSync(join(tree, 'srv/pamela-db/backups'), { recursive: true });
        writeFileSync(join(tree, 'srv/pamela-db/backups/broken.sql.gz'), 'not gzip');
        const r = run(['restore-test'], { FAKE_LS: join(dir, 'ls.json'), FAKE_TREE: tree });
        assert.notEqual(r.code, 0);
        assert.match(r.err, /b2: unreadable: \/srv\/pamela-db\/backups\/broken\.sql\.gz/);
    });
});

describe('lfdln-offsite: what ships', () => {
    it('the sources list only absolute paths, and covers what R1 names', () => {
        const lines = readFileSync(SOURCES, 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
        for (const l of lines) assert.match(l, /^\//, l);
        for (const must of ['/etc/lfdln-panel', '/etc/pammy-panel', '/mnt/storage/uploads', '/pamela/public',
            '/var/lib/svc-lfdlnappdb/backups', '/var/lib/svc-lfdlnmaria/backups', '/var/lib/lfdln-offsite/dumps']) {
            assert.ok(lines.includes(must), must);
        }
    });
});
