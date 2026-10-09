// Building a form: the list of kinds to add, the form itself in the middle, and
// the settings of whatever is picked. On a computer things can be dragged; on a
// phone everything is done by tapping, with Up and Down to move things. Saving
// changes the live form at once (docs/forms-plan.md, D11).
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Check, Copy, Database, Eye, GripVertical, Plus, Save, Settings2, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { ItemSettings, FormSettingsPanel } from '../components/form-settings';
import { FormPreview } from '../components/form-preview';
import { InlineLink, Loading } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '@panel/core/web/components/ui/sheet';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { useNarrow } from '@panel/core/web/hooks/useNarrow';
import { useMe } from '@panel/core/web/hooks/useMe';
import { api } from '@panel/core/web/lib/api';
import { ITEM_GROUPS, ITEM_KINDS, kindOf, newItem } from '../lib/form-items';
import { notify } from '@panel/core/web/lib/status';
import { cn } from '@panel/core/web/lib/utils';
import { isAnswerType, type Form, type FormItem, type FormSettings, type ItemType } from '../lib/types';
import { may } from '@panel/core/web/lib/rights';
import { guideTo } from '@panel/core/web/lib/site';

// What GET /api/media/items sends (the files module's MediaItems), as far as the
// picture picker reads it.
type MediaItems = { items: { path: string }[] };

export function FormBuilder() {
  const { id } = useParams();
  const form = useApi<Form>(`/api/forms/${id}`);
  usePageTitle(form.data ? `${form.data.title} · Forms` : 'Forms');
  if (!form.data) return <div className="mx-auto w-full max-w-6xl px-4 py-8"><Loading /></div>;
  return <Builder key={form.data.id} form={form.data} />;
}

function Builder({ form }: { form: Form }) {
  const navigate = useNavigate();
  const dialogs = useDialogs();
  const qc = useQueryClient();
  const run = useAction();
  const [items, setItems] = useState<FormItem[]>(form.items);
  const [settings, setSettings] = useState<FormSettings>(form.settings);
  const [title, setTitle] = useState(form.title);
  const [version, setVersion] = useState(form.version);
  const [dirty, setDirty] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // images a picture item can use: the form's own folder's, or anyone's for a form that works everywhere (D22)
  const images = useApi<MediaItems>(`/api/media/items?kind=images&sort=added&order=desc${form.scope === '/' ? '' : `&scope=${encodeURIComponent(form.scope)}`}`, { staleTime: 60_000, meta: { quiet: true } });
  const pictures = (images.data?.items ?? []).map((i) => i.path);
  const [previewing, setPreviewing] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const narrow = useNarrow();       // phones and narrow tablets: panels slide in instead of columns
  // docs/form-to-database-plan.md: the account manager's; which questions go
  // into a database field, so deleting one of them asks first (F4)
  const me = useMe();
  const linkable = !!me && may(me, 'databases') && !form.fixture && form.kind !== 'comments';
  const linked = useApi<{ link: { table: string; enabled: boolean; pairs: { key: string; field: string }[] } | null }>(
    linkable ? `/api/forms/${form.id}/database` : null, { meta: { quiet: true } });

  const change = useCallback((next: FormItem[]) => { setItems(next); setDirty(true); }, []);
  const chosen = items.find((i) => i.id === picked) ?? null;

  // Leaving with changes that were never saved would lose them.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  }, [dirty]);

  const add = (type: ItemType, at?: number) => {
    const item = newItem(type);
    const where = at ?? (picked ? items.findIndex((i) => i.id === picked) + 1 : items.length);
    const next = [...items];
    next.splice(where, 0, item);
    change(next);
    setPicked(item.id);
    setAddOpen(false);
    setTimeout(() => canvasRef.current?.querySelector<HTMLElement>(`[data-item="${item.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 30);
  };
  const update = (id: string, patch: Partial<FormItem>) => change(items.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  const remove = async (id: string) => {
    const key = items.find((i) => i.id === id)?.key;
    const into = linked.data?.link?.pairs.filter((p) => p.key === key).map((p) => p.field) ?? [];
    if (key && into.length && !await dialogs.confirm({
      title: 'This answer goes into your database', action: 'Delete it', danger: true,
      body: `It is saved into ${into.join(', ')} of ${linked.data!.link!.table}. Delete the question and that field is no longer filled in by this form${linked.data!.link!.enabled ? ' — if the table needs it, saving stops until you change it' : ''}.`,
    })) return;
    change(items.filter((i) => i.id !== id));
    if (picked === id) setPicked(null);
  };
  const move = (id: string, by: number) => {
    const at = items.findIndex((i) => i.id === id);
    const to = at + by;
    if (at < 0 || to < 0 || to >= items.length) return;
    const next = [...items];
    const [item] = next.splice(at, 1);
    next.splice(to, 0, item!);
    change(next);
  };
  const copy = (id: string) => {
    const at = items.findIndex((i) => i.id === id);
    const source = items[at]!;
    const { id: _old, key: _key, ...rest } = source;
    const clone = { ...newItem(source.type), ...rest, id: newItem(source.type).id };
    const next = [...items];
    next.splice(at + 1, 0, clone);
    change(next);
    setPicked(clone.id);
  };

  const dropOn = (at: number) => {
    if (!dragging) return;
    if (dragging.startsWith('kind:')) { add(dragging.slice(5) as ItemType, at); }
    else {
      const from = items.findIndex((i) => i.id === dragging);
      if (from < 0) return;
      const next = [...items];
      const [item] = next.splice(from, 1);
      next.splice(from < at ? at - 1 : at, 0, item!);
      change(next);
    }
    setDragging(null);
    setDropAt(null);
  };

  const save = async () => {
    const r = await run(() => api<{ form: Form }>(`/api/forms/${form.id}`, { version, title, items, settings }), 'Saved. Your pages show it now.');
    if (!r) return;
    setItems(r.form.items);
    setSettings(r.form.settings);
    setVersion(r.form.version);
    setDirty(false);
    await qc.invalidateQueries({ queryKey: ['/api/forms'] });
    await qc.invalidateQueries({ queryKey: [`/api/forms/${form.id}`] });
  };

  const leave = async () => {
    if (dirty && !await dialogs.confirm({ title: 'Leave without saving?', action: 'Leave', danger: true, body: 'The changes you made here would be lost.' })) return;
    navigate('/forms');
  };

  const questions = useMemo(() => items.filter((i) => isAnswerType(i.type)).length, [items]);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 pb-24 pt-5 sm:px-6 lg:px-8">
      <header data-testid="builder-bar" className="sticky top-14 z-20 -mx-4 mb-4 flex flex-wrap items-center gap-2 border-b border-border bg-bg/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <div className="min-w-0 flex-1 basis-full sm:basis-auto">
          <input aria-label="Form title" value={title} maxLength={120}
            onChange={(e) => { setTitle(e.target.value); setDirty(true); }}
            className="w-full max-w-md rounded border border-transparent bg-transparent px-1 py-0.5 text-lg font-bold hover:border-border focus:border-border focus:outline-none" />
          <p className="px-1 text-xs text-muted-foreground">
            <code className="rounded bg-muted px-1 py-0.5">{form.name}</code> · {questions === 1 ? '1 question' : `${questions} questions`}
            {dirty && <span className="ml-2 font-medium text-amber-700 dark:text-amber-300">Unsaved changes</span>}
            {!form.enabled && <Badge variant="warn" className="ml-2">off</Badge>}
          </p>
        </div>
        <Button variant="outline" onClick={() => setPreviewing((p) => !p)} aria-pressed={previewing}><Eye />{previewing ? 'Back to editing' : 'Preview'}</Button>
        {linkable && (
          <Button variant="outline" onClick={async () => {
            // like Close: unsaved changes are not left behind without asking
            if (dirty && !await dialogs.confirm({ title: 'Leave without saving?', action: 'Leave', danger: true, body: 'Save the form first if the database should see your new questions.' })) return;
            navigate(`/forms/${form.id}/database`);
          }}><Database />{linked.data?.link?.enabled ? `Connected to ${linked.data.link.table}` : 'Connect to a database'}</Button>
        )}
        <Button variant="ghost" onClick={leave}><X />Close</Button>
        <Button onClick={save} disabled={!dirty}><Save />Save</Button>
      </header>

      {previewing ? (
        <FormPreview items={items} settings={settings} title={title} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)_20rem]">
          {/* left: what can be added. On phones this is the "Add" sheet instead. */}
          <aside className="hidden lg:block">
            <div className="sticky top-32 max-h-[calc(100vh-9rem)] overflow-y-auto rounded-lg border border-border bg-card p-3">
              <h2 className="mb-2 px-1 text-sm font-semibold">Add to the form</h2>
              <Palette onAdd={(t) => add(t)} onDragKind={setDragging} />
            </div>
          </aside>

          {/* middle: the form as visitors see it */}
          <div ref={canvasRef} className="min-w-0">
            <div className="rounded-lg border border-border bg-card p-3 sm:p-4">
              {items.length === 0 && (
                <p className="rounded-md border border-dashed border-border px-4 py-10 text-center text-muted-foreground">
                  Nothing on this form yet. <span className="hidden lg:inline">Pick something from the left, or drag it here.</span>
                  <span className="lg:hidden">Tap "Add a question" below.</span>
                </p>
              )}
              <ol className="space-y-2">
                {items.map((item, at) => (
                  <li key={item.id}>
                    <DropLine active={dropAt === at} onDrop={() => dropOn(at)} onOver={() => setDropAt(at)} dragging={!!dragging} />
                    <ItemRow item={item} at={at} count={items.length} picked={picked === item.id}
                      onPick={() => { setPicked(item.id); setSettingsOpen(true); }}
                      onMove={(by) => move(item.id, by)} onCopy={() => copy(item.id)} onRemove={() => remove(item.id)}
                      onDragStart={() => setDragging(item.id)} onDragEnd={() => { setDragging(null); setDropAt(null); }} />
                  </li>
                ))}
              </ol>
              <DropLine active={dropAt === items.length} onDrop={() => dropOn(items.length)} onOver={() => setDropAt(items.length)} dragging={!!dragging} last />
            </div>
            <Button className="mt-3 w-full lg:hidden" variant="outline" onClick={() => setAddOpen(true)}><Plus />Add a question</Button>
          </div>

          {/* right: the settings of what's picked, or of the whole form */}
          <aside className="hidden lg:block">
            <div className="sticky top-32 max-h-[calc(100vh-9rem)] overflow-y-auto rounded-lg border border-border bg-card p-4">
              {chosen
                ? <ItemSettings item={chosen} onChange={(patch) => update(chosen.id, patch)} onClose={() => setPicked(null)} pictures={pictures} scope={form.scope} />
                : <FormSettingsPanel settings={settings} onChange={(patch) => { setSettings({ ...settings, ...patch }); setDirty(true); }} />}
            </div>
          </aside>
        </div>
      )}

      {/* phones: adding and settings are full-screen panels */}
      <Sheet open={addOpen && narrow} onOpenChange={setAddOpen}>
        <SheetContent className="w-screen max-w-none p-4">
          <SheetTitle className="mb-3 text-base font-semibold">Add to the form</SheetTitle>
          <div className="overflow-y-auto"><Palette onAdd={(t) => add(t)} /></div>
        </SheetContent>
      </Sheet>
      <Sheet open={settingsOpen && !!chosen && narrow} onOpenChange={setSettingsOpen}>
        <SheetContent className="w-screen max-w-none overflow-y-auto p-4">
          <SheetTitle className="sr-only">Settings</SheetTitle>
          {chosen && <ItemSettings item={chosen} onChange={(patch) => update(chosen.id, patch)} onClose={() => setSettingsOpen(false)} phone pictures={pictures} scope={form.scope} />}
        </SheetContent>
      </Sheet>

      <p className="mt-6 text-sm text-muted-foreground lg:hidden">
        Form settings (the button's words, who may use it) are on a computer's wider screen{guideTo('forms') ? <>, or <InlineLink to={guideTo('forms')!}>see the guide</InlineLink></> : ''}.
      </p>
    </div>
  );
}

function Palette({ onAdd, onDragKind }: { onAdd: (t: ItemType) => void; onDragKind?: (k: string | null) => void }) {
  return (
    <div className="space-y-4">
      {ITEM_GROUPS.map((group) => (
        <div key={group}>
          <h3 className="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group}</h3>
          <ul className="space-y-1">
            {ITEM_KINDS.filter((k) => k.group === group).map((k) => (
              <li key={k.type}>
                <button type="button" draggable={!!onDragKind}
                  onDragStart={() => onDragKind?.(`kind:${k.type}`)} onDragEnd={() => onDragKind?.(null)}
                  onClick={() => onAdd(k.type)}
                  className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted">
                  <k.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block font-medium">{k.label}</span>
                    <span className="block text-xs text-muted-foreground">{k.hint}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// Where a dragged thing would land.
function DropLine({ active, dragging, onDrop, onOver, last = false }: { active: boolean; dragging: boolean; onDrop: () => void; onOver: () => void; last?: boolean }) {
  if (!dragging) return last ? null : <div className="h-1" />;
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); onOver(); }}
      onDrop={(e) => { e.preventDefault(); onDrop(); }}
      className={cn('my-1 rounded transition-all', active ? 'h-8 border-2 border-dashed border-primary bg-primary-soft' : 'h-3')}
      aria-hidden
    />
  );
}

function ItemRow({ item, at, count, picked, onPick, onMove, onCopy, onRemove, onDragStart, onDragEnd }: {
  item: FormItem; at: number; count: number; picked: boolean; onPick: () => void;
  onMove: (by: number) => void; onCopy: () => void; onRemove: () => void; onDragStart: () => void; onDragEnd: () => void;
}) {
  const kind = kindOf(item.type);
  const what = isAnswerType(item.type) ? item.label || '(no label yet)' : item.text || kind.label;
  return (
    <div data-item={item.id} data-testid="form-item" draggable onDragStart={onDragStart} onDragEnd={onDragEnd}
      onClick={onPick}
      className={cn('cursor-pointer rounded-md border bg-card px-3 py-2.5 hover:border-primary/40',
        picked ? 'border-primary shadow-[0_0_0_1px_var(--primary)]' : 'border-border')}>
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
        <GripVertical className="mt-0.5 hidden size-4 shrink-0 cursor-grab text-muted-foreground lg:block" aria-hidden />
        <kind.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground lg:hidden" aria-hidden />
        <div className="min-w-[12rem] flex-1">
          <p className="flex flex-wrap items-center gap-2 text-[0.9375rem] font-medium [overflow-wrap:anywhere]">
            {what}
            {item.required && <span className="text-destructive" aria-label="must be answered">*</span>}
            {item.key && <code className="rounded bg-muted px-1 py-0.5 text-xs font-normal text-muted-foreground">{item.key}</code>}
          </p>
          <p className="text-xs text-muted-foreground">
            {kind.label}
            {item.options?.length ? `: ${item.options.slice(0, 4).join(', ')}${item.options.length > 4 ? '...' : ''}` : ''}
            {item.type === 'image' && !item.src ? ' (no picture chosen yet)' : ''}
          </p>
        </div>
        <div className="flex w-full shrink-0 justify-end gap-0.5 sm:w-auto sm:gap-1" onClick={(e) => e.stopPropagation()}>
          <Button size="icon" variant="ghost" aria-label={`Move "${what}" up`} disabled={at === 0} onClick={() => onMove(-1)}><ArrowUp /></Button>
          <Button size="icon" variant="ghost" aria-label={`Move "${what}" down`} disabled={at === count - 1} onClick={() => onMove(1)}><ArrowDown /></Button>
          <Button size="icon" variant="ghost" aria-label={`Settings for "${what}"`} onClick={onPick}><Settings2 /></Button>
          <Button size="icon" variant="ghost" aria-label={`Duplicate "${what}"`} onClick={onCopy}><Copy /></Button>
          <Button size="icon" variant="ghost" aria-label={`Remove "${what}"`} onClick={onRemove}><Trash2 /></Button>
        </div>
      </div>
      {picked && <p className="mt-2 flex items-center gap-1.5 text-xs text-primary lg:hidden"><Check className="size-3.5" />Being edited</p>}
    </div>
  );
}
