import { useQueryClient } from '@tanstack/react-query';
import { FilePlus, Lock, LockOpen, TriangleAlert, Users } from 'lucide-react';
import { Link } from 'react-router';
import { useId, useState } from 'react';
import { CredentialsBox, linkCredentials, type Credentials } from '../components/credentials';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { AccessCheckbox, AddPersonForm } from '../components/people';
import { FolderPicker } from '@panel/core/web/components/folder-picker';
import { ActionButton, Addresses, Collapsible, InlineLink, Loading, Page, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { Switch } from '@panel/core/web/components/ui/switch';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { api } from '@panel/core/web/lib/api';
import { folderAddresses, personLabel } from '@panel/core/web/lib/names';
import { notify } from '@panel/core/web/lib/status';
import type { Area, GateState } from '@panel/core/web/lib/types';

// Same five as src/sitefs/ops.ts SIGNIN_PAGES, plus their shared stylesheet.
const SIGNIN_PAGES: [string, string][] = [
  ['login.html', 'sign in'], ['login-forgot.html', 'forgot password'],
  ['login-invite.html', 'choose a password'], ['login-request.html', 'ask for access'], ['logout.html', 'signed out'],
];
const LOGIN_STYLE = 'login-files/style.css';
const missingStarters = (area: Area) => SIGNIN_PAGES.length + 1 - area.pages.length;

function pagesSummary(area: Area) {
  const own = SIGNIN_PAGES.filter(([f]) => area.pages.includes(f)).map(([f]) => f);
  const builtIn = SIGNIN_PAGES.filter(([f]) => !area.pages.includes(f)).map(([, label]) => label);
  const style = area.pages.includes(LOGIN_STYLE) ? ` Their look: ${LOGIN_STYLE}.` : '';
  if (!builtIn.length) return `Sign-in pages: all its own (${own.join(', ')}).${style}`;
  if (!own.length) return `Sign-in pages: the built-in ones, because the folder has none of its own.${style}`;
  return `Sign-in pages: its own ${own.join(', ')}; the built-in page for ${builtIn.join(', ')}.${style}`;
}

export function ProtectedFolders() {
  usePageTitle('Protected folders');
  const gate = useApi<GateState>('/api/protected');
  const run = useAction();
  const dialogs = useDialogs();
  const [path, setPath] = useState('');
  const [openAddFor, setOpenAddFor] = useState<number | null>(null);
  const [shown, setShown] = useState<{ areaId: number; c: Credentials } | null>(null);
  const reserved = gate.data?.reserved ?? [];

  const taken = new Set(gate.data?.areas.map((a) => a.path));
  const locked = new Set(gate.data?.locked);
  // Everything inside a protected folder is locked already. The nearest protected
  // folder a folder is inside (copies and locked ones count), or null.
  const lockedAbove = [...taken, ...(gate.data?.areas.flatMap((a) => a.copies) ?? []), ...locked];
  const insideProtected = (f: string) =>
    lockedAbove.filter((p) => f.startsWith(`${p}/`)).sort((a, b) => b.length - a.length)[0] ?? null;
  const chosen = path.trim().replace(/^\/+|\/+$/g, '');
  const chosenInside = chosen && !taken.has(chosen) && !locked.has(chosen) ? insideProtected(chosen) : null;

  const protect = async () => {
    const p = path.trim().replace(/^\/+|\/+$/g, '');
    if (!p) return notify('Pick a folder to protect.', 'error');
    const above = insideProtected(p);
    if (above && !taken.has(p) && !await dialogs.confirm({
      title: `"${p}" is already protected`, action: 'Add a second lock',
      body: `It's inside the protected folder "${above}", so it's locked already, and the people who can open "${above}" can open it. Protecting it too adds a second lock: people will need to be let into both "${above}" and "${p}". Only do this if some people who can open "${above}" shouldn't see it.`,
    })) return;
    const r = await run(() => api<{ id: number; path: string; loginCreated: boolean; created: string[] }>('/api/protected', { path: p }));
    if (!r) return;
    setPath('');
    setOpenAddFor(r.id);
    notify(`"${r.path}" is protected.${r.created.length ? ` Starter ${r.created.length === 1 ? 'file' : 'files'} put in it, to change as you like: ${r.created.join(', ')}.` : ''} Now choose who can open it.${above ? ` They also need to be let into "${above}".` : ''}`);
    setTimeout(() => document.getElementById(`area-${r.id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 300);
  };

  return (
    <Page title="Protected folders" intro={<>A protected folder needs a username and password to open. You choose who gets in. <InlineLink to="/help/protected-folders">How protected folders and sign-in pages work</InlineLink></>}>
      <Section title="Protect a folder" intro="Everything inside it, including folders inside it, will need a username and password. Five starter sign-in pages are put in it for you (sign in, forgot password, choose a password, ask for access, signed out), with login-files/style.css for their look, unless it already has its own.">
        <form onSubmit={(e) => { e.preventDefault(); void protect(); }}>
          <FolderPicker id="protect-path" label="Folder" placeholder="Type to find a folder, e.g. family" folders={gate.data?.folders}
            loading={!gate.data} value={path} onChange={setPath}
            status={(f) => {
              if (taken.has(f)) return { note: 'protected', disabled: true };
              if (locked.has(f)) return { note: 'locked', disabled: true };
              const above = insideProtected(f);
              return above ? { note: `inside ${above}` } : null;
            }}
            hint={chosenInside && (
              <span role="note" className="flex items-start gap-1.5 text-sm text-amber-800 dark:text-amber-300">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <span>"{chosen}" is already locked, because it's inside the protected folder "{chosenInside}". Protecting it too adds a second lock: people would need to be let into both.</span>
              </span>
            )}
            action={<Button type="submit"><Lock />Protect</Button>} />
        </form>
      </Section>

      {gate.data && gate.data.locked.length > 0 && (
        <Section title="Locked folders" intro="These folders have a protection file (.pammy-protected) the panel doesn't recognise, so nobody can open them. If that's not what you meant, delete the .pammy-protected file inside the folder in WinSCP, or ask momolig.">
          <ul className="list-disc pl-6">{gate.data.locked.map((p) => <li key={p}>{p}</li>)}</ul>
        </Section>
      )}

      <Section plain title="Your protected folders">
        {!gate.data ? <Loading /> : gate.data.areas.length === 0
          ? <p className="rounded-lg border border-dashed border-border px-5 py-6 text-muted-foreground">No protected folders yet.</p>
          : (
            <div className="space-y-6">
              {gate.data.areas.map((area) => (
                <AreaCard key={area.id} area={area} gate={gate.data!} reserved={reserved}
                  addOpen={openAddFor === area.id || gate.data!.visitors.length === 0}
                  shown={shown?.areaId === area.id ? shown.c : null}
                  onShown={(c) => { setShown(c ? { areaId: area.id, c } : null); setOpenAddFor(null); }} />
              ))}
            </div>
          )}
      </Section>
    </Page>
  );
}

function AreaCard({ area, gate, reserved, addOpen, shown, onShown }:
  { area: Area; gate: GateState; reserved: string[]; addOpen: boolean; shown: Credentials | null; onShown: (c: Credentials | null) => void }) {
  const run = useAction();
  const dialogs = useDialogs();
  const qc = useQueryClient();
  const switchId = useId();
  const [requestsOpen, setRequestsOpen] = useState<boolean | null>(null);
  const people = gate.visitors;

  return (
    <article id={`area-${area.id}`} className="scroll-mt-20 rounded-lg border border-border bg-card shadow-card">
      <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <h3 className="flex flex-wrap items-center gap-2 text-base font-semibold [overflow-wrap:anywhere]">
            <span className="grid size-7 place-items-center rounded-md bg-primary-soft text-primary"><Lock className="size-4" /></span>{area.path}
            {!area.exists && <Badge variant="warn">folder not found</Badge>}
            {area.visitors.length === 0 && <Badge variant="warn">nobody can open it yet</Badge>}
            {area.exists && !area.hasIndex && <Badge>no index.html</Badge>}
          </h3>
          <Addresses links={folderAddresses(area.path, reserved)} />
          <div className="mt-2 space-y-1 text-sm text-muted-foreground">
            <p>{area.exists ? pagesSummary(area) : 'The folder is gone (renamed with its protection file deleted, or moved to the trash). If a folder with this name appears again, it will be protected.'}</p>
            {area.copies.length > 0 && <p>Copies with the same protection: {area.copies.join(', ')}</p>}
            {area.exists && !area.hasIndex && <p>This folder has no index.html, so there's no home page. People who sign in see a plain page listing the pages and folders inside it. Add an index.html to give them your own.</p>}
          </div>
          {area.exists && missingStarters(area) > 0 && (
            <ActionButton className="mt-3" icon={FilePlus} onClick={async () => {
              const r = await run(() => api<{ created: string[] }>(`/api/protected/${area.id}/pages`, {}));
              if (r) notify(r.created.length ? `Added ${r.created.join(', ')} to "${area.path}". You can change them in WinSCP.` : 'Nothing was missing.');
            }}>Add the missing starter pages</ActionButton>
          )}
          <div className="mt-4 flex items-center gap-3">
            <Switch id={switchId} checked={requestsOpen ?? area.requestsOpen} disabled={requestsOpen !== null} onCheckedChange={async (open) => {
              setRequestsOpen(open);
              await run(() => api(`/api/protected/${area.id}/requests`, { open }),
                open ? `People can ask for access to "${area.path}". Requests appear on the Requests page.` : `"${area.path}" no longer takes requests.`);
              await qc.refetchQueries({ queryKey: ['/api/protected'] });
              setRequestsOpen(null);
            }} />
            <label htmlFor={switchId} className="cursor-pointer text-[0.95rem]">Let people ask for access (the "ask for access" page)</label>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 sm:flex-col sm:items-end">
        {gate.rolesOn && <Button asChild variant="outline"><Link to={`/access/${area.id}`}><Users />Roles and privileges</Link></Button>}
        <ActionButton variant="danger" icon={LockOpen} onClick={async () => {
          const ok = await dialogs.confirm({
            title: `Stop protecting "${area.path}"?`, action: 'Stop protecting', danger: true,
            body: 'Anyone will be able to open it again, straight away. The people and their passwords stay, so you can protect it again later.',
          });
          if (ok) await run(() => api(`/api/protected/${area.id}/unprotect`, {}), `"${area.path}" is open to everyone again.`);
        }}>Stop protecting</ActionButton>
        </div>
      </div>

      {shown && <div className="px-5 pb-5"><CredentialsBox c={shown} onDone={() => onShown(null)} /></div>}

      <div className="border-t border-border px-5 py-4">
        <h4 className="mb-1 text-sm font-semibold">Who can open it</h4>
        {people.length === 0 ? <p className="text-muted-foreground">Nobody yet. Add a person below.</p>
          : <div className="grid sm:grid-cols-2">{people.map((v) => <AccessCheckbox key={v.id} area={area} visitor={v} label={personLabel(v)} />)}</div>}
      </div>
      <Collapsible className="rounded-t-none border-x-0 border-b-0" defaultOpen={addOpen} summary="Add a new person who can open this folder">
        <AddPersonForm areaIds={[area.id]} onAdded={async (p) => {
          const st = await qc.fetchQuery<GateState>({ queryKey: ['/api/protected'], queryFn: () => api('/api/protected'), staleTime: 0 });
          const v = st.visitors.find((x) => x.id === p.id);
          if (!v) return;
          onShown(p.link ? linkCredentials(v, p.link) : { kind: 'password', who: v.name || v.username, username: v.username, password: p.password!, paths: [area.path] });
          notify(`${p.username} can open "${area.path}"${p.link ? ' once they have chosen a password with the link below' : ''}.`);
        }} />
      </Collapsible>
    </article>
  );
}
