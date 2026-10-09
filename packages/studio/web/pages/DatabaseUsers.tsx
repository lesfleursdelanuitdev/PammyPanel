// Database users (docs/databases-plan.md 9): logins on one engine, for programs
// that speak SQL -- her app, a backup job, a database client on her laptop.
//
// These are not panel accounts and not API keys, and the page says so plainly,
// because the three are easy to muddle and only one of them can change rows
// whether or not the generated API is switched on.
//
// Grouped by engine, because a login on Postgres and a login of the same name on
// MariaDB are two different things and always will be.
import { Plus, ServerCog, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Empty, Facts, Field, GuideLink, InlineLink, List, Loading, Page, Row, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { Input } from '@panel/core/web/components/ui/input';
import { NativeSelect } from '@panel/core/web/components/ui/native-select';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { api, formatTime } from '@panel/core/web/lib/api';
import { SITE, W } from '@panel/core/web/lib/site';
import { notify } from '@panel/core/web/lib/status';
import type { DatabaseEngine, DbUserCard, DbUsersData } from '../lib/types';
import { NewPassword } from '../components/db-password';

const ENGINES: { value: DatabaseEngine; label: string }[] = [
  { value: 'postgres', label: 'Postgres' },
  { value: 'mariadb', label: 'MariaDB' },
];

function facts(u: DbUserCard) {
  if (u.live === false) return ['it is not on the server any more'];
  if (u.live === null) return [`${u.engineName} did not answer, so the panel cannot see it just now`];
  return [
    u.note || null,
    u.createdAt ? `made ${formatTime(u.createdAt)}` : null,
  ];
}

export default function DatabaseUsers() {
  usePageTitle('Database users');
  const list = useApi<DbUsersData>('/api/databases/users');
  const run = useAction();
  const [making, setMaking] = useState(false);
  const [name, setName] = useState('');
  const [engine, setEngine] = useState<DatabaseEngine>('postgres');
  const [note, setNote] = useState('');
  // shown once, then gone: nothing anywhere keeps a copy of it
  const [made, setMade] = useState<{ user: string; engine: DatabaseEngine; password: string } | null>(null);

  const all = list.data?.users ?? [];
  const down = (list.data?.engines ?? []).filter((e) => !e.ok);

  const create = async () => {
    if (!name.trim()) return notify('Type a name for the login.', 'error');
    const r = await run(
      () => api<{ password: string }>('/api/databases/users', { engine, name: name.trim(), note: note.trim() }),
      `${name.trim()} is ready.`);
    if (!r) return;
    setMade({ user: name.trim(), engine, password: r.password });
    setName('');
    setNote('');
    setMaking(false);
  };

  return (
    <Page title="Database users"
      intro={<>{W.explain && <>A database user is a login a <strong>program</strong> uses to reach one of your databases &mdash; a program on the server, or one on your computer. </>}It is not a way of signing in to this panel, and it is not an API key.<GuideLink topic="database-users">About databases</GuideLink></>}
      actions={<Button onClick={() => setMaking((m) => !m)}><Plus />New login</Button>}>

      {down.map((e) => (
        <Section key={e.engine} title={`${e.engine === 'postgres' ? 'Postgres' : 'MariaDB'} is not answering`} className="border-destructive/40">
          <p className="text-sm">{e.message}</p>
        </Section>
      ))}

      {made && (
        <NewPassword title={`The password for ${made.user}`} password={made.password}
          onDone={() => setMade(null)}
          engine={made.engine} user={made.user} />
      )}

      {making && (
        <Section title="New login" intro="It starts off able to reach nothing at all. Once it exists, open it and say which databases it may use.">
          <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); void create(); }}>
            <Field label="Name" htmlFor="u-name"
              hint={SITE.studioUserPrefix
                ? `Starts with ${SITE.studioUserPrefix}, then lowercase letters, digits and underscores — like ${SITE.studioUserPrefix}recipes. This is the name the program signs in with.`
                : 'Lowercase letters, digits and underscores, starting with a letter — like recipes_app. This is the name the program signs in with.'}>
              <Input id="u-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={63} autoComplete="off" spellCheck={false} />
            </Field>
            <Field label="Which server" htmlFor="u-engine"
              hint="A login belongs to one server. The same name on the other server would be a different login.">
              <NativeSelect id="u-engine" value={engine} onChange={(e) => setEngine(e.target.value as DatabaseEngine)}>
                {ENGINES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </NativeSelect>
            </Field>
            <Field label="What it is for" htmlFor="u-note" hint="Optional. A line to remind you later, like “the recipes website”.">
              <Input id="u-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="the recipes website" autoComplete="off" />
            </Field>
            <div><Button type="submit"><UserPlus />Make the login</Button></div>
          </form>
        </Section>
      )}

      {!list.data ? <Loading /> : ENGINES.map((o) => {
        const here = all.filter((u) => u.engine === o.value);
        const yours = here.filter((u) => !u.reserved);
        const theirs = here.filter((u) => u.reserved);
        return (
          <Section key={o.value} flush title={o.label}>
            <List label={`${o.label} logins`}>
              {yours.length === 0 && <Empty>No logins on this server yet.</Empty>}
              {yours.map((u) => (
                <Row key={u.name} title={<Link className="hover:underline" to={`/databases/users/${u.engine}/${u.name}`}>{u.name}</Link>}
                  badges={<>
                    {u.serverWide && <Badge variant="warn">reaches everything</Badge>}
                    {u.live === false && <Badge variant="danger">gone</Badge>}
                    {u.live === null && <Badge variant="warn">can't see it</Badge>}
                  </>}
                  meta={<Facts items={facts(u)} />}
                  actions={u.live === true
                    ? <Button asChild size="sm" variant="outline">
                        <Link to={`/databases/users/${u.engine}/${u.name}`}><ServerCog />Which databases</Link>
                      </Button>
                    : undefined} />
              ))}
            </List>
            {theirs.length > 0 && (
              <p className="px-1 pt-3 text-sm text-muted-foreground">
                This server also has the logins it came with ({theirs.map((u) => u.name).join(', ')}). The panel leaves those alone.
              </p>
            )}
          </Section>
        );
      })}
    </Page>
  );
}
