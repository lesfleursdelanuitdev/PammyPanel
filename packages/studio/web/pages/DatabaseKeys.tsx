// Letting programs in (docs/databases-plan.md 11.3, 13).
//
// This is the only page in the whole studio that can put her data on the
// internet, so it is deliberately the plainest. Two switches, a list of keys,
// and one sentence saying what each thing means. Nothing is on by default, and
// the page says so even when it is empty.
import { ArrowLeft, Ban, KeyRound, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { Empty, Facts, Field, InlineLink, List, Loading, Page, Row, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { Input } from '@panel/core/web/components/ui/input';
import { NativeSelect } from '@panel/core/web/components/ui/native-select';
import { Switch } from '@panel/core/web/components/ui/switch';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { api, formatTime } from '@panel/core/web/lib/api';
import { copyText } from '@panel/core/web/hooks/useAction';
import type { AppData, AppKey, DatabaseEngine } from '../lib/schema';
import { SITE_ORIGIN, W } from '@panel/core/web/lib/site';

// the public site, where the gate answers (the panel's own address never does)
const SITE = SITE_ORIGIN;

export default function DatabaseKeys() {
  const { engine, name } = useParams<{ engine: DatabaseEngine; name: string }>();
  usePageTitle(name ? `${name}: programs` : 'Programs');
  const base = `/api/databases/${engine}/${name}`;
  const data = useApi<AppData>(`${base}/app`);
  const keys = useApi<{ keys: AppKey[]; served: { plural: string; slug: string }[] }>(`${base}/keys`);
  const run = useAction();
  const dialogs = useDialogs();

  const d = data.data;
  const [making, setMaking] = useState(false);
  const [label, setLabel] = useState('');
  const [canWrite, setCanWrite] = useState(false);
  // shown once, and never again
  const [fresh, setFresh] = useState<string | null>(null);

  const setApi = (patch: { read?: boolean; write?: boolean }) =>
    run(() => api(`${base}/api`, patch), 'Saved.');

  const make = async (e: React.FormEvent) => {
    e.preventDefault();
    const got = await run(() => api<{ key: string }>(`${base}/keys`, { label, resources: 'all', canWrite }),
      'The key is made. Copy it now — it is not shown again.');
    if (got) { setFresh(got.key); setMaking(false); setLabel(''); setCanWrite(false); }
  };

  const revoke = async (k: AppKey) => {
    const ok = await dialogs.confirm({
      title: `Stop the key "${k.label}" working?`,
      body: 'Anything using it stops being able to reach your data straight away. This cannot be undone — you would have to make a new key.',
      action: 'Stop it working',
      danger: true,
    });
    if (ok) await run(() => api(`${base}/keys/${k.id}/revoke`, {}), `"${k.label}" has stopped working.`);
  };

  const live = (keys.data?.keys ?? []).filter((k) => !k.revokedAt);
  const gone = (keys.data?.keys ?? []).filter((k) => k.revokedAt);

  return (
    <Page title={name ? `${name}: letting programs in` : ''} wide
      intro={<>
        <InlineLink to="/databases">Your databases</InlineLink>{' · '}
        <InlineLink to={`/databases/${engine}/${name}/app`}>the {W.app.one}</InlineLink>{' · '}
        This is the only part of the panel that can put your data on the internet.
      </>}
      actions={<Button variant="outline" asChild>
        <Link to={`/databases/${engine}/${name}/app`}><ArrowLeft />Back to the {W.app.one}</Link>
      </Button>}>

      {!d ? <Loading /> : d.status !== 'active' ? (
        <Section title={`The ${W.app.one} is not switched on`}>
          <p className="text-sm">
            Programs can only be let into {W.app.a} that is switched on.{' '}
            <InlineLink to={`/databases/${engine}/${name}/app`}>Switch it on first</InlineLink>.
          </p>
        </Section>
      ) : <>
        <Section title="Can programs reach this?"
          intro="Off means nothing outside the panel can read your data, whatever keys exist. A key on its own is never enough.">
          <div className="space-y-3">
            <label className="flex items-start gap-3 text-sm">
              <Switch checked={d.apiRead} onCheckedChange={(v) => void setApi({ read: v, write: v ? undefined : false })}
                aria-label="Programs may read" />
              <span>
                <span className="font-medium">Programs may read it</span>
                <span className="block text-muted-foreground">With a key, a program can list and look at records — only the fields you show. Without a key, only what you have said anyone can read (on each table's own page).</span>
              </span>
            </label>
            <label className="flex items-start gap-3 text-sm">
              <Switch checked={d.apiWrite} disabled={!d.apiRead}
                onCheckedChange={(v) => void setApi({ write: v })} aria-label="Programs may change" />
              <span>
                <span className="font-medium">Programs may change it</span>
                <span className="block text-muted-foreground">
                  A program with the right key can add, change and delete records — never more than the {W.app.one} itself allows.
                  {!d.apiRead && ' Turn reading on first.'}
                </span>
              </span>
            </label>
          </div>
        </Section>

        {fresh && (
          <Section title="Your new key" className="border-primary/40"
            intro="Copy it now. It is not kept anywhere you can read it again — if you lose it, make another one.">
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 overflow-x-auto rounded-md bg-muted px-3 py-2 text-sm">{fresh}</code>
              <Button variant="outline" onClick={() => void copyText(fresh, 'Key')}>Copy</Button>
              <Button variant="ghost" onClick={() => setFresh(null)}>Done</Button>
            </div>
          </Section>
        )}

        <Section flush title="Keys"
          intro={live.length ? 'Each key is a secret. Anyone who has one can do what it says, from anywhere.' : undefined}
          action={<Button onClick={() => setMaking(true)} disabled={!d.apiRead}><Plus />New key</Button>}>
          <List label="Keys">
            {live.length === 0 && (
              <Empty>
                No keys yet{d.apiRead ? '' : ', and nothing can get in while reading is off'}. A key is how one
                particular program — a website, a script — is let in.
              </Empty>
            )}
            {live.map((k) => (
              <Row key={k.id} title={k.label}
                badges={k.canWrite
                  ? <Badge variant="warn">can change records</Badge>
                  : <Badge variant="outline">can only read</Badge>}
                meta={<Facts items={[
                  <span key="p"><KeyRound className="mr-1 inline size-3.5 align-[-0.15em]" aria-hidden />{k.prefix}…</span>,
                  `made ${formatTime(k.createdAt)}`,
                  k.lastUsedAt ? `last used ${formatTime(k.lastUsedAt)}` : 'never used',
                ]} />}
                actions={<Button variant="outline" size="sm" onClick={() => void revoke(k)}><Ban />Stop it working</Button>} />
            ))}
          </List>
        </Section>

        {making && (
          <Section title="A new key" action={<Button variant="ghost" size="sm" onClick={() => setMaking(false)}>Cancel</Button>}>
            <form className="space-y-4" onSubmit={make}>
              <Field label="What is it for?" htmlFor="key-label"
                hint="A name you will recognise later, like “Olivia's website” — so you know what stops working if you take it away.">
                <Input id="key-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} autoComplete="off" />
              </Field>
              <Field label="What may it do?" htmlFor="key-write"
                hint="Reading is much safer. Only allow changes if the program really needs to add or edit records.">
                <NativeSelect id="key-write" value={canWrite ? 'write' : 'read'}
                  onChange={(e) => setCanWrite(e.target.value === 'write')}>
                  <option value="read">Read only</option>
                  <option value="write">Read, and add or change records</option>
                </NativeSelect>
              </Field>
              <div><Button type="submit" disabled={!label.trim()}><KeyRound />Make the key</Button></div>
            </form>
          </Section>
        )}

        {d.apiRead && keys.data && (
          <Section title="Where programs ask"
            intro="Give these to whoever writes the program, with a key. The key goes in the Authorization header as “Bearer” and the key — never in the address.">
            {keys.data.served.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing yet: press “Manage this” for a table on the {W.app.one}'s page for programs to have anything to ask for.</p>
            ) : (
              <ul className="space-y-1.5 text-sm" aria-label="Addresses for programs">
                {keys.data.served.map((r) => (
                  <li key={r.slug} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">{r.plural}</span>
                    <code className="min-w-0 break-all rounded bg-muted px-1.5 py-0.5 text-xs">{`${SITE}/_pammy/api/data/${engine}/${name}/${r.slug}`}</code>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}

        {gone.length > 0 && (
          <Section flush title="Keys that have been stopped">
            <List label="Stopped keys">
              {gone.map((k) => (
                <Row key={k.id} title={k.label}
                  meta={<Facts items={[`${k.prefix}…`, `stopped ${formatTime(k.revokedAt!)}`]} />} />
              ))}
            </List>
          </Section>
        )}
      </>}
    </Page>
  );
}
