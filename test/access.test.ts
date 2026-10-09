// The Access page's side of the gate (docs/roles-plan.md step 4): copying a
// built-in set, privileges, groups, plain and combined roles, the slots, never
// together, people's roles, going back, and Read again -- each change checked,
// and nothing changed while the roles switch is off.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  accessState, copySet, deleteGroup, deleteResource, deleteRole, readManifest, resetSet, saveGroup, saveResource, saveRole,
  setNeverTogether, setPersonRole, setSignedInRole,
} from '@panel/areas/gate/access';
import { createArea, opensArea, rolesOf, setMember } from '@panel/core/gate/store';
import { createVisitor } from '@panel/people/gate/visitors';
import { GateError } from '@panel/core/gate/ops';
import { readVisitorSettings } from '@panel/core/gate/visitor-settings';
import { setVisitorSwitch } from '@panel/people/gate/visitor-settings';
import type { Sql } from '@panel/core/pg';
import { migrate } from '@panel/core/pg-migrate';
import { startPg, type PgTest } from './pg-harness.ts';

let pg: PgTest;
let db: Sql;
const now = 1_800_000_000;
let area: number;
let jo: number, al: number;
const refused = (p: Promise<unknown>, why: RegExp) => assert.rejects(p, (e) => e instanceof GateError && why.test(e.message), why.source);
const roleId = async (label: string) => (await accessState(db, area)).roles.find((r) => r.label === label)!.id;

before(async () => {
  pg = await startPg();
  const database = pg.freshDatabase();
  const owner = pg.connect('owner', database, 1);
  await migrate(owner);
  await owner.end();
  db = pg.connect('gate', database, 4);
  area = (await createArea(db, now, 'club')).id;
  jo = (await createVisitor(db, now, 'jo', '', 'jo-password-123')).id;
  al = (await createVisitor(db, now, 'al', '', 'al-password-123')).id;
  await setMember(db, now, jo, area, true);
});
after(async () => { await db?.end({ timeout: 2 }); pg?.stop(); });

describe('the Access page, in the gate', () => {
  it('reads the built-in set; changes nothing while roles are switched off', async () => {
    const st = await accessState(db, area);
    assert.deepEqual([st.set.label, st.set.builtIn, st.canEditRoles, st.canEditPrivileges], ['Protected folder', true, false, false]);
    assert.deepEqual(st.roles.map((r) => [r.label, r.slot, r.all]), [['Not signed in', 'not-signed-in', []], ['Member', null, ['pages.read']]]);
    assert.deepEqual(st.members.map((m) => m.visitorId), [jo]);
    await refused(copySet(db, now, area), /switched off/);
    await refused(setPersonRole(db, now, area, al, st.roles[1]!.id), /switched off/);
  });

  it('copy to change: the folder and its people move onto a copy of their own', async () => {
    await setVisitorSwitch(db, now, 'roles', true, 'test', { mail: false });
    await refused(saveRole(db, area, { label: 'Editor' }), /built in, so it can't be changed/);
    const st = await copySet(db, now, area);
    assert.deepEqual([st.set.builtIn, st.set.copiedFrom, st.canEditRoles, st.canEditPrivileges], [false, 'Protected folder', true, true]);
    assert.equal(st.members[0]!.roleId, st.roles.find((r) => r.key === 'member')!.id);
    assert.ok(await opensArea(db, jo, area), 'jo still opens it');
    await refused(copySet(db, now, area), /already has roles of its own/);
  });

  it('privileges: resources and actions, and only declared keys anywhere', async () => {
    await saveResource(db, area, { key: 'notes', label: 'Notes', owned: true, actions: ['read', 'update', 'publish'], actionLabels: { publish: 'Publish' } });
    const st = await accessState(db, area);
    assert.deepEqual(st.privileges, ['pages.read', 'notes.publish:own', 'notes.publish:any', 'notes.read:own', 'notes.read:any', 'notes.update:own', 'notes.update:any']);
    assert.deepEqual(st.actions, [{ key: 'publish', label: 'Publish' }]);
    await refused(saveResource(db, area, { key: 'pages', label: 'P', owned: false, actions: ['read'] }), /not "pages"/);
    await refused(saveResource(db, area, { key: 'x', label: 'X', owned: false, actions: [] }), /at least one action/);
    await refused(saveGroup(db, area, { label: 'Bad', privileges: ['notes.read'] }), /Not privileges of this folder: notes\.read/);
  });

  it('groups and plain roles; a privilege in use can\'t be taken away', async () => {
    const { id: write } = await saveGroup(db, area, { label: 'Write notes', privileges: ['notes.read:any', 'notes.update:own'] });
    await saveRole(db, area, { label: 'Editor', groups: [write], privileges: ['pages.read'] });
    await saveRole(db, area, { label: 'Publisher', privileges: ['pages.read', 'notes.publish:any'] });
    const st = await accessState(db, area);
    assert.deepEqual(st.roles.find((r) => r.label === 'Editor')!.all, ['notes.read:any', 'notes.update:own', 'pages.read']);
    await refused(saveResource(db, area, { key: 'notes', label: 'Notes', owned: false, actions: ['read'] }), /still used by/);
    await refused(deleteResource(db, area, 'notes'), /still used by .*the role "Publisher"/);
    await refused(saveRole(db, area, { label: 'editor' }), /a role with that name already/);
  });

  it('combined roles: two plain roles or more, worked out live; never together refuses a pair', async () => {
    const [editor, publisher, member] = [await roleId('Editor'), await roleId('Publisher'), await roleId('Member')];
    await refused(saveRole(db, area, { label: 'Solo', parts: [editor] }), /two roles or more/);
    const { id: chief } = await saveRole(db, area, { label: 'Chief', parts: [editor, publisher] });
    let st = await accessState(db, area);
    assert.deepEqual(st.roles.find((r) => r.id === chief)!.all, ['notes.publish:any', 'notes.read:any', 'notes.update:own', 'pages.read']);
    await refused(saveRole(db, area, { label: 'Nested', parts: [chief, member] }), /plain roles/);
    await refused(setNeverTogether(db, area, editor, publisher, true), /"Chief" is made of both/);
    await setNeverTogether(db, area, member, publisher, true);
    await refused(saveRole(db, area, { label: 'Odd', parts: [member, publisher] }), /can never be given together/);
    await setNeverTogether(db, area, member, publisher, false);
    // a change to a part reaches the combined role at once
    await saveRole(db, area, { id: publisher, privileges: ['pages.read'] });
    st = await accessState(db, area);
    assert.deepEqual(st.roles.find((r) => r.id === chief)!.all, ['notes.read:any', 'notes.update:own', 'pages.read']);
    await refused(deleteRole(db, area, editor, null), /part of "Chief"/);
  });

  it('people: one role each; the signed-in slot for everyone else; the not-signed-in slot', async () => {
    const [editor, member, guest] = [await roleId('Editor'), await roleId('Member'), await roleId('Not signed in')];
    await setPersonRole(db, now, area, al, editor);
    assert.equal((await rolesOf(db, al, area)).get(area)!.role, 'Editor');
    await refused(setPersonRole(db, now, area, al, guest), /no longer there/);
    const sam = (await createVisitor(db, now, 'sam', '', 'sam-password-123')).id;
    assert.equal(await opensArea(db, sam, area), false);
    await setSignedInRole(db, area, member);
    assert.equal((await rolesOf(db, sam, area)).get(area)!.role, 'Member');
    await refused(deleteRole(db, area, member, null), /Everyone signed in counts as "Member"/);
    await setSignedInRole(db, area, null);
    // the not-signed-in slot: pages.read opens the folder to anyone
    await saveRole(db, area, { id: guest, privileges: ['pages.read'] });
    assert.equal(await opensArea(db, sam, area), true);
    await saveRole(db, area, { id: guest, privileges: [] });
    await refused(saveRole(db, area, { id: guest, parts: [editor, member] }), /made of privileges/);
  });

  it('deleting a role moves its people, or takes their role away', async () => {
    const { id: temp } = await saveRole(db, area, { label: 'Temp', privileges: ['pages.read'] });
    await setPersonRole(db, now, area, al, temp);
    const r = await deleteRole(db, area, temp, await roleId('Member'));
    assert.deepEqual(r, { label: 'Temp', people: ['al'], movedTo: 'Member' });
    assert.equal((await rolesOf(db, al, area)).get(area)!.role, 'Member');
  });

  it('switching roles off waits until the folder is back on the built-in roles', async () => {
    // word for word (docs/k-a-plan.md K-a4: the check moves to areas, the words to people), and nothing changed
    await assert.rejects(setVisitorSwitch(db, now, 'roles', false, 'test', { mail: false }),
      (e) => e instanceof GateError && e.code === 'invalid' && e.message === 'First put "club" back on the built-in roles (Access, Roles).');
    assert.equal((await readVisitorSettings(db)).switches.roles, true);
    await setPersonRole(db, now, area, al, await roleId('Editor'));
    const back = await resetSet(db, area);
    assert.deepEqual(back.lost, ['al'], 'Editor has no match in Protected folder');
    const st = await accessState(db, area);
    assert.deepEqual([st.set.label, st.members.map((m) => m.visitorId)], ['Protected folder', [jo]]);
    await setVisitorSwitch(db, now, 'roles', false, 'test', { mail: false });
    await setVisitorSwitch(db, now, 'roles', true, 'test', { mail: false });
  });

  it('Read again: the folder onto its app\'s set, people matched by role key; no privileges added under it (R12)', async () => {
    const manifest = JSON.stringify({
      version: 1, name: 'Club app',
      resources: { notes: { label: 'Notes', owned: true, actions: ['read'] } },
      groups: { reading: { label: 'Reading', privileges: ['pages.read', 'notes.read:own'] } },
      roles: { member: { label: 'Member', groups: ['reading'] }, host: { label: 'Host', groups: ['reading'], privileges: ['notes.read:any'] } },
      slots: { signedIn: null },
    });
    await refused(readManifest(db, now, area, undefined), /No pammy-panel.json/);
    const r = await readManifest(db, now, area, manifest);
    assert.deepEqual(r.lost, []);
    let st = await accessState(db, area);
    assert.deepEqual([st.set.label, st.set.builtIn, st.set.fromManifest], ['Club app', true, true]);
    assert.equal((await rolesOf(db, jo, area)).get(area)!.role, 'Member', 'jo kept Member');
    st = await copySet(db, now, area);
    assert.deepEqual([st.canEditRoles, st.canEditPrivileges], [true, false]);
    await refused(saveResource(db, area, { key: 'extra', label: 'E', owned: false, actions: ['read'] }), /come from its pammy-panel.json/);
    await refused(deleteGroup(db, area, 999999), /no longer there/);
  });
});
