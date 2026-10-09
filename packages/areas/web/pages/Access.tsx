// Access to one protected folder (docs/roles-plan.md step 4): who may do what
// there. Four tabs -- Roles, People, Groups, Privileges -- stacked as a list on
// phones. A built-in set shows a lock and "Copy to change"; the folder's own
// copy can be changed, and can go back to the built-in roles. With the roles
// switch off (Settings > Visitors) the page only explains how to turn it on.
import { ArrowLeft, Copy, FileJson, Lock, Plus, RotateCcw, Save, Trash2, Undo2 } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Link, NavLink, useParams } from 'react-router';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { ActionButton, Collapsible, Field, GuideLink, InlineLink, Loading, Page, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { Checkbox } from '@panel/core/web/components/ui/checkbox';
import { Input } from '@panel/core/web/components/ui/input';
import { NativeSelect } from '@panel/core/web/components/ui/native-select';
import { Switch } from '@panel/core/web/components/ui/switch';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { api } from '@panel/core/web/lib/api';
import { personLabel } from '@panel/core/web/lib/names';
import { notify } from '@panel/core/web/lib/status';
import { cn } from '@panel/core/web/lib/utils';
import type { AccessGroup, AccessRole, AccessView } from '../lib/types';

const TABS = [
  ['roles', 'Roles'], ['people', 'People'], ['groups', 'Groups'], ['privileges', 'Privileges'],
] as const;
type Tab = (typeof TABS)[number][0];
const CRUD = ['read', 'create', 'update', 'delete'];
const CRUD_WORDS: Record<string, string> = { read: 'see', create: 'add', update: 'change', delete: 'remove' };

// ------------------------------------------------------------------ privileges in words
// "Tries at an exam: hand in (their own)"
function words(v: AccessView, key: string): string {
  if (key === 'pages.read') return 'Open the pages';
  const m = /^([a-z0-9-]+)\.([a-z0-9-]+)(?::(own|any))?$/.exec(key);
  if (!m) return key;
  const r = v.resources.find((x) => x.key === m[1]);
  const act = CRUD_WORDS[m[2]!] ?? v.actions.find((a) => a.key === m[2])?.label.toLowerCase() ?? m[2];
  return `${r?.label ?? m[1]}: ${act}${m[3] === 'own' ? ' (their own)' : m[3] === 'any' ? " (anyone's)" : ''}`;
}
// the declared privileges under their resource's heading
function byResource(v: AccessView): [string, string[]][] {
  const out: [string, string[]][] = [['Pages', ['pages.read']]];
  for (const r of v.resources) out.push([r.label, v.privileges.filter((p) => p.startsWith(`${r.key}.`))]);
  return out;
}

export function Access() {
  const { id, tab: rawTab } = useParams<{ id: string; tab?: string }>();
  const tab: Tab = TABS.some(([t]) => t === rawTab) ? rawTab as Tab : 'roles';
  const q = useApi<AccessView>(`/api/access/${id}`);
  const v = q.data;
  usePageTitle(v ? `Access to ${v.area.path}` : 'Access');
  const run = useAction();
  const dialogs = useDialogs();
  const post = (path: string, b: Record<string, unknown> = {}) => api<{ ok: true; result: unknown }>(`/api/access/${id}/${path}`, b);

  if (!v) return <Page title="Access"><Loading /></Page>;
  const locked = !v.canEditRoles;
  // a route's Access page (lfdln, docs/roles-plan.md step 6) says route, and goes back to Hosts
  const route = v.area.kind === 'route';
  const place = route ? 'route' : 'folder';

  const header = (
    <div className="flex flex-wrap items-center gap-2">
      <Badge>{v.set.label}</Badge>
      {v.set.builtIn && <Badge variant="outline"><Lock className="size-3" />built in</Badge>}
      {v.set.fromManifest && <Badge variant="outline"><FileJson className="size-3" />from pammy-panel.json</Badge>}
    </div>
  );

  return (
    <Page title={`Access to ${v.area.path}`} actions={<Button asChild variant="outline"><Link to={route ? '/hosts' : '/protected-folders'}><ArrowLeft />{route ? 'Hosts' : 'Protected folders'}</Link></Button>}
      intro={route
        ? <>Who may do what at this address. Each person gets one role here; a role is a set of privileges, and what the route shows is told them.<GuideLink topic="access">How accounts and access work</GuideLink></>
        : <>Who may do what in this folder. Each person gets one role here; a role is a set of privileges. <InlineLink to="/help/protected-folders">How protected folders work</InlineLink></>}>
      {!v.rolesOn ? (
        <Section title="Roles and privileges are switched off">
          <p>{route ? 'Everyone let in here is its Member.' : 'Everyone who can open this folder is its Member, as on the Protected folders page.'} To give people different roles here, turn on "Roles and privileges on the Access page" in <InlineLink to="/visitor-settings">Settings, Visitors</InlineLink>.</p>
        </Section>
      ) : (
        <>
          <Section title={`The roles this ${place} uses`} intro={v.set.builtIn
            ? `These are built in, so they can’t be changed here. Copy them to give this ${place} roles of its own; everyone keeps the role they have.`
            : `This ${place}’s own roles${v.set.copiedFrom ? `, copied from “${v.set.copiedFrom}”` : ''}.${v.set.fromManifest ? ` Its privileges come from the ${route ? 'app’s' : 'folder’s'} pammy-panel.json; the roles, groups and people are yours to change.` : ''}`}
            action={header}>
            <div className="flex flex-wrap gap-2">
              {v.set.builtIn && (
                <ActionButton icon={Copy} onClick={() => run(() => post('copy'), `This ${place} has roles of its own now. Change them below.`)}>Copy to change</ActionButton>
              )}
              {!v.set.builtIn && (
                <ActionButton variant="outline" icon={Undo2} onClick={async () => {
                  if (!await dialogs.confirm({
                    title: 'Back to the built-in roles?', action: 'Go back', danger: true,
                    body: `Everything changed here goes. People keep a role of the same name in "${v.set.copiedFrom ?? 'Protected folder'}"; anyone else is left with no role here.`,
                  })) return;
                  await run(() => post('reset'), (r) => {
                    const lost = (r.result as { lost: string[] }).lost;
                    return `Back on the built-in roles.${lost.length ? ` No role here now: ${lost.join(', ')}.` : ''}`;
                  });
                }}>Back to the built-in roles</ActionButton>
              )}
              <ActionButton variant="outline" icon={RotateCcw} onClick={() => run(() => post('manifest'), (r) => {
                const x = r.result as { lost: string[]; removedRoles: { label: string }[] };
                return `Read pammy-panel.json.${x.removedRoles.length ? ` Roles gone: ${x.removedRoles.map((y) => y.label).join(', ')}.` : ''}${x.lost.length ? ` No role here now: ${x.lost.join(', ')}.` : ''}`;
              })}>{v.set.fromManifest ? 'Read pammy-panel.json again' : 'Read pammy-panel.json'}</ActionButton>
            </div>
          </Section>

          <nav aria-label="Access" className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-card p-1 sm:flex">
            {TABS.map(([t, label]) => (
              <NavLink key={t} to={`/access/${v.area.id}/${t}`} aria-current={tab === t ? 'page' : undefined}
                className={cn('rounded-md px-3 py-2 text-center text-sm font-medium sm:flex-1', tab === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}>
                {label}
              </NavLink>
            ))}
          </nav>

          {tab === 'roles' && <RolesTab v={v} locked={locked} post={post} />}
          {tab === 'people' && <PeopleTab v={v} post={post} />}
          {tab === 'groups' && <GroupsTab v={v} locked={locked} post={post} />}
          {tab === 'privileges' && <PrivilegesTab v={v} post={post} />}
        </>
      )}
    </Page>
  );
}

type Post = (path: string, b?: Record<string, unknown>) => Promise<{ ok: true; result: unknown }>;

// ------------------------------------------------------------------ a checklist of privileges, in words
function PrivilegeChecklist({ v, chosen, onChange, disabled, covered = new Set() }:
  { v: AccessView; chosen: Set<string>; onChange: (next: Set<string>) => void; disabled: boolean; covered?: Set<string> }) {
  const uid = useId();
  return (
    <div className="space-y-3">
      {byResource(v).filter(([, ps]) => ps.length).map(([heading, ps]) => (
        <fieldset key={heading}>
          <legend className="mb-1 text-sm font-semibold">{heading}</legend>
          <div className="grid sm:grid-cols-2">
            {ps.map((p) => {
              const id = `${uid}-${p}`;
              const fromGroup = covered.has(p);
              return (
                <div key={p} className="flex items-center gap-2.5 py-1">
                  <Checkbox id={id} checked={fromGroup || chosen.has(p)} disabled={disabled || fromGroup} onCheckedChange={(c) => {
                    const next = new Set(chosen);
                    if (c === true) next.add(p); else next.delete(p);
                    onChange(next);
                  }} />
                  <label htmlFor={id} className="cursor-pointer text-[0.9375rem]">{words(v, p)}{fromGroup && <span className="text-muted-foreground"> (from a group)</span>}</label>
                </div>
              );
            })}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

const summary = (v: AccessView, all: string[]) => all.length ? `Can: ${all.map((p) => words(v, p).toLowerCase()).join('; ')}.` : 'Can do nothing here.';

// ------------------------------------------------------------------ Roles
function RolesTab({ v, locked, post }: { v: AccessView; locked: boolean; post: Post }) {
  const run = useAction();
  const uid = useId();
  const [newLabel, setNewLabel] = useState('');
  const [combined, setCombined] = useState(false);
  const slot = v.roles.find((r) => r.slot === 'not-signed-in')!;
  const plain = v.roles.filter((r) => !r.slot);
  const signedIn = v.roles.find((r) => r.id === v.signedInRoleId);
  return (
    <>
      <Section title="Everyone" intro="The two fixed places: people who aren't signed in, and people who are signed in but haven't been given a role here.">
        <div className="space-y-5">
          <div>
            <h3 className="mb-1 font-semibold">Not signed in</h3>
            <p className="mb-2 text-sm text-muted-foreground">Anyone at all, signed in or not. Ticking "Open the pages" opens it here to everyone.</p>
            <RoleEditor v={v} role={slot} locked={locked} post={post} />
          </div>
          <div>
            <Field label={<span className="font-semibold">Signed in, no role given here</span>} htmlFor={`${uid}-si`}
              hint={signedIn ? `Anyone signed in counts as ${signedIn.label}, unless they've been given another role.` : 'Anyone signed in without a role here gets only what "Not signed in" gets.'}>
              <NativeSelect id={`${uid}-si`} disabled={locked} value={v.signedInRoleId ?? ''} className="max-w-sm"
                onChange={(e) => run(() => post('signed-in', { roleId: e.target.value === '' ? null : Number(e.target.value) }), 'Saved.')}>
                <option value="">Nothing more</option>
                {plain.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </NativeSelect>
            </Field>
          </div>
        </div>
      </Section>

      <Section plain title="Roles">
        <div className="space-y-3">
          {plain.map((r) => (
            <Collapsible key={r.id} summary={<span className="flex flex-wrap items-center gap-2"><strong>{r.label}</strong>
              {r.parts.length > 0 && <Badge variant="outline">combined</Badge>}
              <span className="text-sm text-muted-foreground">{r.people} {r.people === 1 ? 'person' : 'people'}</span></span>}>
              <p className="mb-3 text-sm text-muted-foreground">{summary(v, r.all)}</p>
              <RoleEditor v={v} role={r} locked={locked} post={post} />
            </Collapsible>
          ))}
        </div>
      </Section>

      {!locked && (
        <Section title="Add a role">
          <form className="flex flex-wrap items-end gap-3" onSubmit={async (e) => {
            e.preventDefault();
            if (combined) return notify('Make the role, then pick the roles it combines.');
            const r = await run(() => post('role', { label: newLabel }), `Added "${newLabel}". Choose what it can do below.`);
            if (r) setNewLabel('');
          }}>
            <Field label="Its name" htmlFor={`${uid}-new`}><Input id={`${uid}-new`} maxLength={80} value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="e.g. Teacher" /></Field>
            <label className="flex items-center gap-2 pb-2 text-sm"><Switch checked={combined} onCheckedChange={setCombined} />Made of other roles</label>
            <Button type="submit" disabled={!newLabel.trim() || combined}><Plus />Add</Button>
          </form>
          {combined && <p className="mt-2 text-sm text-muted-foreground">Add it as a plain role first, then open it and pick the roles it's made of.</p>}
        </Section>
      )}

      <NeverTogether v={v} locked={locked} post={post} />
    </>
  );
}

function RoleEditor({ v, role, locked, post }: { v: AccessView; role: AccessRole; locked: boolean; post: Post }) {
  const run = useAction();
  const dialogs = useDialogs();
  const uid = useId();
  const [label, setLabel] = useState(role.label);
  const [groups, setGroups] = useState(new Set(role.groups));
  const [extra, setExtra] = useState(new Set(role.privileges));
  const [parts, setParts] = useState(new Set(role.parts));
  const [kind, setKind] = useState<'plain' | 'combined'>(role.parts.length ? 'combined' : 'plain');
  const [moveTo, setMoveTo] = useState<string>('');
  const covered = new Set(v.groups.filter((g) => groups.has(g.id)).flatMap((g) => g.privileges));
  const others = v.roles.filter((r) => !r.slot && r.id !== role.id && r.parts.length === 0);
  const save = () => run(() => post('role', kind === 'combined'
    ? { id: role.id, label: role.slot ? undefined : label, parts: [...parts] }
    : { id: role.id, label: role.slot ? undefined : label, groups: [...groups], privileges: [...extra].filter((p) => !covered.has(p)) }), `Saved "${label}".`);

  return (
    <div className="space-y-4">
      {!role.slot && (
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Name" htmlFor={`${uid}-l`}><Input id={`${uid}-l`} maxLength={80} value={label} disabled={locked} onChange={(e) => setLabel(e.target.value)} /></Field>
          {!locked && others.length >= 2 && (
            <label className="flex items-center gap-2 pb-2 text-sm"><Switch checked={kind === 'combined'} onCheckedChange={(c) => setKind(c ? 'combined' : 'plain')} />Made of other roles</label>
          )}
        </div>
      )}
      {kind === 'combined' ? (
        <fieldset>
          <legend className="mb-1 text-sm font-semibold">Made of</legend>
          <div className="grid sm:grid-cols-2">
            {others.map((r) => (
              <label key={r.id} className="flex items-center gap-2.5 py-1">
                <Checkbox checked={parts.has(r.id)} disabled={locked} onCheckedChange={(c) => { const n = new Set(parts); if (c === true) n.add(r.id); else n.delete(r.id); setParts(n); }} />
                {r.label}
              </label>
            ))}
          </div>
        </fieldset>
      ) : (
        <>
          {v.groups.length > 0 && (
            <fieldset>
              <legend className="mb-1 text-sm font-semibold">Groups</legend>
              <div className="grid sm:grid-cols-2">
                {v.groups.map((g) => (
                  <label key={g.id} className="flex items-center gap-2.5 py-1">
                    <Switch checked={groups.has(g.id)} disabled={locked} onCheckedChange={(c) => { const n = new Set(groups); if (c) n.add(g.id); else n.delete(g.id); setGroups(n); }} />
                    {g.label}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <div>
            <h4 className="mb-1 text-sm font-semibold">{v.groups.length ? 'Extra privileges' : 'Privileges'}</h4>
            <PrivilegeChecklist v={v} chosen={extra} covered={covered} onChange={setExtra} disabled={locked} />
          </div>
        </>
      )}
      {!locked && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <ActionButton icon={Save} onClick={save}>Save</ActionButton>
          {!role.slot && (
            <>
              <span className="ml-auto flex flex-wrap items-center gap-2 text-sm">
                {role.people > 0 && (
                  <NativeSelect aria-label="Move its people to" value={moveTo} onChange={(e) => setMoveTo(e.target.value)} className="w-auto">
                    <option value="">Its people: no role</option>
                    {v.roles.filter((r) => !r.slot && r.id !== role.id).map((r) => <option key={r.id} value={r.id}>Its people: move to {r.label}</option>)}
                  </NativeSelect>
                )}
                <ActionButton variant="danger" icon={Trash2} onClick={async () => {
                  if (!await dialogs.confirm({ title: `Remove "${role.label}"?`, action: 'Remove', danger: true,
                    body: role.people ? `${role.people} ${role.people === 1 ? 'person has' : 'people have'} it: ${moveTo ? 'they move to the role you chose' : 'they will have no role here'}.` : 'Nobody has it.' })) return;
                  await run(() => post('role-delete', { id: role.id, moveTo: moveTo ? Number(moveTo) : null }), `Removed "${role.label}".`);
                }}>Remove</ActionButton>
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function NeverTogether({ v, locked, post }: { v: AccessView; locked: boolean; post: Post }) {
  const run = useAction();
  const plain = v.roles.filter((r) => !r.slot && r.parts.length === 0);
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const name = (id: number) => v.roles.find((r) => r.id === id)?.label ?? '?';
  if (plain.length < 2 && !v.neverTogether.length) return null;
  return (
    <Section title="Never together" intro="Roles that can never be combined into one.">
      {v.neverTogether.length === 0 ? <p className="text-muted-foreground">None.</p> : (
        <ul className="mb-3 space-y-1">
          {v.neverTogether.map((n) => (
            <li key={`${n.a}-${n.b}`} className="flex flex-wrap items-center gap-2">
              {name(n.a)} and {name(n.b)}
              {n.fromManifest ? <Badge variant="outline"><Lock className="size-3" />from pammy-panel.json</Badge>
                : !locked && <Button size="sm" variant="ghost" onClick={() => run(() => post('never', { a: n.a, b: n.b, never: false }), 'Saved.')}>Take off</Button>}
            </li>
          ))}
        </ul>
      )}
      {!locked && plain.length >= 2 && (
        <div className="flex flex-wrap items-end gap-2">
          <NativeSelect aria-label="First role" value={a} onChange={(e) => setA(e.target.value)} className="w-auto"><option value="">Choose a role</option>{plain.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</NativeSelect>
          <NativeSelect aria-label="Second role" value={b} onChange={(e) => setB(e.target.value)} className="w-auto"><option value="">Choose a role</option>{plain.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</NativeSelect>
          <Button disabled={!a || !b || a === b} onClick={() => run(() => post('never', { a: Number(a), b: Number(b), never: true }), 'Saved.')}><Plus />Keep apart</Button>
        </div>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ People
function PeopleTab({ v, post }: { v: AccessView; post: Post }) {
  const run = useAction();
  const uid = useId();
  const roleOf = new Map(v.members.map((m) => [m.visitorId, m.roleId]));
  const signedIn = v.roles.find((r) => r.id === v.signedInRoleId);
  const plain = v.roles.filter((r) => !r.slot);
  return (
    <Section title="People" intro={signedIn ? `Anyone signed in counts as ${signedIn.label} here, unless they're given another role.` : 'Only the people given a role here can do anything more than someone not signed in.'}>
      {v.people.length === 0 ? <p className="text-muted-foreground">Nobody yet. Add people on the <InlineLink to="/people">People</InlineLink> page.</p> : (
        <ul className="divide-y divide-border">
          {v.people.map((p) => (
            <li key={p.id} className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:justify-between">
              <label htmlFor={`${uid}-${p.id}`} className="[overflow-wrap:anywhere]">{personLabel(p)}{!p.active && <Badge variant="warn" className="ml-2">switched off</Badge>}</label>
              <NativeSelect id={`${uid}-${p.id}`} value={roleOf.get(p.id) ?? ''} className="sm:max-w-xs"
                onChange={(e) => run(() => post('person', { visitorId: p.id, roleId: e.target.value === '' ? null : Number(e.target.value) }),
                  e.target.value === '' ? `${p.username} has no role here now.` : `${p.username} is ${plain.find((r) => r.id === Number(e.target.value))?.label} here now.`)}>
                <option value="">{signedIn ? `No role given (counts as ${signedIn.label})` : 'No role'}</option>
                {plain.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </NativeSelect>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ Groups
function GroupsTab({ v, locked, post }: { v: AccessView; locked: boolean; post: Post }) {
  const run = useAction();
  const uid = useId();
  const [label, setLabel] = useState('');
  return (
    <>
      <Section plain title="Groups" intro="Privileges in bundles with plain names, to switch on for a role in one go.">
        {v.groups.length === 0 ? <p className="text-muted-foreground">No groups.</p> : (
          <div className="space-y-3">{v.groups.map((g) => <GroupEditor key={g.id} v={v} g={g} locked={locked} post={post} />)}</div>
        )}
      </Section>
      {!locked && (
        <Section title="Add a group">
          <form className="flex flex-wrap items-end gap-3" onSubmit={async (e) => {
            e.preventDefault();
            if (await run(() => post('group', { label, privileges: [] }), `Added "${label}". Tick its privileges below.`)) setLabel('');
          }}>
            <Field label="Its name" htmlFor={`${uid}-g`}><Input id={`${uid}-g`} maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Keep progress" /></Field>
            <Button type="submit" disabled={!label.trim()}><Plus />Add</Button>
          </form>
        </Section>
      )}
    </>
  );
}

function GroupEditor({ v, g, locked, post }: { v: AccessView; g: AccessGroup; locked: boolean; post: Post }) {
  const run = useAction();
  const dialogs = useDialogs();
  const [chosen, setChosen] = useState(new Set(g.privileges));
  const [label, setLabel] = useState(g.label);
  const uid = useId();
  const usedBy = v.roles.filter((r) => r.groups.includes(g.id));
  return (
    <Collapsible summary={<span className="flex flex-wrap items-center gap-2"><strong>{g.label}</strong><span className="text-sm text-muted-foreground">{g.privileges.length} privileges{usedBy.length ? `, in ${usedBy.map((r) => r.label).join(', ')}` : ''}</span></span>}>
      <div className="space-y-4">
        {!locked && <Field label="Name" htmlFor={`${uid}-l`}><Input id={`${uid}-l`} maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} className="max-w-sm" /></Field>}
        <PrivilegeChecklist v={v} chosen={chosen} onChange={setChosen} disabled={locked} />
        {!locked && (
          <div className="flex flex-wrap gap-2 border-t border-border pt-3">
            <ActionButton icon={Save} onClick={() => run(() => post('group', { id: g.id, label, privileges: [...chosen] }), `Saved "${label}".`)}>Save</ActionButton>
            <ActionButton variant="danger" icon={Trash2} onClick={async () => {
              if (!await dialogs.confirm({ title: `Remove the group "${g.label}"?`, action: 'Remove', danger: true,
                body: usedBy.length ? `${usedBy.map((r) => r.label).join(', ')} will lose what it gave them.` : 'No role uses it.' })) return;
              await run(() => post('group-delete', { id: g.id }), `Removed "${g.label}".`);
            }}>Remove</ActionButton>
          </div>
        )}
      </div>
    </Collapsible>
  );
}

// ------------------------------------------------------------------ Privileges
function PrivilegesTab({ v, post }: { v: AccessView; post: Post }) {
  const editable = v.canEditPrivileges;
  return (
    <>
      <Section plain title="Privileges" intro={v.set.fromManifest
        ? 'These come from pammy-panel.json, so they’re changed there, then read again.'
        : editable ? 'What people can be allowed to do here. "Open the pages" is always there; add a resource for anything a program here keeps (notes, bookings, scores...).'
          : 'Built in. Copy the roles to add privileges of your own.'}>
        <ul className="divide-y divide-border rounded-lg border border-border bg-card">
          <li className="px-4 py-3"><strong>Pages</strong><p className="text-sm text-muted-foreground">Open the pages (built in)</p></li>
          {v.resources.map((r) => (
            <li key={r.key} className="px-4 py-3">
              {editable ? <ResourceEditor v={v} existing={r} post={post} /> : (
                <>
                  <strong>{r.label}</strong> <code className="text-xs text-muted-foreground">{r.key}</code>
                  <p className="text-sm text-muted-foreground">{v.privileges.filter((p) => p.startsWith(`${r.key}.`)).map((p) => words(v, p)).join('; ')}</p>
                </>
              )}
            </li>
          ))}
        </ul>
      </Section>
      {editable && <Section title="Add a resource"><ResourceEditor v={v} post={post} /></Section>}
    </>
  );
}

function ResourceEditor({ v, existing, post }: { v: AccessView; existing?: AccessView['resources'][number]; post: Post }) {
  const run = useAction();
  const dialogs = useDialogs();
  const uid = useId();
  const [label, setLabel] = useState(existing?.label ?? '');
  const [key, setKey] = useState(existing?.key ?? '');
  const [owned, setOwned] = useState(existing?.owned ?? false);
  const [acts, setActs] = useState(new Set(existing?.actions ?? ['read']));
  const [own, setOwn] = useState((existing?.actions ?? []).filter((a) => !CRUD.includes(a)).join(', '));
  const autoKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 32);
  const ownList = own.split(',').map((x) => autoKey(x.trim())).filter(Boolean);
  const actionLabels = Object.fromEntries(own.split(',').map((x) => x.trim()).filter(Boolean).map((x) => [autoKey(x), x]));
  const save = async () => {
    const r = await run(() => post('resource', { key: key || autoKey(label), label, owned, actions: [...CRUD.filter((a) => acts.has(a)), ...ownList], actionLabels }),
      `Saved "${label}".`);
    if (r && !existing) { setLabel(''); setKey(''); setOwn(''); setActs(new Set(['read'])); setOwned(false); }
  };
  const field = (children: ReactNode) => <div className="flex flex-wrap items-center gap-x-4 gap-y-1">{children}</div>;
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="flex flex-wrap gap-3">
        <Field label="Name" htmlFor={`${uid}-l`}><Input id={`${uid}-l`} maxLength={80} value={label} onChange={(e) => { setLabel(e.target.value); if (!existing) setKey(autoKey(e.target.value)); }} placeholder="e.g. Notes" /></Field>
        <Field label="Key (what the program checks)" htmlFor={`${uid}-k`}><Input id={`${uid}-k`} maxLength={32} value={key} disabled={!!existing} onChange={(e) => setKey(autoKey(e.target.value))} placeholder="notes" /></Field>
      </div>
      {field(CRUD.map((a) => (
        <label key={a} className="flex items-center gap-2 text-sm">
          <Checkbox checked={acts.has(a)} onCheckedChange={(c) => { const n = new Set(acts); if (c === true) n.add(a); else n.delete(a); setActs(n); }} />{CRUD_WORDS[a]} ({a})
        </label>
      )))}
      <Field label="Its own actions (optional, separated by commas)" htmlFor={`${uid}-o`}><Input id={`${uid}-o`} value={own} onChange={(e) => setOwn(e.target.value)} placeholder="e.g. publish, grade" /></Field>
      <label className="flex items-center gap-2 text-sm"><Switch checked={owned} onCheckedChange={setOwned} />Has an owner (so a privilege can be for their own, or anyone's)</label>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!label.trim()}><Save />{existing ? 'Save' : 'Add'}</Button>
        {existing && (
          <ActionButton variant="danger" icon={Trash2} onClick={async () => {
            if (!await dialogs.confirm({ title: `Remove "${existing.label}"?`, action: 'Remove', danger: true, body: 'Its privileges go too. A role or group still using one of them has to let it go first.' })) return;
            await run(() => post('resource-delete', { key: existing.key }), `Removed "${existing.label}".`);
          }}>Remove</ActionButton>
        )}
      </div>
    </form>
  );
}
