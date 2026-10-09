// A project helper's jobs (docs/phase8b-plan.md): one row each, its log when opened. The
// Projects page and a project's Packages page both list them.
import { useState } from 'react';
import { FileText } from 'lucide-react';
import { Row } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { useApi } from '@panel/core/web/hooks/useApi';
import { formatTime, timeAgo } from '@panel/core/web/lib/api';

export type Job = {
  id: string; project: string | null; branch: string | null; what: string; by: string; state: 'queued' | 'running' | 'done' | 'failed';
  queuedAt: number; startedAt: number | null; endedAt: number | null; step: string | null; error: string | null;
};

export const WHAT: Record<string, string> = {
  check: 'Check the build environment', create: 'Make', build: 'Build', rollback: 'Roll back', delete: 'Delete',
  push: 'Pushed, so built', share: 'Share its repository', owners: 'Owners', 'dev-on': 'Dev branch on', 'dev-off': 'Dev branch off', promote: 'Put dev live',
  start: 'Start', stop: 'Stop', restart: 'Restart',
  'packages-check': 'Check packages', packages: 'Change packages', script: 'Run a script', nightly: 'The nightly check',
};

const STATE: Record<Job['state'], { word: string; variant: 'ok' | 'danger' | 'warn' | 'outline' }> = {
  queued: { word: 'waiting', variant: 'outline' }, running: { word: 'running', variant: 'warn' }, done: { word: 'done', variant: 'ok' }, failed: { word: 'failed', variant: 'danger' },
};

export function JobRow({ j }: { j: Job }) {
  const [open, setOpen] = useState(false);
  const log = useApi<{ log: string }>(open ? `/api/projects/jobs/${j.id}` : null, { refetchInterval: open && (j.state === 'running' || j.state === 'queued') ? 2000 : false });
  const s = STATE[j.state];
  return (
    <Row title={`${WHAT[j.what] ?? j.what}${j.project ? `: ${j.project}` : ''}${j.branch && j.what !== 'create' ? ` (${j.branch})` : ''}`}
      badges={<Badge variant={s.variant}>{s.word}</Badge>}
      meta={<>{j.by} · <time title={formatTime(j.queuedAt)}>{timeAgo(j.queuedAt)}</time>{j.state === 'running' && j.step ? ` · ${j.step}` : ''}{j.error ? ` · ${j.error}` : ''}</>}
      actions={<Button size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen((o) => !o)}><FileText />{open ? 'Hide the log' : 'Log'}</Button>}>
      {open && (
        <pre data-testid="job-log" className="mt-2 max-h-80 overflow-auto rounded-md bg-muted/70 p-3 font-mono text-xs leading-relaxed">{log.data ? log.data.log || '(empty)' : 'Loading…'}</pre>
      )}
    </Row>
  );
}
