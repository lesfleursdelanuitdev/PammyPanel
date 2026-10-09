// Your databases (docs/databases-plan.md 5): the dashboard over her own MariaDB
// and Postgres. The panel never opens them itself -- everything here goes through
// /api/databases, which asks the database helper.
//
// Three kinds of card, and the difference matters to her:
//   - looked after by the panel     -> she can rename the app, stop, or delete
//   - hers, made somewhere else     -> "Look after this one" (adopt)
//   - the server's own              -> one quiet line, never touched
import { Database, FolderPlus, HandHeart, Plus, Settings2, Sparkles, Table2, Trash2, Unplug } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { ActionButton, Empty, Facts, Field, GuideLink, InlineLink, List, Loading, Page, Row, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { Input } from '@panel/core/web/components/ui/input';
import { NativeSelect } from '@panel/core/web/components/ui/native-select';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { api, formatTime } from '@panel/core/web/lib/api';
import { formatSize } from '@panel/core/web/lib/format';
import { cap, guideTo, isOn, W } from '@panel/core/web/lib/site';
import { notify } from '@panel/core/web/lib/status';
import type { DatabaseCard, DatabaseEngine, DatabasesData } from '../lib/types';

const address = (d: DatabaseCard) => `/api/databases/${d.engine}/${d.name}`;

// what a card says under its name
function facts(d: DatabaseCard) {
  if (d.live === false) return ['it is not on the server any more'];
  if (d.live === null) return [`${d.engineName} did not answer, so the panel cannot see it just now`];
  return [
    d.engineName,
    d.tables === null ? null : d.tables === 1 ? '1 table' : `${d.tables} tables`,
    d.bytes === null ? null : formatSize(d.bytes),
    d.adoptedAt ? `looked after since ${formatTime(d.adoptedAt)}` : null,
  ];
}

export default function Databases() {
  usePageTitle('Your databases');
  const list = useApi<DatabasesData>('/api/databases');
  // how long last night's copy is kept: lfdln's Settings > Backups (docs/lfdln-mariadb-plan.md B4);
  // pammy.org's are Pamela's own script's seven days
  const keep = useApi<{ days: number }>(isOn('services') ? '/api/backups' : null);
  const keptFor = keep.data ? `${keep.data.days} days` : 'seven days';
  const run = useAction();
  const dialogs = useDialogs();
  const [making, setMaking] = useState(false);
  const [name, setName] = useState('');
  const [engine, setEngine] = useState<DatabaseEngine>('postgres');
  const [appName, setAppName] = useState('');

  const all = list.data?.databases ?? [];
  const mine = all.filter((d) => d.managed);
  const theirs = all.filter((d) => !d.managed && d.live === true && !d.system && !d.protectedName && !d.appOwned);
  // the apps' own (lfdln, docs/phase8-plan.md P8-9): looked inside, never changed
  const apps = all.filter((d) => !d.managed && d.live === true && d.appOwned);
  // a site with one kind of database server asks nothing about kinds
  const kinds = (list.data?.engines ?? []).map((e) => e.engine);
  const oneKind = kinds.length === 1;
  // her own `pamela` database: hers to work in, never made or deleted here
  const hers = all.filter((d) => !d.managed && d.live === true && !d.system && d.protectedName);
  const system = all.filter((d) => d.system);
  const down = (list.data?.engines ?? []).filter((e) => !e.ok);

  const create = async () => {
    if (!name.trim()) return notify('Type a name for the database.', 'error');
    const r = await run(() => api(`/api/databases`, { engine: oneKind ? kinds[0] : engine, name: name.trim(), displayName: appName.trim() }),
      `${name.trim()} is ready.`);
    if (!r) return;
    setName('');
    setAppName('');
    setMaking(false);
  };

  const adopt = (d: DatabaseCard) =>
    run(() => api(`${address(d)}/adopt`, {}), `The panel is looking after ${d.name} now.`);

  const rename = async (d: DatabaseCard) => {
    const next = await dialogs.prompt({
      title: `What should the ${W.app.one} for ${d.name} be called?`,
      label: `${cap(W.app.one)} name`,
      value: d.displayName,
      hint: 'This is the name you will see in the menu, like "Blog". Leave it empty if you have not decided.',
      action: 'Save',
    });
    if (next === null) return;
    await run(() => api(`${address(d)}/settings`, { displayName: next }), 'Saved.');
  };

  const unmanage = async (d: DatabaseCard) => {
    const ok = await dialogs.confirm({
      title: `Stop looking after ${d.name}?`,
      body: 'The database and everything in it stays exactly as it is. It just disappears from this page, and you can pick it up again later.',
      action: 'Stop looking after it',
    });
    if (!ok) return;
    await run(() => api(`${address(d)}/unmanage`, {}), `${d.name} is no longer on this page.`);
  };

  const remove = async (d: DatabaseCard) => {
    // D20: the name typed out, and the server also wants a passkey tap just now
    const typed = await dialogs.prompt({
      title: `Delete ${d.name}?`,
      body: <>This deletes the database and <strong>everything in it</strong>. Last night's backup is still there for {keptFor}, but getting it back is a job for momolig. Type <code>{d.name}</code> to be sure.</>,
      label: `Type ${d.name}`,
      placeholder: d.name,
      action: 'Delete it',
    });
    if (typed === null) return;
    if (typed.trim() !== d.name) return notify('That is not the same name, so nothing was deleted.', 'error');
    await run(() => api(`${address(d)}/delete`, { confirm: d.name }), `${d.name} is gone.`);
  };

  return (
    <Page title="Your databases"
      intro={<>{W.explain && 'A database is a tidy place for lists: recipes, guests, posts. '}You can make one here, design its tables, and the panel will build pages for it.<GuideLink topic="databases">About databases</GuideLink>{guideTo('databases') && guideTo('form-or-database') && ' ·'}<GuideLink topic="form-or-database">Form or database?</GuideLink></>}
      actions={<Button onClick={() => setMaking((m) => !m)}><Plus />New database</Button>}>

      {down.map((e) => (
        <Section key={e.engine} title={`${e.engine === 'postgres' ? 'Postgres' : 'MariaDB'} is not answering`} className="border-destructive/40">
          <p className="text-sm">{e.message}</p>
        </Section>
      ))}

      {making && (
        <Section title="New database" intro={oneKind ? 'A name, and the panel makes it.' : 'A name, and which kind. You cannot change the kind later, so if you are not sure, Postgres is the one to pick.'}>
          <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); void create(); }}>
            <Field label="Name" htmlFor="db-name"
              hint="Lowercase letters, digits and underscores, starting with a letter — like family_recipes. This is the name programs use.">
              <Input id="db-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={63} autoComplete="off" spellCheck={false} />
            </Field>
            {!oneKind && (
              <Field label="Which kind" htmlFor="db-engine">
                <NativeSelect id="db-engine" value={engine} onChange={(e) => setEngine(e.target.value as DatabaseEngine)}>
                  <option value="postgres">Postgres — the one to pick if you are not sure</option>
                  <option value="mariadb">MariaDB — works with anything made for MySQL</option>
                </NativeSelect>
              </Field>
            )}
            <Field label={`What the ${W.app.one} will be called`} htmlFor="db-app" hint="Optional, and you can change it whenever you like.">
              <Input id="db-app" value={appName} onChange={(e) => setAppName(e.target.value)} maxLength={60} placeholder="Blog" autoComplete="off" />
            </Field>
            <div><Button type="submit"><FolderPlus />Make the database</Button></div>
          </form>
        </Section>
      )}

      <Section flush title="Looked after by the panel">
        {!list.data ? <Loading /> : (
          <List label="Your databases">
            {mine.length === 0 && <Empty>None yet. Click "New database" to make your first one.</Empty>}
            {mine.map((d) => (
              <Row key={`${d.engine}:${d.name}`} title={d.name}
                badges={<>
                  {d.example && <Badge variant="outline">example</Badge>}
                  {d.appOwned && <Badge variant="outline">{d.projectOwned ? "a project's" : "a service's"}: read only</Badge>}
                  {d.displayName && <Badge variant="outline">{d.displayName}</Badge>}
                  {d.live === false && <Badge variant="danger">gone</Badge>}
                  {d.live === null && <Badge variant="warn">can't see it</Badge>}
                </>}
                meta={<Facts items={facts(d)} />}
                actions={<div className="flex flex-wrap gap-2">
                  {d.live === true && (
                    <Button variant="outline" size="sm" asChild>
                      <Link to={`/databases/${d.engine}/${d.name}`}><Table2 />Tables</Link>
                    </Button>
                  )}
                  {d.example ? (
                    // the panel's own: used, not renamed or deleted -- its page has Reset
                    <Button variant="outline" size="sm" asChild>
                      <Link to={d.example.startsWith('tutorial-') ? '/databases/tutorial-examples' : `/databases/examples/${d.example}`}><Sparkles />The example</Link>
                    </Button>
                  ) : d.appOwned ? (
                    // an app's: looked inside only -- no pages of the panel's, never deleted
                    <ActionButton icon={Unplug} onClick={() => unmanage(d)}>Stop looking after</ActionButton>
                  ) : <>
                    <ActionButton icon={Settings2} onClick={() => rename(d)}>{cap(W.app.one)} name</ActionButton>
                    <ActionButton icon={Unplug} onClick={() => unmanage(d)}>Stop looking after</ActionButton>
                    {d.live === true && <ActionButton icon={Trash2} onClick={() => remove(d)}>Delete</ActionButton>}
                  </>}
                </div>} />
            ))}
          </List>
        )}
      </Section>

      {(theirs.length > 0 || hers.length > 0) && (
        <Section flush title="Databases you made yourself"
          intro="These are on your servers but the panel is not looking after them. Pick one up and it can design its tables and build pages for it.">
          <List label="Databases you made yourself">
            {[...hers, ...theirs].map((d) => (
              <Row key={`${d.engine}:${d.name}`} title={d.name}
                badges={d.protectedName ? <Badge variant="outline">came with your account</Badge> : undefined}
                meta={<Facts items={facts(d)} />}
                actions={<ActionButton icon={HandHeart} onClick={() => adopt(d)}>Look after this one</ActionButton>} />
            ))}
          </List>
        </Section>
      )}

      {apps.length > 0 && (
        <Section flush title="The services' databases"
          intro="Each belongs to a service, which looks after it. Pick one up to look at its tables and records; nothing here changes them.">
          <List label="The services' databases">
            {apps.map((d) => (
              <Row key={`${d.engine}:${d.name}`} title={d.name}
                badges={<Badge variant="outline">a service's: read only</Badge>}
                meta={<Facts items={facts(d)} />}
                actions={<ActionButton icon={HandHeart} onClick={() => adopt(d)}>Look inside</ActionButton>} />
            ))}
          </List>
        </Section>
      )}

      {system.length > 0 && (
        <Section title="The servers' own" plain>
          <p className="text-sm text-muted-foreground">
            <Database className="mr-1.5 inline size-4 align-[-0.2em]" aria-hidden />
            Each server keeps a few databases of its own ({system.map((d) => d.name).join(', ')}). The panel leaves those alone.
          </p>
        </Section>
      )}
    </Page>
  );
}
