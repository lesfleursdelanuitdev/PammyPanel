// One database login, and which of her databases it may use
// (docs/databases-plan.md 9). Four kinds of access, in her words, and a radio
// row per database rather than a privilege matrix: the plan is explicit that v1
// does not show her SELECT, INSERT, UPDATE, DELETE.
//
// What each row says comes from the engine's real grants, read back every time
// this page loads. "Set outside the panel" is not a failure -- it means someone
// granted something in psql or HeidiSQL that is not one of the four shapes, and
// the panel says so instead of guessing which one it is nearest to.
import { KeyRound, Trash2, UserLock } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { NewPassword } from '../components/db-password';
import { ActionButton, Empty, Facts, Field, List, Loading, Page, Row, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { NativeSelect } from '@panel/core/web/components/ui/native-select';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { api, formatTime } from '@panel/core/web/lib/api';
import { notify } from '@panel/core/web/lib/status';
import type { AccessRole, DatabaseEngine, DbUserData, GrantedRole } from '../lib/types';

// The four, weakest first, exactly as docs/databases-plan.md 9 words them.
const ROLES: { value: AccessRole | 'none'; label: string; hint: string }[] = [
  { value: 'none', label: 'No access', hint: 'It cannot reach this database at all.' },
  { value: 'read', label: 'Read only', hint: 'Can look at the information, and change nothing.' },
  { value: 'write', label: 'Read & write', hint: 'Can look at the information, and add, change and remove it.' },
  { value: 'structure', label: 'Structure editor', hint: 'All of that, and can add and change tables as well.' },
  { value: 'admin', label: 'Administrator', hint: 'Everything inside this database. It still cannot delete the database itself.' },
];

const hintFor = (role: GrantedRole | 'none') =>
  role === 'custom'
    ? 'Someone gave this login access with a database program rather than here. The panel will not guess what it adds up to; picking one of the others replaces it.'
    : ROLES.find((r) => r.value === role)?.hint ?? '';

export default function DatabaseUser() {
  const { engine, user } = useParams<{ engine: DatabaseEngine; user: string }>();
  usePageTitle(user ?? 'Database user');
  const base = `/api/databases/users/${engine}/${user}`;
  const data = useApi<DbUserData>(base);
  const run = useAction();
  const dialogs = useDialogs();
  const navigate = useNavigate();
  const [made, setMade] = useState<string | null>(null);

  const u = data.data?.user;
  const databases = data.data?.databases ?? [];
  const access = data.data?.access ?? [];
  const roleOn = (name: string): GrantedRole | 'none' => access.find((a) => a.database === name)?.role ?? 'none';

  const setRole = async (database: string, role: string) => {
    await run(() => api(`${base}/access`, { database, role }),
      role === 'none' ? `${user} can no longer reach ${database}.` : `${user} can now use ${database}.`);
  };

  const rename = async () => {
    const next = await dialogs.prompt({
      title: `What is ${user} for?`,
      label: 'Note',
      value: u?.note ?? '',
      hint: 'Only you see this. A line to remind you later, like “the recipes website”.',
      action: 'Save',
    });
    if (next === null) return;
    await run(() => api(`${base}/note`, { note: next }), 'Saved.');
  };

  const reset = async () => {
    const ok = await dialogs.confirm({
      title: `Give ${user} a new password?`,
      body: 'Anything still connecting with the old password stops working straight away, so change the program too. The old one cannot be looked up — it is not kept anywhere.',
      action: 'Make a new password',
    });
    if (!ok) return;
    const r = await run(() => api<{ password: string }>(`${base}/password`, {}), 'Done.');
    if (r) setMade(r.password);
  };

  const remove = async () => {
    const typed = await dialogs.prompt({
      title: `Remove the login ${user}?`,
      body: <>Anything signing in as <code>{user}</code> stops working. The databases it could reach, and everything in them, are left exactly as they are. Type <code>{user}</code> to be sure.</>,
      label: `Type ${user}`,
      placeholder: user,
      action: 'Remove it',
    });
    if (typed === null) return;
    if (typed.trim() !== user) return notify('That is not the same name, so nothing was removed.', 'error');
    const gone = await run(() => api(`${base}/delete`, { confirm: user }));
    if (gone) {
      // kept through the move back to the list: the shell clears old news on a
      // new page, and the answer to what she just pressed is not old news
      notify(`${user} is gone.`, 'ok', true);
      void navigate('/databases/users');
    }
  };

  return (
    <Page title={user ?? ''}
      intro={<><Link className="text-primary underline-offset-4 hover:underline" to="/databases/users">Database users</Link>{u ? ` · ${u.engineName}` : ''}</>}>

      {!data.data || !u ? <Loading /> : <>
        {made && <NewPassword title={`The new password for ${u.name}`} password={made} engine={u.engine} user={u.name} onDone={() => setMade(null)} />}

        <Section title="This login">
          <Facts items={[
            u.note || 'No note yet',
            u.createdAt ? `made ${formatTime(u.createdAt)}` : 'made outside the panel',
            u.host ? `signs in from ${u.host}` : null,
          ]} />
          {u.serverWide && (
            <p className="mt-2 text-sm">
              <Badge variant="warn" className="mr-2">reaches everything</Badge>
              This login has been given the run of the whole server, so the four kinds of access below do not describe what it can do. That was not done here.
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <ActionButton icon={UserLock} onClick={rename}>What it is for</ActionButton>
            <ActionButton icon={KeyRound} onClick={reset}>New password</ActionButton>
            <ActionButton icon={Trash2} onClick={remove}>Remove this login</ActionButton>
          </div>
        </Section>

        <Section flush title="Which databases it may use"
          intro={`Only databases on ${u.engineName}: a login belongs to one server, and cannot be given access to the other.`}>
          <List label="Databases">
            {databases.length === 0 && <Empty>There are no databases on this server yet.</Empty>}
            {databases.map((d) => {
              const role = roleOn(d.name);
              return (
                <Row key={d.name} title={d.name}
                  badges={<>
                    {d.displayName && <Badge variant="outline">{d.displayName}</Badge>}
                    {role === 'custom' && <Badge variant="warn">set outside the panel</Badge>}
                    {role !== 'none' && role !== 'custom' && <Badge variant="outline">{ROLES.find((r) => r.value === role)?.label}</Badge>}
                  </>}
                  meta={<Facts items={[hintFor(role)]} />}
                  actions={
                    <Field label="What it may do" htmlFor={`role-${d.name}`} className="min-w-56">
                      <NativeSelect id={`role-${d.name}`} value={role === 'custom' ? '' : role}
                        onChange={(e) => void setRole(d.name, e.target.value)}>
                        {role === 'custom' && <option value="" disabled>Set outside the panel</option>}
                        {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                      </NativeSelect>
                    </Field>
                  } />
              );
            })}
          </List>
        </Section>
      </>}
    </Page>
  );
}
