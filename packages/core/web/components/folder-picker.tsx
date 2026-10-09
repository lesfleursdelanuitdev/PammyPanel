// Choosing a folder of her website: a text box with the list of every folder
// always showing under it, narrowed to those containing what's typed (anywhere
// in the path, capitals ignored). Clicking a folder, or Enter on the one picked
// with the arrow keys, puts it in the box; the form's own button does the rest.
//
//   <FolderPicker id="protect-path" label="Folder" folders={['recipes', 'recipes/family']}
//     value={path} onChange={setPath} status={(f) => (taken.has(f) ? { note: 'protected', disabled: true } : null)}
//     action={<Button type="submit">Protect</Button>} />
import { Check, Folder, House } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Input } from './ui/input';
import { cn } from '../lib/utils';
import { SITE } from '../lib/site';

export type FolderStatus = { note: string; disabled?: boolean } | null;

// '' is the main site, offered first when mainSite is set.
export function FolderPicker({ id, label, folders, value, onChange, status, action, mainSite = false, placeholder, loading = false, hint }: {
  id: string; label: ReactNode; folders: string[] | undefined; value: string; onChange: (folder: string) => void;
  status?: (folder: string) => FolderStatus; action?: ReactNode; mainSite?: boolean; placeholder?: string; loading?: boolean; hint?: ReactNode;
}) {
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const [active, setActive] = useState(-1);

  const all = useMemo(() => [...(mainSite ? [''] : []), ...(folders ?? [])], [folders, mainSite]);
  const query = value.trim().replace(/^\/+/, '').toLowerCase();
  const shown = useMemo(
    () => (query ? all.filter((f) => f !== '' && f.toLowerCase().includes(query)) : all),
    [all, query],
  );
  const total = all.filter((f) => f !== '').length;
  const statusOf = (f: string) => status?.(f) ?? null;
  const enabled = (i: number) => i >= 0 && i < shown.length && !statusOf(shown[i]!)?.disabled;

  // typing starts the arrow keys afresh
  useEffect(() => { setActive(-1); }, [query]);
  useEffect(() => {
    if (active < 0) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const move = (by: number) => {
    if (!shown.length) return;
    let i = active;
    for (let n = 0; n < shown.length; n++) {
      i = i < 0 ? (by > 0 ? 0 : shown.length - 1) : (i + by + shown.length) % shown.length;
      if (enabled(i)) { setActive(i); return; }
    }
  };
  const pick = (f: string) => {
    onChange(f);
    setActive(-1);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter' && enabled(active)) { e.preventDefault(); pick(shown[active]!); }      // otherwise Enter submits the form
    else if (e.key === 'Escape' && active >= 0) { e.preventDefault(); setActive(-1); }
  };

  const count = loading || !folders ? 'Loading folders…'
    : !total ? 'No folders yet.'
      : query ? `${shown.length} of ${total} folder${total === 1 ? '' : 's'}` : `${total} folder${total === 1 ? '' : 's'}`;

  return (
    <div className="grid min-w-0 gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input id={id} value={value} placeholder={placeholder} autoComplete="off" autoCapitalize="none" spellCheck={false}
          role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} className="flex-1" />
        {action}
      </div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      <div className="overflow-hidden rounded-md border border-border bg-card">
        <p aria-live="polite" className="border-b border-border bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">{count}</p>
        <ul ref={listRef} id={listId} role="listbox" aria-label={typeof label === 'string' ? `${label}: folders` : 'Folders'}
          className="h-56 overflow-y-auto overscroll-contain py-1">
          {folders && shown.length === 0 && total > 0 && (
            <li role="presentation" className="px-3 py-6 text-center text-sm text-muted-foreground">No folders match "{value.trim()}".</li>
          )}
          {shown.map((f, i) => {
            const s = statusOf(f);
            const selected = value.trim().replace(/^\/+|\/+$/g, '') === f && (f !== '' || value === '');
            return (
              <li key={f || '(main site)'} id={`${listId}-${i}`} data-index={i} role="option" aria-selected={selected} aria-disabled={s?.disabled || undefined}
                onMouseDown={(e) => e.preventDefault()}          // keep the typing cursor in the box
                onClick={() => { if (!s?.disabled) pick(f); }}
                className={cn(
                  'mx-1 flex cursor-pointer items-center gap-2.5 rounded px-2 py-1.5 text-sm',
                  s?.disabled ? 'cursor-default opacity-55' : 'hover:bg-muted',
                  i === active && 'bg-primary-soft',
                  selected && 'bg-primary-soft font-medium',
                )}>
                {f === '' ? <House className="size-4 shrink-0 text-muted-foreground" /> : <Folder className="size-4 shrink-0 text-muted-foreground" />}
                <span className="min-w-0 flex-1 truncate">{f === '' ? `Main site (${SITE.domain})` : <Path path={f} query={query} />}</span>
                {s && <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{s.note}</span>}
                {selected && <Check className="size-4 shrink-0 text-primary" />}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

// recipes/<strong>family</strong>, with the typed letters marked
function Path({ path, query }: { path: string; query: string }) {
  const cut = path.lastIndexOf('/') + 1;
  const at = query ? path.toLowerCase().indexOf(query) : -1;
  const edges = [...new Set([0, cut, path.length, ...(at >= 0 ? [at, at + query.length] : [])])].sort((a, b) => a - b);
  const pieces: ReactNode[] = [];
  for (let k = 0; k < edges.length - 1; k++) {
    const [from, to] = [edges[k]!, edges[k + 1]!];
    if (from === to) continue;
    const text = path.slice(from, to);
    const marked = at >= 0 && from >= at && to <= at + query.length;
    const parent = to <= cut;
    pieces.push(
      <span key={from} className={cn(parent ? 'text-muted-foreground' : 'text-foreground', marked && 'rounded-sm bg-yellow-200 text-foreground dark:bg-yellow-500/40')}>{text}</span>,
    );
  }
  return <>{pieces}</>;
}
