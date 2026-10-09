// Connecting two tables, in her words (docs/databases-plan.md 7). Shared by the
// Fields page and the canvas, because there is one drawing and it would be odd
// for the two surfaces to ask the question differently.
//
// The panel works the change out, not this component: a many-to-many means
// inventing a table, and every refusal is a sentence from
// src/studio/relationships.ts rather than a rule written twice.
import { Link2, Link2Off, Plus } from 'lucide-react';
import { useState } from 'react';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { Empty, Facts, Field, List, Row, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@panel/core/web/components/ui/dialog';
import { Input } from '@panel/core/web/components/ui/input';
import { NativeSelect } from '@panel/core/web/components/ui/native-select';
import { useAction } from '@panel/core/web/hooks/useAction';
import { api } from '@panel/core/web/lib/api';
import {
  ON_DELETE_HINTS, ON_DELETE_NAMES,
  type OnDelete, type Relationship, type RelationshipKind, type SchemaData, type SchemaTable,
} from '../lib/schema';

// What can be pointed AT: a field that says which row is meant. Anything else
// could not answer "which user?", and the panel would refuse it anyway -- so it
// is not offered in the first place.
const identifying = (t: SchemaTable): string[] => {
  const out = t.primaryKey.length === 1 ? [t.primaryKey[0]!] : [];
  for (const u of t.uniques) if (u.columns.length === 1 && !out.includes(u.columns[0]!)) out.push(u.columns[0]!);
  return out;
};

const KIND_LINES: { kind: RelationshipKind; label: (a: string, b: string) => string; hint: string }[] = [
  { kind: 'one-to-many', label: (a, b) => `One ${a} has many ${b}`, hint: 'The usual one. Each row over there belongs to one row here.' },
  { kind: 'one-to-one', label: (a, b) => `One ${a} has one ${b}`, hint: 'A pair. Each row here has at most one row over there, and the other way round.' },
  { kind: 'many-to-many', label: (a, b) => `Many ${a} have many ${b}`, hint: 'Both ways at once, like recipes and their tags. A small connecting table is made to hold the pairs.' },
];

// A window rather than a form under the list, so it opens where she is -- from
// the Connections list, or from a table's menu on the canvas, which is a long
// way above the list.
export function ConnectDialog({ base, d, table, open, onClose }:
  { base: string; d: SchemaData; table?: string; open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent wide>
        {/* mounted afresh each time it opens, so it starts from the table she asked from */}
        {open && <ConnectForm base={base} d={d} table={table} onDone={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function ConnectForm({ base, d, table, onDone }:
  { base: string; d: SchemaData; table?: string; onDone: () => void }) {
  const run = useAction();
  const tables = d.draft.tables;
  // the focused table is the one holding the connection, which is what she is
  // usually looking at when she asks for this
  const [toTable, setToTable] = useState(table ?? tables[0]?.name ?? '');
  const [fromTable, setFromTable] = useState(tables.find((t) => t.name !== toTable)?.name ?? '');
  const [fromColumn, setFromColumn] = useState('');
  const [kind, setKind] = useState<RelationshipKind>('one-to-many');
  const [onDelete, setOnDelete] = useState<OnDelete>('restrict');
  const [field, setField] = useState('');
  const [junction, setJunction] = useState('');

  const from = tables.find((t) => t.name === fromTable);
  const keys = from ? identifying(from) : [];
  const column = fromColumn && keys.includes(fromColumn) ? fromColumn : keys[0] ?? '';
  const chosen = KIND_LINES.find((k) => k.kind === kind)!;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await run(() => api(`${base}/schema/relationship`, {
      from: { table: fromTable, column },
      to: { table: toTable, column: kind === 'many-to-many' ? undefined : field.trim() || undefined },
      kind, onDelete,
      junction: kind === 'many-to-many' ? junction.trim() || undefined : undefined,
    }), 'The connection is in your drawing. Nothing has changed in the database yet.');
    if (r) onDone();
  };

  return (
    <form className="contents" onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>Connect two tables</DialogTitle>
        <DialogDescription>Nothing happens to the database until you apply it — this only draws the connection.</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Which table does the connection point at?" htmlFor="rel-from"
            hint="The one that already exists on its own — an author, a customer, a recipe.">
            <NativeSelect id="rel-from" value={fromTable} onChange={(e) => { setFromTable(e.target.value); setFromColumn(''); }}>
              {tables.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
            </NativeSelect>
          </Field>
          <Field label="Which field says which row?" htmlFor="rel-from-col"
            hint={keys.length ? 'Usually id.' : 'This table has no field that can say which row is meant. Give it a primary key, or mark a field must-be-different.'}>
            <NativeSelect id="rel-from-col" value={column} disabled={!keys.length}
              onChange={(e) => setFromColumn(e.target.value)}>
              {keys.map((k) => <option key={k} value={k}>{k}</option>)}
              {!keys.length && <option value="">nothing to point at</option>}
            </NativeSelect>
          </Field>
          <Field label="Which table holds the connection?" htmlFor="rel-to"
            hint="The many side — the posts, the orders, the bookings.">
            <NativeSelect id="rel-to" value={toTable} onChange={(e) => setToTable(e.target.value)}>
              {tables.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
            </NativeSelect>
          </Field>
          <Field label="What kind of connection?" htmlFor="rel-kind" hint={chosen.hint}>
            <NativeSelect id="rel-kind" value={kind} onChange={(e) => setKind(e.target.value as RelationshipKind)}>
              {KIND_LINES.map((k) => (
                <option key={k.kind} value={k.kind}>{k.label(fromTable || 'this', toTable || 'that')}</option>
              ))}
            </NativeSelect>
          </Field>
          {kind === 'many-to-many' ? (
            <Field label="What should the connecting table be called?" htmlFor="rel-junction"
              hint="Leave it empty and the panel picks a name. It only holds the pairs, and it stays out of your way.">
              <Input id="rel-junction" value={junction} onChange={(e) => setJunction(e.target.value)}
                placeholder="chosen for you" autoComplete="off" spellCheck={false} maxLength={63} />
            </Field>
          ) : (
            <Field label="What should the new field be called?" htmlFor="rel-field"
              hint="Leave it empty and the panel names it after what it points at. An existing field of the right kind can be used instead.">
              <Input id="rel-field" value={field} onChange={(e) => setField(e.target.value)}
                placeholder="chosen for you" autoComplete="off" spellCheck={false} maxLength={63} />
            </Field>
          )}
          <Field label={`When a ${fromTable || 'row'} is deleted`} htmlFor="rel-ondelete" hint={ON_DELETE_HINTS[onDelete]}>
            <NativeSelect id="rel-ondelete" value={onDelete} onChange={(e) => setOnDelete(e.target.value as OnDelete)}>
              {(Object.keys(ON_DELETE_NAMES) as OnDelete[]).map((k) => (
                <option key={k} value={k}>{ON_DELETE_NAMES[k]}</option>
              ))}
            </NativeSelect>
          </Field>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>Cancel</Button>
        <Button type="submit" disabled={!keys.length || !fromTable || !toTable}><Link2 />Draw the connection</Button>
      </DialogFooter>
    </form>
  );
}

// The relationships in the drawing, with the one thing about each of them she is
// most likely to want to change.
export function Relationships({ base, d, table, title = 'Connections' }:
  { base: string; d: SchemaData; table?: string; title?: string }) {
  const run = useAction();
  const dialogs = useDialogs();
  const [making, setMaking] = useState(false);

  // on a table's own page, only the ones it is part of
  const all = d.relationships;
  const mine = table ? all.filter((r) => r.from === table || r.to === table || r.junction === table) : all;

  // its own call: drawing the relationship again would be refused as a
  // duplicate, and rebuilding it would throw away a connecting table
  const change = (r: Relationship, onDelete: OnDelete) =>
    run(() => api(`${base}/schema/relationship/on-delete`, { at: r.at, onDelete }), 'Saved.');

  const remove = async (r: Relationship) => {
    const ok = await dialogs.confirm({
      title: r.junction ? `Disconnect ${r.from} and ${r.to}?` : `Remove the connection to ${r.from}?`,
      body: r.junction
        ? `This goes on the list of changes. When you apply it, the connecting table ${r.junction} is deleted — and anything recorded in it goes with it.`
        : `This goes on the list of changes. The field ${r.to}.${r.toColumns[0]} stays and keeps what is in it; only the connection is removed.`,
      action: 'Add it to the changes',
      danger: !!r.junction,
    });
    if (!ok) return;
    await run(() => api(`${base}/schema/relationship/delete`, { at: r.at }),
      `${r.from} and ${r.to} are no longer connected in your drawing.`);
  };

  return <>
    <Section flush title={title}
      intro={mine.length ? 'A connection says how two tables belong together. Changing one here only changes the drawing.' : undefined}
      action={<Button variant="outline" size="sm" onClick={() => setMaking(true)} disabled={d.draft.tables.length < 1}>
        <Plus />Connect tables
      </Button>}>
      <List label="Connections">
        {mine.length === 0 && (
          <Empty>
            Nothing is connected yet. A connection is how a post knows who wrote it, or how a recipe knows its tags.
          </Empty>
        )}
        {mine.map((r) => (
          <Row key={r.at.map((x) => `${x.table}:${x.foreignKey}`).join('+')} title={r.line}
            badges={<>
              {r.junction && <Badge variant="outline">through {r.junction}</Badge>}
              {r.kind === 'one-to-one' && <Badge variant="outline">one of each</Badge>}
            </>}
            meta={<Facts items={[
              r.kind === 'many-to-many'
                ? `${r.from}.${r.fromColumns[0]} and ${r.to}.${r.toColumns[0]}, paired up in ${r.junction}`
                : `${r.to}.${r.toColumns[0]} points at ${r.from}.${r.fromColumns[0]}`,
            ]} />}
            actions={<div className="flex flex-wrap items-end gap-3">
              <Field label={`When a ${r.from} is deleted`} htmlFor={`od-${r.at[0]!.foreignKey}`} className="w-60">
                <NativeSelect id={`od-${r.at[0]!.foreignKey}`} value={r.onDelete}
                  onChange={(e) => void change(r, e.target.value as OnDelete)}>
                  {(Object.keys(ON_DELETE_NAMES) as OnDelete[]).map((k) => (
                    <option key={k} value={k}>{ON_DELETE_NAMES[k]}</option>
                  ))}
                </NativeSelect>
              </Field>
              <Button variant="outline" size="sm" onClick={() => void remove(r)}><Link2Off />Disconnect</Button>
            </div>} />
        ))}
      </List>
    </Section>
    <ConnectDialog base={base} d={d} table={table} open={making} onClose={() => setMaking(false)} />
  </>;
}
