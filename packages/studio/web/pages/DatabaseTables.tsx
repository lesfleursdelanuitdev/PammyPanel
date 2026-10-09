// The tables inside one database (docs/databases-plan.md 10, "the Tables list is
// the conventional editor"). The canvas arrives later and is a second surface on
// this same drawing, not a second editor.
//
// The habit the whole page is built around: **nothing here changes her
// database.** Adding a table, renaming a field, taking one off -- all of it is a
// drawing, saved as a draft, until she presses Apply on Review. That is why
// every button here is quiet and Review is the one that asks anything of her.
import { ArrowRight, Boxes, Database, Eye, Plus, RotateCcw, Shapes, Table2, Trash2 } from 'lucide-react';
import { AppOwnedNote } from '../components/app-owned';
import { Link, useParams } from 'react-router';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { Empty, Facts, InlineLink, List, Loading, Page, Row, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { api, plural } from '@panel/core/web/lib/api';
import { W } from '@panel/core/web/lib/site';
import { notify } from '@panel/core/web/lib/status';
import {
  drawnLine, isNew, newIdentProblem, nextTableName, pointingAt, starterTable, typeLabel, withoutTable,
  type DatabaseEngine, type SchemaData, type SchemaTable,
} from '../lib/schema';

// One line under a table's name: what is in it, in her words.
const facts = (t: SchemaTable) => [
  plural(t.columns.length, 'field'),
  t.primaryKey.length ? `key: ${t.primaryKey.join(', ')}` : 'no primary key',
  t.foreignKeys.length ? plural(t.foreignKeys.length, 'relationship') : null,
  t.uniques.length ? `${plural(t.uniques.length, 'rule')} about what must be different` : null,
];

export default function DatabaseTables() {
  const { engine, name } = useParams<{ engine: DatabaseEngine; name: string }>();
  usePageTitle(name ?? 'Tables');
  const base = `/api/databases/${engine}/${name}`;
  const data = useApi<SchemaData>(`${base}/schema`);
  const run = useAction();
  const dialogs = useDialogs();

  const d = data.data;
  const tables = d?.draft.tables ?? [];
  const changes = d?.plan.changes ?? [];

  // Every edit on this page is the same move: change the drawing, send the whole
  // thing back. One document, so there is nothing to keep in step.
  const save = (draft: SchemaData['draft'], done?: string) =>
    run(() => api(`${base}/schema/draft`, { draft, basedOn: d!.currentHash }), done);

  const addTable = async () => {
    if (!d) return;
    const suggested = nextTableName(tables);
    const typed = await dialogs.prompt({
      title: 'What is the new table called?',
      label: 'Table name',
      value: suggested,
      hint: 'Lowercase letters, digits and underscores — usually the plural of what it holds, like recipes or guests.',
      action: 'Add it',
    });
    if (typed === null) return;
    const clean = typed.trim();
    const problem = newIdentProblem(clean, 'table');
    if (problem) return notify(problem, 'error');
    if (tables.some((t) => t.name === clean)) return notify(`There is already a table called ${clean}.`, 'error');
    await save({ ...d.draft, tables: [...tables, starterTable(clean)] },
      `${clean} is in your drawing. Nothing has changed in the database yet.`);
  };

  const removeTable = async (t: SchemaTable) => {
    if (!d) return;
    const brandNew = isNew(d.current, t);
    const pointing = pointingAt(tables, t.name);
    const ok = await dialogs.confirm({
      title: brandNew ? `Take ${t.name} out of the drawing?` : `Remove the table ${t.name}?`,
      body: <>
        <p>{brandNew
          ? 'It was never made, so there is nothing in it to lose.'
          : <>This goes on the list of changes. Nothing happens until you apply them — and when you do, <strong>every row in {t.name} is deleted</strong>.</>}</p>
        {pointing.length > 0 && (
          <p>What points at it stops pointing at it: {pointing.map((p) => `${p.table}.${p.columns.join(', ')}`).join('; ')}. Those fields stay.</p>
        )}
      </>,
      action: brandNew ? 'Take it out' : 'Add it to the changes',
    });
    if (!ok) return;
    // the connections to it go with it: the engine will not drop a table
    // something still points at
    await save({ ...d.draft, tables: withoutTable(tables, t.name) },
      brandNew ? `${t.name} is out of the drawing.` : `${t.name} is on the list of changes.`);
  };

  const discard = async () => {
    const ok = await dialogs.confirm({
      title: 'Throw the drawing away?',
      body: 'The database goes back to being exactly what it is now, and your unapplied changes are gone. Nothing in the database itself is touched.',
      action: 'Throw it away',
    });
    if (!ok) return;
    await run(() => api(`${base}/schema/discard`, {}), 'Back to what the database really has.');
  };

  return (
    <Page title={name ?? ''} wide
      intro={<>
        <InlineLink to="/databases">Your databases</InlineLink>
        {d ? ` · ${d.engine === 'postgres' ? 'Postgres' : 'MariaDB'}` : ''}
        {W.explain && ' · A table is a list: one row per recipe, per guest, per post.'}
      </>}
      actions={<div className="flex flex-wrap gap-2">
        <Button variant="outline" asChild disabled={!d}>
          <Link to={`/databases/${engine}/${name}/app`}><Boxes />The {W.app.one}</Link>
        </Button>
        <Button variant="outline" asChild disabled={!d}>
          <Link to={`/databases/${engine}/${name}/canvas`}><Shapes />Canvas</Link>
        </Button>
        <Button onClick={addTable} disabled={!d}><Plus />Add table</Button>
      </div>}>
      <AppOwnedNote engine={engine} name={name} />

      {!d ? <Loading /> : <>
        {d.drift && (
          <Section title="This database changed somewhere else" className="border-destructive/40">
            <p className="text-sm">
              Something changed {name} after you started drawing — in another window, or in a database program.
              Your drawing is still here, but it was worked out from how the database used to be.
            </p>
            <p className="mt-3">
              <Button variant="outline" onClick={discard}><RotateCcw />Start again from the database</Button>
            </p>
          </Section>
        )}

        {changes.length > 0 && (
          <Section title="Not applied yet"
            intro={drawnLine(changes.length, d.app)}
            action={<div className="flex flex-wrap gap-2">
              <Button asChild><Link to={`/databases/${engine}/${name}/review`}><Eye />Review changes<ArrowRight /></Link></Button>
              <Button variant="outline" onClick={discard}><RotateCcw />Throw them away</Button>
            </div>}>
            <List label="Changes">
              {changes.slice(0, 6).map((c, i) => (
                <Row key={i} title={c.line}
                  badges={c.destructive ? <Badge variant="danger">deletes something</Badge> : undefined} />
              ))}
              {changes.length > 6 && <Row title={`…and ${changes.length - 6} more`} />}
            </List>
          </Section>
        )}

        <Section flush title="Tables">
          <List label="Tables">
            {tables.length === 0 && (
              <Empty>Nothing in here yet. "Add table" starts one — with an id field already in it, because every list needs a way to tell one row from another.</Empty>
            )}
            {tables.map((t) => (
              <Row key={t.name} title={t.name}
                badges={<>
                  {isNew(d.current, t) && <Badge variant="outline">not made yet</Badge>}
                  {t.was && t.was !== t.name && <Badge variant="outline">was {t.was}</Badge>}
                </>}
                meta={<>
                  <Facts items={facts(t)} />
                  <p className="mt-1 truncate text-sm text-muted-foreground">
                    {t.columns.slice(0, 6).map((c) => `${c.name} (${typeLabel(c)})`).join(' · ')}
                    {t.columns.length > 6 ? ' · …' : ''}
                  </p>
                </>}
                actions={<div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" asChild>
                    <Link to={`/databases/${engine}/${name}/tables/${t.name}`}><Table2 />Fields</Link>
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void removeTable(t)}><Trash2 />Remove</Button>
                </div>} />
            ))}
          </List>
        </Section>

        {d.notes.length > 0 && (
          <Section title="Also in this database" plain>
            {d.notes.map((n, i) => (
              <p key={i} className="text-sm text-muted-foreground">
                <Database className="mr-1.5 inline size-4 align-[-0.2em]" aria-hidden />{n}
              </p>
            ))}
          </Section>
        )}
      </>}
    </Page>
  );
}
