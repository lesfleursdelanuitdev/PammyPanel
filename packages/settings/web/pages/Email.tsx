// Email (docs/apps-plan.md phase 3): how pammy sends mail -- through Resend, as
// noreply@mail.lesfleursdelanuit.com -- and what the panel emails about. The
// key is typed in here once and never shown again (only its last four); the
// software helper keeps it, pammy-mail and WordPress use it.
import { Mail, Save, Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ActionButton, Facts, Field, InlineLink, Loading, Page, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { Checkbox } from '@panel/core/web/components/ui/checkbox';
import { Input } from '@panel/core/web/components/ui/input';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { api, formatTime, timeAgo } from '@panel/core/web/lib/api';
import type { MailPage } from '../lib/types';
import { isOn, SITE } from '@panel/core/web/lib/site';

// this page is only there with the mail module on, whose profile has its mail facts (checkFacts)
const MAIL = SITE.mail ?? { from: '', replyTo: '', notifyTo: '' };

function Tick({ id, checked, onChange, children }: { id: string; checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-2.5 py-1.5 text-sm">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} className="mt-0.5" />
      <span>{children}</span>
    </label>
  );
}

export default function Email() {
  usePageTitle('Email');
  const page = useApi<MailPage>('/api/mail');
  const run = useAction();
  const d = page.data;
  const settings = d && 'settings' in d.sending ? d.sending.settings : null;
  // the key and addresses set on the server by its installer (lfdln), not here
  const byInstaller = !!d && 'installer' in d.sending;
  const [key, setKey] = useState('');
  const [from, setFrom] = useState('');
  const [replyTo, setReplyTo] = useState('');
  const [notifyTo, setNotifyTo] = useState('');
  const [forms, setForms] = useState<number[]>([]);
  const [areas, setAreas] = useState<number[]>([]);
  const [requests, setRequests] = useState(false);
  // what the server has, once it arrives (and after each save)
  useEffect(() => {
    if (!d) return;
    setFrom(settings?.from ?? MAIL.from);
    setReplyTo(settings?.replyTo ?? MAIL.replyTo);
    setNotifyTo(settings?.notifyTo ?? MAIL.notifyTo);
    setForms(d.notices.forms);
    setAreas(d.notices.commentAreas);
    setRequests(d.notices.requests);
  }, [d, settings]);

  if (!d) return <Page title="Email"><Loading /></Page>;
  const sending = 'error' in d.sending || 'installer' in d.sending ? null : d.sending;
  const sender = 'error' in d.sender ? null : d.sender;
  const toggle = (list: number[], id: number, on: boolean) => (on ? [...list, id] : list.filter((x) => x !== id));
  const save = async () => {
    const r = await run(() => api('/api/mail/settings', { key, from, replyTo, notifyTo }), 'Saved. Send yourself a test to be sure.');
    if (r) setKey('');
  };
  const saveNotices = () => run(() => api('/api/mail/notices', { forms, commentAreas: areas, requests }), 'Saved.');
  const plainForms = d.forms.filter((f) => f.kind !== 'comments');
  const commentAreas = d.forms.filter((f) => f.kind === 'comments');

  return (
    <Page title="Email"
      intro={isOn('apps')
        ? <>How {SITE.domain} sends email: WordPress’s own (password resets, comment notices) and the panel’s notices to you. It goes through Resend, a sending service. <InlineLink to="/software/blog">WordPress</InlineLink></>
        : <>How {SITE.domain} sends email: the panel’s notices, and the emails visitors are sent. It goes through Resend, a sending service.</>}>

      <Section title={<span className="flex items-center gap-2">Sending {sender?.ready ? <Badge variant="ok">ready</Badge> : <Badge variant="warn">not set up</Badge>}</span>}
        intro={sender?.ready
          ? <>Sent as <strong>{sender.from}</strong>; the panel’s notices go to <strong>{sender.notifyTo}</strong>.{sender.sentToday ? ` ${sender.sentToday} sent by the panel today.` : ''}</>
          : sender ? sender.why : `The mail service isn't answering: ${(d.sender as { error: string }).error}`}>
        {byInstaller ? <p className="text-sm text-muted-foreground">The key and the addresses are set on the server, by its installer; changing them is a job there, not here.</p>
          : !sending ? <p className="text-sm text-destructive">{(d.sending as { error: string }).error}</p> : (
          <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <Field label="Resend API key" htmlFor="m-key"
              hint={sending.keySet
                ? <>The key in use ends in <strong>{sending.keyEnds}</strong>. Leave this empty to keep it.</>
                : <>In Resend: API keys, Create API key, “Sending access”, domain {MAIL.from.split('@')[1]}. It starts with <code>re_</code>. It is kept on the server and never shown again.</>}>
              <Input id="m-key" type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" spellCheck={false} placeholder={sending.keySet ? `re_…${sending.keyEnds}` : 're_…'} />
            </Field>
            <Field label="Sent from" htmlFor="m-from" hint="An address at the domain Resend has verified.">
              <Input id="m-from" type="email" value={from} onChange={(e) => setFrom(e.target.value)} required autoComplete="off" />
            </Field>
            <Field label="Replies go to" htmlFor="m-reply" hint="When someone answers one of these emails.">
              <Input id="m-reply" type="email" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} required autoComplete="off" />
            </Field>
            <Field label="Notices go to" htmlFor="m-to" hint="Where the panel tells you about new things (below).">
              <Input id="m-to" type="email" value={notifyTo} onChange={(e) => setNotifyTo(e.target.value)} required autoComplete="off" />
            </Field>
            <div><Button type="submit"><Save />Save</Button></div>
          </form>
        )}
      </Section>

      <Section title="Send a test"
        intro="Each one sends a short email to the notice address. If it doesn't arrive in a minute or two, look in the spam folder.">
        <div className="flex flex-wrap gap-2">
          <ActionButton icon={Send} variant="outline" disabled={!sender?.ready}
            onClick={() => run(() => api<{ to: string }>('/api/mail/test', {}), (r) => `Sent to ${r.to}.`)}>From the panel</ActionButton>
          {sending?.wordpress.map((w) => (
            <ActionButton key={w.id} icon={Mail} variant="outline" disabled={!w.configured}
              onClick={() => run(() => api<{ to: string }>(`/api/software/${w.id}/mail-test`, {}), (r) => `WordPress sent it to ${r.to}.`)}>From WordPress{sending.wordpress.length > 1 ? ` (${w.id})` : ''}</ActionButton>
          ))}
        </div>
      </Section>

      <Section title="Tell me about"
        intro={<>An email to {sender?.notifyTo ?? 'the notice address'} for each one. It says which form or folder and gives a link here; never what someone wrote, or who they are.</>}>
        <div className="grid gap-4">
          {plainForms.length > 0 && (
            <fieldset>
              <legend className="mb-1 text-sm font-semibold">New responses to</legend>
              {plainForms.map((f) => <Tick key={f.id} id={`n-f-${f.id}`} checked={forms.includes(f.id)} onChange={(v) => setForms(toggle(forms, f.id, v))}>{f.title} <span className="text-muted-foreground">({f.name})</span></Tick>)}
            </fieldset>
          )}
          {commentAreas.length > 0 && (
            <fieldset>
              <legend className="mb-1 text-sm font-semibold">Comments waiting for my OK in</legend>
              {commentAreas.map((f) => <Tick key={f.id} id={`n-c-${f.id}`} checked={areas.includes(f.id)} onChange={(v) => setAreas(toggle(areas, f.id, v))}>{f.title}{f.approvable ? '' : <span className="text-muted-foreground"> (shows comments right away, so there is nothing to wait for)</span>}</Tick>)}
            </fieldset>
          )}
          <fieldset>
            <legend className="mb-1 text-sm font-semibold">{isOn('hosts') ? 'Visitors' : 'Protected folders'}</legend>
            <Tick id="n-req" checked={requests} onChange={setRequests}>Someone asks to be let in, or forgot their password</Tick>
          </fieldset>
          <div><ActionButton icon={Save} onClick={saveNotices}>Save</ActionButton></div>
          <Facts items={[
            d.notices.lastSentAt ? `last notice sent ${timeAgo(d.notices.lastSentAt)}` : null,
            d.notices.lastProblem ? <span className="text-destructive">{d.notices.lastProblem} ({formatTime(d.notices.lastProblemAt)})</span> : null,
          ]} />
        </div>
      </Section>
    </Page>
  );
}
