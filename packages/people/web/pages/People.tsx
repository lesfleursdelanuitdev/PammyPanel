import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, Link2, LogOut, Mail, MailCheck, Pencil, Power, PowerOff, Trash2, Unlink } from 'lucide-react';
import { useState } from 'react';
import { CredentialsBox, linkCredentials, type Credentials } from '@panel/areas/web/components/credentials';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { AccessCheckbox, AddPersonForm } from '@panel/areas/web/components/people';
import { ActionButton, Empty, Facts, List, Loading, Page, Row, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { api, formatTime, plural } from '@panel/core/web/lib/api';
import { makePassword } from '@panel/core/web/lib/names';
import { notify } from '@panel/core/web/lib/status';
import type { SetupLink } from '@panel/areas/web/lib/types';
import { SITE } from '@panel/core/web/lib/site';
import type { Area, Visitor } from '@panel/core/web/lib/types';

// the gate's people, and the protected folders they may open (none where a folder is only a
// folder: lfdln's accounts are on routes, their roles given on each route's Access page --
// it has File Explorer since phase 8, but no protected folders)
// deletions: accounts deleted whose apps haven't all been told yet (docs/accounts-plan.md step 4b)
type Deletion = { username: string; deletedAt: number; tries: number; lastError: string | null };
type PeopleData = { areas: Area[]; visitors: Visitor[]; deletions?: Deletion[] };
const FOLDERS = SITE.folderSubdomains;

export function People() {
  usePageTitle('People');
  const gate = useApi<PeopleData>('/api/people');
  const qc = useQueryClient();
  const [shown, setShown] = useState<Credentials | null>(null);

  const show = (c: Credentials) => {
    setShown(c);
    setTimeout(() => document.getElementById('person-created')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 50);
  };
  const pathsFor = (st: PeopleData, v: Visitor) => st.areas.filter((a) => a.visitors.includes(v.id)).map((a) => a.path);

  return (
    <Page title="People" intro={FOLDERS ? 'The people who can sign in to your protected folders. The same person can open several folders.'
      : "The people who can sign in. One account works on every address that's open with accounts; what each person may do there is their role, given on that address's Access page."}>
      <Section title="Add a person" intro={FOLDERS ? 'Someone who can sign in to protected folders. You choose which folders.' : 'Someone who can sign in. Give them a role on an Access page afterwards.'}>
        {gate.data && (
          <AddPersonForm chooseAreas={FOLDERS ? gate.data.areas : undefined} onAdded={async (p) => {
            const st = await qc.fetchQuery<PeopleData>({ queryKey: ['/api/people'], queryFn: () => api('/api/people'), staleTime: 0 });
            const v = st.visitors.find((x) => x.id === p.id);
            if (!v) return;
            show(p.link ? linkCredentials(v, p.link) : { kind: 'password', who: v.name || v.username, username: v.username, password: p.password!, paths: pathsFor(st, v) });
            notify(`${p.username} was added.${p.link ? ' Send them the setup link below.' : ''}`);
          }} />
        )}
      </Section>
      <div id="person-created" className="scroll-mt-24 empty:hidden">{shown && <CredentialsBox c={shown} onDone={() => setShown(null)} />}</div>
      {gate.data?.deletions && gate.data.deletions.length > 0 && (
        <Section flush title="Deleted, still being passed on" intro="These accounts are gone. Each service that uses accounts is told, so it deletes what it keeps for them too; the panel keeps trying until every one has answered.">
          <List label="Deleted accounts still being passed on">
            {gate.data.deletions.map((d) => (
              <Row key={`${d.username}-${d.deletedAt}`} title={d.username}
                meta={<Facts items={[`deleted ${formatTime(d.deletedAt)}`, d.tries > 0 && `tried ${plural(d.tries, 'time')}`, d.lastError && `last answer: ${d.lastError}`]} />} />
            ))}
          </List>
        </Section>
      )}
      <Section flush title="Everyone">
        {!gate.data ? <Loading /> : (
          <List label="People">
            {gate.data.visitors.length === 0 && <Empty>No people yet.</Empty>}
            {gate.data.visitors.map((v) => <PersonRow key={v.id} v={v} gate={gate.data!} onShow={show} pathsFor={pathsFor} />)}
          </List>
        )}
      </Section>
    </Page>
  );
}

// Someone who also opens folders outside your places (docs/permissions-plan.md R5)
// is changed by whoever looks after the whole site; you still give or take your folders.
function PersonRow({ v, gate, onShow, pathsFor }: { v: Visitor; gate: PeopleData; onShow: (c: Credentials) => void; pathsFor: (st: PeopleData, v: Visitor) => string[] }) {
  const run = useAction();
  const dialogs = useDialogs();
  return (
    <Row title={<>{v.name || v.username}{v.name && <span className="ml-1.5 font-normal text-muted-foreground">({v.username})</span>}</>}
      badges={<>
        {!v.active && <Badge variant="warn">switched off</Badge>}
        {v.registered && <Badge variant="outline">made their own account</Badge>}
        {v.registered && !v.emailConfirmed && <Badge>hasn't confirmed their email yet</Badge>}
        {!v.hasPassword && <Badge>hasn't chosen a password yet</Badge>}
        {v.failedLast24h > 0 && <Badge variant="warn">{plural(v.failedLast24h, 'failed sign-in')} today</Badge>}
        {!v.whole && <Badge variant="outline">also opens other folders</Badge>}
      </>}
      meta={<Facts items={[
        v.email && `email: ${v.email}${v.emailConfirmed ? '' : ' (not confirmed)'}`,
        v.contact && `contact: ${v.contact}`,
        v.hasPassword && `last signed in ${formatTime(v.lastLoginAt)}`,
        v.sessions > 0 && `signed in on ${plural(v.sessions, 'browser')}`,
        v.linkExpiresAt && `setup link open until ${formatTime(v.linkExpiresAt)}`,
      ]} />}
      actions={!v.whole ? null : <>
        {/* An account someone made themselves: its password is theirs alone. The
            gate emails a link instead (docs/accounts-plan.md step 4). */}
        {v.active && v.email && v.emailConfirmed && (
          <ActionButton icon={Mail} onClick={() => run(() => api(`/api/visitors/${v.id}/send-reset`, {}),
            `A link to choose a new password was emailed to ${v.email}.`)}>Email a reset link</ActionButton>
        )}
        {v.active && v.registered && !v.emailConfirmed && (
          <ActionButton icon={MailCheck} onClick={() => run(() => api(`/api/visitors/${v.id}/resend-confirm`, {}),
            `The confirmation link was emailed to ${v.email} again.`)}>Send the confirmation again</ActionButton>
        )}
        {v.active && !v.registered && (
          <ActionButton icon={Link2} onClick={async () => {
            if (v.linkExpiresAt && !await dialogs.confirm({ title: `Make a new setup link for ${v.username}?`, body: 'The link you made before stops working.', action: 'Make a new link' })) return;
            const r = await run(() => api<{ link: SetupLink }>(`/api/visitors/${v.id}/link`, {}));
            if (r) onShow(linkCredentials(v, r.link));
          }}>{v.linkExpiresAt ? 'New setup link' : 'Send a setup link'}</ActionButton>
        )}
        {v.linkExpiresAt && (
          <ActionButton icon={Unlink} onClick={() => run(() => api(`/api/visitors/${v.id}/link/cancel`, {}), 'Setup link cancelled. It no longer works.')}>Cancel link</ActionButton>
        )}
        {!v.registered && <ActionButton icon={KeyRound} onClick={async () => {
          const password = await dialogs.prompt({
            title: `New password for ${v.username}`, label: 'Password (at least 10 characters)', value: makePassword(), action: 'Set password',
            body: "One is made up for you; change it if you like. They'll be signed out everywhere.",
          });
          if (password === null) return;
          const r = await run(() => api(`/api/visitors/${v.id}/password`, { password }), 'Password changed.');
          if (r) onShow({ kind: 'password', who: v.name || v.username, username: v.username, password, paths: pathsFor(gate, v) });
        }}>Set a password</ActionButton>}
        <ActionButton icon={Pencil} onClick={async () => {
          const name = await dialogs.prompt({ title: `Name for ${v.username}`, label: 'Name (only you see it)', value: v.name, action: 'Next' });
          if (name === null) return;
          const contact = await dialogs.prompt({ title: `How to reach ${v.username}`, label: 'A phone number or email (only you see it)', value: v.contact, action: 'Save' });
          if (contact === null) return;
          if (name !== v.name && !await run(() => api(`/api/visitors/${v.id}/rename`, { name }))) return;
          if (contact !== v.contact && !await run(() => api(`/api/visitors/${v.id}/contact`, { contact }))) return;
          notify('Saved.');
        }}>Edit</ActionButton>
        {v.sessions > 0 && (
          <ActionButton icon={LogOut} onClick={() => run(() => api(`/api/visitors/${v.id}/signout`, {}), `${v.username} is signed out everywhere.`)}>Sign out everywhere</ActionButton>
        )}
        <ActionButton variant={v.active ? 'danger' : 'outline'} icon={v.active ? PowerOff : Power} onClick={async () => {
          if (v.active && !await dialogs.confirm({ title: `Switch off ${v.username}?`, body: "They're signed out straight away and can't sign in until you switch them back on.", action: 'Switch off', danger: true })) return;
          await run(() => api(`/api/visitors/${v.id}/active`, { active: !v.active }), v.active ? `${v.username} is switched off.` : `${v.username} is switched on.`);
        }}>{v.active ? 'Switch off' : 'Switch on'}</ActionButton>
        <ActionButton variant="danger" icon={Trash2} onClick={async () => {
          if (!await dialogs.confirm({ title: `Remove ${v.username} completely?`, body: `They lose access to every ${FOLDERS ? 'folder' : 'address open with accounts'}. To stop them for a while instead, use Switch off.`, action: 'Remove', danger: true })) return;
          await run(() => api(`/api/visitors/${v.id}/delete`, {}), `${v.username} was removed.`);
        }}>Remove</ActionButton>
      </>}>
      {FOLDERS && <fieldset className="mt-3">
        <legend className="text-sm font-semibold">Can open</legend>
        {gate.areas.length === 0 ? <p className="text-sm text-muted-foreground">No protected folders yet.</p>
          : gate.areas.map((a) => <AccessCheckbox key={a.id} area={a} visitor={v} label={a.path} />)}
      </fieldset>}
    </Row>
  );
}
