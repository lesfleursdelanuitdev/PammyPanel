// Tags & categories on a panel whose sources are apps (docs/catalog-plan.md step 5, lfdln):
// each service that offers things to tag, with its switch, Read again and a link to each
// kind; and the labels that go everywhere.
import { RefreshCw, Tags } from 'lucide-react';
import { Link } from 'react-router';
import { Empty, Facts, List, Loading, Page, Row, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { Switch } from '@panel/core/web/components/ui/switch';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { api, ApiError } from '@panel/core/web/lib/api';
import { EverywhereLabels } from '../components/everywhere';
import type { AppStatus } from '../lib/apps';

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;
const when = (at: number) => new Date(at * 1000).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

export default function Catalog() {
  usePageTitle('Tags & categories');
  const data = useApi<{ services: AppStatus[] }>('/api/catalog/apps');
  const offering = (data.data?.services ?? []).filter((s) => s.on || s.resources.length > 0);
  return (
    <Page title="Tags & categories"
      intro="Words for sorting what the services here offer: a service says in its pammy-panel.json what it has to tag (its topics, say) and what some labels mean to it. Put them on here, and the service reads them back.">
      <Section flush title="Services with things to tag">
        {!data.data ? <Loading /> : (
          <List label="Services with things to tag">
            {offering.length === 0 && <Empty>No service offers anything to tag yet: a "catalog" section in its pammy-panel.json does.</Empty>}
            {offering.map((s) => <ServiceRow key={s.service.id} s={s} />)}
          </List>
        )}
      </Section>
      <Section title="Everywhere" intro="Tags and categories that go on anything, in every service's things.">
        <EverywhereLabels publicSwitch={false} intro="Use one for something that cuts across services (featured, say). A service reads these with its own." />
      </Section>
    </Page>
  );
}

function ServiceRow({ s }: { s: AppStatus }) {
  const run = useAction();
  const dialogs = useDialogs();
  const url = `/api/catalog/apps/${s.service.id}`;
  const labelled = s.resources.reduce((n, r) => n + (r.counts?.labelled ?? 0), 0);
  const turn = async (on: boolean) => {
    if (!on && !await dialogs.confirm({
      title: `Switch off tags for ${s.service.title}?`, action: 'Switch off', danger: labelled > 0,
      body: labelled ? `The tags and categories come off ${plural(labelled, 'thing')}, and ${s.service.title}'s own tags and categories are deleted. Tags that go everywhere stay. The service itself is not touched.`
        : `Nothing of ${s.service.title}'s has tags yet.`,
    })) return;
    await run(() => api(url, { on }), on ? `Tags are on for ${s.service.title}.` : `Tags are off for ${s.service.title}.`);
  };
  const readAgain = async () => {
    const r = await run(() => api(`${url}/read`, {}).catch(async (e: unknown) => {
      if (!(e instanceof ApiError) || e.status !== 409) throw e;
      if (!await dialogs.confirm({ title: 'Let them go?', action: 'Let them go', danger: true, body: `${e.message} Let them go and read the rest?` })) return null;
      return await api(`${url}/read`, { letGo: true });
    }), (res) => (res ? 'Read again.' : 'Nothing was let go.'));
    return r;
  };
  return (
    <Row title={s.service.title}
      badges={s.on ? <Badge variant="ok">tags on</Badge> : <Badge variant="outline">tags off</Badge>}
      meta={s.error && !s.on ? <span className="text-destructive">{s.error}</span> : <Facts items={s.resources.map((r) => `${r.label}${r.counts ? `: ${plural(r.counts.items, 'thing')}, ${r.counts.labelled.toLocaleString('en')} with tags` : ''}`)} />}
      actions={s.on && <Button variant="outline" size="sm" onClick={() => void readAgain()}><RefreshCw />Read again</Button>}>
      <div className="mt-3 space-y-3 text-sm">
        <label className="flex items-start gap-3">
          <Switch checked={s.on} disabled={!s.on && !s.resources.length} onCheckedChange={(v) => void turn(v)} aria-label={`Let me tag ${s.service.title}'s things`} />
          <span>Let me tag these <span className="text-muted-foreground">(up to {s.max.toLocaleString('en')} of each kind)</span></span>
        </label>
        {s.on && s.error && <p className="text-destructive" role="status">{s.error}</p>}
        {s.on && (
          <ul className="space-y-2" aria-label={`What ${s.service.title} offers`}>
            {s.resources.map((r) => (
              <li key={r.key} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {r.source ? <Link className="font-medium underline underline-offset-2" to={`/catalog/${s.service.id}/${r.key}`}><Tags className="mr-1 inline size-4" />{r.label}</Link>
                  : <strong>{r.label}</strong>}
                {!r.offered && <Badge variant="warn">no longer offered</Badge>}
                {!r.source && <Badge variant="outline">new: Read again takes it in</Badge>}
                <span className="text-muted-foreground"><Facts items={[
                  r.state && `read ${when(r.state.at)}`,
                  r.state?.missing ? `${r.state.missing} gone since (their tags are kept 30 days)` : null,
                ]} /></span>
                {r.state?.error && <span className="w-full text-destructive" role="status">{r.state.error}</span>}
              </li>
            ))}
          </ul>
        )}
        {s.on && <p className="text-muted-foreground">What the service changes shows up at once if it tells the panel, and within 15 minutes if not. Read again does it now.</p>}
      </div>
    </Row>
  );
}
