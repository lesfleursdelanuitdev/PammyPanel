// Your git tokens (docs/phase8b-plan.md 8b-7, D7-2): the passwords for git over HTTPS
// (https://git.<domain>/<project>.git). Made after a fresh passkey and shown once; each with an
// expiry and when it was last used; revoked here. Only your own: nobody else sees them.
import { useId, useState } from 'react';
import { ArrowLeft, Copy, KeyRound, Plus, Trash2 } from 'lucide-react';
import { Link } from 'react-router';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { Empty, Facts, Field, List, Loading, Page, Row, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { Input } from '@panel/core/web/components/ui/input';
import { NativeSelect } from '@panel/core/web/components/ui/native-select';
import { copyText, useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { api, formatTime, timeAgo } from '@panel/core/web/lib/api';
import { SITE } from '@panel/core/web/lib/site';

type Token = { id: number; label: string; hint: string; created_at: number; expires_at: number | null; last_used_at: number | null; expired: boolean };
type View = { tokens: Token[]; max: number; days: number[]; defaultDays: number; me: string };

const DAYS_WORDS: Record<number, string> = { 30: '30 days', 90: '90 days', 365: 'A year', 0: 'Until I revoke it' };

export default function GitTokens() {
  usePageTitle('Your git tokens');
  const run = useAction();
  const dialogs = useDialogs();
  const uid = useId();
  const data = useApi<View>('/api/projects/git-tokens');
  const v = data.data;
  const [label, setLabel] = useState('');
  const [days, setDays] = useState<number | null>(null);
  const [made, setMade] = useState<{ token: string; user: string; label: string } | null>(null);
  const host = `git.${SITE.domain}`;
  const full = !!v && v.tokens.length >= v.max;
  return (
    <Page title="Your git tokens"
      intro={<>For git over HTTPS: clone and push a project at <code>https://{host}/&lt;project&gt;.git</code>. When git asks, the user name is your panel username and the password is a token. Anyone with Projects can clone; only a project's owners (and admins) can push.</>}
      actions={<Button size="sm" variant="outline" asChild><Link to="/projects"><ArrowLeft />Projects</Link></Button>}>
      {made && (
        <Section title={<>Your new token, “{made.label}”</>} intro="Copy it now: it is shown only this once. Keep it like a password.">
          <div className="grid gap-3 px-4 py-4 sm:px-5">
            <pre data-testid="new-token" className="overflow-x-auto rounded-md bg-muted/70 p-2.5 font-mono text-xs">{made.token}</pre>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => void copyText(made.token, 'The token')}><Copy />Copy the token</Button>
              <Button size="sm" variant="ghost" onClick={() => setMade(null)}>I've kept it</Button>
            </div>
            <p className="text-sm text-muted-foreground">
              User name: <code>{made.user}</code>. To have git remember it: <code>git config --global credential.helper store</code> (kept in a file in your home folder) or your system's keychain.
            </p>
          </div>
        </Section>
      )}
      <Section title="Tokens" intro={v && <>{v.tokens.length} of {v.max}. Revoking one stops it at once.</>}>
        {!v ? <Loading rows={2} /> : (
          <List label="Your git tokens">
            {v.tokens.length === 0 && <Empty>No tokens yet.</Empty>}
            {v.tokens.map((t) => (
              <Row key={t.id} title={t.label}
                badges={<>
                  <Badge variant="outline" className="font-mono">lfdln_git_{t.hint}…</Badge>
                  {t.expired && <Badge variant="danger">expired</Badge>}
                </>}
                meta={<Facts items={[
                  <>made <time title={formatTime(t.created_at)}>{timeAgo(t.created_at)}</time></>,
                  t.expires_at === null ? 'never expires' : <>{t.expired ? 'expired' : 'expires'} {formatTime(t.expires_at)}</>,
                  t.last_used_at ? <>last used <time title={formatTime(t.last_used_at)}>{timeAgo(t.last_used_at)}</time></> : 'not used yet',
                ]} />}
                actions={<Button size="sm" variant="outline" onClick={async () => {
                  if (!await dialogs.confirm({ title: `Revoke “${t.label}”?`, action: 'Revoke', danger: true, body: 'Git on any computer using it stops being let in at once. You can make another.' })) return;
                  await run(() => api(`/api/projects/git-tokens/${t.id}/revoke`, {}), `Revoked “${t.label}”.`);
                }}><Trash2 />Revoke</Button>} />
            ))}
          </List>
        )}
      </Section>
      <Section title="Make a token" intro="One per computer is easiest: you can revoke one without the others. It asks for your passkey.">
        <form aria-label="Make a git token" className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,12rem)_auto] sm:items-end sm:px-5" onSubmit={async (e) => {
          e.preventDefault();
          const name = label.trim();
          const r = await run(() => api<{ token: string; user: string }>('/api/projects/git-tokens', { label: name, days: days ?? v?.defaultDays }));
          if (r) { setMade({ ...r, label: name }); setLabel(''); setDays(null); }
        }}>
          <Field label="Name" htmlFor={`${uid}-label`}>
            <Input id={`${uid}-label`} maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="my laptop" />
          </Field>
          <Field label="Lasts" htmlFor={`${uid}-days`}>
            <NativeSelect id={`${uid}-days`} value={String(days ?? v?.defaultDays ?? 90)} onChange={(e) => setDays(Number(e.target.value))}>
              {(v?.days ?? [30, 90, 365, 0]).map((d) => <option key={d} value={d}>{DAYS_WORDS[d] ?? `${d} days`}</option>)}
            </NativeSelect>
          </Field>
          <Button type="submit" size="sm" disabled={!v || full || !label.trim()} title={full ? `You have ${v?.max} already: revoke one first.` : undefined}><Plus />Make a token</Button>
        </form>
      </Section>
      <p className="mt-4 flex items-center gap-1.5 text-sm text-muted-foreground"><KeyRound className="size-4" />Tokens are yours alone: an admin can't see them. Turning off your panel account stops them all.</p>
    </Page>
  );
}
