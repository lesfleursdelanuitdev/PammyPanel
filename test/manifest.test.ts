// pammy-panel.json (docs/roles-plan.md step 3): the checks, and a manifest
// taken into a built-in role set -- made, brought up to date, and what that
// does to the people holding a role that went.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { applyManifest, checkManifest, declaredPrivileges, ManifestError, MANIFEST_MAX_BYTES } from '@panel/areas/manifest';
import { rolesOf } from '@panel/core/gate/store';
import type { Sql } from '@panel/core/pg';
import { migrate } from '@panel/core/pg-migrate';
import { startPg, type PgTest } from './pg-harness.ts';

// the plan's own example: Placement Exam Prep
const EXAM_PREP = {
  version: 1,
  name: 'Placement Exam Prep',
  resources: {
    questions: { label: 'Questions', actions: ['read'] },
    attempts: { label: 'Tries at an exam', owned: true, actions: ['create', 'read', 'update', 'submit'] },
    progress: { label: 'Saved progress', owned: true, actions: ['read', 'update', 'delete'] },
  },
  actions: { submit: { label: 'Hand in' } },
  groups: {
    practise: { label: 'Practise', privileges: ['pages.read', 'questions.read', 'attempts.create:own', 'attempts.read:own', 'attempts.update:own', 'attempts.submit:own'] },
    'keep-progress': { label: 'Keep progress on any device', privileges: ['progress.read:own', 'progress.update:own', 'progress.delete:own'] },
    'see-others': { label: "See other people's progress", privileges: ['progress.read:any', 'attempts.read:any'] },
  },
  roles: {
    student: { label: 'Student', groups: ['practise', 'keep-progress'] },
    teacher: { label: 'Teacher', groups: ['practise', 'keep-progress', 'see-others'] },
  },
  slots: { notSignedIn: { groups: ['practise'] }, signedIn: 'student' },
  neverTogether: [],
};
const text = (m: unknown) => JSON.stringify(m);
const with_ = (change: (m: any) => void) => { const m = structuredClone(EXAM_PREP) as any; change(m); return text(m); };
const refused = (t: string, why: RegExp) => assert.throws(() => checkManifest(t), (e) => e instanceof ManifestError && e.problems.some((p) => why.test(p)), why.source);

describe('checking pammy-panel.json', () => {
  it('takes the plan\'s example, with every key it declares', () => {
    const m = checkManifest(text(EXAM_PREP));
    assert.equal(m.name, 'Placement Exam Prep');
    assert.deepEqual(m.privileges, [
      'pages.read', 'questions.read',
      'attempts.create:own', 'attempts.create:any', 'attempts.read:own', 'attempts.read:any', 'attempts.update:own', 'attempts.update:any', 'attempts.submit:own', 'attempts.submit:any',
      'progress.read:own', 'progress.read:any', 'progress.update:own', 'progress.update:any', 'progress.delete:own', 'progress.delete:any']);
    assert.deepEqual(m.slots, { notSignedIn: { groups: ['practise'], privileges: [] }, signedIn: 'student' });
    assert.deepEqual(m.roles.map((r) => r.key), ['student', 'teacher']);
  });

  it('a small one: no roles, nothing for anyone', () => {
    const m = checkManifest(text({ version: 1, name: 'Tiny' }));
    assert.deepEqual([m.privileges, m.roles, m.slots.signedIn], [['pages.read'], [], null]);
  });

  it('refuses what isn\'t right, and says what', () => {
    refused('{', /isn't JSON/);
    refused('[]', /one JSON object/);
    refused(with_((m) => { m.version = 2; }), /"version" must be 1/);
    refused(with_((m) => { m.name = ''; }), /name: a label/);
    refused(with_((m) => { m.colour = 'red'; }), /"colour" isn't something it can say/);
    refused(with_((m) => { m.resources.Questions = m.resources.questions; }), /resources\.Questions: a resource is a lowercase word/);
    refused(with_((m) => { m.resources.pages = { label: 'P', actions: ['read'] }; }), /pages is built in/);
    refused(with_((m) => { m.resources.questions.actions = ['grade']; }), /"grade" is not read, create, update, delete/);
    refused(with_((m) => { m.resources.questions.actions = []; }), /at least one action/);
    refused(with_((m) => { m.actions.read = { label: 'Read' }; }), /read\/create\/update\/delete are already there/);
    refused(with_((m) => { m.groups.practise.privileges.push('questions.read:own'); }), /questions has no owner, so no :own or :any/);
    refused(with_((m) => { m.groups.practise.privileges.push('progress.read'); }), /progress has an owner, so say :own or :any/);
    refused(with_((m) => { m.groups.practise.privileges.push('answers.read'); }), /no resource "answers"/);
    refused(with_((m) => { m.groups.practise.privileges.push('questions.delete'); }), /questions has no action "delete"/);
    refused(with_((m) => { m.groups.practise.privileges.push('pages.update'); }), /pages has only read/);
    refused(with_((m) => { m.groups.practise.privileges.push('Questions.Read'); }), /isn't resource\.action/);
    refused(with_((m) => { m.roles.student.groups.push('nope'); }), /no group "nope"/);
    refused(with_((m) => { m.roles['not-signed-in'] = { label: 'X' }; }), /not "not-signed-in"/);
    refused(with_((m) => { m.roles.teacher.label = 'student'; }), /the same label as roles\.student/);
    refused(with_((m) => { m.slots.signedIn = 'nobody'; }), /slots\.signedIn: one of the roles/);
    refused(with_((m) => { m.slots.notSignedIn.groups = ['nope']; }), /slots\.notSignedIn\.groups: no group "nope"/);
    refused(with_((m) => { m.neverTogether = [['student', 'student']]; }), /isn't two different roles/);
    refused(with_((m) => { m.neverTogether = [['student', 'dean']]; }), /isn't two different roles/);
  });

  it('at most 100 privileges, and 64 KB', () => {
    const resources: Record<string, unknown> = {};
    for (let i = 0; i < 17; i++) resources[`r${i}`] = { label: `R${i}`, owned: true, actions: ['read', 'create', 'update'] };   // 17 x 6 + pages.read = 103
    refused(text({ version: 1, name: 'Big', resources }), /declares 103 privileges; at most 100/);
    refused(text({ version: 1, name: 'x'.repeat(10), pad: ' '.repeat(MANIFEST_MAX_BYTES) }), /larger than 64 KB/);
  });

  it('declaredPrivileges: pages.read first, :own and :any where there is an owner', () => {
    assert.deepEqual(declaredPrivileges([{ key: 'notes', label: 'N', owned: true, actions: ['read'] }, { key: 'tags', label: 'T', owned: false, actions: ['read'] }]),
      ['pages.read', 'notes.read:own', 'notes.read:any', 'tags.read']);
  });
});

// ------------------------------------------------------------------ into the database
let pg: PgTest;
let db: Sql;
const clock = 1_800_000_000;
before(async () => {
  pg = await startPg();
  const database = pg.freshDatabase();
  const owner = pg.connect('owner', database, 1);
  await migrate(owner);
  await owner.end();
  db = pg.connect('gate', database, 4);
});
after(async () => { await db?.end({ timeout: 2 }); pg?.stop(); });

describe('a manifest taken into a role set', () => {
  it('makes the built-in set: roles, groups, the slots, never-together', async () => {
    const r = await applyManifest(db, clock, 'app-examprep', with_((m) => { m.neverTogether = [['teacher', 'student']]; }));
    assert.equal(r.created, true);
    const [set] = await db`SELECT id, key, label, built_in, manifest IS NOT NULL AS has_manifest, signed_in_role_id FROM role_sets WHERE key = 'app-examprep'`;
    assert.deepEqual([set!.label, set!.built_in, set!.has_manifest], ['Placement Exam Prep', true, true]);
    const roles = await db`SELECT key, label, slot FROM roles WHERE role_set_id = ${set!.id} ORDER BY key`;
    assert.deepEqual(roles.map((x) => [x.key, x.slot]), [['not-signed-in', 'not-signed-in'], ['student', null], ['teacher', null]]);
    const [student] = await db`SELECT id FROM roles WHERE role_set_id = ${set!.id} AND key = 'student'`;
    assert.equal(set!.signed_in_role_id, student!.id);
    assert.equal((await db`SELECT count(*) AS n FROM never_together WHERE role_set_id = ${set!.id} AND from_manifest`)[0]!.n, 1);
    const slot = await db`SELECT p.privilege FROM role_all_privileges p JOIN roles r ON r.id = p.role_id WHERE r.role_set_id = ${set!.id} AND r.slot IS NOT NULL ORDER BY 1`;
    assert.deepEqual(slot.map((x) => x.privilege), ['attempts.create:own', 'attempts.read:own', 'attempts.submit:own', 'attempts.update:own', 'pages.read', 'questions.read']);
  });

  it('a person in an area on it: the signed-in slot, then a role given; then brought up to date', async () => {
    const [set] = await db`SELECT id FROM role_sets WHERE key = 'app-examprep'`;
    const [area] = await db`INSERT INTO areas (token, path, created_at, role_set_id) VALUES ('t-exam', 'exam', 1, ${set!.id}) RETURNING id`;
    const [ana] = await db`INSERT INTO visitors (username, password_hash, created_at, password_changed_at) VALUES ('ana', '', 1, 1) RETURNING id`;
    const [tom] = await db`INSERT INTO visitors (username, password_hash, created_at, password_changed_at) VALUES ('tom', '', 1, 1) RETURNING id`;
    const roleOf = async (v: number) => { const r = (await rolesOf(db, v, area!.id)).get(area!.id); return r && [r.role, r.privileges.has('progress.read:any')]; };
    assert.deepEqual(await roleOf(ana!.id), ['Student', false]);
    const [teacher] = await db`SELECT id FROM roles WHERE role_set_id = ${set!.id} AND key = 'teacher'`;
    await db`INSERT INTO memberships (visitor_id, area_id, role_set_id, role_id, created_at) VALUES (${tom!.id}, ${area!.id}, ${set!.id}, ${teacher!.id}, 1)`;
    assert.deepEqual(await roleOf(tom!.id), ['Teacher', true]);

    // the same file again: nothing changes, and nobody loses anything
    const same = await applyManifest(db, clock + 1, 'app-examprep', with_((m) => { m.neverTogether = [['teacher', 'student']]; }));
    assert.deepEqual([same.created, same.removedPrivileges, same.removedRoles], [false, [], []]);
    assert.deepEqual(await roleOf(tom!.id), ['Teacher', true]);

    // Teacher and see-others go, Student is renamed: Tom counts as signed in, no role given
    const next = await applyManifest(db, clock + 2, 'app-examprep', with_((m) => {
      delete m.roles.teacher; delete m.groups['see-others']; m.roles.student.label = 'Learner';
    }));
    assert.deepEqual(next.removedRoles, [{ key: 'teacher', label: 'Teacher', people: ['tom'] }]);
    assert.deepEqual(next.removedPrivileges, ['attempts.read:any', 'progress.read:any']);
    assert.deepEqual(await roleOf(tom!.id), ['Learner', false]);
    assert.deepEqual(await roleOf(ana!.id), ['Learner', false]);
    assert.equal((await db`SELECT count(*) AS n FROM never_together WHERE role_set_id = ${set!.id}`)[0]!.n, 0);
  });

  it('a file that fails a check changes nothing, and the last good one stays', async () => {
    const [before_] = await db`SELECT manifest, manifest_read_at FROM role_sets WHERE key = 'app-examprep'`;
    await assert.rejects(applyManifest(db, clock + 3, 'app-examprep', with_((m) => { m.version = 2; })), ManifestError);
    const [after_] = await db`SELECT manifest, manifest_read_at FROM role_sets WHERE key = 'app-examprep'`;
    assert.deepEqual(after_, before_);
  });

  it('never the panel\'s own built-in sets', async () => {
    await assert.rejects(applyManifest(db, clock, 'protected-folder', text(EXAM_PREP)), /can't name an app's role set/);
    const [pf] = await db`SELECT label, manifest FROM role_sets WHERE key = 'protected-folder'`;
    assert.deepEqual([pf!.label, pf!.manifest], ['Protected folder', null]);
  });
});
