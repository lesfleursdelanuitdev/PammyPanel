// One file, opened: a preview, what the panel knows about it, its addresses,
// its tags and categories, and everything that can be done to it.
import { Code, Copy, CopyPlus, Download, ExternalLink as ExternalLinkIcon, FilePenLine, FolderInput, Pencil, Save, Tags, Trash2 } from 'lucide-react';
import { Link } from 'react-router';
import { useState } from 'react';
import { Field, Loading } from '@panel/core/web/components/page';
import { Input } from '@panel/core/web/components/ui/input';
import { Button } from '@panel/core/web/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@panel/core/web/components/ui/dialog';
import { copyText, useAction } from '@panel/core/web/hooks/useAction';
import { useApi } from '@panel/core/web/hooks/useApi';
import { api, formatTime, friendlyError } from '@panel/core/web/lib/api';
import { editorHref, isEditable } from '../../lib/editor';
import { fileUrl, htmlFor, isProgramFile, kindLabel, publicAddresses, useShown } from '../../lib/media';
import { useMe } from '@panel/core/web/hooks/useMe';
import { isOn, W } from '@panel/core/web/lib/site';
import { formatSize } from '@panel/core/web/lib/format';
import type { MediaInfo, MediaItem } from '../../lib/types';
import type { ItemActions } from './items';
import { whereOf } from './items';
import { LabelChips } from './thumb';

export function FileDetails({ it, reserved, actions, onClose }: { it: MediaItem | null; reserved: string[]; actions: ItemActions; onClose: () => void }) {
  // quiet: straight after a rename or move the old name is gone, and that's no news
  const info = useApi<MediaInfo>(it ? `${it.path.split('/')[0] === 'media' || it.path.split('/')[1] === 'media' ? '/api/media/info' : '/api/files/info'}?path=${encodeURIComponent(it.path)}` : null, { meta: { quiet: true } });
  const i = info.data;
  const shown = useShown();
  const addresses = it ? publicAddresses(it.path, reserved, shown) : [];
  const url = it ? fileUrl(it.path) : '';
  const then = (fn: () => void) => () => { onClose(); fn(); };
  const me = useMe();
  const program = !!it && isProgramFile(it.name);

  return (
    <Dialog open={it !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>{it?.name}</DialogTitle>
          <DialogDescription>{it ? `In ${whereOf(it, true)}` : ''}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {!it ? null : info.error ? <p className="text-destructive">{friendlyError(info.error)}</p> : !i ? <Loading rows={2} /> : (
            <div className="space-y-5">
              {i.fits && it.kind === 'images' && <img src={url} alt={i.name} className="mx-auto max-h-[45vh] rounded-lg border border-border object-contain" />}
              {i.fits && it.kind === 'video' && <video src={url} controls preload="metadata" poster={it.thumb?.src ?? undefined} className="max-h-[45vh] w-full rounded-lg bg-black" />}
              {i.fits && it.kind === 'audio' && <>
                {it.thumb?.src && <img src={it.thumb.src} alt="" className="mx-auto max-h-40 rounded-lg border border-border" />}
                <audio src={url} controls preload="metadata" className="w-full" />
              </>}
              {i.fits && it.kind === 'files' && it.thumb?.src && <img src={it.thumb.src} alt={`First page of ${i.name}`} className="mx-auto max-h-[40vh] rounded-lg border border-border" />}
              {program && <p role="note" className="rounded-lg bg-muted px-4 py-3 text-sm">This file runs on the server. It is put in and changed there, by a programmer, not in the panel.</p>}
              {!i.fits && <p className="rounded-lg bg-danger-soft px-4 py-3 text-destructive">This file doesn't belong in {kindLabel(it.kind).toLowerCase()}. Move it to the right kind of folder.</p>}
              <dl className="grid gap-x-6 gap-y-1.5 sm:grid-cols-[max-content_1fr]">
                {([
                  ['Size', `${formatSize(i.size)} (${i.size.toLocaleString()} bytes)`],
                  i.dimensions ? ['Picture size', `${i.dimensions.width} × ${i.dimensions.height} pixels`] : null,
                  ['Created', formatTime(i.createdAt)],
                  ['Last changed', formatTime(i.modifiedAt)],
                  ['Added by', i.addedBy ? `${i.how === 'copied' ? 'Copied' : 'Uploaded'} by ${i.addedBy}, ${formatTime(i.addedAt)}` : "Put here outside the panel (with WinSCP or Claude), so the panel doesn't know who."],
                ] as ([string, string] | null)[]).filter((x): x is [string, string] => x !== null).map(([k, v]) => (
                  <div key={k} className="contents"><dt className="text-sm font-semibold text-muted-foreground sm:pt-0.5">{k}</dt><dd className="[overflow-wrap:anywhere]">{v}</dd></div>
                ))}
                <div className="contents">
                  <dt className="text-sm font-semibold text-muted-foreground sm:pt-0.5">Tags and categories</dt>
                  <dd className="flex flex-wrap items-center gap-2">
                    {i.tags.length || i.categories.length ? <LabelChips tags={i.tags} categories={i.categories} /> : <span className="text-muted-foreground">None yet</span>}
                    <Button size="sm" variant="ghost" onClick={then(() => actions.labels([it]))}><Tags />Change</Button>
                  </dd>
                </div>
              </dl>
              {isOn('media') && <Describe key={`${it.id}-${i.title ?? ''}-${i.alt ?? ''}`} id={it.id} title={i.title} alt={i.alt} image={it.kind === 'images'} />}
              <div>
                <h3 className="mb-2 text-base font-semibold">Address</h3>
                <div className="space-y-2">
                  {addresses.length === 0 && <p className="text-sm text-muted-foreground">Not on the internet: no route shows this folder yet (Hosts).</p>}
                  {addresses.map((a) => (
                    <div key={a} className="flex items-center gap-2">
                      <code className="min-w-0 flex-1 rounded-md bg-muted px-2.5 py-1.5 text-sm [overflow-wrap:anywhere]">{a}</code>
                      <Button size="sm" variant="outline" onClick={() => copyText(a, 'Address')}><Copy />Copy address</Button>
                    </div>
                  ))}
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 rounded-md bg-muted px-2.5 py-1.5 text-sm [overflow-wrap:anywhere]">{htmlFor(it.path, it.kind)}</code>
                    <Button size="sm" variant="outline" onClick={() => copyText(htmlFor(it.path, it.kind), 'HTML')}><Code />Copy HTML</Button>
                  </div>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">The HTML is for a page in {i.site ? `the "${i.site}" folder` : `${W.website.top}`}. From a page in a folder inside that, put ../ in front once for each level.</p>
              </div>
            </div>
          )}
        </DialogBody>
        {i && it && (
          <DialogFooter className="justify-start">
            {isEditable(it.name) && <Button asChild size="sm"><Link to={editorHref(it.path)} className="no-underline" onClick={onClose}><FilePenLine />Edit</Link></Button>}
            {addresses[0] && <Button asChild size="sm" variant="outline"><a href={addresses[0]} target="_blank" rel="noopener" className="no-underline"><ExternalLinkIcon />Open</a></Button>}
            {(!program || me?.role === 'manager') && <Button asChild size="sm" variant="outline"><a href={fileUrl(it.path, true)} className="no-underline"><Download />Download</a></Button>}
            {!program && <>
              <Button size="sm" variant="outline" onClick={then(() => actions.rename(it))}><Pencil />Rename</Button>
              <Button size="sm" variant="outline" onClick={then(() => actions.move([it], 'move'))}><FolderInput />Move to…</Button>
              <Button size="sm" variant="outline" onClick={then(() => actions.move([it], 'copy'))}><CopyPlus />Make a copy…</Button>
              <Button size="sm" variant="danger" className="sm:ml-auto" onClick={then(() => actions.trash([it]))}><Trash2 />Move to trash</Button>
            </>}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

// M9: a title, and "what it shows" for people who can't see it. Galleries and
// slide shows on her pages use both (12-media-on-your-pages.txt).
function Describe({ id, title, alt, image }: { id: number; title: string | null; alt: string | null; image: boolean }) {
  const run = useAction();
  const [t, setT] = useState(title ?? '');
  const [a, setA] = useState(alt ?? '');
  const changed = t !== (title ?? '') || a !== (alt ?? '');
  return (
    <form className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-2" aria-label="Title and description"
      onSubmit={(e) => { e.preventDefault(); void run(() => api(`/api/media/items/${id}/details`, { title: t, alt: a }), 'Saved.'); }}>
      <Field label="Title" htmlFor={`title-${id}`} hint="Shown under it in a gallery or slide show.">
        <Input id={`title-${id}`} value={t} maxLength={200} onChange={(e) => setT(e.target.value)} placeholder="e.g. Sunset at the beach" />
      </Field>
      <Field label={image ? 'What it shows' : 'Description'} htmlFor={`alt-${id}`} hint={image ? "A few words for people who can't see it." : 'A few words about it.'}>
        <Input id={`alt-${id}`} value={a} maxLength={500} onChange={(e) => setA(e.target.value)} placeholder={image ? 'e.g. An orange sky over the sea' : ''} />
      </Field>
      <div className="sm:col-span-2"><Button type="submit" size="sm" disabled={!changed}><Save />Save</Button></div>
    </form>
  );
}
