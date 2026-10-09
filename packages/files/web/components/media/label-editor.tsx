// Tags and categories on files (D10-D13). One file: its chips, with × to take
// one off and a box to add more. Several: what to add to all of them, and which
// of theirs to take off. A name not there yet is made in each file's own media
// folder ("Summer 2026" becomes summer-2026).
import { useQueryClient } from '@tanstack/react-query';
import { Tags } from 'lucide-react';
import { useState } from 'react';
import { AddBox, Chip } from '@panel/catalog/web/components/labels';
import { Button } from '@panel/core/web/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@panel/core/web/components/ui/dialog';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi } from '@panel/core/web/hooks/useApi';
import { api } from '@panel/core/web/lib/api';
import { labelSlug, pathUnderScope } from '../../lib/media';
import type { LabelType, MediaItem, MediaLabel } from '../../lib/types';

type Names = { tags: string[]; categories: string[] };
const KEY = { tag: 'tags', category: 'categories' } as const;
const WORD = { tag: ['Tags', 'tag'], category: ['Categories', 'category'] } as const;

export function LabelEditor({ items, onClose }: { items: MediaItem[]; onClose: () => void }) {
  const run = useAction();
  const qc = useQueryClient();
  const one = items.length === 1 ? items[0]! : null;
  // the labels of the chosen files' folders and the folders above them
  const common = items.map((i) => i.path.split('/').slice(0, -1)).reduce((a, p) => a.slice(0, a.findIndex((x, n) => p[n] !== x) === -1 ? a.length : a.findIndex((x, n) => p[n] !== x)));
  const all = useApi<{ labels: MediaLabel[] }>(`/api/media/labels?around=${encodeURIComponent(common.join('/'))}`);
  const known = (type: LabelType) => [...new Set((all.data?.labels ?? []).filter((l) => l.type === type && items.some((i) => pathUnderScope(i.path, l.scope))).map((l) => l.name))].sort();
  // one file: what it will have; several: what to add, and what to take off
  const [have, setHave] = useState<Names>({ tags: one?.tags ?? [], categories: one?.categories ?? [] });
  const [add, setAdd] = useState<Names>({ tags: [], categories: [] });
  const [off, setOff] = useState<Names>({ tags: [], categories: [] });
  const onFiles = (type: LabelType) => [...new Set(items.flatMap((i) => i[KEY[type]]))].sort();
  const toggle = (n: Names, set: (v: Names) => void, type: LabelType, name: string) =>
    set({ ...n, [KEY[type]]: n[KEY[type]].includes(name) ? n[KEY[type]].filter((x) => x !== name) : [...n[KEY[type]], name] });

  const [typed, setTyped] = useState<Record<LabelType, string>>({ tag: '', category: '' });
  const save = async () => {
    // anything still in the boxes counts as added
    const plus = (n: Names): Names => ({
      tags: [...new Set([...n.tags, labelSlug(typed.tag)].filter(Boolean))],
      categories: [...new Set([...n.categories, labelSlug(typed.category)].filter(Boolean))],
    });
    const body = one ? { ids: [one.id], set: plus(have) } : { ids: items.map((i) => i.id), add: plus(add), remove: off };
    const r = await run(() => api<{ changed: number; created: string[] }>('/api/media/items/labels', body),
      (res) => (res.changed ? `${one ? `Saved for "${one.name}"` : `Changed ${res.changed} file${res.changed === 1 ? '' : 's'}`}${res.created.length ? `; made ${res.created.join(', ')}` : ''}.` : 'Nothing to change.'));
    if (r) { await qc.invalidateQueries(); onClose(); }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="contents">
          <DialogHeader>
            <DialogTitle>Tags and categories{one ? ` for "${one.name}"` : ` for ${items.length} files`}</DialogTitle>
            <DialogDescription>
              Categories are the few broad shelves (like news or recipes); tags are the many specific words (like dogs or beach).
              They're only in the panel, for finding things: nothing on your site changes.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-5">
            {(['category', 'tag'] as const).map((type) => (
              <section key={type} aria-label={WORD[type][0]} className="grid gap-2">
                <h3 className="text-sm font-semibold">{WORD[type][0]}</h3>
                {one ? (
                  <div className="flex min-h-7 flex-wrap gap-1.5">
                    {have[KEY[type]].length === 0 && <span className="text-sm text-muted-foreground">None yet.</span>}
                    {have[KEY[type]].map((n) => <Chip key={n} name={n} type={type} onRemove={() => toggle(have, setHave, type, n)} />)}
                  </div>
                ) : <>
                  {add[KEY[type]].length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      <span className="text-sm text-muted-foreground">Add to all of them:</span>
                      {add[KEY[type]].map((n) => <Chip key={n} name={n} type={type} onRemove={() => toggle(add, setAdd, type, n)} />)}
                    </div>
                  )}
                  {onFiles(type).length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      <span className="text-sm text-muted-foreground">On some of them now (× to take off all of them):</span>
                      {onFiles(type).map((n) => <Chip key={n} name={n} type={type} struck={off[KEY[type]].includes(n)} onRemove={() => toggle(off, setOff, type, n)} />)}
                    </div>
                  )}
                </>}
                <AddBox type={type} known={known(type)} text={typed[type]} setText={(t) => setTyped((x) => ({ ...x, [type]: t }))} onAdd={(n) => {
                  if (one) { if (!have[KEY[type]].includes(n)) setHave({ ...have, [KEY[type]]: [...have[KEY[type]], n] }); }
                  else if (!add[KEY[type]].includes(n)) setAdd({ ...add, [KEY[type]]: [...add[KEY[type]], n] });
                }} />
              </section>
            ))}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit"><Tags />Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
