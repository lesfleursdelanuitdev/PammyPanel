// API keys: what a program needs to read a form's responses, or media, from another
// place. Only an account manager can make or revoke one, and a key is shown once.
// What a key can read comes from the modules on (docs/catalog-plan.md step 3c).
import { guideTo, isOn } from '@panel/core/web/lib/site';
import { useQueryClient } from '@tanstack/react-query';
import { Copy, KeySquare, Plus, ShieldX } from 'lucide-react';
import { Fragment, useState } from 'react';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { ActionButton, Empty, Facts, Field, InlineLink, List, Loading, Page, Row, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { Input } from '@panel/core/web/components/ui/input';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { api, formatTime } from '@panel/core/web/lib/api';
import { notify } from '@panel/core/web/lib/status';
import type { Me } from '@panel/core/web/lib/types';
import type { AnyKeyCover } from '../lib/covers';
import type { ApiKeysData } from '../lib/types';

const startOf = (covers: readonly AnyKeyCover[]) => Object.fromEntries(covers.map((c) => [c.kind, c.start])) as Record<string, unknown>;

export function ApiKeys({ me, covers }: { me: Me; covers: readonly AnyKeyCover[] }) {
  usePageTitle('API keys');
  const keys = useApi<ApiKeysData>('/api/api-keys');
  const qc = useQueryClient();
  const run = useAction();
  const dialogs = useDialogs();
  const [making, setMaking] = useState(false);
  const [label, setLabel] = useState('');
  // each cover's part of the form, by kind
  const [parts, setParts] = useState(() => startOf(covers));
  const [made, setMade] = useState<string | null>(null);

  const create = async () => {
    if (!label.trim()) return notify('Give the key a name, so you know what it is for.', 'error');
    const r = await run(() => api<{ key: string }>('/api/api-keys', {
      label: label.trim(), ...Object.assign({}, ...covers.map((c) => c.body(parts[c.kind]))),
    }));
    if (!r) return;
    setMade(r.key);
    setLabel('');
    setParts(startOf(covers));
    setMaking(false);
    await qc.invalidateQueries({ queryKey: ['/api/api-keys'] });
  };

  return (
    <Page title="API keys" intro={<>A key lets a program read {covers.map((c) => c.reads).join(', or ')}, from somewhere else. Pages on your own website don't need one. {covers.filter((c) => guideTo(c.help.topic)).map((c, i) => <Fragment key={c.kind}>{i > 0 && ' · '}<InlineLink to={guideTo(c.help.topic)!}>{c.help.label}</InlineLink></Fragment>)}</>}
      actions={me.role === 'manager' && <Button onClick={() => setMaking((m) => !m)}><Plus />New key</Button>}>

      {made && (
        <Section title="Your new key" className="border-primary/40">
          <p className="mb-2 text-sm">Copy it now: it is never shown again. Anyone who has it can read what the key allows, so send it privately and never put it on a web page.</p>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 text-[0.8125rem]" data-testid="new-api-key"><code>{made}</code></pre>
          <div className="mt-2 flex gap-2">
            <ActionButton icon={Copy} onClick={async () => { await navigator.clipboard.writeText(made); notify('Key copied.'); }}>Copy</ActionButton>
            <Button variant="ghost" onClick={() => setMade(null)}>Done</Button>
          </div>
        </Section>
      )}

      {making && me.role === 'manager' && (
        <Section title="New key" intro="It works until you revoke it.">
          <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); void create(); }}>
            <Field label="What it is for" htmlFor="key-label" hint="Only you see this, e.g. Olivia's website.">
              <Input id="key-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} autoComplete="off" />
            </Field>
            {covers.map((c) => <c.Fields key={c.kind} state={parts[c.kind]} set={(v: unknown) => setParts((p) => ({ ...p, [c.kind]: v }))} />)}
            <div><Button type="submit"><KeySquare />Make the key</Button></div>
          </form>
        </Section>
      )}

      <Section flush title="Keys">
        {!keys.data ? <Loading /> : (
          <List label="API keys">
            {keys.data.keys.length === 0 && <Empty>No keys yet.{me.role === 'manager' ? ` Click "New key" if a program needs to read ${covers[0]!.kind === 'forms' ? 'responses' : 'media'}.` : ' Only an account manager can make one.'}</Empty>}
            {keys.data.keys.map((k) => (
              <Row key={k.id} title={k.label}
                badges={<>
                  {k.revokedAt ? <Badge variant="warn">revoked</Badge> : <Badge variant="ok">working</Badge>}
                  {covers.map((c) => <Fragment key={c.kind}>{c.badges(k)}</Fragment>)}
                </>}
                meta={<Facts items={[
                  <code key="p" className="rounded bg-muted px-1.5 py-0.5">{k.prefix}...</code>,
                  ...covers.flatMap((c) => c.facts(k)),
                  `made ${formatTime(k.createdAt)}${k.createdBy ? ` by ${k.createdBy}` : ''}`,
                  k.lastUsedAt ? `last used ${formatTime(k.lastUsedAt)}` : 'never used',
                  k.revokedAt ? `revoked ${formatTime(k.revokedAt)}${k.revokedBy ? ` by ${k.revokedBy}` : ''}` : null,
                ]} />}
                actions={!k.revokedAt && me.role === 'manager' && (
                  <ActionButton variant="danger" icon={ShieldX} onClick={async () => {
                    const ok = await dialogs.confirm({
                      title: `Revoke "${k.label}"?`, action: 'Revoke', danger: true,
                      body: 'Whatever uses this key stops working straight away. You can make a new key instead.',
                    });
                    if (ok && await run(() => api(`/api/api-keys/${k.id}/revoke`, {}), `"${k.label}" was revoked.`)) {
                      await qc.invalidateQueries({ queryKey: ['/api/api-keys'] });
                    }
                  }}>Revoke</ActionButton>
                )} />
            ))}
          </List>
        )}
      </Section>
    </Page>
  );
}
