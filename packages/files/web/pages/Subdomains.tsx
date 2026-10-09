import { ArchiveRestore, FilePlus2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { HomePageEditor, RemoveHomePage } from '../components/home-page';
import { ActionButton, Addresses, Empty, Field, List, Loading, Page, Row, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { Input } from '@panel/core/web/components/ui/input';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { api, ApiError, formatTime, friendlyError, signedOut } from '@panel/core/web/lib/api';
import { folderAddresses, nameProblem } from '@panel/core/web/lib/names';
import { clearNotice, notify } from '@panel/core/web/lib/status';
import type { SitesData } from '@panel/core/web/lib/types';
import { cn } from '@panel/core/web/lib/utils';
import { SITE } from '@panel/core/web/lib/site';
import { useMe } from '@panel/core/web/hooks/useMe';
import { isKept } from '@panel/core/web/lib/rights';

export function Subdomains() {
  usePageTitle('Subdomains');
  const sites = useApi<SitesData>('/api/sites');
  // kept to places (docs/permissions-plan.md R5): their own folders' pages only;
  // making, trashing and restoring folders is for whoever looks after the whole site
  const me = useMe();
  const kept = !!me && isKept(me);
  const run = useAction();
  const dialogs = useDialogs();
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<string | null>(null);   // the folder whose temporary page is open
  const reserved = sites.data?.reserved ?? ['www', 'api', 'panel', 'media'];
  const problem = nameProblem(name.trim(), reserved);

  const create = async () => {
    const n = name.trim();
    if (problem !== null) return notify(problem || 'Please type a name.', 'error');
    const r = await run(() => api('/api/sites', { name: n }), `Created. ${n}.${SITE.domain} is live now; open it and press Ctrl+F5 if you see an old page.`);
    if (r) setName('');
  };

  const restore = async (entry: string, original: string) => {
    let as: string | undefined;
    for (;;) {
      clearNotice();
      try {
        const r = await api<{ name: string }>('/api/sites/restore', { entry, as });
        notify(`"${r.name}" is back.`);
        break;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return signedOut();
        if (!(err instanceof ApiError) || err.status !== 409) { notify(friendlyError(err), 'error'); break; }
        const next = await dialogs.prompt({
          title: `There's already a folder called "${as ?? original}"`, label: 'Restore it under this name', value: `${original}-restored`, action: 'Restore',
        });
        if (next === null) break;
        as = next;
      }
    }
    await sites.refetch();
  };

  return (
    <Page title="Subdomains" intro={`Every folder in your website with a simple lowercase name is also a subdomain: recipes/ is recipes.${SITE.domain}.`}>
      {!kept && <Section title="Make a subdomain" intro="This makes a folder in your website with a temporary page in it, whose words you can change below. It's live straight away at both of its addresses.">
        <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <Field label="Name" htmlFor="site-name" className="flex-1">
            <Input id="site-name" maxLength={63} placeholder="e.g. recipes" autoComplete="off" autoCapitalize="none" spellCheck={false}
              value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!problem} aria-describedby="site-preview" />
          </Field>
          <Button type="submit"><Plus />Create</Button>
        </form>
        <p id="site-preview" className={cn('mt-2 text-sm', problem ? 'font-semibold text-destructive' : 'text-muted-foreground')}>
          {problem === '' ? 'Lowercase letters, digits and hyphens.' : problem ?? `It will be live at https://${name.trim()}.${SITE.domain}/ and https://${SITE.domain}/${name.trim()}/`}
        </p>
      </Section>}

      <Section flush title="Your folders" intro="Every folder in your website. A folder with a simple lowercase name is also a subdomain.">
        {!sites.data ? <Loading /> : (
          <List label="Your folders">
            {sites.data.folders.length === 0 && <Empty>No folders yet.</Empty>}
            {sites.data.folders.map((f) => (
              <Row key={f.name} title={f.name}
                badges={<>
                  {f.subdomain && <Badge variant="ok">subdomain</Badge>}
                  {f.reserved && <Badge>name used by the server</Badge>}
                  {!f.subdomain && !f.reserved && <Badge>no subdomain (name has capitals or symbols)</Badge>}
                  {f.homePage === 'none' && <Badge variant="warn">no home page</Badge>}
                  {f.homePage === 'temporary' && <Badge>temporary page</Badge>}
                  {f.symlink && <Badge>shortcut</Badge>}
                </>}
                actions={kept ? null :
                  <ActionButton variant="danger" icon={Trash2} onClick={async () => {
                    const ok = await dialogs.confirm({
                      title: `Move "${f.name}" to the trash?`, action: 'Move to trash', danger: true,
                      body: <>
                        <p>Its addresses stop working straight away. You can restore it from the trash for {sites.data!.purgeDays} days.</p>
                        {!f.hasIndex && <p>This folder has no index.html, so it may hold files other pages use, like images or styles. Those pages would break.</p>}
                      </>,
                    });
                    if (ok) await run(() => api('/api/sites/trash', { name: f.name }), `"${f.name}" moved to the trash.`);
                  }}>Move to trash</ActionButton>
                }>
                {!f.reserved && <Addresses links={f.subdomain ? folderAddresses(f.name, reserved).reverse() : folderAddresses(f.name, reserved).slice(0, 1)} />}
                {/* a temporary home page: only a folder that can be a subdomain, and not a protected one (docs/temporary-home-plan.md) */}
                {f.subdomain && !f.protected && !f.symlink && f.homePage !== 'own' && (editing === f.name
                  ? <HomePageEditor folder={f.name} onDone={() => setEditing(null)} />
                  : f.homePage === 'none' ? (
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
                      <span className="text-muted-foreground">It has no index.html, so visitors see "403 Forbidden" there.</span>
                      <Button size="sm" variant="outline" onClick={() => setEditing(f.name)}><FilePlus2 />Make a temporary page</Button>
                    </div>
                  ) : (
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                      <span className="text-muted-foreground">A temporary page the panel made. Put your own index.html here and it takes its place.</span>
                      <Button size="sm" variant="outline" onClick={() => setEditing(f.name)}><Pencil />Change the words</Button>
                      <RemoveHomePage folder={f.name} />
                    </div>
                  ))}
              </Row>
            ))}
          </List>
        )}
      </Section>

      {!kept && <Section flush title="Trash" intro="Folders you've moved to the trash. Restore them within 30 days; after that they're deleted for good.">
        {sites.data && (
          <List label="Trash">
            {sites.data.trash.length === 0 && <Empty>The trash is empty.</Empty>}
            {sites.data.trash.map((t) => (
              <Row key={t.entry} title={t.name}
                meta={`Moved to the trash ${formatTime(t.trashedAt)} · deleted for good after ${formatTime(t.purgeAt)}`}
                actions={<ActionButton icon={ArchiveRestore} onClick={() => restore(t.entry, t.name)}>Restore</ActionButton>} />
            ))}
          </List>
        )}
      </Section>}
    </Page>
  );
}
