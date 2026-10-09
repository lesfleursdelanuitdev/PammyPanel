// "Move to…" and "Make a copy…", for one file or several: any media folder, any
// folder inside it. Into another media folder, tags and categories go along by
// name, and the dialog says which will be made there first (D8).
import { useQueryClient } from '@tanstack/react-query';
import { CopyPlus, FolderInput } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Field } from '@panel/core/web/components/page';
import { Button } from '@panel/core/web/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@panel/core/web/components/ui/dialog';
import { Input } from '@panel/core/web/components/ui/input';
import { NativeSelect } from '@panel/core/web/components/ui/native-select';
import { useApi } from '@panel/core/web/hooks/useApi';
import { api, ApiError, friendlyError, signedOut } from '@panel/core/web/lib/api';
import { kindFits, kindLabel, labelAddress, MEDIA_KINDS, scopeOf } from '@panel/files/web/lib/media';
import { siteLabel } from '@panel/core/web/lib/format';
import { clearNotice, notify } from '@panel/core/web/lib/status';
import type { MediaItem, MediaKind, MediaLabel, MediaSite } from '@panel/files/web/lib/types';

export function MoveOrCopy({ items, mode, sites, onClose }: { items: MediaItem[]; mode: 'move' | 'copy'; sites: MediaSite[]; onClose: () => void }) {
  const qc = useQueryClient();
  const one = items.length === 1 ? items[0]! : null;
  const kinds = [...new Set(items.map((i) => i.kind))];
  const [site, setSite] = useState(items[0]!.site);
  const [toKind, setToKind] = useState<MediaKind>(() => (MEDIA_KINDS.some(([k]) => k === kinds[0]) ? kinds[0] as MediaKind : 'files'));
  const [bucket, setBucket] = useState('');
  const [newName, setNewName] = useState(one?.name ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  // several files of different kinds each go to the top of their own kind
  const sameKind = kinds.length === 1 || !!one;
  const dir = [site, 'media', toKind].filter(Boolean).join('/');
  const buckets = useApi<{ buckets: string[] }>(sameKind ? `/api/media/buckets?dir=${encodeURIComponent(dir)}` : null);
  useEffect(() => { setBucket(''); }, [dir]);
  const target = scopeOf(site);
  const there = useApi<{ labels: MediaLabel[] }>(`/api/media/labels?scope=${encodeURIComponent(target)}`);
  const made = [...new Set(items.filter((i) => i.scope !== target).flatMap((i) => [
    ...i.tags.filter((t) => !there.data?.labels.some((l) => l.type === 'tag' && l.name === t)).map((t) => labelAddress('tag', target, t)),
    ...i.categories.filter((c) => !there.data?.labels.some((l) => l.type === 'category' && l.name === c)).map((c) => labelAddress('category', target, c)),
  ]))];
  const warn = one && !kindFits(toKind, newName) ? `"${newName}" doesn't belong in ${kindLabel(toKind).toLowerCase()}.` : '';
  const verb = mode === 'copy' ? 'Copy' : 'Move';

  const go = async () => {
    clearNotice();
    const failed: string[] = [];
    let done = 0;
    let last = '';
    for (const [n, it] of items.entries()) {
      setBusy(items.length > 1 ? `${mode === 'copy' ? 'Copying' : 'Moving'} ${n + 1} of ${items.length}…` : '…');
      const to = [site, 'media', one || sameKind ? toKind : it.kind, one || sameKind ? bucket : ''].filter(Boolean).join('/');
      try {
        const r = await api<{ path: string }>(`/api/media/${mode}`, { from: it.path, to, name: one ? newName.trim() || it.name : it.name });
        last = r.path;
        done++;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return signedOut();
        failed.push(`${it.name}: ${friendlyError(err)}`);
      }
    }
    setBusy(null);
    await qc.invalidateQueries();
    if (failed.length) {
      setProblems(failed);
      notify(`${done} ${mode === 'copy' ? 'copied' : 'moved'}; ${failed.length} couldn't be (see the list).`, 'error');
      return;
    }
    notify(one ? `${mode === 'copy' ? 'Copied' : 'Moved'} to ${last}.` : `${done} files ${mode === 'copy' ? 'copied' : 'moved'} to ${siteLabel(site)}.`);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent>
        <form onSubmit={(e) => { e.preventDefault(); void go(); }} className="contents">
          <DialogHeader>
            <DialogTitle>{mode === 'copy' ? 'Copy' : 'Move'} {one ? `"${one.name}"` : `${items.length} files`}</DialogTitle>
            <DialogDescription>{mode === 'copy' ? 'The copy keeps the same tags and categories.' : 'Choose where it goes.'}</DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-4">
            <Field label="Media folder" htmlFor="mc-site">
              <NativeSelect id="mc-site" value={site} onChange={(e) => setSite(e.target.value)}>
                {sites.map((f) => <option key={f.folder} value={f.folder}>{siteLabel(f.folder)}</option>)}
              </NativeSelect>
            </Field>
            {one && (
              <Field label="Kind" htmlFor="mc-kind">
                <NativeSelect id="mc-kind" value={toKind} onChange={(e) => setToKind(e.target.value as MediaKind)}>
                  {MEDIA_KINDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                </NativeSelect>
              </Field>
            )}
            {sameKind ? (
              <Field label="Inside" htmlFor="mc-bucket">
                <NativeSelect id="mc-bucket" value={bucket} onChange={(e) => setBucket(e.target.value)}>
                  <option value="">(the top of {kindLabel(toKind).toLowerCase()})</option>
                  {(buckets.data?.buckets ?? []).map((b) => <option key={b} value={b}>{b.split('/').join(' › ')}</option>)}
                </NativeSelect>
              </Field>
            ) : <p className="text-sm text-muted-foreground">These are different kinds, so each goes to the top of its own kind (images, files, audio or video) in that media folder.</p>}
            {one && (
              <Field label="Name" htmlFor="mc-name">
                <Input id="mc-name" maxLength={120} autoComplete="off" value={newName} onChange={(e) => setNewName(e.target.value)} />
              </Field>
            )}
            {made.length > 0 && (
              <p className="rounded-lg bg-warning-soft px-3 py-2 text-sm" data-testid="labels-made">
                {siteLabel(site)} doesn't have {made.length === 1 ? 'this' : 'these'} yet, so {made.length === 1 ? "it'll be" : "they'll be"} made there: {made.join(', ')}
              </p>
            )}
            {(warn || buckets.error) && <p className="text-sm font-semibold text-destructive">{warn || friendlyError(buckets.error)}</p>}
            {problems.length > 0 && <ul className="list-disc space-y-1 pl-5 text-sm text-destructive">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={!!busy}>Cancel</Button>
            <Button type="submit" disabled={!!busy}>{mode === 'copy' ? <CopyPlus /> : <FolderInput />}{busy && busy !== '…' ? busy : `${verb} here`}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
