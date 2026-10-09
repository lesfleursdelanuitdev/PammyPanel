import { Copy, Link2, LogOut, Power, PowerOff, SlidersHorizontal, Trash2, Unlink, UserPlus } from 'lucide-react';
import { useId, useState } from 'react';
import { useDialogs } from '../components/dialogs';
import { ActionButton, Facts, Field, List, Loading, Page, Row, Section } from '../components/page';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Checkbox } from '../components/ui/checkbox';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { RadioGroup, RadioGroupItem } from '../components/ui/radio-group';
import { copyText, useAction } from '../hooks/useAction';
import { useApi, usePageTitle } from '../hooks/useApi';
import { api, formatTime, plural } from '../lib/api';
import { partOn, PLACE_RIGHTS, RIGHT_WORDS, RIGHTS, type Right } from '../lib/rights';
import { cap, isOn, W } from '../lib/site';
import type { Account, SitesData } from '../lib/types';

// What an ordinary account may use (docs/permissions-plan.md R4-R6): the parts of
// the panel, each on or off, and the folders it is kept to (none: the whole site).
type Access = { rights: Right[]; places: string[] };
// the parts this site has (a part whose module isn't here can't be given)
const PARTS = RIGHTS.filter(partOn);
const partsSaid = (rights: readonly Right[]) => rights.map((r) => RIGHT_WORDS[r].label).join(', ');
// What a place is: a folder at the top of the website (pammy.org), or a host where
// the site routes names (lfdln, docs/hosts-plan.md H9).
// A place as people read it: "olivia", or "blog files" for installed software (catalog step 3b)
const placeName = (p: string) => (p.startsWith('/') ? p.slice(1) : `${p.slice('software:'.length)} files`);
const onlySoftware = (places: string[]) => places.length > 0 && places.every((p) => !p.startsWith('/'));
const PLACES = isOn('hosts') ? { many: 'hosts', none: 'There are no hosts yet.' } : { many: 'folders', none: 'There are no folders at the top of the website yet.' };

export function Accounts() {
  usePageTitle('Accounts');
  const users = useApi<{ users: Account[] }>('/api/users');
  const run = useAction();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [access, setAccess] = useState<Access>({ rights: [], places: [] });
  const [added, setAdded] = useState(0);   // a fresh picker after each new account (its "Where" too)
  const sites = useApi<SitesData>(isOn('hosts') ? null : '/api/sites', { staleTime: 60_000 });
  const hosts = useApi<{ hosts: { name: string }[] }>(isOn('hosts') ? '/api/hosts' : null, { staleTime: 60_000 });
  const folders = isOn('hosts') ? (hosts.data?.hosts ?? []).map((h) => h.name) : (sites.data?.folders ?? []).filter((f) => !f.symlink).map((f) => f.name);
  const [links, setLinks] = useState<Record<number, { link: string; expiresAt: number }>>({});

  return (
    <Page title="Accounts" intro={`Who can sign in to this panel, and what each person can use. A setup link lets someone add a passkey to their account. It works once, for 24 hours. Use it for new accounts and for anyone who lost their devices. ${cap(W.admin.many)} can use everything, and only they see this page.`}>
      <Section flush title="Accounts">
        {!users.data ? <Loading /> : (
          <List label="Accounts">
            {users.data.users.map((u) => <AccountRow key={u.id} u={u} folders={folders} link={links[u.id]} onLink={(l) => setLinks((x) => ({ ...x, [u.id]: l }))} />)}
          </List>
        )}
      </Section>
      <Section title="Add an account" intro="Choose what they can use now or later. A new account has nothing until you do.">
        <form className="grid gap-4" onSubmit={async (e) => {
          e.preventDefault();
          const u = username.trim().toLowerCase();
          const r = await run(() => api('/api/users', { username: u, displayName, ...access }), `Account added. Now create a setup link so ${displayName.trim() || u} can add a passkey.`);
          if (r) { setUsername(''); setDisplayName(''); setAccess({ rights: [], places: [] }); setAdded((n) => n + 1); }
        }}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field label="Username" htmlFor="new-username" className="flex-1">
              <Input id="new-username" maxLength={32} placeholder="e.g. pamela" autoComplete="off" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} />
            </Field>
            <Field label="Name" htmlFor="new-displayname" className="flex-1">
              <Input id="new-displayname" maxLength={60} placeholder="e.g. Pamela" autoComplete="off" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </Field>
          </div>
          <AccessPicker key={added} value={access} onChange={setAccess} folders={folders} />
          <div><Button type="submit"><UserPlus />Add account</Button></div>
        </form>
        <p className="mt-4 text-sm text-muted-foreground">
          To make someone {W.admin.a}, run <code className="font-mono">sudo pammy-panel role &lt;username&gt; manager</code> on the server.
          It isn't done from here, so a stolen sign-in can't make more of them.
        </p>
      </Section>
    </Page>
  );
}

// The whole site or some folders, then the parts: a part that can't tell which
// folder a thing is in yet can't be given to someone kept to folders.
function AccessPicker({ value, onChange, folders }: { value: Access; onChange: (a: Access) => void; folders: string[] }) {
  const uid = useId();
  const kept = value.places.length > 0;
  const softOnly = onlySoftware(value.places);
  const [someFolders, setSomeFolders] = useState(kept);
  // installed software's files are places too (docs/catalog-plan.md step 3b): File Explorer only
  const installed = useApi<{ apps: { id: string; kindName: string; setup: unknown; deleted: unknown }[] }>(isOn('apps') ? '/api/software' : null, { staleTime: 60_000 });
  const softwareShown = [...new Set([
    ...(installed.data?.apps ?? []).filter((x) => x.setup === null && x.deleted === null).map((x) => `software:${x.id}`),
    ...value.places.filter((p) => !p.startsWith('/')),
  ])].sort();
  const kindOf = (place: string) => installed.data?.apps.find((x) => `software:${x.id}` === place)?.kindName ?? 'software';
  const setPlaces = (places: string[]) =>
    onChange({ places, rights: !places.length ? value.rights : value.rights.filter((r) => (onlySoftware(places) ? r === 'files' : PLACE_RIGHTS.includes(r))) });
  // folders chosen before that aren't there any more still show, so they can be taken off
  const shown = [...new Set([...folders, ...value.places.filter((p) => p.startsWith('/')).map((p) => p.slice(1))])].sort();
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <fieldset className="min-w-0">
        <legend className="mb-2 text-sm font-semibold">Where</legend>
        <RadioGroup value={someFolders ? 'some' : 'all'} onValueChange={(v) => { setSomeFolders(v === 'some'); if (v === 'all') setPlaces([]); }}>
          <div className="flex items-center gap-2.5">
            <RadioGroupItem id={`${uid}-all`} value="all" />
            <label htmlFor={`${uid}-all`} className="cursor-pointer">The whole site</label>
          </div>
          <div className="flex items-center gap-2.5">
            <RadioGroupItem id={`${uid}-some`} value="some" />
            <label htmlFor={`${uid}-some`} className="cursor-pointer">Only these {PLACES.many}</label>
          </div>
        </RadioGroup>
        {someFolders && (
          <div className="mt-2 max-h-60 overflow-y-auto border-l-2 border-border pl-3">
            {shown.length === 0 && <p className="text-sm text-muted-foreground">{PLACES.none}</p>}
            {shown.map((f) => {
              const place = `/${f}`;
              return (
                <div key={f} className="flex items-center gap-2.5 py-1">
                  <Checkbox id={`${uid}-f-${f}`} checked={value.places.includes(place)}
                    onCheckedChange={(v) => setPlaces(v === true ? [...value.places, place].sort() : value.places.filter((p) => p !== place))} />
                  <label htmlFor={`${uid}-f-${f}`} className="cursor-pointer [overflow-wrap:anywhere]">{f}</label>
                </div>
              );
            })}
            {softwareShown.length > 0 && <p className="mt-3 mb-1 text-sm font-medium">Installed software's files</p>}
            {softwareShown.map((place) => (
              <div key={place} className="flex items-center gap-2.5 py-1">
                <Checkbox id={`${uid}-s-${place}`} checked={value.places.includes(place)}
                  onCheckedChange={(v) => setPlaces(v === true ? [...value.places, place].sort() : value.places.filter((p) => p !== place))} />
                <label htmlFor={`${uid}-s-${place}`} className="cursor-pointer [overflow-wrap:anywhere]">
                  {place.slice('software:'.length)} <span className="text-muted-foreground">({kindOf(place)}: its wp-content folder, in File Explorer)</span>
                </label>
              </div>
            ))}
            {!kept && <p className="mt-1 text-sm text-muted-foreground">Tick at least one, or they see the whole site.</p>}
          </div>
        )}
      </fieldset>
      <fieldset className="min-w-0">
        <legend className="mb-2 text-sm font-semibold">What they can use</legend>
        {PARTS.map((r) => {
          const shut = kept && (softOnly ? r !== 'files' : !PLACE_RIGHTS.includes(r));
          return (
            <div key={r} className="flex items-start gap-2.5 py-1">
              <Checkbox id={`${uid}-r-${r}`} className="mt-0.5" checked={!shut && value.rights.includes(r)} disabled={shut}
                onCheckedChange={(v) => onChange({ ...value, rights: v === true ? RIGHTS.filter((x) => x === r || value.rights.includes(x)) : value.rights.filter((x) => x !== r) })} />
              <label htmlFor={`${uid}-r-${r}`} className={shut ? 'text-muted-foreground' : 'cursor-pointer'}>
                <span className="font-medium">{RIGHT_WORDS[r].label}</span>
                <span className="block text-sm text-muted-foreground">{shut ? (softOnly ? 'Not for someone kept only to installed software: it is about the website.' : `Not for someone kept to ${PLACES.many} yet.`) : RIGHT_WORDS[r].about}</span>
              </label>
            </div>
          );
        })}
      </fieldset>
    </div>
  );
}

function AccountRow({ u, folders, link, onLink }: { u: Account; folders: string[]; link?: { link: string; expiresAt: number }; onLink: (l: { link: string; expiresAt: number }) => void }) {
  const run = useAction();
  const dialogs = useDialogs();
  const [choosing, setChoosing] = useState(false);
  return (
    <Row title={<>{u.displayName} <span className="font-normal text-muted-foreground">({u.username})</span></>}
      badges={<>
        {u.role === 'manager' && <Badge>{W.admin.one}</Badge>}
        {!u.active && <Badge variant="warn">switched off</Badge>}
        {u.isYou && <Badge variant="ok">you</Badge>}
        {u.places.length > 0 && <Badge variant="outline">only {u.places.map(placeName).join(', ')}</Badge>}
        {u.role !== 'manager' && u.rights.length === 0 && <Badge variant="warn">nothing to use yet</Badge>}
      </>}
      meta={<Facts items={[u.role === 'manager' ? 'everything' : u.rights.length > 0 && partsSaid(u.rights), plural(u.passkeys.length, 'passkey'), `last sign-in ${formatTime(u.lastLoginAt)}`,
        u.active && plural(u.sessions, 'active session'), u.inviteExpiresAt && `setup link open until ${formatTime(u.inviteExpiresAt)}`]} />}
      actions={<>
        {u.active && (
          <ActionButton icon={Link2} onClick={async () => {
            const r = await run(() => api<{ link: string; expiresAt: number }>(`/api/users/${u.id}/invite`, {}));
            if (r) onLink(r);
          }}>{u.inviteExpiresAt ? 'New setup link' : 'Create setup link'}</ActionButton>
        )}
        {u.role !== 'manager' && <ActionButton icon={SlidersHorizontal} onClick={() => setChoosing(true)}>What they can use</ActionButton>}
        {u.inviteExpiresAt && <ActionButton icon={Unlink} onClick={() => run(() => api(`/api/users/${u.id}/invite/cancel`, {}), 'Setup link cancelled.')}>Cancel link</ActionButton>}
        {u.active && u.sessions > 0 && !u.isYou && (
          <ActionButton icon={LogOut} onClick={async () => {
            if (await dialogs.confirm({ title: `Sign ${u.displayName} out on every device?`, action: 'Sign out everywhere' })) await run(() => api(`/api/users/${u.id}/signout`, {}), 'Signed out everywhere.');
          }}>Sign out everywhere</ActionButton>
        )}
        {!u.isYou && (
          <ActionButton variant={u.active ? 'danger' : 'outline'} icon={u.active ? PowerOff : Power} onClick={async () => {
            if (u.active && !await dialogs.confirm({ title: `Switch off ${u.displayName}'s account?`, body: "They'll be signed out and can't sign in until you switch it back on.", action: 'Switch off', danger: true })) return;
            await run(() => api(`/api/users/${u.id}/${u.active ? 'disable' : 'enable'}`, {}), u.active ? 'Account switched off.' : 'Account switched on.');
          }}>{u.active ? 'Switch off' : 'Switch on'}</ActionButton>
        )}
      </>}>
      {u.passkeys.length > 0 && (
        <ul className="mt-3 space-y-1.5 border-l-2 border-border pl-3">
          {u.passkeys.map((pk) => (
            <li key={pk.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span><strong>{pk.name}</strong> <span className="text-muted-foreground">last used {formatTime(pk.lastUsedAt)}</span></span>
              <ActionButton variant="ghost" className="h-7 text-destructive" icon={Trash2} onClick={async () => {
                const last = u.passkeys.length === 1;
                const ok = await dialogs.confirm({
                  title: `Remove "${pk.name}" from ${u.displayName}'s account?`, action: 'Remove', danger: true,
                  body: last && !u.isYou ? `This is their only passkey: ${u.displayName} won't be able to sign in until you send a new setup link.` : undefined,
                });
                if (ok) await run(() => api(`/api/users/${u.id}/passkeys/${pk.id}/delete`, {}), 'Passkey removed.');
              }}>Remove</ActionButton>
            </li>
          ))}
        </ul>
      )}
      {choosing && <AccessDialog u={u} folders={folders} onClose={() => setChoosing(false)} />}
      {link && (
        <div className="mt-3 rounded-lg border-2 border-primary/40 bg-accent/60 p-3">
          <p>Send this to {u.displayName} privately. It works once, until {formatTime(link.expiresAt)}:</p>
          <div className="mt-2 select-all rounded-md border border-border bg-card px-3 py-2 font-mono text-sm [overflow-wrap:anywhere]">{link.link}</div>
          <Button size="sm" className="mt-2" onClick={() => copyText(link.link, 'Link')}><Copy />Copy link</Button>
        </div>
      )}
    </Row>
  );
}

// Their parts and folders, changed together. Nobody is signed out: it works on
// their very next click (the server reads it with every request).
function AccessDialog({ u, folders, onClose }: { u: Account; folders: string[]; onClose: () => void }) {
  const run = useAction();
  const [access, setAccess] = useState<Access>({ rights: u.rights, places: u.places });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-2xl">
        <form className="contents" onSubmit={async (e) => {
          e.preventDefault();
          const r = await run(() => api(`/api/users/${u.id}/access`, access), `Saved. ${u.displayName} has it from their next click.`);
          if (r) onClose();
        }}>
          <DialogHeader>
            <DialogTitle>What {u.displayName} can use</DialogTitle>
            <DialogDescription>
              {isOn('hosts')
                ? 'Kept to hosts, they see only those hosts in every part they have: their routes, the site folders they show and the files and media in them, and the forms and comments there. Activity always shows them only what they did themselves.'
                : 'Kept to folders, they see only those folders in every part they have: their files and media, the forms that work there and their responses, those protected folders and the people who open them. Activity always shows them only what they did themselves.'}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <AccessPicker value={access} onChange={setAccess} folders={folders} />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit"><SlidersHorizontal />Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
