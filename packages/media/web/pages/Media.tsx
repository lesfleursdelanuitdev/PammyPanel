// The Media tab (docs/media-plan.md D20-D21): every media file the panel knows
// about (media.db), one media folder or all of them, one kind or all four,
// searched and filtered by tag or category, as a grid or a table. Browsing one
// folder shows its subfolders first; uploads go where you are. Everything
// about what's shown is in the address, so Back and shared links work.
import { useQueryClient } from '@tanstack/react-query';
import {
  CopyPlus, CornerLeftUp, Ellipsis, FolderInput, FolderOpen, FolderPlus, LayoutGrid, List as ListIcon, Pencil, Search, Tags, Trash2, Upload, X, BookmarkPlus, BookmarkX,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { FileDetails } from '@panel/files/web/components/media/details';
import { FullScreenArea, FullScreenButton, useFullScreen } from '@panel/files/web/components/media/full-screen';
import { CheckForChanges, MediaTrash, OutOfPlace } from '@panel/files/web/components/media/extras';
import { FolderTiles, MediaGrid, MediaTable, SelectionBar, type ItemActions } from '@panel/files/web/components/media/items';
import { LabelEditor } from '@panel/files/web/components/media/label-editor';
import { MoveOrCopy } from '../components/move-copy';
import { LabelFilter } from '@panel/files/web/components/media/label-filter';
import { KIND_ICONS } from '@panel/files/web/components/media/thumb';
import { ActionButton, Collapsible, Field, InlineLink, Loading, Page } from '@panel/core/web/components/page';
import { Button } from '@panel/core/web/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@panel/core/web/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@panel/core/web/components/ui/dropdown-menu';
import { Input } from '@panel/core/web/components/ui/input';
import { NativeSelect } from '@panel/core/web/components/ui/native-select';
import { Progress } from '@panel/core/web/components/ui/progress';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { useMe } from '@panel/core/web/hooks/useMe';
import { may } from '@panel/core/web/lib/rights';
import { api, ApiError, friendlyError, signedOut } from '@panel/core/web/lib/api';
import { browseDir, browseHref, browsing, itemsUrl, KIND_EXTENSIONS, kindFits, kindForFile, kindLabel, MAX_UPLOAD, MEDIA_KINDS, parentOf, pref, readBrowse, scopeOf, sendFile, setPref, folderToScope, MEDIA_WHERE, NO_MAIN_MEDIA, type Browse } from '@panel/files/web/lib/media';
import { siteLabel } from '@panel/core/web/lib/format';
import { clearNotice, notify } from '@panel/core/web/lib/status';
import type { MediaItem, MediaItems, MediaKind, MediaLabel, MediaSite, MediaSites, TagScope } from '@panel/files/web/lib/types';
import type { SitesData } from '@panel/core/web/lib/types';
import { cn } from '@panel/core/web/lib/utils';
import { SITE, sizeWords } from '@panel/core/web/lib/site';

type Upload = { id: number; name: string; progress: number; state: string; status: 'waiting' | 'uploading' | 'ok' | 'failed' };
let uploadId = 1;
type View = 'grid' | 'table';
const SORTS: [string, Browse['sort'], boolean][] = [
  ['Name, A to Z', 'name', false], ['Name, Z to A', 'name', true], ['Newest first', 'added', true], ['Oldest first', 'added', false],
  ['Biggest first', 'size', true], ['Smallest first', 'size', false],
];
const folderValue = (f: string | null) => (f === null ? '*' : f === '' ? '/' : f);

export default function Media() {
  usePageTitle('Media');
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const run = useAction();
  const sites = useApi<MediaSites>('/api/media');
  // (reserved names, for addresses; an account that only sees one folder has no Subdomains to ask)
  const me = useMe();
  // (Subdomains' names, where folders are subdomains; lfdln has no such page)
  const sitesInfo = useApi<SitesData>(SITE.folderSubdomains && me && may(me, 'subdomains') ? '/api/sites' : null, { staleTime: 60_000 });
  const reserved = sitesInfo.data?.reserved ?? [];
  const [trashOpen, setTrashOpen] = useState(false);

  const all = sites.data?.folders ?? [];
  const withMedia = all.filter((f) => f.hasMedia);
  // no folder in the address: the one last looked at in this browser, else all of them (or the only one)
  const remembered = pref<string>('folder', '');
  const fallback = remembered === '*' && withMedia.length > 1 ? null
    : remembered && withMedia.some((f) => folderValue(f.folder) === remembered) ? (remembered === '/' ? '' : remembered)
      : withMedia.length > 1 ? null : withMedia[0]?.folder ?? '';
  // a person kept to places (D22) is always in one of them: the one asked for, else the first
  const limitedTo = sites.data?.limitedTo ?? null;
  const b0 = readBrowse(params, fallback);
  const b = limitedTo !== null && !(b0.folder !== null && limitedTo.includes(b0.folder)) ? { ...b0, folder: limitedTo[0] ?? '' } : b0;
  const go = (patch: Partial<Browse>, replace = false) => navigate(browseHref({ ...b, page: 1, ...patch }), { replace });
  useEffect(() => { if (sites.data && (b.folder === null || withMedia.some((f) => f.folder === b.folder))) setPref('folder', folderValue(b.folder)); },
    [b.folder, sites.data]);                // eslint-disable-line react-hooks/exhaustive-deps

  const make = async (f: string) => {
    const r = await run(() => api<{ created: string[]; folder: string }>('/api/media/folder', { folder: f }));
    if (!r) return;
    notify(r.created.length ? `Made a media folder in ${siteLabel(r.folder)}, with images, files, audio and video in it.` : `${siteLabel(r.folder)} already has a media folder.`);
    navigate(browseHref({ ...b, folder: r.folder, kind: null, inner: '', page: 1 }));
  };

  const hasMedia = new Set(withMedia.map((f) => f.folder));
  const noMediaHere = b.folder !== null && !hasMedia.has(b.folder);
  return (
    <Page wide title="Media" intro={NO_MAIN_MEDIA
      ? 'Images, files, audio and video for each of your site folders. They live in a media folder inside the site folder.'
      : 'Images, files, audio and video for your main site and each of your folders. They live in a media folder at the top of the site or of the folder.'}>
      {!sites.data ? <Loading /> : (
        <div className="space-y-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <Field label="Media folder" htmlFor="media-site" className="lg:w-80">
              <NativeSelect id="media-site" value={folderValue(b.folder)} onChange={(e) => {
                const v = e.target.value;
                go({ folder: v === '*' ? null : v === '/' ? '' : v, inner: '', tags: [], categories: [] });
              }}>
                {withMedia.length === 0 && <option value={folderValue(b.folder)}>No media folders yet</option>}
                {withMedia.length > 0 && limitedTo === null && <option value="*">All media folders</option>}
                {noMediaHere && withMedia.length > 0 && <option value={folderValue(b.folder)}>{siteLabel(b.folder!)} (no media folder)</option>}
                {withMedia.map((f) => <option key={f.folder} value={folderValue(f.folder)}>{siteLabel(f.folder)}</option>)}
              </NativeSelect>
            </Field>
            <CheckForChanges sync={sites.data.sync} />
          </div>
          {sites.data.sync && <OutOfPlace sync={sites.data.sync} />}

          {noMediaHere || withMedia.length === 0 ? (
            <div className="rounded-lg border border-dashed border-input bg-card p-6">
              <h2 className="text-base font-semibold">{withMedia.length ? `${siteLabel(b.folder ?? '')} has no media folder` : 'No media folders yet'}</h2>
              <p className="mt-2 max-w-prose text-muted-foreground">{MEDIA_WHERE}</p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                {/* (no main site's media folder on lfdln: choose a site folder on the next page) */}
                {NO_MAIN_MEDIA && !b.folder
                  ? <Button asChild><Link to="/media/folders" className="no-underline"><FolderPlus />Make a media folder</Link></Button>
                  : <ActionButton size="default" variant="default" icon={FolderPlus} onClick={() => make(b.folder ?? '')}>Make a media folder in {siteLabel(b.folder ?? '')}</ActionButton>}
                {limitedTo === null && !(NO_MAIN_MEDIA && !b.folder) && <InlineLink to="/media/folders">Or somewhere else</InlineLink>}
              </div>
            </div>
          ) : <Browser b={b} go={go} sites={withMedia} reserved={reserved} />}

          <Collapsible summary={<><Trash2 className="size-4" />Trash</>} onToggle={setTrashOpen}>
            <p className="mb-3 text-muted-foreground">Media you moved to the trash. Restore it within 30 days (with its tags and categories); after that it's deleted for good.</p>
            {trashOpen && <MediaTrash />}
          </Collapsible>
        </div>
      )}
    </Page>
  );
}

// The toolbar's second row: kind, search, filters, order, and Grid | Table.
function Toolbar({ b, go, view, setView, full, setFull }: {
  b: Browse; go: (p: Partial<Browse>, replace?: boolean) => void; view: View; setView: (v: View) => void; full: boolean; setFull: (on: boolean) => void;
}) {
  const [q, setQ] = useState(b.q);
  useEffect(() => { setQ(b.q); }, [b.q]);
  useEffect(() => {
    if (q === b.q) return;
    const t = setTimeout(() => go({ q: q.trim() ? q : '' }, true), 350);
    return () => clearTimeout(t);
  }, [q]);                                  // eslint-disable-line react-hooks/exhaustive-deps
  const labels = useApi<{ labels: MediaLabel[] }>(`/api/media/labels${b.folder !== null ? `?scope=${encodeURIComponent(scopeOf(b.folder))}` : ''}`);
  const of = (t: 'tag' | 'category') => (labels.data?.labels ?? []).filter((l) => l.type === t);
  const name = (l: MediaLabel) => (b.folder === null ? l.address : l.type === 'tag' ? `#${l.name}` : l.name);
  const kinds: [MediaKind | null, string][] = [[null, 'All'], ...MEDIA_KINDS];
  const filtered = !!(b.q || b.tags.length || b.categories.length);

  return (
    <div className="space-y-3">
      <nav aria-label="Kinds of media" className="flex gap-1 overflow-x-auto border-b border-border">
        {kinds.map(([k, label]) => {
          const Icon = k ? KIND_ICONS[k] : null;
          return (
            <Link key={label} to={browseHref({ ...b, kind: k, inner: '', page: 1 })} aria-current={k === b.kind ? 'page' : undefined}
              className={cn('-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 py-2.5 text-sm font-medium no-underline sm:gap-2 sm:px-4',
                k === b.kind ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
              {Icon && <Icon className="hidden size-4 sm:block" />}{label}
            </Link>
          );
        })}
      </nav>
      <div className="flex flex-wrap items-end gap-2">
        <div className="relative min-w-48 flex-1">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={b.inner ? 'Find by name in this folder' : 'Find by name'}
            aria-label="Find by name" className="pl-8" />
        </div>
        <LabelFilter label="Tag" labels={of('tag')} selected={b.tags} nameOf={name} onChange={(tags) => go({ tags })} />
        <LabelFilter label="Category" labels={of('category')} selected={b.categories} nameOf={name} onChange={(categories) => go({ categories })} />
        <NativeSelect aria-label="Order" value={`${b.sort}-${b.desc ? 'desc' : 'asc'}`} className="w-auto"
          onChange={(e) => { const [s, d] = e.target.value.split('-'); go({ sort: s as Browse['sort'], desc: d === 'desc' }); }}>
          {SORTS.map(([label, s, d]) => <option key={label} value={`${s}-${d ? 'desc' : 'asc'}`}>{label}</option>)}
        </NativeSelect>
        {filtered && <Button variant="ghost" size="sm" className="h-9" onClick={() => { setQ(''); go({ q: '', tags: [], categories: [] }); }}><X />Clear</Button>}
        <div role="radiogroup" aria-label="Show as" className="ml-auto inline-flex rounded-md border border-border bg-muted/50 p-0.5">
          {([['grid', 'Grid', LayoutGrid], ['table', 'Table', ListIcon]] as const).map(([v, label, Icon]) => (
            <button key={v} type="button" role="radio" aria-checked={view === v} onClick={() => setView(v)}
              className={cn('inline-flex h-8 items-center gap-1.5 rounded px-3 text-sm font-medium',
                view === v ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
              <Icon className="size-4" />{label}
            </button>
          ))}
        </div>
        <FullScreenButton on={full} onChange={setFull} />
      </div>
    </div>
  );
}

function Browser({ b, go, sites, reserved }: { b: Browse; go: (p: Partial<Browse>, replace?: boolean) => void; sites: MediaSite[]; reserved: string[] }) {
  const navigate = useNavigate();
  const dialogs = useDialogs();
  const run = useAction();
  const qc = useQueryClient();
  const [view, setViewState] = useState<View>(() => pref('view', 'grid', ['grid', 'table'] as const));
  const [full, setFull] = useFullScreen();
  const setView = (v: View) => { setViewState(v); setPref('view', v); };
  const list = useApi<MediaItems>(itemsUrl(b), { placeholderData: (prev) => prev, meta: { quiet: true } });
  const scopes = useApi<{ scopes: TagScope[] }>(b.folder !== null ? `/api/media/scopes?tree=${encodeURIComponent(scopeOf(b.folder))}` : null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const [details, setDetails] = useState<MediaItem | null>(null);
  const [moving, setMoving] = useState<{ items: MediaItem[]; mode: 'move' | 'copy' } | null>(null);
  const [labeling, setLabeling] = useState<MediaItem[] | null>(null);
  const [bucketMove, setBucketMove] = useState<string | null>(null);
  const dir = browseDir(b);
  const isBrowsing = browsing(b);
  const steps = b.inner ? b.inner.split('/') : [];

  // a new view: nothing chosen
  useEffect(() => { setSelected(new Set()); }, [itemsUrl(b)]);     // eslint-disable-line react-hooks/exhaustive-deps
  // a folder inside that isn't there (any more): back to the top
  useEffect(() => {
    if (!list.error) return;
    if (list.error instanceof ApiError && list.error.status === 404 && b.inner) navigate(browseHref({ ...b, inner: '', page: 1 }), { replace: true });
    else notify(friendlyError(list.error), 'error');
  }, [list.error]);                         // eslint-disable-line react-hooks/exhaustive-deps

  const data = list.data;
  const items = data?.items ?? [];
  const chosen = items.filter((i) => selected.has(i.id));
  const allOn = items.length > 0 && items.every((i) => selected.has(i.id));
  const select = (id: number, on: boolean) => setSelected((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  const selectPage = (on: boolean) => setSelected(on ? new Set(items.map((i) => i.id)) : new Set());

  // ------------------------------------------------ what can be done to files
  const trash = async (its: MediaItem[]) => {
    const one = its.length === 1 ? its[0]! : null;
    const ok = await dialogs.confirm({
      title: one ? `Move "${one.name}" to the trash?` : `Move ${its.length} files to the trash?`, action: 'Move to trash', danger: true,
      body: <><p>Pages that use {one ? 'it' : 'them'} will show {one ? 'it' : 'them'} as missing. You can restore {one ? 'it' : 'them'} for 30 days, with tags and categories.</p>{SITE.front === 'cloudflare' && <p>Cloudflare may keep showing old copies at their addresses for up to 4 hours.</p>}</>,
    });
    if (!ok) return;
    clearNotice();
    let done = 0;
    const failed: string[] = [];
    for (const it of its) {
      try { await api('/api/media/trash', { path: it.path }); done++; } catch (err) {
        if (err instanceof ApiError && err.status === 401) return signedOut();
        failed.push(`${it.name} (${friendlyError(err)})`);
      }
    }
    setSelected(new Set());
    await qc.invalidateQueries();
    notify(failed.length ? `${done} moved to the trash; not: ${failed.join(', ')}` : one ? `"${one.name}" moved to the trash.` : `${done} files moved to the trash.`, failed.length ? 'error' : 'ok');
  };
  const actions: ItemActions = {
    open: setDetails,
    rename: async (it) => {
      const n = await dialogs.prompt({ title: `Rename "${it.name}"`, label: 'New name', value: it.name, action: 'Rename' });
      if (!n || n === it.name) return;
      await run(() => api('/api/media/move', { from: it.path, to: parentOf(it.path), name: n }), `Renamed to "${n.trim()}".`);
    },
    move: (its, mode) => setMoving({ items: its, mode }),
    labels: setLabeling,
    trash,
  };

  // ------------------------------------------------ uploads
  // Into the folder being browsed; otherwise each file to the top of its own kind.
  const target = (f: File): { dir: string; kind: MediaKind } | null => {
    if (b.folder === null) return null;
    if (isBrowsing && dir) return { dir, kind: b.kind! };
    const kind = b.kind ?? kindForFile(f.name);
    return { dir: [b.folder, 'media', kind].filter(Boolean).join('/'), kind };
  };
  const upload = async (files: File[]) => {
    if (!files.length || b.folder === null) return;
    clearNotice();
    const rows: Upload[] = files.map((f) => ({ id: uploadId++, name: f.name, progress: 0, state: 'waiting', status: 'waiting' }));
    setUploads(rows);
    const set = (id: number, patch: Partial<Upload>) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    let done = 0;
    let problems = 0;
    for (const [i, file] of files.entries()) {
      const id = rows[i]!.id;
      const t = target(file)!;
      if (!kindFits(t.kind, file.name)) {
        set(id, { status: 'failed', state: t.kind === 'files' ? "web pages and scripts can't go here" : `not ${t.kind === 'images' ? 'an image' : t.kind === 'audio' ? 'an audio file' : 'a video'}` });
        problems++; continue;
      }
      if (file.size > MAX_UPLOAD) { set(id, { status: 'failed', state: `over ${sizeWords(MAX_UPLOAD)}: use WinSCP` }); problems++; continue; }
      set(id, { status: 'uploading', state: 'uploading' });
      try {
        const r = await sendFile(file, t.dir, (p) => set(id, { progress: p, state: `${Math.round(p * 100)}%` }));
        set(id, { status: 'ok', progress: 1, state: r.renamed ? `done, saved as ${r.name}` : 'done' });
        done++;
      } catch (err) {
        if ((err as { status?: number }).status === 401) return signedOut();
        set(id, { status: 'failed', state: (err as Error).message });
        problems++;
      }
    }
    notify(problems ? `${done} uploaded; ${problems} couldn't be (see the list).` : `${done} file${done === 1 ? '' : 's'} uploaded.`, problems ? 'error' : 'ok');
    if (!problems) setTimeout(() => setUploads([]), 4000);
    await qc.invalidateQueries();
  };
  const canUpload = b.folder !== null;
  const onDrag = canUpload ? {
    onDragEnter: (e: DragEvent) => { if (!e.dataTransfer.types.includes('Files')) return; e.preventDefault(); depth.current++; setDragging(true); },
    onDragOver: (e: DragEvent) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); },
    onDragLeave: () => { if (--depth.current <= 0) { depth.current = 0; setDragging(false); } },
    onDrop: (e: DragEvent) => {
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      void upload([...e.dataTransfer.files]);
    },
  } : {};

  // ------------------------------------------------ folders inside
  const bucketMenu = (name: string) => {
    const path = `${dir}/${name}`;
    const sc = folderToScope(path);
    const defined = scopes.data?.scopes.find((s) => s.path === sc);
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="ghost" className="mr-1 size-9" aria-label={`More for ${name}`}><Ellipsis /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={async () => {
            const n = await dialogs.prompt({ title: `Rename the folder "${name}"`, label: 'New name', value: name, action: 'Rename' });
            if (n && n !== name) await run(() => api('/api/media/move', { from: path, to: dir, name: n }), `Renamed to "${n.trim()}".`);
          }}><Pencil />Rename</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setBucketMove(path)}><FolderInput />Move to…</DropdownMenuItem>
          {!defined && (
            <DropdownMenuItem onSelect={async () => {
              await run(() => api('/api/media/scopes', { path }), `"${name}" is now a tag scope. Tags you make there stay with files in this folder.`);
            }}><BookmarkPlus />Use as a tag scope</DropdownMenuItem>
          )}
          {defined && !defined.automatic && (
            <DropdownMenuItem onSelect={async () => {
              await run(() => api('/api/media/scopes/delete', { path: sc }), `"${name}" is no longer a tag scope.`);
            }}><BookmarkX />Stop using as a tag scope</DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={async () => {
            if (!await dialogs.confirm({ title: `Move the folder "${name}" to the trash?`, body: 'Everything in it goes too. You can restore it for 30 days.', action: 'Move to trash', danger: true })) return;
            await run(() => api('/api/media/trash', { path }), `"${name}" moved to the trash.`);
          }}><Trash2 />Move to trash</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  const where = b.folder === null ? 'all media folders' : siteLabel(b.folder);
  const showSite = b.folder === null;
  const from = (data?.offset ?? 0) + 1;
  const to = (data?.offset ?? 0) + items.length;
  const summary = useMemo(() => {
    if (!data) return '';
    const what = b.kind ? kindLabel(b.kind).toLowerCase() : 'files';
    const n = data.total === 1 ? `1 ${b.kind ? what.replace(/s$/, '') : 'file'}` : `${data.total} ${what}`;
    return `${n} in ${where}${b.q ? ` matching "${b.q}"` : ''}`;
  }, [data, b.kind, b.q, where]);

  return (
    <FullScreenArea on={full} label="Media files" className="space-y-4">
      <Toolbar b={b} go={go} view={view} setView={setView} full={full} setFull={setFull} />
      <div {...onDrag} className={cn('relative space-y-4 rounded-lg border border-border bg-card p-3 shadow-card sm:p-5', dragging && 'border-2 border-dashed border-primary bg-accent/40')}>
        <div className="flex flex-wrap items-center gap-3">
          {isBrowsing ? (
            <nav aria-label="Folders" className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-[1.05rem]">
              <Link to={browseHref({ ...b, inner: '', page: 1 })} className="flex items-center gap-1.5 font-semibold no-underline"><FolderOpen className="size-5" />{kindLabel(b.kind!)}</Link>
              {steps.map((step, i) => (
                <span key={i} className="flex items-center gap-1">
                  <span aria-hidden className="text-muted-foreground">›</span>
                  {i === steps.length - 1 ? <strong aria-current="page">{step}</strong> : <Link to={browseHref({ ...b, inner: steps.slice(0, i + 1).join('/'), page: 1 })}>{step}</Link>}
                </span>
              ))}
            </nav>
          ) : <p className="min-w-0 flex-1 font-semibold" aria-live="polite">{summary}</p>}
          <div className="flex flex-wrap gap-2">
            {isBrowsing && steps.length > 0 && <Button asChild size="sm" variant="ghost"><Link to={browseHref({ ...b, inner: steps.slice(0, -1).join('/'), page: 1 })} className="no-underline"><CornerLeftUp />Up</Link></Button>}
            {isBrowsing && (
              <ActionButton icon={FolderPlus} onClick={async () => {
                const name = await dialogs.prompt({ title: `New folder in ${[kindLabel(b.kind!), ...steps].join(' › ')}`, label: 'Name', action: 'Make folder', hint: 'For tidy addresses, use lowercase letters and hyphens, like "2026-trip".' });
                if (name) await run(() => api('/api/media/mkdir', { dir, name }), `Folder "${name.trim()}" made.`);
              }}>New folder</ActionButton>
            )}
            {canUpload && <>
              <Button size="sm" onClick={() => input.current?.click()}><Upload />Upload</Button>
              <input ref={input} type="file" multiple hidden data-testid="media-upload"
                accept={b.kind && b.kind !== 'files' ? KIND_EXTENSIONS[b.kind].map((x) => `.${x}`).join(',') : undefined}
                onChange={(e) => { void upload([...(e.target.files ?? [])]); e.target.value = ''; }} />
            </>}
          </div>
        </div>
        {canUpload && !isBrowsing && <p className="-mt-2 text-sm text-muted-foreground">Uploads go to the top of {b.kind ? kindLabel(b.kind).toLowerCase() : 'images, audio, video or files, by their type,'} in {siteLabel(b.folder!)}.</p>}

        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-lg bg-card/85 text-lg font-semibold text-primary">
            <span className="flex items-center gap-2"><Upload />Drop to upload</span>
          </div>
        )}

        {uploads.length > 0 && (
          <ul aria-label="Uploads" className="space-y-2 rounded-lg border border-border p-3">
            {uploads.map((u) => (
              <li key={u.id} data-status={u.status} className="grid items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,14rem)_1fr_minmax(0,16rem)]">
                <span className="truncate font-semibold">{u.name}</span>
                <Progress value={u.progress * 100} className={cn(u.status === 'failed' && '[&>div]:bg-destructive')} aria-label={`${u.name} upload`} />
                <span className={cn('text-sm', u.status === 'failed' ? 'font-semibold text-destructive' : u.status === 'ok' ? 'text-success' : 'text-muted-foreground')}>{u.state}</span>
              </li>
            ))}
          </ul>
        )}

        <SelectionBar count={chosen.length} onClear={() => selectPage(false)} onPage={() => selectPage(!allOn)} allOnPage={allOn}>
          <Button size="sm" variant="outline" onClick={() => setLabeling(chosen)}><Tags />Tags…</Button>
          <Button size="sm" variant="outline" onClick={() => setMoving({ items: chosen, mode: 'move' })}><FolderInput />Move to…</Button>
          <Button size="sm" variant="outline" onClick={() => setMoving({ items: chosen, mode: 'copy' })}><CopyPlus />Copy to…</Button>
          <Button size="sm" variant="danger" onClick={() => void trash(chosen)}><Trash2 />Move to trash</Button>
        </SelectionBar>

        {!data ? <Loading rows={2} /> : <>
          {isBrowsing && <FolderTiles folders={data.folders} href={(n) => browseHref({ ...b, inner: [b.inner, n].filter(Boolean).join('/'), page: 1 })} menu={bucketMenu} />}
          {items.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-5 py-8 text-center text-muted-foreground">
              {b.q || b.tags.length || b.categories.length ? 'Nothing matches.' : isBrowsing && data.folders.length ? 'No files here, only folders.'
                : canUpload ? 'Nothing here yet. Click Upload, or drag files onto this box.' : 'No files yet.'}
            </p>
          ) : view === 'grid'
            ? <MediaGrid items={items} actions={actions} reserved={reserved} selected={selected} onSelect={select} showSite={showSite} showWhere={!isBrowsing} />
            : <MediaTable items={items} actions={actions} reserved={reserved} selected={selected} onSelect={select} showSite={showSite} showWhere={!isBrowsing}
                browse={b} onSort={(sort, desc) => go({ sort, desc })} allOn={allOn} onAll={selectPage} />}
          {data.total > data.limit && (
            <nav aria-label="Pages" className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm text-muted-foreground">{from}–{to} of {data.total}</span>
              <span className="flex gap-2">
                <Button size="sm" variant="outline" disabled={b.page <= 1} onClick={() => go({ page: b.page - 1 })}>Previous</Button>
                <Button size="sm" variant="outline" disabled={to >= data.total} onClick={() => go({ page: b.page + 1 })}>Next</Button>
              </span>
            </nav>
          )}
        </>}
      </div>

      <FileDetails it={details} reserved={reserved} actions={actions} onClose={() => setDetails(null)} />
      {moving && <MoveOrCopy key={moving.items.map((i) => i.id).join() + moving.mode} {...moving} sites={sites} onClose={() => { setMoving(null); setSelected(new Set()); }} />}
      {labeling && <LabelEditor items={labeling} onClose={() => { setLabeling(null); }} />}
      {bucketMove && <BucketMove path={bucketMove} sites={sites} onClose={() => setBucketMove(null)} />}
    </FullScreenArea>
  );
}

// A folder (with everything in it) to another place in the same kind, in any media folder.
function BucketMove({ path, sites, onClose }: { path: string; sites: MediaSite[]; onClose: () => void }) {
  const run = useAction();
  const parts = path.split('/');
  const at = parts.indexOf('media');
  const kind = parts[at + 1] as MediaKind;
  const name = parts[parts.length - 1]!;
  const [site, setSite] = useState(parts.slice(0, at).join('/'));
  const [inside, setInside] = useState('');
  const dir = [site, 'media', kind].filter(Boolean).join('/');
  const buckets = useApi<{ buckets: string[] }>(`/api/media/buckets?dir=${encodeURIComponent(dir)}`);
  useEffect(() => { setInside(''); }, [dir]);
  const choices = (buckets.data?.buckets ?? []).filter((x) => !`${dir}/${x}/`.startsWith(`${path}/`));
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <form className="contents" onSubmit={async (e) => {
          e.preventDefault();
          const to = [dir, inside].filter(Boolean).join('/');
          if (await run(() => api<{ path: string }>('/api/media/move', { from: path, to, name }), (r) => `Moved to ${r.path}.`)) onClose();
        }}>
          <DialogHeader>
            <DialogTitle>Move the folder "{name}"</DialogTitle>
            <DialogDescription>Everything in it goes too. A folder of {kindLabel(kind).toLowerCase()} stays in {kindLabel(kind).toLowerCase()}.</DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-4">
            <Field label="Media folder" htmlFor="bm-site">
              <NativeSelect id="bm-site" value={site} onChange={(e) => setSite(e.target.value)}>
                {sites.map((f) => <option key={f.folder} value={f.folder}>{siteLabel(f.folder)}</option>)}
              </NativeSelect>
            </Field>
            <Field label="Inside" htmlFor="bm-inside">
              <NativeSelect id="bm-inside" value={inside} onChange={(e) => setInside(e.target.value)}>
                <option value="">(the top of {kindLabel(kind).toLowerCase()})</option>
                {choices.map((x) => <option key={x} value={x}>{x.split('/').join(' › ')}</option>)}
              </NativeSelect>
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit"><FolderInput />Move here</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
