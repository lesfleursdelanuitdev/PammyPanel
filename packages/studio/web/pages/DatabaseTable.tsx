// One table's fields (docs/databases-plan.md 6 and 10). A row per field: what it
// is called, what kind of thing goes in it, whether it has to be filled in, what
// it starts out as.
//
// Two things are deliberately not editable here, and both say so on the page
// rather than being silently missing:
//
//  * **The primary key.** It is settled when the table is made. Changing one on
//    a table with rows in it is not one statement on either engine, and a
//    half-done one is the worst thing that can happen to her data (S16).
//  * **A field the panel did not make.** An adopted database is full of types
//    the panel does not offer, and a field with one is shown with the engine's
//    own words for it and left exactly as it is.
import { KeyRound, Plus, Trash2, Undo2 } from 'lucide-react';
import { AppOwnedNote } from '../components/app-owned';
import { useParams } from 'react-router';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { Relationships } from '../components/relationships';
import { Empty, Facts, Field, InlineLink, List, Loading, Page, Row, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { Checkbox } from '@panel/core/web/components/ui/checkbox';
import { Input } from '@panel/core/web/components/ui/input';
import { NativeSelect } from '@panel/core/web/components/ui/native-select';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { api } from '@panel/core/web/lib/api';
import { notify } from '@panel/core/web/lib/status';
import {
  canAlter, canBeNow, COLUMN_TYPES, DEFAULT_TEXT_RE, defaultChoices, defaultLabel, isKey, isNew, newIdentProblem, starterColumn,
  TYPE_HINTS, TYPE_NAMES, typeLabel, whyNotAlterable,
  type ColumnDefault, type ColumnType, type DatabaseEngine, type SchemaColumn, type SchemaData, type SchemaTable,
} from '../lib/schema';

const defaultValueOf = (d: ColumnDefault | null | undefined): string => {
  if (!d) return '';
  if (d.kind === 'text') return d.value;
  if (d.kind === 'number') return String(d.value);
  return '';
};

const defaultKindOf = (d: ColumnDefault | null | undefined): string => {
  if (!d || d.kind === 'none') return 'none';
  if (d.kind === 'boolean') return d.value ? 'yes' : 'no';
  if (d.kind === 'now') return 'now';
  return 'text';
};

export default function DatabaseTable() {
  const { engine, name, table } = useParams<{ engine: DatabaseEngine; name: string; table: string }>();
  usePageTitle(table ?? 'Table');
  const base = `/api/databases/${engine}/${name}`;
  const data = useApi<SchemaData>(`${base}/schema`);
  const run = useAction();
  const dialogs = useDialogs();

  const d = data.data;
  const t = d?.draft.tables.find((x) => x.name === table);

  const saveTable = (next: SchemaTable, done?: string) =>
    run(() => api(`${base}/schema/draft`, {
      draft: { ...d!.draft, tables: d!.draft.tables.map((x) => (x.name === table ? next : x)) },
      basedOn: d!.currentHash,
    }), done);

  const setColumn = (column: SchemaColumn, patch: Partial<SchemaColumn>, done?: string) => {
    if (!t) return;
    const next = { ...column, ...patch };
    return saveTable({
      ...t,
      columns: t.columns.map((c) => (c.name === column.name ? next : c)),
      // the key follows a rename: it names fields, and she renamed one
      primaryKey: t.primaryKey.map((k) => (k === column.name ? next.name : k)),
      uniques: t.uniques.map((u) => ({ ...u, columns: u.columns.map((k) => (k === column.name ? next.name : k)) })),
    }, done);
  };

  const addField = async () => {
    if (!t) return;
    const typed = await dialogs.prompt({
      title: `What is the new field in ${t.name} called?`,
      label: 'Field name',
      hint: 'Lowercase letters, digits and underscores — like title, price, or posted_on.',
      action: 'Add it',
    });
    if (typed === null) return;
    const clean = typed.trim();
    const problem = newIdentProblem(clean, 'field');
    if (problem) return notify(problem, 'error');
    if (t.columns.some((c) => c.name === clean)) return notify(`${t.name} already has a field called ${clean}.`, 'error');
    await saveTable({ ...t, columns: [...t.columns, starterColumn(clean)] }, `${clean} is in your drawing.`);
  };

  const rename = async (c: SchemaColumn) => {
    if (!t) return;
    const typed = await dialogs.prompt({
      title: `What should ${c.name} be called?`,
      label: 'Field name',
      value: c.name,
      hint: 'Anything already asking for this field by name will have to be changed too.',
      action: 'Rename it',
    });
    if (typed === null) return;
    const clean = typed.trim();
    if (clean === c.name) return;
    const problem = newIdentProblem(clean, 'field');
    if (problem) return notify(problem, 'error');
    if (t.columns.some((x) => x.name === clean)) return notify(`${t.name} already has a field called ${clean}.`, 'error');
    // `was` is what tells the panel this is a rename and not a field thrown away
    // and another one made. A field that was only ever in the drawing has no
    // old name to remember.
    const wasAlready = c.was ?? (isNew(d!.current, t) ? undefined : c.name);
    await setColumn(c, { name: clean, was: wasAlready === clean ? undefined : wasAlready }, `It is called ${clean} in your drawing.`);
  };

  const removeField = async (c: SchemaColumn) => {
    if (!t) return;
    const live = !isNew(d!.current, t) && !!d!.current.tables.find((x) => x.name === (t.was ?? t.name))?.columns.some((x) => x.name === (c.was ?? c.name));
    const ok = await dialogs.confirm({
      title: live ? `Remove ${c.name} from ${t.name}?` : `Take ${c.name} out of the drawing?`,
      body: live
        ? <>This goes on the list of changes. When you apply it, <strong>whatever is in {c.name} is deleted</strong> from every row.</>
        : 'It was never made, so there is nothing in it to lose.',
      action: live ? 'Add it to the changes' : 'Take it out',
    });
    if (!ok) return;
    await saveTable({
      ...t,
      columns: t.columns.filter((x) => x.name !== c.name),
      primaryKey: t.primaryKey.filter((k) => k !== c.name),
      uniques: t.uniques.filter((u) => !u.columns.includes(c.name)),
      foreignKeys: t.foreignKeys.filter((f) => !f.columns.includes(c.name)),
    }, live ? `${c.name} is on the list of changes.` : `${c.name} is out of the drawing.`);
  };

  const setType = (c: SchemaColumn, type: ColumnType) => {
    const patch: Partial<SchemaColumn> = { type };
    if (type === 'short_text') patch.length = c.length ?? 255;
    if (type === 'decimal') { patch.precision = c.precision ?? 12; patch.scale = c.scale ?? 2; }
    // a starting value that no longer makes sense for the new kind of field
    if (c.default?.kind === 'now' && !canBeNow(type)) patch.default = null;
    return setColumn(c, patch);
  };

  const setDefault = (c: SchemaColumn, choice: string) => {
    const map: Record<string, ColumnDefault | null> = {
      none: null,
      now: { kind: 'now' },
      yes: { kind: 'boolean', value: true },
      no: { kind: 'boolean', value: false },
    };
    if (choice !== 'text') return setColumn(c, { default: map[choice] ?? null });
    const value = defaultValueOf(c.default);
    return setColumn(c, {
      default: c.type === 'integer' || c.type === 'decimal'
        ? { kind: 'number', value: Number(value) || 0 }
        : { kind: 'text', value },
    });
  };

  const setDefaultValue = (c: SchemaColumn, value: string) => {
    if (c.type === 'integer' || c.type === 'decimal') {
      if (value !== '' && !Number.isFinite(Number(value))) return notify('That is not a number.', 'error');
      return setColumn(c, { default: { kind: 'number', value: Number(value) || 0 } });
    }
    if (!DEFAULT_TEXT_RE.test(value)) {
      return notify('A starting value can be up to 100 letters, digits and ordinary punctuation. Quotes and backslashes are not allowed.', 'error');
    }
    return setColumn(c, { default: { kind: 'text', value } });
  };

  const toggleUnique = (c: SchemaColumn, on: boolean) => {
    if (!t) return;
    const covers = (u: { columns: string[] }) => u.columns.length === 1 && u.columns[0] === c.name;
    return saveTable({
      ...t,
      uniques: on
        ? [...t.uniques, { name: `${t.name}_${c.name}_key`.slice(0, 63), columns: [c.name] }]
        : t.uniques.filter((u) => !covers(u)),
    });
  };

  return (
    <Page title={table ?? ''} wide
      intro={<>
        <InlineLink to="/databases">Your databases</InlineLink>{' · '}
        <InlineLink to={`/databases/${engine}/${name}`}>{name}</InlineLink>{' · '}
        A field is one column of the list: the title of a recipe, the date of a party.
      </>}
      actions={<Button onClick={addField} disabled={!t}><Plus />Add field</Button>}>
      <AppOwnedNote engine={engine} name={name} />

      {!d ? <Loading /> : !t ? (
        <Section title="Not in the drawing">
          <p className="text-sm">There is no table called {table} here. It may have been removed. <InlineLink to={`/databases/${engine}/${name}`}>Back to the tables</InlineLink></p>
        </Section>
      ) : <>
        <Section flush title="Fields"
          intro={isNew(d.current, t)
            ? 'This table has not been made yet, so everything here is still a drawing. Review and apply it when it looks right.'
            : 'Changes here go on a list. Nothing happens to the database until you apply them.'}>
          <List label="Fields">
            {t.columns.length === 0 && <Empty>No fields yet.</Empty>}
            {t.columns.map((c) => {
              const key = isKey(t, c);
              const frozen = !canAlter(c);
              const why = whyNotAlterable(c);
              const unique = t.uniques.some((u) => u.columns.length === 1 && u.columns[0] === c.name);
              const kind = defaultKindOf(c.default);
              return (
                <Row key={c.name} title={c.name}
                  badges={<>
                    {key && <Badge variant="outline"><KeyRound className="mr-1 size-3" aria-hidden />primary key</Badge>}
                    {c.identity && <Badge variant="outline">fills itself in</Badge>}
                    {c.was && c.was !== c.name && <Badge variant="outline">was {c.was}</Badge>}
                    {frozen && <Badge variant="warn">left as it is</Badge>}
                  </>}
                  meta={<Facts items={[
                    typeLabel(c),
                    c.required ? 'has to be filled in' : 'can be left empty',
                    unique ? 'must be different in every row' : null,
                    defaultLabel(c.default) ? `starts out as ${defaultLabel(c.default)}` : null,
                    why,
                  ]} />}
                  actions={<div className="flex flex-wrap items-end gap-3">
                    {!key && !frozen && <>
                      <Field label="What goes in it" htmlFor={`type-${c.name}`} className="min-w-44">
                        <NativeSelect id={`type-${c.name}`} value={c.type}
                          onChange={(e) => void setType(c, e.target.value as ColumnType)}>
                          {COLUMN_TYPES.map((k) => <option key={k} value={k} title={TYPE_HINTS[k]}>{TYPE_NAMES[k]}</option>)}
                        </NativeSelect>
                      </Field>
                      {c.type === 'short_text' && (
                        <Field label="How long" htmlFor={`len-${c.name}`} className="w-24">
                          <Input id={`len-${c.name}`} type="number" min={1} max={4000} defaultValue={c.length ?? 255}
                            onBlur={(e) => void setColumn(c, { length: Math.min(4000, Math.max(1, Number(e.target.value) || 255)) })} />
                        </Field>
                      )}
                      <Field label="Starts out as" htmlFor={`def-${c.name}`} className="min-w-40">
                        <NativeSelect id={`def-${c.name}`} value={kind} onChange={(e) => void setDefault(c, e.target.value)}>
                          {defaultChoices(c.type).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </NativeSelect>
                      </Field>
                      {kind === 'text' && (
                        <Field label="Which value" htmlFor={`defv-${c.name}`} className="w-36">
                          <Input id={`defv-${c.name}`} defaultValue={defaultValueOf(c.default)} maxLength={100}
                            onBlur={(e) => void setDefaultValue(c, e.target.value)} />
                        </Field>
                      )}
                      <label className="flex items-center gap-2 pb-2 text-sm">
                        <Checkbox checked={c.required} onCheckedChange={(v) => void setColumn(c, { required: v === true })} />
                        Has to be filled in
                      </label>
                      <label className="flex items-center gap-2 pb-2 text-sm">
                        <Checkbox checked={unique} onCheckedChange={(v) => void toggleUnique(c, v === true)} />
                        All different
                      </label>
                    </>}
                    {key && <p className="pb-2 text-sm text-muted-foreground">The primary key is settled when the table is made.</p>}
                    <Button variant="outline" size="sm" onClick={() => void rename(c)}><Undo2 />Rename</Button>
                    {!key && <Button variant="outline" size="sm" onClick={() => void removeField(c)}><Trash2 />Remove</Button>}
                  </div>} />
              );
            })}
          </List>
        </Section>

        <Relationships base={base} d={d} table={t.name} title={`How ${t.name} connects to other tables`} />

        {t.indexes.length > 0 && (
          <Section title="Indexes" plain>
            <p className="text-sm text-muted-foreground">
              {t.indexes.map((i) => `${i.name} (${i.columns.join(', ')})`).join(' · ')}. These make looking things up faster. The panel leaves them exactly as they are.
            </p>
          </Section>
        )}
      </>}
    </Page>
  );
}
