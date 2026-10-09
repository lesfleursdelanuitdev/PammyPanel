// File Explorer on a software root (docs/catalog-plan.md step 3): an installed piece of
// software's wp-content/ folder, reached through its own helper. Not catalogued, so no
// tags, thumbnails or search: its folders and files as they are, by path. Upload, new
// folder, rename, move, trash (with its own trash to restore from), download, and the
// editor for text and .php files (.php saved by panel admins only; the server says so).
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Download, Ellipsis, Folder, FolderInput, FolderPlus, Pencil, SquarePen, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { ActionButton, Collapsible, Loading } from '@panel/core/web/components/page';
import { Button } from '@panel/core/web/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@panel/core/web/components/ui/dropdown-menu';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi } from '@panel/core/web/hooks/useApi';
import { useMe } from '@panel/core/web/hooks/useMe';
import { api, formatTime, friendlyError } from '@panel/core/web/lib/api';
import { notify } from '@panel/core/web/lib/status';
import { sizeWords } from '@panel/core/web/lib/site';
import { editorHref, isCode, isEditable } from '../lib/editor';
import { parentOf, rootFileUrl, sendFile } from '../lib/media';

type Listing = { dir: string; folders: { name: string; items: number }[]; files: { path: string; name: string; size: number; modifiedAt: number }[] };
type TrashItem = { id: string; path: string; name: string; isDir: boolean; trashedAt: number; purgeAt: number };

export function SoftwareFiles({ root, label, path, dirs, go }: {
  root: string; label: string; path: string; dirs: string[]; go: (path: string) => void;
}) {
  const me = useMe();
  const admin = me?.role === 'manager';
  const dialogs = useDialogs();
  const run = useAction();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const rq = `root=${encodeURIComponent(root)}`;
  const list = useApi<Listing>(`/api/files/items?${rq}&dir=${encodeURIComponent(path)}`, { placeholderData: (prev) => prev });
  const steps = path ? path.split('/') : [];
  const refresh = () => qc.invalidateQueries();
  const post = (url: string, body: Record<string, unknown>) => api(url, { root, ...body });

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    let done = 0;
    for (const f of [...files]) {
      setUploading(`${f.name}: 0%`);
      try {
        await sendFile(f, path, (p) => setUploading(`${f.name}: ${Math.round(p * 100)}%`), `/api/files/upload?${rq}`);
        done++;
      } catch (err) { notify(`${f.name}: ${friendlyError(err)}`, 'error'); }
    }
    setUploading(null);
    if (done) notify(done === 1 ? 'Uploaded.' : `${done} files uploaded.`);
    void refresh();
  };
  const rename = async (from: string, name: string, folder: boolean) => {
    const n = await dialogs.prompt({ title: `Rename ${folder ? 'folder' : 'file'}`, label: 'New name', value: name, action: 'Rename' });
    if (n && n.trim() && n !== name) await run(() => post('/api/files/move', { from, to: parentOf(from), name: n.trim() }), `Renamed to "${n.trim()}".`);
  };
  const move = async (from: string, name: string) => {
    const to = await dialogs.prompt({
      title: `Move "${name}"`, label: 'To the folder', value: parentOf(from), action: 'Move',
      hint: <>A folder inside wp-content, like <code>themes/my-theme</code>. Empty: wp-content itself.</>,
    });
    if (to === null) return;
    const dest = to.split('/').filter(Boolean).join('/');
    if (dest && !dirs.includes(dest)) { notify(`There's no folder "${dest}".`, 'error'); return; }
    await run(() => post('/api/files/move', { from, to: dest }), `Moved to ${dest || 'wp-content'}.`);
  };
  const trash = async (p: string, name: string) => {
    if (!await dialogs.confirm({
      title: `Move "${name}" to the trash?`, action: 'Move to trash', danger: true,
      body: <p>{label} may stop working if it needs this. You can restore it for 30 days.</p>,
    })) return;
    await run(() => post('/api/files/trash', { path: p }), `"${name}" moved to the trash.`);
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        The <code>wp-content</code> folder of {label}: its themes, plugins and uploads. {admin
          ? 'You can change .php files here because you are an account manager; a mistake in one can stop the site working.'
          : 'You can read .php files here; only account managers can change them.'} Files starting with a dot are never shown or changed.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <nav aria-label="Folder" className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-sm">
          <button type="button" className="font-mono hover:underline" onClick={() => go('')}>wp-content</button>
          {steps.map((s, i) => (
            <span key={i} className="flex items-center gap-1">
              <ChevronRight className="size-3.5 text-muted-foreground" />
              <button type="button" className="font-mono hover:underline" onClick={() => go(steps.slice(0, i + 1).join('/'))}>{s}</button>
            </span>
          ))}
        </nav>
        <Button size="sm" variant="outline" onClick={async () => {
          const name = await dialogs.prompt({ title: 'New folder', label: 'Name', action: 'Make it' });
          if (name) await run(() => post('/api/files/mkdir', { dir: path, name }), `Folder "${name.trim()}" made.`);
        }}><FolderPlus />New folder</Button>
        <Button size="sm" onClick={() => input.current?.click()} disabled={uploading !== null}><Upload />{uploading ?? 'Upload'}</Button>
        <input ref={input} type="file" multiple hidden onChange={(e) => { void upload(e.target.files); e.target.value = ''; }} />
      </div>

      {!list.data ? <Loading rows={4} /> : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card shadow-card">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr><th className="px-3 py-2 font-medium">Name</th><th className="hidden px-3 py-2 font-medium sm:table-cell">Size</th><th className="hidden px-3 py-2 font-medium md:table-cell">Changed</th><th className="w-10" /></tr>
            </thead>
            <tbody>
              {path && (
                <tr className="border-t border-border"><td colSpan={4} className="px-3 py-2">
                  <button type="button" className="text-muted-foreground hover:underline" onClick={() => go(parentOf(path))}>.. (up a folder)</button>
                </td></tr>
              )}
              {list.data.folders.map((f) => {
                const p = path ? `${path}/${f.name}` : f.name;
                return (
                  <tr key={`d:${f.name}`} className="border-t border-border">
                    <td className="px-3 py-2"><button type="button" className="flex items-center gap-2 font-medium hover:underline" onClick={() => go(p)}><Folder className="size-4 text-primary" />{f.name}</button></td>
                    <td className="hidden px-3 py-2 text-muted-foreground sm:table-cell">{f.items} {f.items === 1 ? 'item' : 'items'}</td>
                    <td className="hidden md:table-cell" />
                    <td className="px-1"><RowMenu name={f.name} onRename={() => rename(p, f.name, true)} onMove={() => move(p, f.name)} onTrash={() => trash(p, f.name)} /></td>
                  </tr>
                );
              })}
              {list.data.files.map((f) => (
                <tr key={`f:${f.name}`} className="border-t border-border">
                  <td className="px-3 py-2">
                    {isEditable(f.name) || isCode(f.name)
                      ? <Link to={editorHref(f.path, root)} className="font-mono">{f.name}</Link>
                      : <a href={rootFileUrl(root, f.path)} target="_blank" rel="noreferrer" className="font-mono">{f.name}</a>}
                  </td>
                  <td className="hidden px-3 py-2 text-muted-foreground sm:table-cell">{sizeWords(f.size)}</td>
                  <td className="hidden px-3 py-2 text-muted-foreground md:table-cell">{formatTime(f.modifiedAt)}</td>
                  <td className="px-1">
                    <RowMenu name={f.name} editHref={isEditable(f.name) || isCode(f.name) ? editorHref(f.path, root) : null} downloadHref={rootFileUrl(root, f.path, true)}
                      onRename={() => rename(f.path, f.name, false)} onMove={() => move(f.path, f.name)} onTrash={() => trash(f.path, f.name)} />
                  </td>
                </tr>
              ))}
              {!list.data.folders.length && !list.data.files.length && (
                <tr className="border-t border-border"><td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">This folder is empty.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <Collapsible summary={<><Trash2 className="size-4" />Trash</>} onToggle={setTrashOpen}>
        <p className="mb-3 text-muted-foreground">What you moved to the trash from {label}'s files. Restore within 30 days; after that it's deleted for good.</p>
        {trashOpen && <SoftwareTrash root={root} />}
      </Collapsible>
    </div>
  );
}

function RowMenu({ name, editHref, downloadHref, onRename, onMove, onTrash }: {
  name: string; editHref?: string | null; downloadHref?: string; onRename: () => void; onMove: () => void; onTrash: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={`More for ${name}`}><Ellipsis /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {editHref && <DropdownMenuItem asChild><Link to={editHref} className="no-underline"><SquarePen />Open in the editor</Link></DropdownMenuItem>}
        {downloadHref && <DropdownMenuItem asChild><a href={downloadHref} className="no-underline"><Download />Download</a></DropdownMenuItem>}
        <DropdownMenuItem onSelect={onRename}><Pencil />Rename</DropdownMenuItem>
        <DropdownMenuItem onSelect={onMove}><FolderInput />Move to…</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onTrash} className="text-destructive"><Trash2 />Move to trash</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SoftwareTrash({ root }: { root: string }) {
  const trash = useApi<{ items: TrashItem[] }>(`/api/files/trash?root=${encodeURIComponent(root)}`);
  const run = useAction();
  if (!trash.data) return <Loading rows={2} />;
  if (!trash.data.items.length) return <p className="text-muted-foreground">Nothing in the trash.</p>;
  return (
    <ul className="divide-y divide-border">
      {trash.data.items.map((t) => (
        <li key={t.id} className="flex flex-wrap items-center gap-3 py-2">
          <span className="min-w-0 flex-1 truncate font-mono text-sm" title={t.path}>{t.path}{t.isDir ? '/' : ''}</span>
          <span className="text-xs text-muted-foreground">until {formatTime(t.purgeAt)}</span>
          <ActionButton size="sm" variant="outline" onClick={() => run(() => api('/api/files/restore', { root, id: t.id }), `"${t.name}" is back.`)}>Restore</ActionButton>
        </li>
      ))}
    </ul>
  );
}
