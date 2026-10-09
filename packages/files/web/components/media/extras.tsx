// Around the Media page's list: "Check for changes" (with when it last looked),
// what's out of place in the media folders, and the media trash.
import { useQueryClient } from '@tanstack/react-query';
import { ArchiveRestore, File, Folder, RefreshCw, TriangleAlert } from 'lucide-react';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { ActionButton, Empty, Facts, List, Loading, Row } from '@panel/core/web/components/page';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi } from '@panel/core/web/hooks/useApi';
import { api, ApiError, formatTime, friendlyError, signedOut, timeAgo } from '@panel/core/web/lib/api';
import { parentOf } from '../../lib/media';
import { clearNotice, notify } from '@panel/core/web/lib/status';
import type { MediaSyncInfo, MediaTrashItem } from '../../lib/types';

// Files put in with WinSCP (or by Claude) show up once the panel has looked:
// by itself every 15 minutes and when Media is opened, or now with this button.
// (File Explorer asks its own routes: a site may have it without media folders)
export function CheckForChanges({ sync, url = '/api/media/sync' }: { sync: MediaSyncInfo | null; url?: string }) {
  const run = useAction();
  return (
    <div className="flex flex-wrap items-center gap-3 lg:justify-end">
      <span className="text-sm text-muted-foreground" data-testid="media-checked">
        {sync ? `Checked for changes ${timeAgo(sync.at)}` : 'Not checked for changes yet'}
      </span>
      <ActionButton icon={RefreshCw} onClick={() => run(() => api<{ summary: string }>(url, {}),
        (r) => (r.summary === 'no changes' ? 'Checked: nothing has changed.' : `Checked: ${r.summary}.`))}>
        Check for changes
      </ActionButton>
    </div>
  );
}

// Things in a media folder that aren't where the panel can use them. Never moved automatically.
export function OutOfPlace({ sync }: { sync: MediaSyncInfo }) {
  if (!sync.strays.length && !sync.truncated) return null;
  return (
    <div role="note" className="flex gap-3 rounded-lg border border-warning/40 bg-warning-soft p-4 text-sm">
      <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warning" />
      <div className="min-w-0 space-y-2">
        {sync.strays.length > 0 && <>
          <p className="font-semibold">{sync.strays.length === 1 ? 'One thing is' : `${sync.strays.length} things are`} where the panel can't use {sync.strays.length === 1 ? 'it' : 'them'}:</p>
          <ul className="list-disc space-y-0.5 pl-5 [overflow-wrap:anywhere]">
            {sync.strays.slice(0, 20).map((x) => <li key={x}><code>{x}</code></li>)}
            {sync.strays.length > 20 && <li>and {sync.strays.length - 20} more</li>}
          </ul>
          <p className="text-muted-foreground">A media folder holds only images, files, audio and video, and never pages or programs: move each of these into one of those four, or out of the media folder. Shortcuts (links) and names with unusual characters aren't shown anywhere.</p>
        </>}
        {sync.truncated && <p>There are more files in the media folders than the panel checks at once, so some newer ones may not show. Tell momolig.</p>}
      </div>
    </div>
  );
}

export function MediaTrash({ url = '/api/media/trash' }: { url?: string } = {}) {
  const trash = useApi<{ items: MediaTrashItem[] }>(url);
  const dialogs = useDialogs();
  const qc = useQueryClient();

  const restore = async (t: MediaTrashItem) => {
    let as: string | undefined;
    for (;;) {
      clearNotice();
      try {
        const r = await api<{ path: string }>('/api/files/restore', { id: t.id, as });
        notify(`Restored to ${r.path}.`);
        break;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return signedOut();
        if (!(err instanceof ApiError) || err.status !== 409) { notify(friendlyError(err), 'error'); break; }
        const next = await dialogs.prompt({ title: err.message, label: 'Restore it under this name', value: `restored-${t.name}`, action: 'Restore' });
        if (next === null) break;
        as = next;
      }
    }
    await qc.invalidateQueries();
  };

  if (!trash.data) return <Loading rows={1} />;
  return (
    <List label="Trashed media">
      {trash.data.items.length === 0 && <Empty>The trash is empty.</Empty>}
      {trash.data.items.map((t) => (
        <Row key={t.id} title={<span className="flex items-center gap-2">{t.isDir ? <Folder className="size-4" /> : <File className="size-4" />}{t.name}</span>}
          meta={<Facts items={[`was in ${parentOf(t.path)}`, `moved to the trash ${formatTime(t.trashedAt)}`, `deleted for good after ${formatTime(t.purgeAt)}`]} />}
          actions={<ActionButton icon={ArchiveRestore} onClick={() => restore(t)}>Restore</ActionButton>} />
      ))}
    </List>
  );
}
