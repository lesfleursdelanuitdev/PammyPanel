// "Add field" as one small form: everything a field is, decided before it goes
// into the drawing, rather than a name first and the rest on the Fields page.
// The same choices the Fields page offers, in the same words -- nothing here that
// page could not change afterwards.
//
// It only builds the field. Whoever opened it saves the drawing, so the canvas
// and anything else that wants it share one way of saving.
import { useEffect, useId, useState } from 'react';
import { Field } from '@panel/core/web/components/page';
import { Button } from '@panel/core/web/components/ui/button';
import { Checkbox } from '@panel/core/web/components/ui/checkbox';
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@panel/core/web/components/ui/dialog';
import { Input } from '@panel/core/web/components/ui/input';
import { NativeSelect } from '@panel/core/web/components/ui/native-select';
import {
  canBeNow, COLUMN_TYPES, DEFAULT_TEXT_RE, defaultChoices, newIdentProblem, TYPE_HINTS, TYPE_NAMES,
  type ColumnDefault, type ColumnType, type SchemaColumn, type SchemaTable,
} from '../lib/schema';

export type NewField = { column: SchemaColumn; unique: boolean };

const BLANK = {
  name: '', type: 'text' as ColumnType, length: '255', precision: '12', scale: '2',
  start: 'none', value: '', required: false, unique: false,
};

export function AddFieldDialog({ table, live, onClose, onAdd }: {
  // the table it goes into; null when the window is shut
  table: SchemaTable | null;
  // the table is already in the database, so it may have rows in it
  live: boolean;
  onClose: () => void;
  // true when it was saved and the window can shut
  onAdd: (field: NewField) => Promise<boolean>;
}) {
  const id = useId();
  const [f, setF] = useState(BLANK);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<typeof BLANK>) => { setF((x) => ({ ...x, ...patch })); setProblem(null); };

  // a fresh form each time it opens
  useEffect(() => { if (table) { setF(BLANK); setProblem(null); } }, [table?.name]);

  const setType = (type: ColumnType) =>
    // a starting value that no longer makes sense for the new kind of field
    set({ type, start: defaultChoices(type).some((o) => o.value === f.start) ? f.start : 'none', value: '' });

  const number = f.type === 'integer' || f.type === 'decimal';

  // Checked here so she gets the sentence in the window, next to what to fix,
  // rather than in a notice after it has shut. The helper checks it all again.
  const build = (): NewField | string => {
    const name = f.name.trim();
    const bad = newIdentProblem(name, 'field');
    if (bad) return bad;
    if (table!.columns.some((c) => c.name === name)) return `${table!.name} already has a field called ${name}.`;
    const column: SchemaColumn = { name, type: f.type, required: f.required, default: null };
    if (f.type === 'short_text') {
      const n = Number(f.length);
      if (!Number.isInteger(n) || n < 1 || n > 4000) return 'A short text field can be 1 to 4000 characters long.';
      column.length = n;
    }
    if (f.type === 'decimal') {
      const p = Number(f.precision);
      const s = Number(f.scale);
      if (!Number.isInteger(p) || p < 1 || p > 38) return 'A decimal number can keep 1 to 38 digits.';
      if (!Number.isInteger(s) || s < 0 || s > p) return 'The digits after the point have to fit inside the digits it keeps.';
      column.precision = p;
      column.scale = s;
    }
    let start: ColumnDefault | null = null;
    if (f.start === 'now') start = { kind: 'now' };
    if (f.start === 'yes' || f.start === 'no') start = { kind: 'boolean', value: f.start === 'yes' };
    if (f.start === 'text') {
      if (number) {
        if (f.value.trim() === '' || !Number.isFinite(Number(f.value))) return 'The starting value has to be a number.';
        if (f.type === 'integer' && !Number.isInteger(Number(f.value))) return 'A whole number cannot start out with a point in it.';
        start = { kind: 'number', value: Number(f.value) };
      } else {
        if (!DEFAULT_TEXT_RE.test(f.value)) {
          return 'A starting value can be up to 100 letters, digits and ordinary punctuation. Quotes and backslashes are not allowed.';
        }
        start = { kind: 'text', value: f.value };
      }
    }
    column.default = start;
    return { column, unique: f.unique };
  };

  const submit = async () => {
    const made = build();
    if (typeof made === 'string') return setProblem(made);
    setBusy(true);
    try {
      if (await onAdd(made)) onClose();
    } finally {
      setBusy(false);
    }
  };

  // The one combination that works on a new table and fails on one with rows
  // in it: said before she presses anything, not after Apply refuses it.
  const emptyOnly = live && f.required && f.start === 'none';

  return (
    <Dialog open={table !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent aria-describedby={`${id}-about`}>
        <form className="contents" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <DialogHeader>
            <DialogTitle>Add a field to {table?.name}</DialogTitle>
            <DialogDescription id={`${id}-about`}>
              It goes into your drawing. Nothing changes in the database until you apply it.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-4">
            <Field label="Field name" htmlFor={`${id}-name`}
              hint="Lowercase letters, digits and underscores — like title, price, or posted_on.">
              <Input id={`${id}-name`} value={f.name} autoFocus autoComplete="off" spellCheck={false} maxLength={63}
                onChange={(e) => set({ name: e.target.value })} />
            </Field>

            <Field label="What goes in it" htmlFor={`${id}-type`} hint={TYPE_HINTS[f.type]}>
              <NativeSelect id={`${id}-type`} value={f.type} onChange={(e) => setType(e.target.value as ColumnType)}>
                {COLUMN_TYPES.map((k) => <option key={k} value={k}>{TYPE_NAMES[k]}</option>)}
              </NativeSelect>
            </Field>

            {f.type === 'short_text' && (
              <Field label="How long, at most" htmlFor={`${id}-len`} hint="In characters, 1 to 4000." className="max-w-40">
                <Input id={`${id}-len`} type="number" min={1} max={4000} value={f.length}
                  onChange={(e) => set({ length: e.target.value })} />
              </Field>
            )}

            {f.type === 'decimal' && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Digits it keeps" htmlFor={`${id}-p`} hint="All of them, 1 to 38.">
                  <Input id={`${id}-p`} type="number" min={1} max={38} value={f.precision}
                    onChange={(e) => set({ precision: e.target.value })} />
                </Field>
                <Field label="After the point" htmlFor={`${id}-s`} hint="2 for a price.">
                  <Input id={`${id}-s`} type="number" min={0} max={38} value={f.scale}
                    onChange={(e) => set({ scale: e.target.value })} />
                </Field>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Starts out as" htmlFor={`${id}-start`}>
                <NativeSelect id={`${id}-start`} value={f.start} onChange={(e) => set({ start: e.target.value, value: '' })}>
                  {defaultChoices(f.type).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </NativeSelect>
              </Field>
              {f.start === 'text' && (
                <Field label="Which value" htmlFor={`${id}-value`}>
                  <Input id={`${id}-value`} value={f.value} maxLength={100} inputMode={number ? 'decimal' : undefined}
                    placeholder={canBeNow(f.type) ? (f.type === 'time' ? '09:00' : '2026-01-31') : undefined}
                    onChange={(e) => set({ value: e.target.value })} />
                </Field>
              )}
            </div>

            <div className="grid gap-2">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={f.required} onCheckedChange={(v) => set({ required: v === true })} />
                Has to be filled in
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={f.unique} onCheckedChange={(v) => set({ unique: v === true })} />
                Must be different in every row
              </label>
            </div>

            {emptyOnly && (
              <p className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm">
                {table?.name} is already in the database. A field that has to be filled in and starts out as nothing can
                only be added while {table?.name} is empty. Give it a starting value, or let it be left empty.
              </p>
            )}
            {problem && <p role="alert" className="text-sm font-medium text-destructive">{problem}</p>}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy || !f.name.trim()}>Add field</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
