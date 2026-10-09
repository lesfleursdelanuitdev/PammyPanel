// File Explorer: every file under the website, with the same Media styling
// (grid/table, thumbs, tags, move/copy, upload, trash) plus an address bar and
// a folder tree that slides in from the left. Media is the media-folder filter
// over the same records.
import { useQueryClient } from '@tanstack/react-query';
import {
  BookmarkPlus, BookmarkX, ChevronRight, CopyPlus, CornerLeftUp, Ellipsis, FilePlus, Folder, FolderInput, FolderPlus, FolderTree,
  LayoutGrid, List as ListIcon, PanelLeft, PanelLeftClose, Pencil, Search, Tags, Trash2, Upload, X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { NewFileDialog } from '../components/editor/new-file';
import { SoftwareFiles } from '../components/software-files';
import { FileDetails } from '../components/media/details';
import { FullScreenArea, FullScreenButton, useFullScreen } from '../components/media/full-screen';
import { CheckForChanges, MediaTrash, OutOfPlace } from '../components/media/extras';
import { FolderTiles, MediaGrid, MediaTable, SelectionBar, type ItemActions } from '../components/media/items';
import { LabelEditor } from '../components/media/label-editor';
import { LabelFilter } from '../components/media/label-filter';
import { ActionButton, Collapsible, Field, Loading, Page } from '@panel/core/web/components/page';
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
import { FILE_KINDS, FILES_DEFAULTS, filesBrowsing, filesHref, filesItemsUrl, folderToScope, kindLabel, MAX_UPLOAD, parentOf, pref, readFilesBrowse, sendFile, setPref, type FilesBrowse } from '../lib/media';
import { editorHref, isEditable } from '../lib/editor';
import { clearNotice, notify } from '@panel/core/web/lib/status';
import type { FileKind, MediaItem, MediaItems, MediaLabel, MediaSyncInfo, TagScope } from '../lib/types';
import type { SitesData } from '@panel/core/web/lib/types';
import { cn } from '@panel/core/web/lib/utils';
import { SITE, sizeWords, W } from '@panel/core/web/lib/site';

type Upload = { id: number; name: string; progress: number; state: string; status: 'waiting' | 'uploading' | 'ok' | 'failed' };
let uploadId = 1;
type View = 'grid' | 'table';
const SORTS: [string, FilesBrowse['sort'], boolean][] = [
  ['Name, A to Z', 'name', false], ['Name, Z to A', 'name', true], ['Newest first', 'added', true], ['Oldest first', 'added', false],
  ['Biggest first', 'size', true], ['Smallest first', 'size', false],
];

// roots: what File Explorer can show this person (docs/catalog-plan.md step 3): the website,
// and each installed software's wp-content/ for someone not kept to places
type FilesRoot = { root: string | null; roots: { id: string; label: string; kind: 'website' | 'software' }[]; dirs: string[]; sync: MediaSyncInfo | null; limitedTo: string[] | null };

export default function Files() {
  usePageTitle('File Explorer');
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const me = useMe();
  // (Subdomains' names, where folders are subdomains; lfdln has no such page)
  const sitesInfo = useApi<SitesData>(SITE.folderSubdomains && me && may(me, 'subdomains') ? '/api/sites' : null, { staleTime: 60_000 });
  const reserved = sitesInfo.data?.reserved ?? [];
  const rootId = params.get('root') ?? '';
  const soft = rootId !== '' && rootId !== 'website';
  const root = useApi<FilesRoot>(soft ? `/api/files?root=${encodeURIComponent(rootId)}` : '/api/files');
  const [trashOpen, setTrashOpen] = useState(false);
  // a person kept to places (D22) is always in one of them: the one the address is in, else the first
  const places = root.data?.limitedTo ?? (me?.places.length ? me.places.filter((p) => p.startsWith('/')).map((p) => p.slice(1)) : null);
  const inPlace = (path: string) => places?.find((pl) => path === pl || path.startsWith(`${pl}/`)) ?? null;
  const b0 = readFilesBrowse(params, places?.[0] ?? '');
  const limitedTo = places === null ? null : inPlace(b0.path) ?? places[0] ?? null;
  const b = limitedTo !== null && inPlace(b0.path) === null ? { ...b0, path: limitedTo } : b0;
  const go = (patch: Partial<FilesBrowse>, replace = false) => navigate(filesHref({ ...b, page: 1, ...patch }), { replace });
  const roots = root.data?.roots ?? [];
  // kept only to installed software (docs/catalog-plan.md step 3b): straight to its files
  const firstSoftware = !soft && root.data?.root === null ? roots[0]?.id : undefined;
  useEffect(() => { if (firstSoftware) navigate(`/files?root=${encodeURIComponent(firstSoftware)}`, { replace: true }); }, [firstSoftware]); // eslint-disable-line react-hooks/exhaustive-deps
  const here = roots.find((r) => r.id === (soft ? rootId : 'website'));
  const picker = roots.length > 1 && (
    <label className="flex flex-wrap items-center gap-2 text-sm">
      <span className="font-medium">Showing</span>
      <NativeSelect value={soft ? rootId : 'website'} onChange={(e) => navigate(e.target.value === 'website' ? '/files' : `/files?root=${encodeURIComponent(e.target.value)}`)} className="w-auto">
        {roots.map((r) => <option key={r.id} value={r.id}>{r.kind === 'website' ? W.website.title : `${r.label}: wp-content`}</option>)}
      </NativeSelect>
    </label>
  );

  if (firstSoftware || (root.data && root.data.root === null && !soft)) {
    return <Page wide title="File Explorer">{root.data && !roots.length ? <p className="text-muted-foreground">There are no files here for you yet.</p> : <Loading />}</Page>;
  }
  if (soft) {
    return (
      <Page wide title="File Explorer" intro={here ? `The files of ${here.label}.` : undefined}>
        {!root.data ? <Loading /> : (
          <div className="space-y-5">
            {picker}
            <SoftwareFiles root={rootId} label={here?.label ?? rootId} path={b0.path} dirs={root.data.dirs}
              go={(path) => navigate(filesHref({ ...FILES_DEFAULTS, root: rootId, path }))} />
          </div>
        )}
      </Page>
    );
  }

  return (
    <Page wide title="File Explorer" intro={`Every file in ${W.website.your}. The Media tab is the same library, showing only media/images, media/files, media/audio and media/video.`}>
      {!root.data ? <Loading /> : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">{picker || <span />}<CheckForChanges sync={root.data.sync} url="/api/files/sync" /></div>
          {root.data.sync && <OutOfPlace sync={root.data.sync} />}
          <Explorer b={b} go={go} dirs={root.data.dirs} reserved={reserved} limitedTo={limitedTo} places={places ?? []} />
          <Collapsible summary={<><Trash2 className="size-4" />Trash</>} onToggle={setTrashOpen}>
            <p className="mb-3 text-muted-foreground">Files you moved to the trash. Restore them within 30 days (with tags and categories); after that they're deleted for good.</p>
            {trashOpen && <MediaTrash url="/api/files/trash" />}
          </Collapsible>
        </div>
      )}
    </Page>
  );
}

function Explorer({ b, go, dirs, reserved, limitedTo, places }: {
  b: FilesBrowse; go: (p: Partial<FilesBrowse>, replace?: boolean) => void; dirs: string[]; reserved: string[]; limitedTo: string | null; places: string[];
}) {
  const navigate = useNavigate();
  const dialogs = useDialogs();
  const run = useAction();
  const qc = useQueryClient();
  const [view, setViewState] = useState<View>(() => pref('files-view', 'grid', ['grid', 'table'] as const));
  const [full, setFull] = useFullScreen();
  const setView = (v: View) => { setViewState(v); setPref('files-view', v); };
  // (on a phone the folders start hidden: beside the files they leave too little room)
  const [treeOpen, setTreeOpen] = useState(() => pref('files-tree', window.matchMedia('(min-width: 768px)').matches ? '1' : '0', ['0', '1'] as const) !== '0');
  const toggleTree = () => { const on = !treeOpen; setTreeOpen(on); setPref('files-tree', on ? '1' : '0'); };
  const list = useApi<MediaItems>(filesItemsUrl(b), { placeholderData: (prev) => prev, meta: { quiet: true } });
  const scopes = useApi<{ scopes: TagScope[] }>(`/api/media/scopes?tree=${encodeURIComponent(folderToScope(limitedTo || b.path.split('/')[0] || ''))}`);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const [details, setDetails] = useState<MediaItem | null>(null);
  const [moving, setMoving] = useState<{ items: MediaItem[]; mode: 'move' | 'copy' } | null>(null);
  const [labeling, setLabeling] = useState<MediaItem[] | null>(null);
  const [bucketMove, setBucketMove] = useState<string | null>(null);
  const [newFile, setNewFile] = useState(false);
  const [addr, setAddr] = useState(b.path);
  const isBrowsing = filesBrowsing(b);
  const steps = b.path ? b.path.split('/') : [];

  useEffect(() => { setAddr(b.path); }, [b.path]);
  useEffect(() => { setSelected(new Set()); }, [filesItemsUrl(b)]);     // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!list.error) return;
    if (list.error instanceof ApiError && list.error.status === 404 && b.path) navigate(filesHref({ ...b, path: parentOf(b.path), page: 1 }), { replace: true });
    else notify(friendlyError(list.error), 'error');
  }, [list.error]);                         // eslint-disable-line react-hooks/exhaustive-deps

  const data = list.data;
  const items = data?.items ?? [];
  const chosen = items.filter((i) => selected.has(i.id));
  const allOn = items.length > 0 && items.every((i) => selected.has(i.id));
  const select = (id: number, on: boolean) => setSelected((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  const selectPage = (on: boolean) => setSelected(on ? new Set(items.map((i) => i.id)) : new Set());

  const trash = async (its: MediaItem[]) => {
    const one = its.length === 1 ? its[0]! : null;
    const ok = await dialogs.confirm({
      title: one ? `Move "${one.name}" to the trash?` : `Move ${its.length} files to the trash?`, action: 'Move to trash', danger: true,
      body: <><p>Pages that use {one ? 'it' : 'them'} will show {one ? 'it' : 'them'} as missing. You can restore {one ? 'it' : 'them'} for 30 days, with tags and categories.</p></>,
    });
    if (!ok) return;
    clearNotice();
    let done = 0;
    const failed: string[] = [];
    for (const it of its) {
      try { await api('/api/files/trash', { path: it.path }); done++; } catch (err) {
        if (err instanceof ApiError && err.status === 401) return signedOut();
        failed.push(`${it.name} (${friendlyError(err)})`);
      }
    }
    setSelected(new Set());
    await qc.invalidateQueries();
    notify(failed.length ? `${done} moved to the trash; not: ${failed.join(', ')}` : one ? `"${one.name}" moved to the trash.` : `${done} files moved to the trash.`, failed.length ? 'error' : 'ok');
  };
  // a text file opens in the editor (docs/editor-plan.md); anything else in the details
  const edit = (it: MediaItem) => navigate(editorHref(it.path));
  const actions: ItemActions = {
    open: (it) => (isEditable(it.name) ? edit(it) : setDetails(it)),
    edit,
    details: setDetails,
    rename: async (it) => {
      const n = await dialogs.prompt({ title: `Rename "${it.name}"`, label: 'New name', value: it.name, action: 'Rename' });
      if (!n || n === it.name) return;
      await run(() => api('/api/files/move', { from: it.path, to: parentOf(it.path), name: n }), `Renamed to "${n.trim()}".`);
    },
    move: (its, mode) => setMoving({ items: its, mode }),
    labels: setLabeling,
    trash,
  };

  const upload = async (files: File[]) => {
    if (!files.length) return;
    clearNotice();
    const rows: Upload[] = files.map((f) => ({ id: uploadId++, name: f.name, progress: 0, state: 'waiting', status: 'waiting' }));
    setUploads(rows);
    const set = (id: number, patch: Partial<Upload>) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    let done = 0;
    let problems = 0;
    for (const [i, file] of files.entries()) {
      const id = rows[i]!.id;
      if (file.size > MAX_UPLOAD) { set(id, { status: 'failed', state: `over ${sizeWords(MAX_UPLOAD)}: use WinSCP` }); problems++; continue; }
      set(id, { status: 'uploading', state: 'uploading' });
      try {
        const r = await sendFile(file, b.path, (p) => set(id, { progress: p, state: `${Math.round(p * 100)}%` }), '/api/files/upload');
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
  const onDrag = {
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
  };

  const folderMenu = (name: string) => {
    const path = [b.path, name].filter(Boolean).join('/');
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
            if (n && n !== name) await run(() => api('/api/files/move', { from: path, to: b.path, name: n }), `Renamed to "${n.trim()}".`);
          }}><Pencil />Rename</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setBucketMove(path)}><FolderInput />Move to…</DropdownMenuItem>
          {!defined && (
            <DropdownMenuItem onSelect={async () => {
              await run(() => api('/api/media/scopes', { path }), `"${name}" is now a tag scope.`);
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
            await run(() => api('/api/files/trash', { path }), `"${name}" moved to the trash.`);
          }}><Trash2 />Move to trash</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  const goAddr = (e?: FormEvent) => {
    e?.preventDefault();
    const path = addr.split('/').filter((x) => x && x !== '.' && x !== '..').join('/');
    go({ path, ...FILES_DEFAULTS });
  };

  const from = (data?.offset ?? 0) + 1;
  const to = (data?.offset ?? 0) + items.length;
  const summary = useMemo(() => {
    if (!data) return '';
    const what = b.kind ? kindLabel(b.kind).toLowerCase() : 'files';
    const n = data.total === 1 ? `1 file` : `${data.total} ${what}`;
    return `${n}${b.q ? ` matching "${b.q}"` : ''}`;
  }, [data, b.kind, b.q]);

  const [q, setQ] = useState(b.q);
  useEffect(() => { setQ(b.q); }, [b.q]);
  useEffect(() => {
    if (q === b.q) return;
    const t = setTimeout(() => go({ q: q.trim() ? q : '' }, true), 350);
    return () => clearTimeout(t);
  }, [q]);                                  // eslint-disable-line react-hooks/exhaustive-deps
  // every label a file here or further down can have (its folder's, those above it, those below)
  const labels = useApi<{ labels: MediaLabel[] }>(`/api/media/labels?around=${encodeURIComponent(b.path)}`);
  const of = (t: 'tag' | 'category') => (labels.data?.labels ?? []).filter((l) => l.type === t);

  return (
    <FullScreenArea on={full} label={`${W.website.title} files`} className="relative flex gap-0">
      <aside className={cn(
        'shrink-0 overflow-hidden border-r border-border bg-card transition-[width,margin] duration-200',
        treeOpen ? 'w-60 mr-4' : 'w-0 mr-0 border-r-0',
      )} aria-hidden={!treeOpen}>
        <div className="w-60 p-3">
          <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><FolderTree className="size-4" />Folders</p>
          {places.length > 1 && (
            <NativeSelect aria-label="Which of your folders" value={limitedTo ?? ''} className="mb-2 h-8 text-sm"
              onChange={(e) => go({ path: e.target.value, ...FILES_DEFAULTS })}>
              {places.map((pl) => <option key={pl} value={pl}>{pl}</option>)}
            </NativeSelect>
          )}
          <FolderTreeList dirs={dirs} current={b.path} root={limitedTo ?? ''} onPick={(path) => go({ path, ...FILES_DEFAULTS })} />
        </div>
      </aside>
      <div className="min-w-0 flex-1 space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <Button size="sm" variant="outline" onClick={toggleTree} aria-pressed={treeOpen} aria-label={treeOpen ? 'Hide folders' : 'Show folders'}>
            {treeOpen ? <PanelLeftClose /> : <PanelLeft />}{treeOpen ? 'Hide folders' : 'Folders'}
          </Button>
          <form className="flex min-w-48 flex-1 gap-2" onSubmit={goAddr}>
            <Input value={addr} onChange={(e) => setAddr(e.target.value)} aria-label="Folder address" placeholder="Folder path" className="font-mono text-sm" />
            <Button type="submit" size="sm" variant="outline">Go</Button>
          </form>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="relative min-w-48 flex-1">
            <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find by name" aria-label="Find by name" className="pl-8" />
          </div>
          <NativeSelect aria-label="Kind" value={b.kind ?? ''} className="w-auto" onChange={(e) => go({ kind: (e.target.value || null) as FileKind | null })}>
            <option value="">All kinds</option>
            {FILE_KINDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </NativeSelect>
          <LabelFilter label="Tag" labels={of('tag')} selected={b.tags} nameOf={(l) => `#${l.name}`} onChange={(tags) => go({ tags })} />
          <LabelFilter label="Category" labels={of('category')} selected={b.categories} nameOf={(l) => l.name} onChange={(categories) => go({ categories })} />
          <NativeSelect aria-label="Order" value={`${b.sort}-${b.desc ? 'desc' : 'asc'}`} className="w-auto"
            onChange={(e) => { const [s, d] = e.target.value.split('-'); go({ sort: s as FilesBrowse['sort'], desc: d === 'desc' }); }}>
            {SORTS.map(([label, s, d]) => <option key={label} value={`${s}-${d ? 'desc' : 'asc'}`}>{label}</option>)}
          </NativeSelect>
          {(b.q || b.tags.length || b.categories.length || b.kind) && (
            <Button variant="ghost" size="sm" className="h-9" onClick={() => { setQ(''); go({ q: '', tags: [], categories: [], kind: null }); }}><X />Clear</Button>
          )}
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

        <div {...onDrag} className={cn('relative space-y-4 rounded-lg border border-border bg-card p-3 shadow-card sm:p-5', dragging && 'border-2 border-dashed border-primary bg-accent/40')}>
          <div className="flex flex-wrap items-center gap-3">
            {isBrowsing ? (
              <nav aria-label="Folders" className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-[1.05rem]">
                <Link to={filesHref({ ...b, path: limitedTo ?? '', page: 1 })} className="flex items-center gap-1.5 font-semibold no-underline"><Folder className="size-5" />{W.website.title}</Link>
                {steps.map((step, i) => (
                  <span key={i} className="flex items-center gap-1">
                    <span aria-hidden className="text-muted-foreground">›</span>
                    {i === steps.length - 1 ? <strong aria-current="page">{step}</strong>
                      : <Link to={filesHref({ ...b, path: steps.slice(0, i + 1).join('/'), page: 1 })}>{step}</Link>}
                  </span>
                ))}
              </nav>
            ) : <p className="min-w-0 flex-1 font-semibold" aria-live="polite">{summary}</p>}
            <div className="flex flex-wrap gap-2">
              {isBrowsing && steps.length > 0 && (limitedTo === null || b.path !== limitedTo) && (
                <Button asChild size="sm" variant="ghost"><Link to={filesHref({ ...b, path: parentOf(b.path), page: 1 })} className="no-underline"><CornerLeftUp />Up</Link></Button>
              )}
              {isBrowsing && (
                <ActionButton icon={FolderPlus} onClick={async () => {
                  const name = await dialogs.prompt({ title: 'New folder', label: 'Name', action: 'Make folder' });
                  if (name) await run(() => api('/api/files/mkdir', { dir: b.path, name }), `Folder "${name.trim()}" made.`);
                }}>New folder</ActionButton>
              )}
              {isBrowsing && <Button size="sm" variant="outline" onClick={() => setNewFile(true)}><FilePlus />New file</Button>}
              <Button size="sm" onClick={() => input.current?.click()}><Upload />Upload</Button>
              <input ref={input} type="file" multiple hidden onChange={(e) => { void upload([...(e.target.files ?? [])]); e.target.value = ''; }} />
            </div>
          </div>
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
            {isBrowsing && <FolderTiles folders={data.folders} href={(n) => filesHref({ ...b, path: [b.path, n].filter(Boolean).join('/'), page: 1 })} menu={folderMenu} />}
            {items.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-5 py-8 text-center text-muted-foreground">
                {b.q || b.tags.length || b.categories.length || b.kind ? 'Nothing matches.' : isBrowsing && data.folders.length ? 'No files here, only folders.'
                  : 'Nothing here yet. Click Upload, or drag files onto this box.'}
              </p>
            ) : view === 'grid'
              ? <MediaGrid items={items} actions={actions} reserved={reserved} selected={selected} onSelect={select} showSite={!limitedTo} showWhere={!isBrowsing} />
              : <MediaTable items={items} actions={actions} reserved={reserved} selected={selected} onSelect={select} showSite={!limitedTo} showWhere={!isBrowsing}
                  browse={{ folder: b.path, kind: null, inner: '', q: b.q, tags: b.tags, categories: b.categories, sort: b.sort, desc: b.desc, page: b.page }}
                  onSort={(sort, desc) => go({ sort, desc })} allOn={allOn} onAll={selectPage} />}
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
      </div>
      <FileDetails it={details} reserved={reserved} actions={actions} onClose={() => setDetails(null)} />
      {newFile && <NewFileDialog dir={b.path} hasStyle={items.some((i) => i.name === 'style.css' && parentOf(i.path) === b.path)} onClose={() => setNewFile(false)} />}
      {labeling && <LabelEditor items={labeling} onClose={() => { setLabeling(null); }} />}
      {moving && <PathMove key={moving.items.map((i) => i.id).join() + moving.mode} {...moving} dirs={dirs} current={b.path} onClose={() => { setMoving(null); setSelected(new Set()); }} />}
      {bucketMove && <PathMove items={[{ id: 0, path: bucketMove, name: bucketMove.split('/').pop()!, scope: '', site: '', kind: 'files', folder: '', size: 0, addedAt: 0, modifiedAt: 0, addedBy: null, how: null, fits: true, thumb: null, tags: [], categories: [], title: null, alt: null }]} mode="move" dirs={dirs} current={b.path} folder onClose={() => setBucketMove(null)} />}
    </FullScreenArea>
  );
}

function FolderTreeList({ dirs, current, root, onPick }: { dirs: string[]; current: string; root: string; onPick: (path: string) => void }) {
  const visible = dirs.filter((d) => !root || d === root || d.startsWith(`${root}/`) || d === '');
  const childrenOf = (parent: string) => visible.filter((d) => parentOf(d) === parent && d !== parent).sort((a, b) => a.localeCompare(b));
  const Node = ({ path }: { path: string }) => {
    const kids = childrenOf(path);
    const name = path ? path.split('/').pop()! : W.website.title;
    const on = current === path;
    const inCurrent = current === path || current.startsWith(`${path}/`);
    const [open, setOpen] = useState(inCurrent || !path);
    useEffect(() => { if (inCurrent) setOpen(true); }, [inCurrent]);
    return (
      <li>
        <div className={cn('flex items-center rounded-md', on && 'bg-primary-soft')}>
          {kids.length > 0 ? (
            <button type="button" className="grid size-7 place-items-center text-muted-foreground" aria-label={open ? 'Collapse' : 'Expand'} onClick={() => setOpen((o) => !o)}>
              <ChevronRight className={cn('size-4 transition-transform', open && 'rotate-90')} />
            </button>
          ) : <span className="size-7" />}
          <button type="button" onClick={() => onPick(path)} className={cn('min-w-0 flex-1 truncate px-1 py-1 text-left text-sm', on ? 'font-semibold text-primary' : 'hover:text-foreground')}>
            {name}
          </button>
        </div>
        {open && kids.length > 0 && <ul className="ml-3 border-l border-border pl-1">{kids.map((c) => <Node key={c} path={c} />)}</ul>}
      </li>
    );
  };
  return <ul className="max-h-[70vh] overflow-auto text-sm"><Node path={root} /></ul>;
}

function PathMove({ items, mode, dirs, current, onClose, folder }: {
  items: MediaItem[]; mode: 'move' | 'copy'; dirs: string[]; current: string; onClose: () => void; folder?: boolean;
}) {
  const qc = useQueryClient();
  const one = items.length === 1 ? items[0]! : null;
  const [to, setTo] = useState(current);
  const [newName, setNewName] = useState(one?.name ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const verb = mode === 'copy' ? 'Copy' : 'Move';
  const go = async () => {
    clearNotice();
    const failed: string[] = [];
    let done = 0;
    let last = '';
    for (const [n, it] of items.entries()) {
      setBusy(items.length > 1 ? `${mode === 'copy' ? 'Copying' : 'Moving'} ${n + 1} of ${items.length}…` : '…');
      try {
        const r = await api<{ path: string }>(`/api/files/${mode}`, { from: it.path, to, name: one ? newName.trim() || it.name : it.name });
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
    notify(one ? `${mode === 'copy' ? 'Copied' : 'Moved'} to ${last}.` : `${done} files ${mode === 'copy' ? 'copied' : 'moved'}.`);
    onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent>
        <form onSubmit={(e) => { e.preventDefault(); void go(); }} className="contents">
          <DialogHeader>
            <DialogTitle>{verb} {one ? `"${one.name}"` : `${items.length} files`}</DialogTitle>
            <DialogDescription>{folder ? 'Everything in the folder goes too.' : `Choose a folder in ${W.website.your}.`}</DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-4">
            <Field label="Folder" htmlFor="fm-to">
              <NativeSelect id="fm-to" value={to} onChange={(e) => setTo(e.target.value)}>
                {dirs.map((d) => <option key={d || '/'} value={d}>{d ? d.split('/').join(' › ') : `${W.website.title} (top)`}</option>)}
              </NativeSelect>
            </Field>
            {one && (
              <Field label="Name" htmlFor="fm-name">
                <Input id="fm-name" maxLength={120} autoComplete="off" value={newName} onChange={(e) => setNewName(e.target.value)} />
              </Field>
            )}
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
