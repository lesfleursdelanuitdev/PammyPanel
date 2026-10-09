// Services (docs/adopt-plan.md V9): what runs on the server, taken in by the
// installer -- TutorStar and the Gonsalves apps. How each part is, which hosts
// send visitors to it, its log, and Start, Stop and Restart. A stopped part stays
// stopped after the server restarts, until someone starts it here. Nothing here
// deletes anything.
import { useState } from 'react';
import { Play, RotateCw, ScrollText, Square } from 'lucide-react';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { ActionButton, Addresses, Empty, Facts, List, Loading, Page, Row, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { api, plural, timeAgo } from '@panel/core/web/lib/api';

type PartView = {
  id: string; title: string; unit: string; port: number | null; health: string | null; controls: boolean; requires: string[];
  active: string; sub: string; masked: boolean; since: number | null; restarts: number | null; memory: number | null;
  answering: { status: number | null; ms: number } | null; well: boolean | null; changed: boolean | null;
  shownAt: { address: string; live: boolean }[];
};
type DataWhere = { database: string; engine: 'server' | 'lfdln-appdb'; port: number; since: number | null };
type ServiceView = { id: string; title: string; user: string; about: string; adoptedAt: number; parts: PartView[]; database?: DataWhere | null };

// where its data is (docs/data-move-plan.md M7)
const dataLine = (w: DataWhere) => `its data: ${w.database}, on ${w.engine === 'lfdln-appdb' ? 'lfdln-appdb' : "the server's own Postgres"} (:${w.port})${w.since ? `, since ${timeAgo(w.since)}` : ''}`;

const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;
const running = (p: PartView) => p.active === 'active' && p.sub !== 'exited';

export default function Services() {
  usePageTitle('Services');
  const data = useApi<{ services: ServiceView[] }>('/api/services', { refetchInterval: 30_000 });
  return (
    <Page title="Services" intro="What runs on this server, taken in as it was: its containers, whether each answers, and Start, Stop and Restart. A stopped part stays stopped after the server restarts, until it is started here. Nothing here deletes anything; new versions are still deployed with each service's own runbook.">
      <Section flush title="Services">
        {!data.data ? <Loading /> : (
          <List label="Services">
            {data.data.services.length === 0 && <Empty>No services taken in yet (lfdln's installer takes them in).</Empty>}
            {data.data.services.map((s) => <ServiceRow key={s.id} s={s} />)}
          </List>
        )}
      </Section>
    </Page>
  );
}

function ServiceRow({ s }: { s: ServiceView }) {
  const run = useAction();
  const dialogs = useDialogs();
  const controlled = s.parts.filter((p) => p.controls);
  const up = controlled.filter(running).length;
  const unwell = controlled.filter((p) => running(p) && p.well === false).length;
  const many = controlled.length > 1;
  return (
    <Row title={s.title}
      badges={<>
        {up === controlled.length ? <Badge variant={unwell ? 'warn' : 'ok'}>{unwell ? `running, ${unwell} not answering` : 'running'}</Badge>
          : up === 0 ? <Badge variant="danger">stopped</Badge> : <Badge variant="warn">{up} of {controlled.length} running</Badge>}
        <Badge variant="outline">taken in {timeAgo(s.adoptedAt)}</Badge>
      </>}
      meta={<Facts items={[`runs as ${s.user}`, ...(s.database ? [dataLine(s.database)] : []), s.about]} />}
      actions={<>
        <ActionButton icon={RotateCw} disabled={up === 0}
          onClick={() => run(() => api(`/api/services/${s.id}/restart`, {}), `${s.title} restarted, and answering.`)}>{many ? 'Restart all' : 'Restart'}</ActionButton>
        {up < controlled.length && (
          <ActionButton icon={Play} variant="default"
            onClick={() => run(() => api(`/api/services/${s.id}/start`, {}), `${s.title} started, and answering.`)}>{many ? 'Start all' : 'Start'}</ActionButton>
        )}
        {up > 0 && (
          <ActionButton icon={Square} variant="danger" onClick={async () => {
            if (!await dialogs.confirm({ title: `Stop ${s.title}?`, action: 'Stop', danger: true,
              body: `${many ? 'All its parts stop' : 'It stops'}, and ${many ? 'stay' : 'stays'} stopped after the server restarts, until someone starts ${many ? 'them' : 'it'} here. Its addresses answer an error meanwhile.` })) return;
            await run(() => api(`/api/services/${s.id}/stop`, {}), `${s.title} is stopped.`);
          }}>{many ? 'Stop all' : 'Stop'}</ActionButton>
        )}
      </>}>
      <ul className="mt-3 space-y-3 border-l-2 border-border pl-3" aria-label={`Parts of ${s.title}`}>
        {s.parts.map((p) => <PartLine key={p.id} s={s} p={p} many={many} />)}
      </ul>
    </Row>
  );
}

function PartLine({ s, p, many }: { s: ServiceView; p: PartView; many: boolean }) {
  const run = useAction();
  const dialogs = useDialogs();
  const [logs, setLogs] = useState<string[] | null>(null);
  const on = running(p);
  // what stops with it: the parts that can't run without it
  const dependents = s.parts.filter((x) => x.requires.includes(p.id));
  const state = p.masked ? <Badge variant="danger">stopped</Badge>
    : on ? (p.well === false ? <Badge variant="warn">running, not answering</Badge> : <Badge variant="ok">running</Badge>)
    : p.active === 'failed' ? <Badge variant="danger">failed</Badge>
    : p.active === 'activating' ? <Badge variant="warn">starting</Badge>
    : !p.controls && p.sub === 'exited' ? <Badge variant="outline">ran, finished</Badge>
    : <Badge variant="outline">not running</Badge>;
  return (
    <li className="text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {many && <strong>{p.title}</strong>}
        {state}
        {p.changed && <Badge variant="warn">its Quadlet file changed since it was taken in</Badge>}
        {!p.controls && <Badge variant="outline">not started from the panel</Badge>}
        <span className="text-muted-foreground">
          <Facts items={[
            <span key="u" className="font-mono">{p.unit}.service</span>,
            p.port !== null && `127.0.0.1:${p.port}`,
            p.answering && (p.answering.status === null ? `${p.health}: no answer` : `${p.health}: ${p.answering.status} in ${p.answering.ms} ms`),
            on && p.since && `up ${timeAgo(p.since).replace(/ ago$/, '')}`,
            p.memory !== null && mb(p.memory),
            !!p.restarts && `restarted by itself ${plural(p.restarts, 'time')}`,
          ]} />
        </span>
      </div>
      {p.shownAt.length > 0 && <Addresses links={p.shownAt.map((a) => ({ href: a.address, text: a.live ? a.address : `${a.address} (route off)` }))} />}
      <div className="mt-1.5 flex flex-wrap gap-2">
        {many && p.controls && (on ? <>
          <ActionButton variant="ghost" className="h-7" icon={RotateCw}
            onClick={() => run(() => api(`/api/services/${s.id}/restart`, { part: p.id }), `${p.title} restarted${dependents.length ? `, and ${dependents.map((x) => x.title).join(' and ')} with it` : ''}.`)}>Restart</ActionButton>
          <ActionButton variant="ghost" className="h-7 text-destructive" icon={Square} onClick={async () => {
            if (!await dialogs.confirm({ title: `Stop ${p.title}?`, action: 'Stop', danger: true,
              body: `${dependents.length ? `${dependents.map((x) => x.title).join(' and ')} can't run without it, so ${dependents.length > 1 ? 'they stop' : 'it stops'} too. ` : ''}It stays stopped after the server restarts, until someone starts it here.` })) return;
            await run(() => api(`/api/services/${s.id}/stop`, { part: p.id }), `${p.title} is stopped.`);
          }}>Stop</ActionButton>
        </> : (
          <ActionButton variant="ghost" className="h-7" icon={Play}
            onClick={() => run(() => api(`/api/services/${s.id}/start`, { part: p.id }), `${p.title} started, and answering.`)}>Start</ActionButton>
        ))}
        <ActionButton variant="ghost" className="h-7" icon={ScrollText} onClick={async () => {
          if (logs) { setLogs(null); return; }
          const r = await run(() => api<{ lines: string[] }>(`/api/services/${s.id}/logs?part=${encodeURIComponent(p.id)}`));
          if (r) setLogs(r.lines);
        }}>{logs ? 'Hide the log' : 'Log'}</ActionButton>
      </div>
      {logs && (
        <pre className="mt-2 max-h-80 overflow-auto rounded-md border border-border bg-muted/50 p-2 text-xs leading-relaxed" aria-label={`The log of ${p.title}`}>
          {logs.length ? logs.join('\n') : 'Nothing in its log.'}
        </pre>
      )}
    </li>
  );
}
