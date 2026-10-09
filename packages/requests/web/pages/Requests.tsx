import { Check, Link2, Trash2, X } from 'lucide-react';
import { useId, useState } from 'react';
import { CredentialsBox, type Credentials } from '@panel/areas/web/components/credentials';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { ActionButton, Collapsible, Empty, Facts, Field, List, Loading, Page, Row, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { Input } from '@panel/core/web/components/ui/input';
import { NativeSelect } from '@panel/core/web/components/ui/native-select';
import { RadioGroup, RadioGroupItem } from '@panel/core/web/components/ui/radio-group';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { api, formatTime } from '@panel/core/web/lib/api';
import { personLabel, suggestUsername } from '@panel/core/web/lib/names';
import { notify } from '@panel/core/web/lib/status';
import type { SetupLink } from '@panel/areas/web/lib/types';
import type { GateRequest, RequestsData } from '../lib/types';
import { SITE } from '@panel/core/web/lib/site';

type Approved = { username: string; contact: string; areaPath: string; role: string | null; link?: SetupLink };

const folderOf = (r: GateRequest) => (r.areaPath ? `"${r.areaPath}"` : SITE.folderSubdomains ? 'a folder that is no longer protected' : 'an address that no longer lets only people in');

export function Requests() {
  usePageTitle('Requests');
  const data = useApi<RequestsData>('/api/requests');
  const [shown, setShown] = useState<Credentials | null>(null);
  const show = (res: Approved, who: string) => {
    if (!res.link) return;
    setShown({ kind: 'link', who, username: res.username, contact: res.contact, link: res.link });
    setTimeout(() => document.getElementById('request-link')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 50);
  };

  return (
    <Page title="Requests" intro={`${SITE.folderSubdomains
      ? 'From the "ask for access" and "forgot your password" pages of your protected folders.'
      : 'From the "Ask for access" and "Forgot your password?" links on the sign-in page of an address that only lets people in (with "Emailed links" on, a forgotten password is emailed instead and never comes here).'} Nothing is sent to anyone automatically: when you say yes, you get a link to send them yourself (a text message is fine). Each link works once, for 7 days.`}>
      <div id="request-link" className="scroll-mt-24 empty:hidden">{shown && <CredentialsBox c={shown} onDone={() => setShown(null)} />}</div>
      <Section flush title="Waiting">
        {!data.data ? <Loading /> : (
          <List label="Waiting requests">
            {data.data.open.length === 0 && <Empty>No requests waiting.</Empty>}
            {data.data.open.map((r) => (r.kind === 'reset'
              ? <ResetRow key={r.id} r={r} onLink={show} />
              : <AccessRow key={r.id} r={r} data={data.data!} onLink={show} />))}
          </List>
        )}
      </Section>
      {data.data && (
        <Collapsible summary="Dealt with in the last 30 days">
          {data.data.recent.length === 0 ? <p className="text-muted-foreground">Nothing in the last 30 days.</p> : (
            <ul className="divide-y divide-border">
              {data.data.recent.map((r) => {
                const who = r.kind === 'reset' ? (r.person ? personLabel(r.person) : r.name) : r.name;
                const what = r.kind === 'reset' ? `${who} forgot their password` : `${who} asked to open ${folderOf(r)}`;
                const outcome = r.handledBy === 'they chose a new password' ? 'they chose a new password'
                  : `${r.status === 'declined' ? (r.kind === 'reset' ? 'dismissed' : 'declined') : r.kind === 'reset' ? 'new link made' : 'approved'}${r.handledBy ? ` by ${r.handledBy}` : ''}`;
                return (
                  <li key={r.id} className="py-3 first:pt-0 last:pb-0">
                    {what}
                    <div className="text-sm text-muted-foreground"><Facts items={[outcome, formatTime(r.handledAt)]} /></div>
                  </li>
                );
              })}
            </ul>
          )}
        </Collapsible>
      )}
    </Page>
  );
}

function Said({ r }: { r: GateRequest }) {
  return r.message ? <blockquote className="mt-2 whitespace-pre-wrap border-l-2 border-primary/40 pl-3 italic [overflow-wrap:anywhere]">{r.message}</blockquote> : null;
}

function ResetRow({ r, onLink }: { r: GateRequest; onLink: (res: Approved, who: string) => void }) {
  const run = useAction();
  const p = r.person;
  return (
    <Row title={<>{p ? personLabel(p) : r.name} <span className="font-normal">forgot their password</span></>}
      badges={p && !p.active && <Badge variant="warn">switched off</Badge>}
      meta={<Facts items={[`asked ${formatTime(r.createdAt)}`, r.areaPath && `on ${r.areaPath}`,
        p ? (p.contact ? `contact: ${p.contact}` : 'no contact detail saved for them') : 'this person has since been removed']} />}
      actions={<>
        {p && p.active && (
          <ActionButton variant="default" icon={Link2} onClick={async () => {
            const res = await run(() => api<Approved>(`/api/requests/${r.id}/approve`, {}));
            if (!res) return;
            onLink(res, p.name || p.username);
            notify(`New setup link made for ${res.username}. Their old password keeps working until they use the link.`);
          }}>Make a new link</ActionButton>
        )}
        <ActionButton icon={X} onClick={() => run(() => api(`/api/requests/${r.id}/decline`, {}), 'Dismissed. Nothing is sent to them.')}>Dismiss</ActionButton>
      </>}>
      <Said r={r} />
    </Row>
  );
}

function AccessRow({ r, data, onLink }: { r: GateRequest; data: RequestsData; onLink: (res: Approved, who: string) => void }) {
  const run = useAction();
  const dialogs = useDialogs();
  const uid = useId();
  const [who, setWho] = useState<'new' | 'existing'>('new');
  const [username, setUsername] = useState(() => suggestUsername(r.name, new Set(data.visitors.map((v) => v.username))));
  const [name, setName] = useState(r.name.slice(0, 60));
  const [existing, setExisting] = useState('');
  // the role they get, where there is more than Member to choose from (roles on)
  const [role, setRole] = useState(() => String(r.roles?.find((x) => x.key === 'member')?.id ?? r.roles?.[0]?.id ?? ''));
  const [busy, setBusy] = useState(false);

  const approve = async () => {
    if (who === 'existing' && !existing) return notify('Choose who they are on your People list.', 'error');
    setBusy(true);
    const payload = { ...(who === 'existing' ? { visitorId: Number(existing) } : { username, name }), ...(r.roles && role ? { roleId: Number(role) } : {}) };
    const res = await run(() => api<Approved>(`/api/requests/${r.id}/approve`, payload));
    setBusy(false);
    if (!res) return;
    if (res.link) {
      onLink(res, r.name);
      notify(`${res.username} can open "${res.areaPath}"${res.role ? ` as ${res.role}` : ''} once they choose a password. Send them the link below.`);
    } else {
      notify(`${res.username} can now open "${res.areaPath}"${res.role ? ` as ${res.role}` : ''}. They already have a password, so just let them know (${res.contact}).`);
    }
  };

  return (
    <Row title={<>{r.name} <span className="font-normal">wants to open {folderOf(r)}</span></>}
      meta={<Facts items={[`contact: ${r.contact}`, `asked ${formatTime(r.createdAt)}`]} />}
      actions={<>
        <ActionButton icon={X} onClick={async () => {
          if (await dialogs.confirm({ title: `Decline ${r.name}'s request?`, body: 'Nothing is sent to them.', action: 'Decline' })) await run(() => api(`/api/requests/${r.id}/decline`, {}), 'Declined.');
        }}>Decline</ActionButton>
        <ActionButton variant="danger" icon={Trash2} onClick={async () => {
          if (await dialogs.confirm({ title: 'Delete this request completely?', body: 'Use this for spam.', action: 'Delete', danger: true })) await run(() => api(`/api/requests/${r.id}/delete`, {}), 'Deleted.');
        }}>Delete as junk</ActionButton>
      </>}>
      <Said r={r} />
      {r.areaPath && (
        <details className="group mt-3">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 h-8 rounded-md bg-primary px-3 text-[0.8125rem] font-semibold text-primary-foreground shadow-card hover:bg-primary/90 [&::-webkit-details-marker]:hidden">
            <Check className="size-4" />Approve…
          </summary>
          <form className="mt-3 grid gap-3 rounded-lg border border-border p-4" onSubmit={(e) => { e.preventDefault(); void approve(); }}>
            <fieldset>
              <legend className="mb-2 text-sm font-semibold">Let them in as</legend>
              <RadioGroup value={who} onValueChange={(v) => setWho(v as 'new' | 'existing')}>
                <div className="flex items-center gap-2.5"><RadioGroupItem value="new" id={`${uid}-new`} /><label htmlFor={`${uid}-new`}>a new person, with this username:</label></div>
                <div className="grid gap-3 pl-7 sm:grid-cols-2">
                  <Field label="Username" htmlFor={`${uid}-u`}><Input id={`${uid}-u`} maxLength={64} autoComplete="off" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => { setUsername(e.target.value); setWho('new'); }} /></Field>
                  <Field label="Name (only you see it)" htmlFor={`${uid}-n`}><Input id={`${uid}-n`} maxLength={60} autoComplete="off" value={name} onChange={(e) => { setName(e.target.value); setWho('new'); }} /></Field>
                </div>
                {data.visitors.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2.5">
                    <RadioGroupItem value="existing" id={`${uid}-ex`} />
                    <label htmlFor={`${uid}-ex`}>someone already on your People list:</label>
                    <NativeSelect className="w-auto min-w-48" aria-label="Who they are" value={existing} onChange={(e) => { setExisting(e.target.value); if (e.target.value) setWho('existing'); }}>
                      <option value="">choose...</option>
                      {data.visitors.map((v) => <option key={v.id} value={String(v.id)}>{personLabel(v)}</option>)}
                    </NativeSelect>
                  </div>
                )}
              </RadioGroup>
            </fieldset>
            {r.roles && (
              <Field label="With the role" htmlFor={`${uid}-role`}>
                <NativeSelect id={`${uid}-role`} className="w-auto min-w-48" value={role} onChange={(e) => setRole(e.target.value)}>
                  {r.roles.map((x) => <option key={x.id} value={String(x.id)}>{x.label}</option>)}
                </NativeSelect>
              </Field>
            )}
            <div><Button type="submit" disabled={busy}><Check />Approve</Button></div>
          </form>
        </details>
      )}
    </Row>
  );
}
