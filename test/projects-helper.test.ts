// The projects helper, step 8b-1 (docs/phase8b-plan.md): its record, the ports it hands out,
// one job at a time with each job's log, and the build environment's check as svc-lfdln-apps.
// 8b-2: static projects. 8b-3: owners, groups, the shared repository, pushes, the dev branch.
// 8b-4a: Next.js servers. 8b-4b: each branch's environment, and how each server is (health).
// 8b-5: each branch's database, as written down. 8b-8a: packages, scripts, the registry.
// A recording runner stands in for systemd-run; verify-lfdln runs the real thing.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { RunSpec, RunResult } from '@panel/core/runner';
import { createQueue } from '@panel/projects/jobs';
import { freePorts, groupOf, isProjectId, loadRecord, LONG_RUNNING, PKG_NAME_RE, PKG_SPEC_RE, PORT_MAX, PORT_MIN, ProjectsError, saveRecord, type ProjectsRecord } from '@panel/projects/record';
import { APPS_USER, backVars, BUILD_IMAGE, BUILD_PROXY, CONTAINERFILE, createProjectsOps, HOOKS_DIR, moveVars, projectNetwork, quadletText, upstreamText } from '@panel/projects/helper/ops';
import { allowed, createProxy, loadAllow, makeLookup, target } from '../packages/projects/container/proxy.mjs';
import { projectKind } from '@panel/projects/route-kind';
import { assetsOf, projectsAndMaking } from '@panel/projects/panel/route-kind';
import { handle } from '@panel/projects/helper/service';
import { closeTo, LONG_RUNNING as BOX_LONG_RUNNING, NAME_RE as BOX_NAME_RE, SPEC_RE as BOX_SPEC_RE, warningsOf } from '../packages/projects/container/packages.mjs';

const dir = mkdtempSync(join(tmpdir(), 'projects-helper-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let clock = 1_900_000_000;
const now = () => clock++;

describe('names and the record', () => {
  it('a project is a DNS label that leaves room for <name>-dev', () => {
    for (const ok of ['blog', 'a', 'my-site', 'x1']) assert.ok(isProjectId(ok), ok);
    for (const bad of ['', 'Blog', '1site', 'site-', 'my--site', 'blog-dev', 'a'.repeat(37), 'a.b', '../x']) assert.ok(!isProjectId(bad), bad);
  });

  it('no file yet is an empty record; saved whole, root-only, and read back', () => {
    const f = join(dir, 'projects.json');
    assert.deepEqual(loadRecord(f), { version: 1, projects: [] });
    const r: ProjectsRecord = { version: 1, projects: [{ id: 'blog', kind: 'react', pm: 'pnpm', typescript: true, tailwind: true, createdAt: 1, createdBy: 'momolig', branches: { main: { ports: [], live: null, releases: [] } }, owners: ['momolig'], shared: true }] };
    saveRecord(f, r);
    assert.deepEqual(loadRecord(f), r);
    assert.equal(statSync(f).mode & 0o777, 0o600);
    assert.ok(!existsSync(`${f}.new`));
  });

  it('refuses a record with a doubled name or an unknown kind', () => {
    const f = join(dir, 'bad.json');
    const p = { kind: 'react', pm: 'npm', typescript: true, tailwind: false, createdAt: 1, createdBy: 'x', branches: {} };
    writeFileSync(f, JSON.stringify({ version: 1, projects: [{ id: 'a', ...p }, { id: 'a', ...p }] }));
    assert.throws(() => loadRecord(f), ProjectsError);
    writeFileSync(f, JSON.stringify({ version: 1, projects: [{ id: 'a', ...p, kind: 'cobol' }] }));
    assert.throws(() => loadRecord(f), ProjectsError);
  });

  it('ports: the lowest free in 4200-4999, and none left is said plainly', () => {
    assert.deepEqual([PORT_MIN, PORT_MAX], [4200, 4999]);
    assert.deepEqual(freePorts([4200, 4202], 3), [4201, 4203, 4204]);
    const all = Array.from({ length: PORT_MAX - PORT_MIN + 1 }, (_, i) => PORT_MIN + i);
    assert.throws(() => freePorts(all, 1), /No free ports/);
  });
});

describe('jobs: one at a time, in order, each with its log', () => {
  const qdir = join(dir, 'q');
  mkdirSync(qdir);

  it('the second waits for the first; a failure is said and the next still runs', async () => {
    const q = createQueue({ dir: qdir, now });
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const a = q.add('check', 'momolig', async ({ step, log }) => { order.push('a start'); step('first'); log('hello'); await gate; order.push('a end'); return 1; });
    const b = q.add('check', 'badmon', async () => { order.push('b'); throw new ProjectsError('internal', 'It broke.'); }, { project: 'blog', branch: 'main' });
    const c = q.add('check', 'ericka', async () => { order.push('c'); return 3; });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual([q.get(a.id)!.state, q.get(b.id)!.state, q.busy()], ['running', 'queued', true]);
    release();
    const [da, db, dc] = await Promise.all([q.done(a.id), q.done(b.id), q.done(c.id)]);
    assert.deepEqual(order, ['a start', 'a end', 'b', 'c']);
    assert.deepEqual([da.state, da.result, db.state, db.error, dc.state], ['done', 1, 'failed', 'It broke.', 'done']);
    assert.match(q.log(a.id), /--- first\nhello\n/);
    assert.match(q.log(b.id), /FAILED: It broke\./);
    assert.ok(existsSync(join(qdir, 'logs', 'blog', `${b.id}.log`)));
    assert.deepEqual(q.list('blog').map((j) => j.id), [b.id]);
  });

  it('kept across a restart; one cut off by it says so', () => {
    const jobsFile = join(qdir, 'jobs.json');
    const jobs = JSON.parse(readFileSync(jobsFile, 'utf8'));
    jobs.push({ ...jobs[0], id: '1900009999-deadbeef', state: 'running', endedAt: null });
    writeFileSync(jobsFile, JSON.stringify(jobs));
    const q = createQueue({ dir: qdir, now });
    assert.equal(q.list().length, 4);
    assert.deepEqual([q.get('1900009999-deadbeef')!.state, q.get('1900009999-deadbeef')!.error], ['failed', 'The helper stopped while this job was waiting or running.']);
  });
});

describe('the helper\'s operations', () => {
  const root = join(dir, 'root');
  mkdirSync(join(root, 'etc'), { recursive: true });
  const calls: RunSpec[] = [];
  let answers: Record<string, RunResult> = {};
  const run = async (spec: RunSpec): Promise<RunResult> => { calls.push(spec); return answers[spec.what] ?? { code: 0, stdout: '', stderr: '' }; };
  const state = join(dir, 'state');
  mkdirSync(state);
  const ops = createProjectsOps({ recordFile: join(state, 'projects.json'), stateDir: state, run, now, root });

  it('without its user: the check fails and says to run the installer', async () => {
    writeFileSync(join(root, 'etc/passwd'), 'root:x:0:0::/root:/bin/bash\n');
    const { job } = await ops.check('momolig', true);
    assert.equal(job.state, 'failed');
    assert.match(job.error!, /svc-lfdln-apps\) is missing: run install-lfdln\.sh/);
    assert.equal((await ops.info()).user, null);
  });

  it('with it: runs the image as svc-lfdln-apps, no network, read-only, and keeps the versions', async () => {
    writeFileSync(join(root, 'etc/passwd'), `${APPS_USER}:x:974:966::/var/lib/${APPS_USER}:/usr/sbin/nologin\n`);
    answers = { versions: { code: 0, stdout: '{"node":"v24.21.0","npm":"11.19.0","pnpm":"12.9.1","git":"2.39.5"}\n', stderr: '' } };
    calls.length = 0;
    const { job } = await ops.check('momolig', true);
    assert.equal(job.state, 'done', job.error ?? '');
    assert.deepEqual(job.result, { node: 'v24.21.0', npm: '11.19.0', pnpm: '12.9.1', git: '2.39.5' });
    const v = calls.find((c) => c.what === 'versions')!;
    assert.deepEqual(v.as, { user: APPS_USER, uid: 974, home: `/var/lib/${APPS_USER}` });
    for (const flag of ['--network=none', '--read-only', '--rm']) assert.ok(v.argv.includes(flag), flag);
    assert.ok(v.argv.includes(BUILD_IMAGE));
    const info = await ops.info();
    assert.deepEqual([info.user, info.image, info.lastCheck?.state, info.projects], [APPS_USER, BUILD_IMAGE, 'done', 0]);
  });

  it('a missing image or one that answers oddly fails the check, plainly', async () => {
    answers = { 'image-exists': { code: 1, stdout: '', stderr: '' } };
    assert.match((await ops.check('momolig', true)).job.error!, /build image .* is missing/);
    answers = { versions: { code: 0, stdout: '{"node":"<script>"}', stderr: '' } };
    assert.match((await ops.check('momolig', true)).job.error!, /answered something unexpected/);
  });

  it('the socket takes only its operations, a job id of its shape and a project name', async () => {
    await assert.rejects(handle(ops, { op: 'build-anything' }), /Unknown request/);
    await assert.rejects(handle(ops, { op: 'job', id: '../../etc/passwd' }), /Which job/);
    await assert.rejects(handle(ops, { op: 'jobs', project: '../x' }), /Which project/);
    const { jobs } = await handle(ops, { op: 'jobs' }) as { jobs: { id: string }[] };
    const one = await handle(ops, { op: 'job', id: jobs[0]!.id }) as { log: string };
    assert.match(one.log, /--- the projects' user/);
  });
});

describe('static projects (8b-2): make, build, roll back, delete', () => {
  const root = join(dir, 'root2');
  mkdirSync(join(root, 'etc'), { recursive: true });
  writeFileSync(join(root, 'etc/passwd'), `${APPS_USER}:x:974:966::/var/lib/${APPS_USER}:/usr/sbin/nologin\n`);
  const srv = join(dir, 'srv');
  mkdirSync(srv);
  const calls: RunSpec[] = [];
  let builds = 0;
  let makeFails = false;
  const commit = (n: number) => String(n).repeat(40).slice(0, 40);
  const run = async (spec: RunSpec): Promise<RunResult> => {
    calls.push(spec);
    if (spec.what === 'make') return makeFails ? { code: 1, stdout: '$ npx create-vite\n', stderr: '\nFAILED: npx create-vite failed (exit 1)' } : { code: 0, stdout: `made\n{"commit":"${commit(1)}"}\n`, stderr: '' };
    if (spec.what === 'build') { builds++; return { code: 0, stdout: `built\n{"commit":"${commit(builds + 1)}","files":8,"bytes":273585}\n`, stderr: '' }; }
    return { code: 0, stdout: '', stderr: '' };
  };
  const state = join(dir, 'state2');
  mkdirSync(state);
  const ops = createProjectsOps({ recordFile: join(state, 'projects.json'), stateDir: state, run, now: () => (clock += 60), root, projectsRoot: srv, containerDir: '/opt/x/container' });
  const spec = { id: 'demo', kind: 'react', pm: 'pnpm', typescript: true, tailwind: true };
  const argvOf = (what: string) => calls.filter((c) => c.what === what).map((c) => c.argv);

  it('refuses what 8b-2 does not make, and bad names, before queueing', async () => {
    await assert.rejects(ops.create({ ...spec, kind: 'laravel' }, 'momolig', true), /later version/);
    await assert.rejects(ops.create({ ...spec, id: 'demo-dev' }, 'momolig', true), /not ending in -dev/);
    await assert.rejects(ops.create({ ...spec, pm: 'yarn' }, 'momolig', true), /npm or pnpm/);
    assert.equal(calls.length, 0);
  });

  it('a starter that fails: its folder is taken away again, nothing in the record', async () => {
    makeFails = true;
    const { job } = await ops.create(spec, 'momolig', true);
    makeFails = false;
    assert.deepEqual([job.state, job.error], ['failed', 'Making it failed: npx create-vite failed (exit 1)']);
    assert.deepEqual(argvOf('undo'), [['rm', '-rf', '--', join(srv, 'demo')], ['groupdel', 'lfdln-p-demo']]);
    assert.equal((await ops.list()).projects.length, 0);
    calls.length = 0;
  });

  it('made: its folder as root (711, svc-lfdln-apps\'), the starter and the first build in the box, then live', async () => {
    const { job } = await ops.create(spec, 'momolig', true);
    assert.equal(job.state, 'done', job.error ?? '');
    assert.deepEqual(calls.find((c) => c.what === 'folder')!, { as: 'root', argv: ['install', '-d', '-o', APPS_USER, '-g', APPS_USER, '-m', '711', join(srv, 'demo')], what: 'folder', timeoutSec: 300 });
    const make = argvOf('make')[0]!;
    for (const a of ['--userns=keep-id', '--user=974:966', '--read-only', '--memory=2g', '--cpus=2', '--timeout=900', `${join(srv, 'demo', 'work')}:/work:rw`, `${join(srv, 'demo', 'repo.git')}:/repo:rw`, '/opt/x/container:/lfdln:ro', BUILD_IMAGE]) assert.ok(make.includes(a), a);
    assert.deepEqual(make.slice(-7), ['/lfdln/scaffold.mjs', 'react', 'ts', 'tailwind', 'pnpm', 'demo', 'momolig'].slice(-7));
    const b = argvOf('build')[0]!;
    assert.ok(b.includes(`${join(srv, 'demo', 'repo.git')}:/repo:ro`), 'the build reads the repository, never writes it');
    assert.ok(b.includes(`${join(srv, 'demo', 'releases', 'main')}:/out:rw`));
    const p = (await ops.list()).projects[0]!;
    assert.deepEqual([p.id, p.kind, p.pm, p.createdBy, p.branches.main!.releases.length, p.branches.main!.live!.commit], ['demo', 'react', 'pnpm', 'momolig', 1, commit(2)]);
    const rid = p.branches.main!.live!.id;
    assert.match(rid, /^[0-9]{14}$/);
    assert.deepEqual(argvOf('link').at(-1), ['ln', '-sfn', rid, join(srv, 'demo', 'releases', 'main', '.current-new')]);
    assert.deepEqual(argvOf('switch').at(-1), ['mv', '-Tf', join(srv, 'demo', 'releases', 'main', '.current-new'), join(srv, 'demo', 'releases', 'main', 'current')]);
    assert.match(ops.queue.log(job.id), /live: release [0-9]{14} \(commit 222222222222\)/);
    // root only for its folder, its group and git's list of shared repositories (8b-3)
    for (const c of calls.filter((x) => !['folder', 'undo', 'group', 'safe-list'].includes(x.what))) assert.equal((c.as as { user: string }).user, APPS_USER, c.what);
    await assert.rejects(ops.create(spec, 'momolig', true), /already a project called demo/);
  });

  it('rebuilt three more times: three releases kept, the oldest let go', async () => {
    for (let i = 0; i < 3; i++) assert.equal((await ops.build('demo', 'main', 'badmon', true)).job.state, 'done');
    const b = (await ops.list()).projects[0]!.branches.main!;
    assert.equal(b.releases.length, 3);
    assert.equal(b.live!.id, b.releases[0]!.id);
    assert.equal(argvOf('let-go').length, 1);
    // the first release, the one made with it, is the one let go
    assert.match(argvOf('let-go')[0]![3]!, new RegExp(`^${join(srv, 'demo', 'releases', 'main')}/[0-9]{14}$`));
    assert.ok(!b.releases.some((r) => argvOf('let-go')[0]![3]!.endsWith(r.id)));
  });

  it('roll back to a kept release; one not kept is refused', async () => {
    const b = (await ops.list()).projects[0]!.branches.main!;
    const older = b.releases[2]!.id;
    assert.equal((await ops.rollback('demo', 'main', older, 'momolig', true)).job.state, 'done');
    assert.equal((await ops.list()).projects[0]!.branches.main!.live!.id, older);
    assert.deepEqual(argvOf('link').at(-1), ['ln', '-sfn', older, join(srv, 'demo', 'releases', 'main', '.current-new')]);
    await assert.rejects(ops.rollback('demo', 'main', '19990101000000', 'momolig', true), /only the last 3 are kept/);
    await assert.rejects(ops.rollback('demo', 'dev', older, 'momolig', true), /no release/);
    await assert.rejects(ops.build('demo', 'feature', 'momolig', true), /main or dev/);
  });

  it('delete: to the trash (as root), out of the record; the trash keeps 30 days', async () => {
    mkdirSync(join(srv, 'demo'));
    mkdirSync(join(srv, '.trash'));
    mkdirSync(join(srv, '.trash', 'old--20200101000000'));
    const { job } = await ops.remove('demo', 'momolig', true);
    assert.equal(job.state, 'done', job.error ?? '');
    const mv = calls.filter((c) => c.what === 'trash').at(-1)!;
    assert.equal(mv.as, 'root');
    assert.equal(mv.argv[0], 'mv');
    assert.equal(mv.argv[3], join(srv, 'demo'));
    assert.match(mv.argv[4]!, /\.trash\/demo--[0-9]{14}$/);
    assert.deepEqual(calls.filter((c) => c.what === 'purge').map((c) => c.argv), [['rm', '-rf', '--', join(srv, '.trash', 'old--20200101000000')]]);
    assert.equal((await ops.list()).projects.length, 0);
    await assert.rejects(ops.remove('demo', 'momolig', true), /no project called demo/);
  });
});

describe('the project route kind (8b-2)', () => {
  const k = projectKind('/srv/lfdln-projects');
  const cfg = { php: null } as never;
  it('checks its fields', () => {
    assert.deepEqual(k.fields({ project: 'demo', branch: 'main', spa: true, cacheForever: ['/assets/'] }), { project: 'demo', branch: 'main', spa: true, cacheForever: ['/assets/'], serve: 'files' });
    for (const bad of [{ project: '../x', branch: 'main', spa: true }, { project: 'demo', branch: 'prod', spa: true }, { project: 'demo', branch: 'main', spa: 'yes' },
      { project: 'demo', branch: 'main', spa: true, cacheForever: ['/a b/'] }]) assert.throws(() => k.fields(bad), JSON.stringify(bad));
  });
  it('serves the branch\'s live release as files, its hashed assets cached for good', () => {
    const lines = k.locations({ cfg, host: 'demo' } as never, { kind: 'project', host: 'demo', path: '/', enabled: true, project: 'demo', branch: 'main', spa: true, cacheForever: [assetsOf({ kind: 'react' })] }).join('\n');
    assert.match(lines, /root \/srv\/lfdln-projects\/demo\/releases\/main\/current;/);
    assert.match(lines, /try_files \$uri \$uri\/ \/index\.html;/);
    assert.match(lines, /location \/assets\/ \{[\s\S]*expires 1y;/);
    assert.doesNotMatch(lines, /fastcgi_pass/);
    const deeper = k.locations({ cfg, host: 'demo' } as never, { kind: 'project', host: 'demo', path: '/app/', enabled: true, project: 'demo', branch: 'main', spa: false, cacheForever: [] }).join('\n');
    assert.match(deeper, /alias \/srv\/lfdln-projects\/demo\/releases\/main\/current\/;/);
    assert.match(deeper, /try_files \$uri \$uri\/ =404;/);
    assert.equal(assetsOf({ kind: 'next-static' }), '/_next/static/');
  });
});

describe('git and the dev branch (8b-3)', () => {
  const root = join(dir, 'root3');
  mkdirSync(join(root, 'etc'), { recursive: true });
  const me = process.getuid!();
  // momolig: a person with a shell; ericka: a panel account only; svc-x: a system user whatever
  // its name; pusher: whoever runs these tests, as the owner of the spool's files
  writeFileSync(join(root, 'etc/passwd'), [`${APPS_USER}:x:974:966::/var/lib/${APPS_USER}:/usr/sbin/nologin`, `momolig:x:${me === 2000 ? 2001 : 2000}:2000::/home/momolig:/bin/bash`,
    'badmon:x:1003:1003::/home/badmon:/usr/sbin/nologin', 'svc-x:x:1500:1500::/:/bin/bash', `pusher:x:${me}:${me}::/tmp:/bin/sh`, ''].join('\n'));
  const groups = (members: string) => writeFileSync(join(root, 'etc/group'), `lfdln-p-site:x:990:${members}\nlfdln-git:x:991:svc-lfdln-apps\n`);
  groups('svc-lfdln-apps,pusher');
  const srv = join(dir, 'srv3');
  const spool = join(dir, 'spool');
  mkdirSync(srv);
  mkdirSync(spool);
  const calls: RunSpec[] = [];
  const heads: Record<string, string | undefined> = {};
  let builds = 0;
  let behind = 0;
  let odd = '';
  const sha = (c: string) => c.repeat(40);
  const run = async (spec: RunSpec): Promise<RunResult> => {
    calls.push(spec);
    const a = spec.argv;
    if (spec.what === 'make') { heads.main = sha('1'); return { code: 0, stdout: `{"commit":"${sha('1')}"}\n`, stderr: '' }; }
    if (spec.what === 'build') {
      builds++;
      const branch = a[a.indexOf('/lfdln/build.mjs') + 1]!;
      return { code: 0, stdout: `{"commit":"${heads[branch] ?? sha('0')}","files":3,"bytes":1000}\n`, stderr: '' };
    }
    if (spec.what === 'git-check') return { code: 0, stdout: odd, stderr: '' };
    if (spec.what === 'git-head') { const h = heads[a.at(-1)!.replace('refs/heads/', '')]; return h ? { code: 0, stdout: `${h}\n`, stderr: '' } : { code: 1, stdout: '', stderr: '' }; }
    if (spec.what === 'git-ancestor') return { code: behind, stdout: '', stderr: '' };
    if (spec.what === 'git-update') {
      const i = a.indexOf('update-ref');
      const args = a.slice(i + 1).filter((x, k, all) => x !== '-m' && all[k - 1] !== '-m');
      const [ref, to, from] = args as [string, string, string | undefined];
      const b = ref.replace('refs/heads/', '');
      if (from === '' ? heads[b] : from !== undefined && heads[b] !== from) return { code: 1, stdout: '', stderr: 'fatal: cannot lock ref' };
      heads[b] = to;
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const state = join(dir, 'state3');
  mkdirSync(state);
  const ops = createProjectsOps({ recordFile: join(state, 'projects.json'), stateDir: state, run, now: () => (clock += 60), root, projectsRoot: srv,
    containerDir: '/opt/x/container', hooksDir: '/opt/x/git-hooks', spool, safeFile: join(dir, 'safe.cfg') });
  const argvOf = (what: string) => calls.filter((c) => c.what === what).map((c) => c.argv);
  const project = async (id = 'site') => (await ops.list()).projects.find((p) => p.id === id)!;

  it('a group name fits in 32, and two long names never share one', () => {
    assert.equal(groupOf('site'), 'lfdln-p-site');
    const a = groupOf('a-very-long-project-name-number-one');
    const b = groupOf('a-very-long-project-name-number-two');
    assert.ok(a.length <= 32 && b.length <= 32);
    assert.notEqual(a, b);
  });

  it('made with the dev branch: owned by its maker, its repository shared, dev = main, both built', async () => {
    const { job } = await ops.create({ id: 'site', kind: 'vue', pm: 'npm', typescript: false, tailwind: false, dev: true }, 'momolig', true);
    assert.equal(job.state, 'done', job.error ?? '');
    const p = await project();
    assert.deepEqual([p.owners, p.shared, p.pushers, p.group], [['momolig'], true, ['momolig'], 'lfdln-p-site']);
    // the group (root): svc-lfdln-apps and its people; lfdln-git: everyone who may push
    assert.deepEqual(argvOf('group'), [['groupadd', '-f', '--system', 'lfdln-p-site'], ['gpasswd', '-M', 'svc-lfdln-apps,momolig', 'lfdln-p-site'], ['gpasswd', '-M', 'svc-lfdln-apps,momolig', 'lfdln-git']]);
    const repo = join(srv, 'site', 'repo.git');
    const cfg = argvOf('git-config').map((a) => a.slice(-2));
    assert.deepEqual(cfg, [['core.sharedRepository', '0664'], ['receive.denyDeletes', 'true'], ['receive.autogc', 'false'], ['core.hooksPath', '/opt/x/git-hooks']]);
    for (const a of argvOf('git-config')) assert.deepEqual(a.slice(0, 4), ['git', '-c', 'core.hooksPath=/dev/null', `--git-dir=${repo}`]);
    // the modes as svc-lfdln-apps, never root; the top folder 3770
    const modes = calls.filter((c) => c.what === 'modes');
    assert.ok(modes.every((c) => (c.as as { user: string }).user === APPS_USER));
    assert.deepEqual(modes.at(-1)!.argv, ['chmod', '3770', '--', repo]);
    const safe = calls.find((c) => c.what === 'safe-list')!;
    assert.equal(safe.as, 'root');
    // tee into a new file (stdin is a socket under systemd-run --pipe), then 644, then one rename
    const sf = join(dir, 'safe.cfg');
    assert.deepEqual(argvOf('safe-list').slice(0, 3), [['tee', `${sf}.new`], ['chmod', '644', `${sf}.new`], ['mv', '-f', `${sf}.new`, sf]]);
    assert.match(safe.stdin!, new RegExp(`\\[safe\\]\\n\\tdirectory = ${repo}\\n`));
    // dev: made from main only if it isn't there ("" as the old value), then built into releases/dev
    assert.deepEqual(argvOf('git-update')[0]!.slice(-4), ['update-ref', 'refs/heads/dev', sha('1'), '']);
    assert.ok(argvOf('build').some((a) => a.includes(`${join(srv, 'site', 'releases', 'dev')}:/out:rw`)));
    assert.deepEqual([p.branches.main!.live!.commit, p.branches.dev!.live!.commit], [sha('1'), sha('1')]);
    assert.deepEqual(job.result && Object.keys(job.result as object), ['release', 'dev']);
  });

  it('owners: a list of panel usernames, never none; only those with a Unix account join the group', async () => {
    for (const bad of [[], ['Momolig'], ['a', 'a'], 'momolig', Array.from({ length: 21 }, (_, i) => `u${i}x`)]) {
      await assert.rejects(ops.owners('site', bad, 'momolig', true), /1 to 20 owners/, JSON.stringify(bad));
    }
    calls.length = 0;
    const { job } = await ops.owners('site', ['momolig', 'ericka', 'badmon', 'svc-x'], 'momolig', true);
    assert.equal(job.state, 'done', job.error ?? '');
    assert.deepEqual(argvOf('group')[1], ['gpasswd', '-M', 'svc-lfdln-apps,momolig', 'lfdln-p-site']);
    assert.deepEqual((await project()).owners, ['momolig', 'ericka', 'badmon', 'svc-x']);
    // owners changing never touch the repository's modes (root never walks what pushers write)
    assert.equal(argvOf('modes').length, 0);
  });

  it('Put dev live: nothing when they are the same; refused when they have diverged; else main moves to dev, then built', async () => {
    assert.deepEqual((await ops.promote('site', 'momolig', true)).job.result, { same: true, commit: sha('1') });
    heads.dev = sha('2');
    behind = 1;
    const refused = (await ops.promote('site', 'momolig', true)).job;
    assert.equal(refused.state, 'failed');
    assert.match(refused.error!, /merge main into dev/);
    assert.equal(heads.main, sha('1'));
    behind = 0;
    calls.length = 0;
    const { job } = await ops.promote('site', 'ericka', true);
    assert.equal(job.state, 'done', job.error ?? '');
    assert.deepEqual(argvOf('git-update')[0]!.slice(-3), ['refs/heads/main', sha('2'), sha('1')]);
    assert.equal(heads.main, sha('2'));
    assert.equal((await project()).branches.main!.live!.commit, sha('2'));
  });

  it('a push to main in between: update-ref fails, nothing lost', async () => {
    heads.dev = sha('3');
    const real = heads.main;
    const racing = async (spec: RunSpec) => { if (spec.what === 'git-update') heads.main = sha('4'); return run(spec); };
    const ops2 = createProjectsOps({ recordFile: join(state, 'projects.json'), stateDir: join(dir, 'state3b'), run: racing, now: () => (clock += 60), root, projectsRoot: srv, spool: join(dir, 'none') });
    mkdirSync(join(dir, 'state3b'), { recursive: true });
    const { job } = await ops2.promote('site', 'momolig', true);
    assert.equal(job.state, 'failed');
    assert.match(job.error!, /was it pushed to just now/);
    assert.equal(heads.main, sha('4'));
    heads.main = real;
  });

  it('a repository with a commondir file is refused before any git runs on it', async () => {
    odd = `${join(srv, 'site', 'repo.git')}/commondir\n`;
    const { job } = await ops.promote('site', 'momolig', true);
    odd = '';
    assert.equal(job.state, 'failed');
    assert.match(job.error!, /shouldn't be there/);
  });

  it('pushes: the hook\'s files are read once and removed; only a member\'s push to a branch that is on builds', async () => {
    const drop = (name: string, text: string) => writeFileSync(join(spool, name), text, { mode: 0o644 });
    heads.dev = sha('5');
    drop('push.AAAAAAAAAA', `site dev ${sha('5')}\n`);
    drop('push.BBBBBBBBBB', `site dev ${sha('5')}\n`);               // the same branch again: one build takes both
    drop('push.CCCCCCCCCC', `other main ${sha('5')}\n`);             // no such project
    drop('push.DDDDDDDDDD', 'site dev ../../etc\n');                  // not what the hook writes
    drop('not-a-push', `site main ${sha('5')}\n`);                    // not its name
    drop('.push.EEEEEEEEEE', 'half');                                 // being written: left alone
    symlinkSync(join(root, 'etc/passwd'), join(spool, 'push.FFFFFFFFFF'));
    const before = builds;
    // something else running, so the pushes wait: a waiting build of a branch takes later pushes
    // to it (one running may have cloned the older commit, so it doesn't)
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    ops.queue.add('check', 'momolig', () => held);
    const queued = await ops.drainPushes();
    release();
    assert.equal(queued, 1);
    assert.deepEqual(readdirSync(spool).sort(), ['.push.EEEEEEEEEE']);
    assert.ok(existsSync(join(root, 'etc/passwd')), 'a link is removed, never followed');
    const job = ops.queue.list('site').find((j) => j.what === 'push')!;
    assert.deepEqual([job.by, job.branch], ['pusher', 'dev']);
    const done = await ops.queue.done(job.id);
    assert.equal(done.state, 'done', done.error ?? '');
    assert.equal(builds, before + 1);
    assert.match(ops.queue.log(job.id), new RegExp(`pusher pushed dev \\(${sha('5').slice(0, 12)}\\)`));
    assert.equal((await project()).branches.dev!.live!.by, 'pusher');
  });

  it('a push by someone not in the project\'s group builds nothing', async () => {
    groups('svc-lfdln-apps,momolig');
    writeFileSync(join(spool, 'push.GGGGGGGGGG'), `site main ${sha('5')}\n`);
    assert.equal(await ops.drainPushes(), 0);
    assert.deepEqual(readdirSync(spool).filter((n) => !n.startsWith('.')), []);
    groups('svc-lfdln-apps,pusher');
  });

  it('over HTTPS (8b-7, D7-7): svc-lfdln-apps\' file names the person the panel let in; anyone else\'s "via" is ignored', async () => {
    const passwdFile = join(root, 'etc/passwd');
    const people = readFileSync(passwdFile, 'utf8');
    const names = ['push.IIIIIIIIII', 'push.JJJJJJJJJJ'];
    const pushOf = async (text: string) => {
      writeFileSync(join(spool, names.shift()!), text, { mode: 0o644 });
      assert.equal(await ops.drainPushes(), 1);
      const job = ops.queue.list('site').find((j) => j.what === 'push' && j.state !== 'done' && j.state !== 'failed')!;
      const done = await ops.queue.done(job.id);
      assert.equal(done.state, 'done', done.error ?? '');
      return { by: job.by, log: ops.queue.log(job.id) };
    };
    try {
      // the files are this test's: written as git-http-backend's (svc-lfdln-apps) ...
      writeFileSync(passwdFile, people.replace(`${APPS_USER}:x:974:`, `${APPS_USER}:x:${me}:`).replace(`pusher:x:${me}:`, 'pusher:x:4242:'));
      const https = await pushOf(`site main ${sha('5')} via ericka\n`);
      assert.equal(https.by, 'ericka');
      assert.match(https.log, /ericka pushed main \([0-9a-f]{12}\) over HTTPS/);
    } finally { writeFileSync(passwdFile, people); }
    // ... and as a person's over SSH: their own name, whatever the file says
    const ssh = await pushOf(`site main ${sha('5')} via momolig\n`);
    assert.equal(ssh.by, 'pusher');
    assert.doesNotMatch(ssh.log, /over HTTPS/);
  });

  it('dev off: its releases gone, a push to it builds nothing; on again: the branch in git kept, built', async () => {
    assert.equal((await ops.dev('site', false, 'momolig', true)).job.state, 'done');
    assert.equal((await project()).branches.dev, undefined);
    assert.deepEqual(argvOf('let-go').at(-1), ['rm', '-rf', '--', join(srv, 'site', 'releases', 'dev')]);
    await assert.rejects(ops.dev('site', false, 'momolig', true), /already off/);
    await assert.rejects(ops.promote('site', 'momolig', true), /no dev branch/);
    writeFileSync(join(spool, 'push.HHHHHHHHHH'), `site dev ${sha('5')}\n`);
    assert.equal(await ops.drainPushes(), 0);
    calls.length = 0;
    const { job } = await ops.dev('site', true, 'momolig', true);
    assert.equal(job.state, 'done', job.error ?? '');
    assert.equal(argvOf('git-update').length, 0, 'dev was still in git: not made again');
    assert.equal((await project()).branches.dev!.live!.commit, sha('5'));
  });

  it('a project made before 8b-3 is shared with its maker when the helper starts', async () => {
    const f = join(state, 'projects.json');
    const r = JSON.parse(readFileSync(f, 'utf8'));
    r.projects.push({ id: 'old', kind: 'react', pm: 'npm', typescript: true, tailwind: false, createdAt: 1, createdBy: 'momolig', branches: { main: { ports: [], live: null, releases: [] } } });
    writeFileSync(f, JSON.stringify(r));
    assert.deepEqual([(await project('old')).owners, (await project('old')).shared], [['momolig'], false]);
    calls.length = 0;
    const ops3 = createProjectsOps({ recordFile: f, stateDir: join(dir, 'state3b'), run, now: () => (clock += 60), root, projectsRoot: srv, spool: join(dir, 'none'), safeFile: join(dir, 'safe.cfg') });
    ops3.start();
    const share = ops3.queue.list('old').find((j) => j.what === 'share')!;
    assert.equal((await ops3.queue.done(share.id)).state, 'done');
    assert.equal((await project('old')).shared, true);
    assert.ok(argvOf('group').some((a) => a.join(' ') === 'groupadd -f --system lfdln-p-old'));
    assert.match(calls.find((c) => c.what === 'safe-list')!.stdin!, /old\/repo\.git\n[\s\S]*site\/repo\.git|site\/repo\.git[\s\S]*old\/repo\.git/);
  });

  it('delete: its group gone, and it is off git\'s list', async () => {
    calls.length = 0;
    mkdirSync(join(srv, 'old'), { recursive: true });
    assert.equal((await ops.remove('old', 'momolig', true)).job.state, 'done');
    assert.deepEqual(argvOf('group')[0], ['groupdel', 'lfdln-p-old']);
    assert.doesNotMatch(calls.find((c) => c.what === 'safe-list')!.stdin!, /old\/repo\.git/);
  });

  it('a route may show dev, which tells search engines to stay away', () => {
    const lines = projectKind('/srv/lfdln-projects').locations({ cfg: { php: null } as never, host: 'site-dev' } as never,
      { kind: 'project', host: 'site-dev', path: '/', enabled: true, project: 'site', branch: 'dev', spa: true, cacheForever: [] }).join('\n');
    assert.match(lines, /root \/srv\/lfdln-projects\/site\/releases\/dev\/current;/);
    assert.match(lines, /add_header X-Robots-Tag "noindex, nofollow" always;/);
  });

  it('a project being made is listed, so New project can show it at once', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const slow = async (spec: RunSpec) => { if (spec.what === 'make') await held; return run(spec); };
    mkdirSync(join(dir, 'state3c'));
    const ops4 = createProjectsOps({ recordFile: join(dir, 'state3c', 'p.json'), stateDir: join(dir, 'state3c'), run: slow, now: () => (clock += 60), root, projectsRoot: srv, spool: join(dir, 'none'), safeFile: join(dir, 'safe.cfg') });
    const { job } = await ops4.create({ id: 'fresh', kind: 'react', pm: 'npm', typescript: true, tailwind: true, dev: true }, 'momolig', false);
    await new Promise((r) => setTimeout(r, 20));
    const l = await ops4.list();
    assert.deepEqual(l.making, [{ id: 'fresh', kind: 'react', dev: true }]);
    assert.deepEqual(projectsAndMaking(l).map((p) => [p.id, Object.keys(p.branches)]), [['fresh', ['main', 'dev']]]);
    await assert.rejects(ops4.create({ id: 'fresh', kind: 'react', pm: 'npm', typescript: true, tailwind: true }, 'momolig', false), /being made already/);
    release();
    await ops4.queue.done(job.id);
    assert.deepEqual((await ops4.list()).making, []);
  });
});

describe('the push hook, run by a real git push', () => {
  const top = join(dir, 'hook');
  const repo = join(top, 'site', 'repo.git');
  const spool = join(top, 'spool');
  const work = join(top, 'work');
  const g = (args: string[], cwd: string, env: Record<string, string> = {}) => execFileSync('git', args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  it('a push to main or dev drops one file each, 644, saying the project, branch and commit; other branches none', () => {
    mkdirSync(join(top, 'site'), { recursive: true });
    mkdirSync(spool);
    mkdirSync(work);
    g(['init', '-q', '--bare', '-b', 'main', repo], top);
    g(['config', 'core.hooksPath', HOOKS_DIR], repo);
    g(['init', '-q', '-b', 'main'], work);
    g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'one'], work);
    const head = g(['rev-parse', 'HEAD'], work).trim();
    const out = execFileSync('git', ['push', repo, 'main', 'main:dev', 'main:feature'], { cwd: work, env: { ...process.env, LFDLN_PUSH_SPOOL: spool }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    void out;
    const files = readdirSync(spool).sort();
    assert.equal(files.length, 2);
    for (const f of files) {
      assert.match(f, /^push\.[A-Za-z0-9]{10}$/);
      assert.equal(statSync(join(spool, f)).mode & 0o777, 0o644);
    }
    assert.deepEqual(files.map((f) => readFileSync(join(spool, f), 'utf8')).sort(), [`site dev ${head}\n`, `site main ${head}\n`]);
  });

  it('over HTTPS (8b-7): it adds who git-http-backend says (REMOTE_USER), only a panel username', () => {
    const drained = () => { const t = readdirSync(spool).map((f) => readFileSync(join(spool, f), 'utf8')); for (const f of readdirSync(spool)) rmSync(join(spool, f)); return t; };
    drained();
    const commit = (m: string) => { g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', m], work); return g(['rev-parse', 'HEAD'], work).trim(); };
    const one = commit('two');
    g(['push', '-q', repo, 'main'], work, { LFDLN_PUSH_SPOOL: spool, REMOTE_USER: 'ericka' });
    assert.deepEqual(drained(), [`site main ${one} via ericka\n`]);
    for (const odd of ['Ericka', 'ericka; rm -rf', 'e', 'x'.repeat(33), '-ericka']) {
      const c = commit(`odd ${odd}`);
      g(['push', '-q', repo, 'main'], work, { LFDLN_PUSH_SPOOL: spool, REMOTE_USER: odd });
      assert.deepEqual(drained(), [`site main ${c}\n`], `REMOTE_USER ${JSON.stringify(odd)} is not a panel username`);
    }
  });
});

describe('Next.js servers (8b-4a)', () => {
  const root = join(dir, 'root4');
  mkdirSync(join(root, 'etc'), { recursive: true });
  writeFileSync(join(root, 'etc/passwd'), `${APPS_USER}:x:974:966::/var/lib/${APPS_USER}:/usr/sbin/nologin\n`);
  const srv = join(dir, 'srv4');
  const ngx = join(dir, 'nginx4');
  mkdirSync(srv);
  mkdirSync(ngx);
  const calls: RunSpec[] = [];
  let answering = true;
  let nginxOk = true;
  let builds = 0;
  const heads: Record<string, string> = { main: '1'.repeat(40), dev: '1'.repeat(40) };
  // the Quadlets as written (tee to <file>.new, then mv), for refresh's cat (S1d)
  const quadlets = new Map<string, string>();
  const run = async (spec: RunSpec): Promise<RunResult> => {
    calls.push(spec);
    const a = spec.argv;
    if (spec.what === 'quadlet') {
      if (a[0] === 'tee') quadlets.set(a[1]!, spec.stdin ?? '');
      if (a[0] === 'mv') { quadlets.set(a[3]!, quadlets.get(a[2]!) ?? ''); quadlets.delete(a[2]!); }
      if (a[0] === 'rm') quadlets.delete(a.at(-1)!);
      if (a[0] === 'cat') return quadlets.has(a.at(-1)!) ? { code: 0, stdout: quadlets.get(a.at(-1)!)!, stderr: '' } : { code: 1, stdout: '', stderr: 'No such file' };
    }
    if (spec.what === 'make') return { code: 0, stdout: `{"commit":"${heads.main}"}\n`, stderr: '' };
    if (spec.what === 'build') { builds++; return { code: 0, stdout: `{"commit":"${String(builds % 10).repeat(40)}","files":120,"bytes":9000000}\n`, stderr: '' }; }
    if (spec.what === 'git-head') return { code: 0, stdout: `${heads[a.at(-1)!.replace('refs/heads/', '')]}\n`, stderr: '' };
    if (spec.what === 'nginx-test') return nginxOk ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'nginx: [emerg] host not found in upstream' };
    if (spec.what === 'images') return { code: 0, stdout: 'localhost/proj-app:dev-20300101000000\nlocalhost/proj-app:main-20300101000000\n', stderr: '' };
    if (spec.what === 'show') return { code: 0, stdout: 'Id=proj-app-main-b.service\nLoadState=loaded\nActiveState=active\nSubState=running\n', stderr: '' };
    if (spec.what === 'logs') return { code: 0, stdout: '2026-10-06T01:00:00+00:00 host proj-app-main-b[1]: ready on 3000\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const probes: number[] = [];
  const probe = async (port: number) => { probes.push(port); return { status: answering ? 200 : null, ms: 3 }; };
  const state = join(dir, 'state4');
  mkdirSync(state);
  const ops = createProjectsOps({ recordFile: join(state, 'projects.json'), stateDir: state, run, now: () => (clock += 60), root, projectsRoot: srv,
    spool: join(dir, 'none'), safeFile: join(dir, 'safe4.cfg'), nginxDir: ngx, probe, sleep: async () => {}, answerMs: 50, dbPorts: [5436, 3308] });
  const argvOf = (what: string) => calls.filter((c) => c.what === what).map((c) => c.argv);
  const stdinOf = (what: string) => calls.filter((c) => c.what === what).map((c) => c.stdin ?? '');
  const branch = async (b: 'main' | 'dev') => (await ops.list()).projects.find((p) => p.id === 'app')!.branches[b]!;
  const ctl = (args: string[]) => ['systemctl', '--user', ...args];

  it('the Quadlet and the upstream it is switched through', () => {
    const q = quadletText('app', 'dev', 1, 4203, 'localhost/proj-app:dev-1');
    for (const line of ['Image=localhost/proj-app:dev-1', 'ContainerName=proj-app-dev-b', 'PublishPort=127.0.0.1:4203:3000', 'ReadOnly=true', 'DropCapability=all',
      'NoNewPrivileges=true', 'PodmanArgs=--memory=256m --cpus=1 --pids-limit=256', 'HealthCmd=node /app/.lfdln-health.mjs']) assert.ok(q.split('\n').includes(line), line);
    // S1d: pasta, its own address, no way to the gateway; the engines' ports alone (none: none)
    assert.ok(q.split('\n').includes('Network=pasta:-4,--no-map-gw,-a,10.0.2.100,-n,24,-g,10.0.2.2'));
    assert.doesNotMatch(q, /slirp4netns|allow_host_loopback/);
    assert.ok(quadletText('app', 'dev', 1, 4203, 'x', undefined, undefined, [5436, 3308]).split('\n').includes('Network=pasta:-4,--no-map-gw,-a,10.0.2.100,-n,24,-g,10.0.2.2,-T,3308,-T,5436'));
    assert.equal(projectNetwork([5436, 5436, 0, 70000, 1.5, 3308]), 'pasta:-4,--no-map-gw,-a,10.0.2.100,-n,24,-g,10.0.2.2,-T,3308,-T,5436');
    assert.match(quadletText('app', 'main', 0, 4200, 'x'), /--memory=512m/);
    // the gate's public key and the name its proofs are made out to (docs/s1-plan.md S1a)
    const key = 'A'.repeat(43);
    const told = quadletText('app', 'dev', 1, 4203, 'x', undefined, key).split('\n');
    assert.ok(told.includes(`Environment=LFDLN_IDENTITY_KEY=${key}`));
    assert.ok(told.includes('Environment=LFDLN_IDENTITY_AUDIENCE=project.app.dev'));
    assert.doesNotMatch(q, /LFDLN_IDENTITY/, 'no key, nothing told');
    assert.doesNotMatch(quadletText('app', 'dev', 1, 4203, 'x', undefined, 'bad key'), /LFDLN_IDENTITY/);
    assert.match(upstreamText('app', 'main', 4201), /upstream lfdln-project-app-main \{\n    server 127\.0\.0\.1:4201;\n\}/);
    assert.match(upstreamText('app', 'main', null), /server 127\.0\.0\.1:9 down;/);
    assert.match(CONTAINERFILE, /^FROM docker\.io\/library\/node:24-bookworm-slim$/m);
    assert.match(CONTAINERFILE, /^USER node$/m);
  });

  it('asked for: two ports a branch and upstreams pointing nowhere, before its job runs; then built, imaged and switched in', async () => {
    const { job } = await ops.create({ id: 'app', kind: 'next', pm: 'pnpm', typescript: true, tailwind: false, dev: true }, 'momolig', false);
    // the upstreams were written as it was asked for, before anything was built
    const first = calls.findIndex((c) => c.what === 'make');
    const ups = calls.map((c, i) => [c, i] as const).filter(([c]) => c.what === 'upstream' && c.argv[0] === 'tee');
    assert.ok(ups.length >= 2 && ups.slice(0, 2).every(([, i]) => first === -1 || i < first));
    assert.deepEqual(ups.slice(0, 2).map(([c]) => [c.argv[1], /down;/.test(c.stdin!)]), [[`${join(ngx, 'app-main.conf')}.new`, true], [`${join(ngx, 'app-dev.conf')}.new`, true]]);
    const done = await ops.queue.done(job.id);
    assert.equal(done.state, 'done', done.error ?? '');
    const main = await branch('main');
    const dev = await branch('dev');
    assert.deepEqual([main.ports, dev.ports, main.slot, dev.slot, main.stopped], [[4200, 4201], [4202, 4203], 0, 0, false]);
    // built into the build folder (never nginx's to read), then the image, offline
    const b = argvOf('build')[0]!;
    assert.ok(b.includes(`${join(srv, 'app', 'build', 'out')}:/out:rw`));
    const img = argvOf('image').find((a) => a[0] === 'podman')!;
    assert.deepEqual(img.slice(0, 3), ['podman', 'build', '--pull=never']);
    assert.ok(img.includes(`localhost/proj-app:main-${main.live!.id}`));
    assert.equal(main.live!.image, `localhost/proj-app:main-${main.live!.id}`);
    // slot a's Quadlet, started, asked, then nginx tested and reloaded
    const q = stdinOf('quadlet').find((t) => t.includes('ContainerName=proj-app-main-a'))!;
    assert.match(q, /PublishPort=127\.0\.0\.1:4200:3000/);
    assert.ok(argvOf('start').some((a) => a.join(' ') === ctl(['restart', 'proj-app-main-a.service']).join(' ')));
    assert.ok(probes.includes(4200) && probes.includes(4202));
    assert.ok(stdinOf('upstream').some((t) => t.includes('upstream lfdln-project-app-main') && t.includes('127.0.0.1:4200;')));
    assert.ok(argvOf('nginx-test').length >= 2 && argvOf('nginx-reload').length >= 2);
  });

  it('rebuilt: the other slot started beside the live one, nginx switched, then the old one stopped and its file gone', async () => {
    calls.length = 0;
    probes.length = 0;
    const { job } = await ops.build('app', 'main', 'momolig', true);
    assert.equal(job.state, 'done', job.error ?? '');
    assert.equal((await branch('main')).slot, 1);
    assert.deepEqual(probes, [4201]);
    const order = calls.map((c) => `${c.what}:${c.argv.slice(-1)[0]}`);
    const started = order.indexOf('start:proj-app-main-b.service');
    const switched = calls.findIndex((c) => c.what === 'nginx-reload');
    const stopped = order.indexOf('stop:proj-app-main-a.service');
    assert.ok(started >= 0 && started < switched && switched < stopped, order.join(' '));
    const qdir = join('/var/lib', APPS_USER, '.config', 'containers', 'systemd');
    assert.ok(argvOf('quadlet').some((a) => a.join(' ') === `rm -f -- ${join(qdir, 'proj-app-main-a.container')}`));
  });

  it('a release that never answers: stopped again, nginx untouched, its image gone, nothing changed', async () => {
    const before = await branch('main');
    calls.length = 0;
    answering = false;
    const { job } = await ops.build('app', 'main', 'momolig', true);
    answering = true;
    assert.equal(job.state, 'failed');
    assert.match(job.error!, /didn't answer on port 4200 .*nothing changed/);
    assert.equal(argvOf('nginx-reload').length, 0);
    assert.ok(argvOf('stop').some((a) => a.at(-1) === 'proj-app-main-a.service'));
    assert.ok(argvOf('let-go').some((a) => a[1] === 'rmi'));
    const after = await branch('main');
    assert.deepEqual([after.slot, after.live!.id, after.releases.length], [before.slot, before.live!.id, before.releases.length]);
  });

  it('nginx refusing the switch: the upstream put back, the new slot stopped, nothing changed', async () => {
    calls.length = 0;
    nginxOk = false;
    const { job } = await ops.build('app', 'main', 'momolig', true);
    nginxOk = true;
    assert.equal(job.state, 'failed');
    assert.match(job.error!, /nginx refused the switch/);
    assert.equal(argvOf('nginx-reload').length, 0);
    // (no file there before, in the tests: taken away again)
    assert.ok(argvOf('upstream').some((a) => a.join(' ') === `rm -f -- ${join(ngx, 'app-main.conf')}`));
    assert.equal((await branch('main')).slot, 1);
  });

  it('roll back: the kept release\'s image switched in, nothing built', async () => {
    const older = (await branch('main')).releases[1]!;
    calls.length = 0;
    const { job } = await ops.rollback('app', 'main', older.id, 'momolig', true);
    assert.equal(job.state, 'done', job.error ?? '');
    assert.equal(argvOf('build').length + argvOf('image').length, 0);
    assert.ok(stdinOf('quadlet').some((t) => t.includes(`Image=${older.image}`)));
    assert.deepEqual([(await branch('main')).slot, (await branch('main')).live!.id], [0, older.id]);
  });

  it('Stop (kept stopped after a reboot), Restart refused while stopped, Start (and it answers)', async () => {
    calls.length = 0;
    assert.equal((await ops.control('app', 'main', 'stop', 'momolig', true)).job.state, 'done');
    assert.deepEqual([argvOf('stop')[0], argvOf('mask')[0]], [ctl(['stop', 'proj-app-main-a.service']), ctl(['mask', 'proj-app-main-a.service'])]);
    assert.equal((await branch('main')).stopped, true);
    await assert.rejects(ops.control('app', 'main', 'restart', 'momolig', true), /is stopped: start it instead/);
    await assert.rejects(ops.control('app', 'main', 'reboot', 'momolig', true), /Start, stop or restart/);
    calls.length = 0;
    probes.length = 0;
    assert.equal((await ops.control('app', 'main', 'start', 'momolig', true)).job.state, 'done');
    assert.deepEqual(calls.filter((c) => ['unmask', 'reload', 'start'].includes(c.what)).map((c) => c.argv.slice(2).join(' ')), ['unmask proj-app-main-a.service', 'daemon-reload', 'start proj-app-main-a.service']);
    assert.deepEqual([probes, (await branch('main')).stopped], [[4200], false]);
  });

  it('its log: both slots\' journal; how it runs, in the list', async () => {
    const { lines } = await ops.logs('app', 'main');
    assert.equal(lines.length, 1);
    const j = argvOf('logs').at(-1)!;
    for (const a of ['_UID=974', '_SYSTEMD_USER_UNIT=proj-app-main-a.service', '_SYSTEMD_USER_UNIT=proj-app-main-b.service', '-n', '200']) assert.ok(j.includes(a), a);
    const p = (await ops.list()).projects.find((x) => x.id === 'app')!;
    assert.deepEqual(Object.keys(p.running), ['main', 'dev']);
    assert.equal(p.running.main!.port, 4200);
  });

  it('environment: names as the shell has them, never the panel\'s, one line; kept root-only; the server\'s env file svc-lfdln-apps\' 600', async () => {
    await assert.rejects(ops.envSet('app', 'main', 'my_key', 'x'), /capital letters/);
    await assert.rejects(ops.envSet('app', 'main', '1KEY', 'x'), /capital letters/);
    await assert.rejects(ops.envSet('app', 'main', 'PORT', '1'), /is the panel's/);
    await assert.rejects(ops.envSet('app', 'main', 'LFDLN_IDENTITY_KEY', 'x'), /is the panel's/);
    await assert.rejects(ops.envSet('app', 'main', 'KEY', 'a\nb'), /one line/);
    await assert.rejects(ops.envSet('app', 'main', 'KEY', 'x'.repeat(4097)), /one line/);
    await assert.rejects(ops.envSet('app', 'main', 'GONE', null), /has no GONE/);
    calls.length = 0;
    assert.deepEqual(await ops.envSet('app', 'main', 'API_KEY', 's3cret=1'), { name: 'API_KEY', removed: false, needs: 'restart', public: false });
    assert.equal((await ops.envSet('app', 'main', 'NEXT_PUBLIC_SITE', 'Blog')).needs, 'rebuild');
    await ops.envSet('app', 'dev', 'API_KEY', 'test');
    const store = join(state, 'env', 'app.json');
    assert.equal(statSync(store).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(store, 'utf8')).branches, { main: { API_KEY: 's3cret=1', NEXT_PUBLIC_SITE: 'Blog' }, dev: { API_KEY: 'test' } });
    const file = join(srv, 'app', 'env', 'main.env');
    assert.ok(argvOf('env').some((a) => a.join(' ') === `install -m 600 /dev/null ${file}.new`));
    assert.equal(stdinOf('env').filter((t) => t.includes('NEXT_PUBLIC_SITE')).at(-1), 'API_KEY=s3cret=1\nNEXT_PUBLIC_SITE=Blog\n');
    assert.ok(calls.filter((c) => c.what === 'env').every((c) => c.as !== 'root'));
    assert.deepEqual(await ops.env('app', 'main'), { vars: [{ name: 'API_KEY', public: false, oldHost: false }, { name: 'NEXT_PUBLIC_SITE', public: true, oldHost: false }], max: 100, panel: ['PORT', 'HOSTNAME', 'NODE_ENV', 'NEXT_TELEMETRY_DISABLED', 'HOME', 'CI', 'LFDLN_IDENTITY_KEY', 'LFDLN_IDENTITY_AUDIENCE'] });
    assert.deepEqual((await ops.envValues('app', 'dev')).values, { API_KEY: 'test' });
    assert.equal((await handle(ops, { op: 'env-set', id: 'app', branch: 'main', name: 'OLD', value: 'x' }) as { needs: string }).needs, 'restart');
    assert.equal((await handle(ops, { op: 'env-set', id: 'app', branch: 'main', name: 'OLD', value: null }) as { removed: boolean }).removed, true);
  });

  it('a build gets the branch\'s environment through --env-file, removed after; the new slot\'s Quadlet reads the env file', async () => {
    calls.length = 0;
    assert.equal((await ops.build('app', 'main', 'momolig', true)).job.state, 'done');
    const env = join(srv, 'app', 'build.env');
    const b = argvOf('build')[0]!;
    assert.equal(b[b.indexOf('--env-file') + 1], env);
    assert.ok(b.indexOf('--env-file') < b.indexOf('CI=1'), 'the box\'s own -e settings come after, so they win');
    const used = calls.findIndex((c) => c.what === 'build');
    const gone = calls.findIndex((c) => c.what === 'env' && c.argv.join(' ') === `rm -f -- ${env}`);
    assert.ok(used >= 0 && gone > used);
    assert.ok(stdinOf('quadlet').some((t) => t.includes(`EnvironmentFile=${join(srv, 'app', 'env', 'main.env')}`)));
  });

  it('Restart: the live slot\'s Quadlet written again with its env file, reloaded, then restarted', async () => {
    const slot = (await branch('main')).slot === 0 ? 'a' : 'b';
    calls.length = 0;
    assert.equal((await ops.control('app', 'main', 'restart', 'momolig', true)).job.state, 'done');
    const order = calls.map((c) => c.what).filter((w) => ['env', 'quadlet', 'reload', 'start'].includes(w));
    assert.ok(order.indexOf('quadlet') < order.indexOf('reload') && order.indexOf('reload') < order.indexOf('start'), order.join(' '));
    assert.ok(stdinOf('quadlet').some((t) => t.includes(`ContainerName=proj-app-main-${slot}`) && t.includes('EnvironmentFile=')));
  });

  it('health: each server branch with a release, as systemd sees it, and whether it answers', async () => {
    const { servers } = await ops.health();
    const main = servers.find((x) => x.branch === 'main')!;
    assert.deepEqual([main.unit, main.active, main.stopped, main.answering?.status], ['proj-app-main-b', 'active', false, 200]);
    const dev = servers.find((x) => x.branch === 'dev')!;
    assert.deepEqual([dev.active, dev.answering], ['unknown', null]);
    assert.ok(await handle(ops, { op: 'health' }));
  });

  type Refreshed = { projects: { project: string; branch: string; result: string; env: string[]; left?: string[]; error?: string }[]; failed: number; kept: number };
  const refreshed = async () => (await ops.refresh('install-lfdln', true)).job as { state: string; error?: string; result: Refreshed };
  const qdir = join('/var/lib', APPS_USER, '.config', 'containers', 'systemd');
  const envFile = join(srv, 'app', 'env', 'main.env');
  // the env file's writes (tee to <file>.new), in order
  const envWrites = () => calls.filter((c) => c.what === 'env' && c.argv[0] === 'tee').map((c) => ({ file: c.argv[1]!.replace(/\.new$/, ''), text: c.stdin ?? '' }));
  const clear = async (...names: string[]) => { for (const n of names) await ops.envSet('app', 'main', n, null).catch(() => {}); };

  it('moveVars (S1d): URLs, libpq strings and host variables with an engine\'s port; never public ones; the rest named as left', () => {
    const ports = new Set([5436, 3308]);
    const r = moveVars({
      DATABASE_URL: 'postgres://u:p@10.0.2.2:5436/d', OWNER: 'mysql://o:p@10.0.2.2:3308/d?ssl=false', DSN: 'host=10.0.2.2 port=5436 dbname=d',
      PGHOST: '10.0.2.2', PGPORT: '5436', MYSQL_HOST: '10.0.2.2', MYSQL_PORT: '3308', NEXT_PUBLIC_DB: 'postgres://u:p@10.0.2.2:5436/x', PLAIN: 'nothing here',
    }, ports);
    assert.deepEqual(r.moved, ['DATABASE_URL', 'DSN', 'MYSQL_HOST', 'OWNER', 'PGHOST']);
    assert.deepEqual([r.vars.DATABASE_URL, r.vars.OWNER, r.vars.DSN, r.vars.PGHOST, r.vars.MYSQL_HOST, r.vars.NEXT_PUBLIC_DB],
      ['postgres://u:p@127.0.0.1:5436/d', 'mysql://o:p@127.0.0.1:3308/d?ssl=false', 'host=127.0.0.1 port=5436 dbname=d', '127.0.0.1', '127.0.0.1', 'postgres://u:p@10.0.2.2:5436/x']);
    assert.deepEqual(r.left, []);
    // not sure it is an engine: left as it is, and named
    const odd = moveVars({ PGHOST: '10.0.2.2', DB_HOST: '10.0.2.2', DB_PORT: '5432', API: 'http://u:p@10.0.2.2:3046/', HOSTS: '10.0.2.2:5436', DSN: 'host=10.0.2.2 dbname=d' }, ports);
    assert.deepEqual([odd.moved, odd.left], [[], ['API', 'DB_HOST', 'DSN', 'HOSTS', 'PGHOST']]);
  });

  it('backVars (S1f): from the before-copy while the value is still what refresh wrote; else by form, as moveVars, the other way; never public ones', () => {
    const ports = new Set([5436, 3308]);
    const was = { DATABASE_URL: 'postgres://u:p@10.0.2.2:5436/d', OWNER: 'mysql://o:p@10.0.2.2:3308/d?ssl=false', DSN: 'host=10.0.2.2 port=5436 dbname=d', PGHOST: '10.0.2.2', PGPORT: '5436', NEXT_PUBLIC_DB: 'postgres://u:p@127.0.0.1:5436/x', API: 'http://127.0.0.1:3046/' };
    const m = moveVars(was, ports);
    const copy = Object.fromEntries(m.moved.map((k) => [k, { from: was[k as keyof typeof was], to: m.vars[k]! }]));
    // round trip: exactly as they were
    const r = backVars(m.vars, ports, copy);
    assert.deepEqual(r.vars, was);
    assert.deepEqual([r.moved, r.fromCopy], [['DATABASE_URL', 'DSN', 'OWNER', 'PGHOST'], ['DATABASE_URL', 'DSN', 'OWNER', 'PGHOST']]);
    // no copy (moved by S1d's release, or a database made since at 127.0.0.1): by form, the same values
    assert.deepEqual(backVars(m.vars, ports).vars, was);
    assert.deepEqual(backVars(m.vars, ports).fromCopy, []);
    // changed since refresh: not the copy's value, but its form still told back; another port, or a public one, left
    const changed = backVars({ ...m.vars, DATABASE_URL: 'postgres://u:new@127.0.0.1:5436/d', API: 'http://u:p@127.0.0.1:3046/' }, ports, copy);
    assert.equal(changed.vars.DATABASE_URL, 'postgres://u:new@10.0.2.2:5436/d');
    assert.equal(changed.vars.API, 'http://u:p@127.0.0.1:3046/');
    assert.equal(changed.vars.NEXT_PUBLIC_DB, 'postgres://u:p@127.0.0.1:5436/x');
    assert.ok(!changed.fromCopy.includes('DATABASE_URL'));
  });

  it('refresh (S1d): a running server put live in its other slot on pasta; its env file and variables change only once nginx switched; then nothing to do', async () => {
    const before = await branch('main');
    const live = before.slot === 0 ? 'a' : 'b';
    const other = before.slot === 0 ? 'b' : 'a';
    // as an older release left it: slirp4netns, and the panel's DATABASE_URL at 10.0.2.2
    quadlets.set(join(qdir, `proj-app-main-${live}.container`), 'Network=slirp4netns:allow_host_loopback=true\n');
    await ops.envSet('app', 'main', 'DATABASE_URL', 'postgres://u:p@10.0.2.2:5436/proj_app');
    await ops.envSet('app', 'main', 'DATABASE_OWNER_URL', 'mysql://o:p@10.0.2.2:3308/proj_app?ssl=false');
    await ops.envSet('app', 'main', 'PGHOST', '10.0.2.2');
    await ops.envSet('app', 'main', 'PGPORT', '5436');
    await ops.envSet('app', 'main', 'NEXT_PUBLIC_DB', 'postgres://u:p@10.0.2.2:5436/x');
    calls.length = 0;
    probes.length = 0;
    const { job } = await handle(ops, { op: 'refresh', actor: 'install-lfdln', wait: true }) as { job: { state: string; error?: string; result: Refreshed } };
    assert.equal(job.state, 'done', job.error ?? '');
    const main = job.result.projects.find((x) => x.branch === 'main')!;
    assert.deepEqual([main.result, main.env, job.result.failed, job.result.kept], ['redeployed', ['DATABASE_OWNER_URL', 'DATABASE_URL', 'PGHOST'], 0, 0]);
    const vars = (await ops.envValues('app', 'main')).values;
    assert.deepEqual([vars.DATABASE_URL, vars.DATABASE_OWNER_URL, vars.PGHOST], ['postgres://u:p@127.0.0.1:5436/proj_app', 'mysql://o:p@127.0.0.1:3308/proj_app?ssl=false', '127.0.0.1']);
    assert.equal(vars.NEXT_PUBLIC_DB, 'postgres://u:p@10.0.2.2:5436/x', 'built into the pages: left as it is');
    // the new slot started from <branch>.env.next; the shared file written only after nginx switched
    const order = calls.map((c) => `${c.what}:${c.argv[0] === 'tee' ? c.argv[1] : c.argv.slice(-1)[0]}`);
    const nextAt = order.indexOf(`env:${envFile}.next.new`);
    const startAt = order.indexOf(`start:proj-app-main-${other}.service`);
    const switchAt = order.indexOf('nginx-reload:nginx');
    const stopAt = order.indexOf(`stop:proj-app-main-${live}.service`);
    const sharedAt = order.indexOf(`env:${envFile}.new`);
    assert.ok(nextAt >= 0 && nextAt < startAt && startAt < switchAt && switchAt < stopAt && stopAt < sharedAt, order.join(' '));
    assert.match(envWrites().find((w) => w.file === `${envFile}.next`)!.text, /^DATABASE_URL=postgres:\/\/u:p@127\.0\.0\.1:5436\/proj_app$/m);
    assert.match(envWrites().find((w) => w.file === envFile)!.text, /^PGHOST=127\.0\.0\.1$/m);
    assert.ok(argvOf('env').some((a) => a.join(' ') === `rm -f -- ${envFile}.next`), 'the next file gone');
    // the new slot's Quadlet: pasta, and the shared env file again
    assert.equal((await branch('main')).slot, before.slot === 0 ? 1 : 0);
    const q = quadlets.get(join(qdir, `proj-app-main-${other}.container`)) ?? '';
    assert.match(q, /^Network=pasta:-4,--no-map-gw,-a,10\.0\.2\.100,-n,24,-g,10\.0\.2\.2,-T,3308,-T,5436$/m);
    assert.ok(q.split('\n').includes(`EnvironmentFile=${envFile}`), q);
    assert.ok(!quadlets.has(join(qdir, `proj-app-main-${live}.container`)), 'the old slot\'s Quadlet gone');
    // asked again: nothing to do, nothing restarted
    calls.length = 0;
    assert.equal((await refreshed()).result.projects.find((x) => x.branch === 'main')!.result, 'unchanged');
    assert.equal(argvOf('start').length + argvOf('nginx-reload').length + envWrites().length, 0);
    await clear('PGHOST', 'PGPORT', 'NEXT_PUBLIC_DB', 'DATABASE_OWNER_URL');
  });

  it('refresh (S1d): a server that doesn\'t answer on pasta keeps running as it was, its env file and variables untouched, and is said', async () => {
    const before = await branch('main');
    const liveFile = join(qdir, `proj-app-main-${before.slot === 0 ? 'a' : 'b'}.container`);
    quadlets.set(liveFile, 'Network=slirp4netns:allow_host_loopback=true\n');
    await ops.envSet('app', 'main', 'DATABASE_URL', 'postgres://u:p@10.0.2.2:5436/proj_app');
    calls.length = 0;
    answering = false;
    const job = await refreshed();
    answering = true;
    assert.equal(job.state, 'done');
    const main = job.result.projects.find((x) => x.branch === 'main')!;
    assert.deepEqual([main.result, main.env, job.result.failed], ['failed', [], 1]);
    assert.match(main.error!, /didn't answer .*nothing changed/);
    assert.equal((await branch('main')).slot, before.slot);
    assert.equal(quadlets.get(liveFile), 'Network=slirp4netns:allow_host_loopback=true\n', 'the running one\'s Quadlet untouched');
    assert.deepEqual(envWrites().map((w) => w.file), [`${envFile}.next`], 'the live slot\'s env file never written');
    assert.ok(argvOf('env').some((a) => a.join(' ') === `rm -f -- ${envFile}.next`), 'the next file gone');
    assert.equal((await ops.envValues('app', 'main')).values.DATABASE_URL, 'postgres://u:p@10.0.2.2:5436/proj_app', 'its variable as it was');
  });

  it('refresh (S1d): 10.0.2.2 left in a variable after moving: kept on slirp4netns, untouched, named (not its value)', async () => {
    const before = await branch('main');
    const liveFile = join(qdir, `proj-app-main-${before.slot === 0 ? 'a' : 'b'}.container`);
    await ops.envSet('app', 'main', 'OTHER_URL', 'http://u:s3cret@10.0.2.2:3046/');
    calls.length = 0;
    const job = await refreshed();
    const main = job.result.projects.find((x) => x.branch === 'main')!;
    assert.deepEqual([main.result, main.left, job.result.kept, job.result.failed], ['kept', ['OTHER_URL'], 1, 0]);
    assert.doesNotMatch(JSON.stringify(job), /s3cret/);
    assert.equal(quadlets.get(liveFile), 'Network=slirp4netns:allow_host_loopback=true\n');
    assert.equal(argvOf('start').length + envWrites().length, 0);
    assert.equal((await ops.envValues('app', 'main')).values.DATABASE_URL, 'postgres://u:p@10.0.2.2:5436/proj_app', 'not moved either');
    await clear('OTHER_URL');
  });

  it('refresh keeps a before-copy; put-back (S1f) puts the variables back from it and the server live again on slirp4netns, slot to slot; refresh moves it again', async () => {
    const store = () => JSON.parse(readFileSync(join(state, 'env', 'app.json'), 'utf8')) as { branches: Record<string, Record<string, string>>; moved?: Record<string, Record<string, { from: string; to: string }>> };
    await ops.envSet('app', 'main', 'PGHOST', '10.0.2.2');
    await ops.envSet('app', 'main', 'PGPORT', '5436');
    // 10.0.2.2 in a variable: the Environment page is told (its name only)
    const flagged = (await ops.env('app', 'main')).vars.filter((v) => v.oldHost).map((v) => v.name);
    assert.deepEqual(flagged, ['DATABASE_URL', 'PGHOST']);
    assert.doesNotMatch(JSON.stringify(await ops.env('app', 'main')), /10\.0\.2\.2|5436/);
    assert.equal((await refreshed()).result.projects.find((x) => x.branch === 'main')!.result, 'redeployed');
    assert.deepEqual(store().moved?.main, {
      DATABASE_URL: { from: 'postgres://u:p@10.0.2.2:5436/proj_app', to: 'postgres://u:p@127.0.0.1:5436/proj_app' },
      PGHOST: { from: '10.0.2.2', to: '127.0.0.1' },
    });
    assert.deepEqual((await ops.env('app', 'main')).vars.filter((v) => v.oldHost), []);
    // put back: slot to slot, its Quadlet slirp4netns, the variables from the copy, the copy gone
    const before = await branch('main');
    const other = before.slot === 0 ? 'b' : 'a';
    calls.length = 0;
    const { job } = await handle(ops, { op: 'put-back', id: 'app', actor: 'lfdln-panel', wait: true }) as { job: { state: string; error?: string; what: string; project: string; result: Refreshed } };
    assert.equal(job.state, 'done', job.error ?? '');
    assert.deepEqual([job.what, job.project], ['put-back', 'app']);
    const main = job.result.projects.find((x) => x.branch === 'main')!;
    assert.deepEqual([main.result, main.env, job.result.failed], ['redeployed', ['DATABASE_URL', 'PGHOST'], 0]);
    assert.deepEqual([store().branches.main!.DATABASE_URL, store().branches.main!.PGHOST], ['postgres://u:p@10.0.2.2:5436/proj_app', '10.0.2.2']);
    assert.equal(store().moved, undefined);
    const q = quadlets.get(join(qdir, `proj-app-main-${other}.container`)) ?? '';
    assert.ok(q.split('\n').includes('Network=slirp4netns:allow_host_loopback=true'), q);
    assert.ok(q.split('\n').includes(`EnvironmentFile=${envFile}`), q);
    const order = calls.map((c) => `${c.what}:${c.argv[0] === 'tee' ? c.argv[1] : c.argv.slice(-1)[0]}`);
    assert.ok(order.indexOf(`env:${envFile}.next.new`) < order.indexOf('nginx-reload:nginx') && order.indexOf('nginx-reload:nginx') < order.indexOf(`env:${envFile}.new`), order.join(' '));
    assert.match(envWrites().find((w) => w.file === envFile)!.text, /^DATABASE_URL=postgres:\/\/u:p@10\.0\.2\.2:5436\/proj_app$/m);
    // asked again: nothing to do; another project's id: refused
    calls.length = 0;
    const again = (await ops.putBack('app', 'lfdln-panel', true)).job as { result: Refreshed };
    assert.equal(again.result.projects.find((x) => x.branch === 'main')!.result, 'unchanged');
    assert.equal(argvOf('start').length, 0);
    await assert.rejects(Promise.resolve().then(() => ops.putBack('nope', 'x', true)), /no project called nope/);
    // the install's refresh moves it again
    assert.equal((await refreshed()).result.projects.find((x) => x.branch === 'main')!.result, 'redeployed');
    assert.equal(store().branches.main!.DATABASE_URL, 'postgres://u:p@127.0.0.1:5436/proj_app');
    await clear('PGHOST', 'PGPORT');
  });

  it('put-back (S1f): no copy (moved by S1d\'s release): by form; a value changed since refresh is told back by form, not overwritten from the copy', async () => {
    const f = join(state, 'env', 'app.json');
    const e = JSON.parse(readFileSync(f, 'utf8'));
    e.branches.main.DATABASE_URL = 'postgres://u:changed@127.0.0.1:5436/proj_app';
    e.moved = { main: { DATABASE_URL: { from: 'postgres://u:old@10.0.2.2:5436/proj_app', to: 'postgres://u:p@127.0.0.1:5436/proj_app' } } };
    writeFileSync(f, JSON.stringify(e));
    const job = (await ops.putBack(undefined, 'lfdln-panel', true)).job as { state: string; result: Refreshed };
    assert.equal(job.state, 'done');
    assert.equal((await ops.envValues('app', 'main')).values.DATABASE_URL, 'postgres://u:changed@10.0.2.2:5436/proj_app');
    assert.equal((await refreshed()).result.failed, 0);
    await ops.envSet('app', 'main', 'DATABASE_URL', 'postgres://u:p@10.0.2.2:5436/proj_app');
  });

  it('refresh (S1d): a stopped one gets its files (variables, env file, Quadlet), not started', async () => {
    const before = await branch('main');
    const liveFile = join(qdir, `proj-app-main-${before.slot === 0 ? 'a' : 'b'}.container`);
    assert.equal((await ops.control('app', 'main', 'stop', 'momolig', true)).job.state, 'done');
    quadlets.set(liveFile, 'Network=slirp4netns:allow_host_loopback=true\n');
    calls.length = 0;
    const s = await refreshed();
    assert.deepEqual(s.result.projects.find((x) => x.branch === 'main')!.result, 'stopped');
    assert.match(quadlets.get(liveFile)!, /^Network=pasta:/m);
    assert.match(envWrites().find((w) => w.file === envFile)!.text, /^DATABASE_URL=postgres:\/\/u:p@127\.0\.0\.1:5436\/proj_app$/m);
    assert.equal(argvOf('start').length, 0);
    assert.equal((await ops.control('app', 'main', 'start', 'momolig', true)).job.state, 'done');
    await clear('DATABASE_URL');
  });

  it('a branch\'s database (8b-5): written down beside the branch, checked; null when it uses none; never for files', async () => {
    const db = { engine: 'postgres', name: 'proj_app', owner: 'db_proj_app_owner', app: 'db_proj_app_app' };
    const r = await ops.database('app', 'main', db, 'momolig');
    assert.deepEqual({ ...r.database, at: 0 }, { ...db, at: 0, by: 'momolig' });
    assert.deepEqual((await branch('main')).database?.name, 'proj_app');
    await ops.database('app', 'dev', { ...db, shared: true }, 'momolig');
    assert.equal((await branch('dev')).database?.shared, true);
    await assert.rejects(ops.database('app', 'main', { ...db, engine: 'sqlite' }, 'momolig'), /Which database/);
    await assert.rejects(ops.database('app', 'main', { ...db, name: 'Proj-App' }, 'momolig'), /Which database/);
    await assert.rejects(ops.database('app', 'main', undefined, 'momolig'), /Which database/);
    assert.equal((await handle(ops, { op: 'database', id: 'app', branch: 'dev', database: null, actor: 'momolig' }) as { database: unknown }).database, null);
    assert.equal((await branch('dev')).database, null);
  });

  it('dev off: both its slots stopped, its images and upstream gone; main untouched', async () => {
    calls.length = 0;
    assert.equal((await ops.dev('app', false, 'momolig', true)).job.state, 'done');
    for (const u of ['proj-app-dev-a.service', 'proj-app-dev-b.service']) assert.ok(argvOf('stop').some((a) => a.at(-1) === u), u);
    assert.ok(!argvOf('stop').some((a) => a.at(-1)!.startsWith('proj-app-main')));
    assert.deepEqual(argvOf('let-go').filter((a) => a[1] === 'rmi').map((a) => a[3]), ['localhost/proj-app:dev-20300101000000']);
    assert.ok(argvOf('upstream').some((a) => a.join(' ') === `rm -f -- ${join(ngx, 'app-dev.conf')}`));
    // its environment too; main's kept
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(state, 'env', 'app.json'), 'utf8')).branches), ['main']);
    assert.ok(argvOf('env').some((a) => a.join(' ') === `rm -f -- ${join(srv, 'app', 'env', 'dev.env')}`));
  });

  it('a static project has nothing to start or a server log', async () => {
    await assert.rejects(ops.logs('site', 'main').catch((e) => { throw e; }), /no project called site|serves files/);
  });

  it('the route: a server goes to its branch\'s upstream, with the identity headers; old routes still serve files', () => {
    const k = projectKind('/srv/lfdln-projects');
    const cfg = { php: null } as never;
    assert.equal(k.fields({ project: 'app', branch: 'main', spa: false }).serve, 'files');
    assert.throws(() => k.fields({ project: 'app', branch: 'main', spa: false, serve: 'cgi' }), /serves files or goes to its server/);
    const lines = k.locations({ cfg, host: 'app' } as never, { kind: 'project', host: 'app', path: '/', enabled: true, project: 'app', branch: 'main', spa: false, cacheForever: [], serve: 'proxy' }).join('\n');
    assert.match(lines, /proxy_pass http:\/\/lfdln-project-app-main;/);
    assert.match(lines, /proxy_set_header Upgrade \$http_upgrade;/);
    assert.doesNotMatch(lines, /root |X-Robots-Tag/);
    const dev = k.locations({ cfg, host: 'app-dev' } as never, { kind: 'project', host: 'app-dev', path: '/', enabled: true, project: 'app', branch: 'dev', spa: false, cacheForever: [], serve: 'proxy' }).join('\n');
    assert.match(dev, /proxy_pass http:\/\/lfdln-project-app-dev;[\s\S]*add_header X-Robots-Tag "noindex, nofollow" always;/);
    // with accounts: the check names the branch, even for the longest id a project may have
    // (36; review SF1: the proof's audience rule once stopped at 32, and every re-render with it)
    const long = 'a'.repeat(35) + 'z';
    const gated = { kind: 'project', host: 'app', path: '/', enabled: true, project: long, branch: 'main', spa: false, cacheForever: [], serve: 'proxy', accounts: { token: 'T'.repeat(32) } } as never;
    const g = k.locations({ cfg: { identity: 'Lfdln' }, host: 'app' } as never, gated).join('\n');
    assert.match(g, new RegExp(`auth_request /_pammy/check/${'T'.repeat(32)}/project\\.${long}\\.main;`));
    assert.match(g, /proxy_set_header X-Lfdln-Proof \$lfdln_proof;/);
    assert.equal(k.audience?.(gated), `project.${long}.main`);
    assert.equal(k.audience?.({ ...(gated as object), serve: 'files' } as never), null, 'files: no app, no proof');
  });

  it('delete: every slot and image, the upstreams', async () => {
    calls.length = 0;
    mkdirSync(join(srv, 'app'), { recursive: true });
    assert.equal((await ops.remove('app', 'momolig', true)).job.state, 'done');
    assert.ok(argvOf('stop').some((a) => a.at(-1) === 'proj-app-main-a.service'));
    assert.ok(argvOf('upstream').some((a) => a.join(' ') === `rm -f -- ${join(ngx, 'app-main.conf')}`));
    assert.ok(!existsSync(join(state, 'env', 'app.json')), 'its environment\'s record goes too');
  });
});

describe('packages and scripts (8b-8a)', () => {
  const root = join(dir, 'root8');
  mkdirSync(join(root, 'etc'), { recursive: true });
  writeFileSync(join(root, 'etc/passwd'), `${APPS_USER}:x:974:966::/var/lib/${APPS_USER}:/usr/sbin/nologin\n`);
  const srv = join(dir, 'srv8');
  mkdirSync(srv);
  const calls: RunSpec[] = [];
  let builds = 0;
  let buildFails = false;
  let changed = true;
  const sha = (c: string) => c.repeat(40);
  const run = async (spec: RunSpec): Promise<RunResult> => {
    calls.push(spec);
    const a = spec.argv;
    if (spec.what === 'make') return { code: 0, stdout: `{"commit":"${sha('1')}"}\n`, stderr: '' };
    if (spec.what === 'build') {
      builds++;
      return buildFails ? { code: 1, stdout: '', stderr: '\nFAILED: npm run build failed (exit 1)' } : { code: 0, stdout: `{"commit":"${sha('2')}","files":8,"bytes":1000}\n`, stderr: '' };
    }
    if (spec.what === 'packages') {
      const op = a[a.indexOf('/lfdln/packages.mjs') + 1];
      if (op === 'check') return { code: 0, stdout: `{"pm":"npm","commit":"${sha('2')}","packages":[{"name":"react","range":"^19.0.0","type":"dependencies","current":"19.0.0","wanted":"19.0.1","latest":"19.1.0","deprecated":null,"advisory":null}],"scripts":{"build":"vite build","dev":"vite"},"audit":{"low":0,"moderate":1,"high":0,"critical":0},"auditRead":true}\n`, stderr: '' };
      if (op === 'change') return { code: 0, stdout: changed ? `{"changed":true,"before":"${sha('2')}","commit":"${sha('3')}","summary":"add zod@latest"}\n` : `{"changed":false,"before":"${sha('2')}","summary":"update all"}\n`, stderr: '' };
      if (op === 'run') return { code: 0, stdout: `--- npm run build\nbuilt\n{"script":"build","exit":0}\n`, stderr: '' };
    }
    if (spec.what === 'git-head') return { code: 0, stdout: `${sha('2')}\n`, stderr: '' };
    if (spec.what === 'registry') return { code: 0, stdout: a.includes('search') ? '{"results":[{"name":"zod","version":"4.0.0"}]}\n' : '{"found":true,"name":"zod","warnings":[]}\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const state = join(dir, 'state8');
  mkdirSync(state);
  const ops = createProjectsOps({ recordFile: join(state, 'projects.json'), stateDir: state, run, now: () => (clock += 60), root, projectsRoot: srv, containerDir: '/opt/x/container', spool: join(dir, 'none8'), safeFile: join(dir, 'safe8.cfg') });
  const argvOf = (what: string) => calls.filter((c) => c.what === what).map((c) => c.argv);
  const box = (op: string) => argvOf('packages').filter((x) => x[x.indexOf('/lfdln/packages.mjs') + 1] === op);

  it('the helper and the build container keep the same rules for names, versions and serving scripts', () => {
    assert.deepEqual([BOX_NAME_RE.source, BOX_SPEC_RE.source, BOX_LONG_RUNNING], [PKG_NAME_RE.source, PKG_SPEC_RE.source, LONG_RUNNING]);
    for (const ok of ['zod', '@types/node', 'lodash.merge', '@tanstack/react-query']) assert.ok(PKG_NAME_RE.test(ok), ok);
    for (const bad of ['Zod', '../x', '@/x', 'a b', '', 'x;rm']) assert.ok(!PKG_NAME_RE.test(bad), bad);
    for (const ok of ['1.2.3', '^4', '~1.2', 'latest', '>=1 <2', '5.x']) assert.ok(PKG_SPEC_RE.test(ok), ok);
    for (const bad of ['1;rm', '$(x)', 'a\nb', '`x`']) assert.ok(!PKG_SPEC_RE.test(bad), bad);
  });

  it('the warnings before adding one: new, few users, a look-alike name, deprecated, an odd licence, install scripts', () => {
    assert.ok(closeTo('lodahs', 'lodash') && closeTo('reacts', 'react') && closeTo('expres', 'express'));
    assert.ok(!closeTo('react', 'react') && !closeTo('vue', 'svelte') && !closeTo('preact', 'react-dom'));
    const ok = { name: 'zod', created: '2020-03-07T00:00:00Z', weekly: 30_000_000, deprecated: null, license: 'MIT', installScripts: false };
    assert.deepEqual(warningsOf(ok, ['react', 'zod']), []);
    const w = warningsOf({ name: 'reactt', created: new Date().toISOString(), weekly: 12, deprecated: 'use react', license: 'SSPL-1.0', installScripts: true }, ['react']);
    assert.deepEqual(w.map((x) => x.kind), ['new', 'few', 'lookalike', 'deprecated', 'license', 'scripts']);
    assert.match(w.find((x) => x.kind === 'lookalike')!.text, /one letter away from react/);
    assert.deepEqual(warningsOf({ ...ok, license: null }, []).map((x) => x.kind), ['license']);
  });

  it('checked as a job in the box (the repository read-only), kept; changes go to dev when there is one', async () => {
    assert.equal((await ops.create({ id: 'shop', kind: 'react', pm: 'npm', typescript: true, tailwind: false, dev: true }, 'momolig', true)).job.state, 'done');
    assert.deepEqual(await ops.packages('shop'), { branch: 'dev', check: null, autoUpdate: false });
    calls.length = 0;
    const { job } = await ops.packagesCheck('shop', 'momolig', true);
    assert.equal(job.state, 'done', job.error ?? '');
    const b = box('check')[0]!;
    assert.ok(b.includes(`${join(srv, 'shop', 'repo.git')}:/repo:ro`));
    assert.deepEqual(b.slice(-2), ['check', 'dev']);
    const kept = (await ops.packages('shop')).check as { packages: { name: string }[]; branch: string; at: number };
    assert.deepEqual([kept.branch, kept.packages[0]!.name, typeof kept.at], ['dev', 'react', 'number']);
    assert.equal(statSync(join(state, 'packages', 'shop-dev.json')).mode & 0o777, 0o600);
  });

  it('a change: refused unless one, well named; in the box with the repository writable and its environment; committed by its asker; then built and checked again', async () => {
    await assert.rejects(ops.packagesChange('shop', { add: [{ name: 'zod' }], remove: ['react'] }, 'momolig', true), /One change at a time/);
    await assert.rejects(ops.packagesChange('shop', { add: [{ name: 'Bad Name' }] }, 'momolig', true), /Which packages/);
    await assert.rejects(ops.packagesChange('shop', { add: [{ name: 'zod', version: '1.0.0; rm -rf /' }] }, 'momolig', true), /Which packages/);
    await assert.rejects(ops.packagesChange('shop', { update: [] }, 'momolig', true), /Which packages/);
    await assert.rejects(ops.packagesChange('shop', { fix: 'yes' }, 'momolig', true), /Which packages/);
    await ops.envSet('shop', 'dev', 'NPM_TOKEN', 'x');
    calls.length = 0;
    const built = builds;
    const { job } = await ops.packagesChange('shop', { add: [{ name: 'zod', version: '^4' }, { name: '@types/node', dev: true }] }, 'momolig', true);
    assert.equal(job.state, 'done', job.error ?? '');
    const b = box('change')[0]!;
    assert.ok(b.includes(`${join(srv, 'shop', 'repo.git')}:/repo:rw`));
    assert.equal(b[b.indexOf('--env-file') + 1], join(srv, 'shop', 'build.env'));
    assert.deepEqual(b.slice(-4, -1), ['change', 'dev', 'momolig']);
    assert.deepEqual(JSON.parse(b.at(-1)!), { add: [{ name: 'zod', version: '^4' }, { name: '@types/node', dev: true }] });
    assert.equal(builds, built + 1, 'built after the change');
    assert.equal(box('check').length, 1, 'checked again after it');
    assert.equal(argvOf('git-update').length, 0, 'nothing undone');
  });

  it('a build that fails: dev put back to before the change (only if still at it), the job says so', async () => {
    buildFails = true;
    calls.length = 0;
    const { job } = await ops.packagesChange('shop', { update: ['react'] }, 'momolig', true);
    buildFails = false;
    assert.equal(job.state, 'failed');
    assert.match(job.error!, /^The build failed, so the change was undone: /);
    const undo = argvOf('git-update')[0]!;
    assert.deepEqual(undo.slice(-3), ['refs/heads/dev', sha('2'), sha('3')]);
  });

  it('nothing changed: no commit, no build', async () => {
    changed = false;
    const built = builds;
    const { job } = await ops.packagesChange('shop', { update: 'all' }, 'momolig', true);
    changed = true;
    assert.deepEqual([job.state, (job.result as { changed: boolean }).changed, builds], ['done', false, built]);
  });

  it('a script: one of its names, never one that serves; with its environment, the repository read-only', async () => {
    await assert.rejects(ops.packagesRun('shop', 'dev', 'momolig', true), /serves and never finishes/);
    await assert.rejects(ops.packagesRun('shop', 'rm -rf /', 'momolig', true), /Which script/);
    calls.length = 0;
    assert.equal((await ops.packagesRun('shop', 'build', 'momolig', true)).job.state, 'done');
    const b = box('run')[0]!;
    assert.ok(b.includes(`${join(srv, 'shop', 'repo.git')}:/repo:ro`) && b.includes('--env-file'));
    assert.deepEqual(b.slice(-3), ['run', 'dev', 'build']);
  });

  it('the registry: asked from a short box with no folders, never queued', async () => {
    calls.length = 0;
    assert.deepEqual(await ops.packageSearch(' zod '), { results: [{ name: 'zod', version: '4.0.0' }] });
    const s = argvOf('registry')[0]!;
    assert.ok(!s.some((x) => x.includes(':/repo') || x.includes(':/build')), 'no project folders');
    assert.ok(s.includes('--read-only') && s.includes('--memory=256m'));
    assert.deepEqual(s.slice(-2), ['search', 'zod']);
    assert.equal((await ops.packageAbout('zod', 'ts')).found, true);
    assert.deepEqual(argvOf('registry')[1]!.slice(-3), ['about', 'zod', 'ts']);
    await assert.rejects(ops.packageSearch(''), /Search for what/);
    await assert.rejects(ops.packageAbout('../etc', 'js'), /isn't a package name/);
    assert.equal(ops.queue.list('shop').filter((j) => j.what === 'registry').length, 0);
  });

  it('every box is on the internal network, its proxy in the environment (8b-8b, P8b-11)', () => {
    for (const b of [...box('check'), ...box('change'), ...box('run'), ...argvOf('registry')]) {
      assert.ok(b.includes('--network=lfdln-build'), b.join(' '));
      for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) assert.ok(b.includes(`${k}=${BUILD_PROXY}`), k);
      assert.ok(b.includes('NODE_USE_ENV_PROXY=1'));
    }
    assert.equal(BUILD_PROXY, 'http://lfdln-build-proxy:3128');
  });

  it('the summary the Projects list shows; each night every project checked, and updated if it says so (8b-8b)', async () => {
    const s = (await ops.list()).projects.find((x) => x.id === 'shop')!.packages;
    assert.deepEqual({ ...s, at: 0 }, { at: 0, outdated: 1, inRange: 1, majors: [], advisories: 1 });
    await assert.rejects(ops.autoUpdate('shop', 'yes'), /On or off/);
    assert.deepEqual(await ops.autoUpdate('shop', true), { autoUpdate: true });
    assert.equal((await ops.packages('shop')).autoUpdate, true);
    calls.length = 0;
    const { jobs } = await ops.nightly();
    assert.equal(jobs.length, 1);
    const j = await ops.queue.done(jobs[0]!);
    assert.equal(j.state, 'done', j.error ?? '');
    assert.equal(j.by, 'nightly');
    assert.equal(box('check').length >= 1, true);
    const ch = box('change')[0]!;
    assert.deepEqual([ch.at(-2), JSON.parse(ch.at(-1)!)], ['panel', { update: 'all' }], 'updated within ranges, as the panel');
    await ops.autoUpdate('shop', false);
    calls.length = 0;
    await ops.queue.done((await ops.nightly()).jobs[0]!);
    assert.equal(box('change').length, 0, 'off: only checked');
  });

  it('dev off and delete take their checks away', async () => {
    assert.equal((await ops.dev('shop', false, 'momolig', true)).job.state, 'done');
    assert.ok(!existsSync(join(state, 'packages', 'shop-dev.json')));
    await ops.packagesCheck('shop', 'momolig', true);
    assert.ok(existsSync(join(state, 'packages', 'shop-main.json')));
    mkdirSync(join(srv, 'shop'), { recursive: true });
    assert.equal((await ops.remove('shop', 'momolig', true)).job.state, 'done');
    assert.ok(!existsSync(join(state, 'packages', 'shop-main.json')));
  });
});

describe('the build boxes\' proxy (8b-8b, P8b-11: container/proxy.mjs)', () => {
  const list = loadAllow(readFileSync(new URL('../packages/projects/container/proxy-allow.txt', import.meta.url), 'utf8'));
  it('its allow-list: the registries and the few hosts builds need, one a line', () => {
    for (const h of ['registry.npmjs.org', 'api.npmjs.org', 'github.com', 'fonts.gstatic.com']) assert.ok(allowed(list, h), h);
    for (const h of ['example.com', 'npmjs.org.evil.com', 'evilregistry.npmjs.org', 'registry.npmjs.org.', '', 'registry.npmjs.org:443']) assert.equal(allowed(list, h), h === 'registry.npmjs.org.', h);
    assert.ok(allowed(['*.example.com'], 'a.example.com') && !allowed(['*.example.com'], 'example.com') && !allowed(['*.example.com'], 'badexample.com'));
    assert.deepEqual(loadAllow('# a note\nA.org  # its own\n\nb.org\n'), ['a.org', 'b.org']);
  });
  it('CONNECT to port 443 only', () => {
    assert.equal(target('registry.npmjs.org:443'), 'registry.npmjs.org');
    for (const t of ['registry.npmjs.org:80', 'registry.npmjs.org', '1.2.3.4:22', 'a b:443']) assert.equal(target(t), null, t);
  });
  it('refuses a host not on the list, and plain HTTP, and says so', async () => {
    const said: string[] = [];
    const server = createProxy(list, (l) => said.push(l));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const ask = (raw: string) => new Promise<string>((resolve) => {
      const c = connect(port, '127.0.0.1', () => c.write(raw));
      let got = '';
      c.on('data', (b) => { got += b.toString(); });
      c.on('close', () => resolve(got));
      c.setTimeout(3000, () => c.destroy());
    });
    assert.match(await ask('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n'), /^HTTP\/1\.1 403/);
    assert.match(await ask('CONNECT registry.npmjs.org:80 HTTP/1.1\r\nHost: registry.npmjs.org:80\r\n\r\n'), /^HTTP\/1\.1 403/);
    assert.match(await ask('GET http://registry.npmjs.org/ms HTTP/1.1\r\nHost: registry.npmjs.org\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 403/);
    assert.deepEqual(said, ['refused CONNECT example.com:443', 'refused CONNECT registry.npmjs.org:80', 'refused GET http://registry.npmjs.org/ms (plain HTTP)']);
    server.close();
  });
  it('names: the resolvers it is given, else the container\'s own; in the shape net.connect asks for', async () => {
    const ask = (servers: string[], host: string, all: boolean) => new Promise<unknown[]>((resolve) => makeLookup(servers)(host, { all }, (...a) => resolve(a)));
    assert.deepEqual(await ask([], 'localhost', true), [null, [{ address: '127.0.0.1', family: 4 }]]);
    assert.deepEqual(await ask([], 'localhost', false), [null, '127.0.0.1', 4]);
    const [e] = await ask([], 'nosuch.invalid', false);
    assert.ok(e instanceof Error);
  });

  it('a host on the list it can\'t reach: 502, and the tunnel is gone again', async () => {
    const server = createProxy(['nosuch.invalid'], () => {});
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const got = await new Promise<string>((resolve) => {
      const c = connect(port, '127.0.0.1', () => c.write('CONNECT nosuch.invalid:443 HTTP/1.1\r\nHost: nosuch.invalid:443\r\n\r\n'));
      let t = '';
      c.on('data', (b) => { t += b.toString(); });
      c.on('close', () => resolve(t));
      c.setTimeout(10_000, () => c.destroy());
    });
    assert.match(got, /^HTTP\/1\.1 502/);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(server.openTunnels(), 0);
    server.close();
  });
});
