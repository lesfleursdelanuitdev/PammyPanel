// Install a new WordPress (docs/apps-plan.md 4b): where it goes, its title and
// its admin. The software helper checks everything again and does the work as
// a job; this page hands over and goes to the new one's own page, which shows
// each step and, at the end, its admin password once.
import { ArrowLeft, Download } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { Field, InlineLink, Page, Section } from '@panel/core/web/components/page';
import { Button } from '@panel/core/web/components/ui/button';
import { Input } from '@panel/core/web/components/ui/input';
import { useAction } from '@panel/core/web/hooks/useAction';
import { usePageTitle } from '@panel/core/web/hooks/useApi';
import { api } from '@panel/core/web/lib/api';
import { notify } from '@panel/core/web/lib/status';
import { SITE } from '@panel/core/web/lib/site';
import { useWholeSite } from '../lib/whole-site';

type Mode = 'subdomain' | 'path' | 'root' | 'off';
const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export default function SoftwareInstall() {
  usePageTitle('Install WordPress');
  // "Try again" on an install that didn't finish: the same name, and the helper
  // picks up where it stopped
  const again = useSearchParams()[0].get('again');
  // the whole website only where nginx still reads WordPress's part of it (8-7d)
  const wholeSite = useWholeSite();
  const [mode, setMode] = useState<Mode>('subdomain');
  const [name, setName] = useState(again ?? '');
  const [short, setShort] = useState(again ?? '');
  const [title, setTitle] = useState('');
  const [adminUser, setAdminUser] = useState(SITE.owner?.user ?? '');
  const [adminEmail, setAdminEmail] = useState(SITE.mail?.notifyTo ?? '');
  const run = useAction();
  const dialogs = useDialogs();
  const navigate = useNavigate();
  const clean = name.trim().toLowerCase();
  const named = mode === 'subdomain' || mode === 'path';
  const id = (named ? clean : short.trim().toLowerCase());
  const where = mode === 'root' ? `the whole of ${SITE.domain}` : mode === 'off' ? 'no address yet' : mode === 'subdomain' ? `${clean || 'name'}.${SITE.domain}` : `${SITE.domain}/${clean || 'name'}/`;

  const install = async () => {
    if (named && !NAME_RE.test(clean)) return notify('Use lowercase letters, digits and hyphens for the name, like "journal".', 'error');
    if (!/^[a-z][a-z0-9]{0,19}(-[a-z0-9]+)*$/.test(id) || id.length > 20) return notify('Its short name: lowercase letters and digits, starting with a letter, at most 20.', 'error');
    if (!await dialogs.confirm({
      title: `Install WordPress at ${where}?`,
      body: <>
        <p>It takes a few minutes: the server makes it a user of its own, downloads WordPress and its database, and sets it up. You can leave the page while it works.</p>
        {mode === 'root' && <p className="mt-2">It becomes the home page of {SITE.domain}. Your own pages and folders stay as they are.</p>}
        <p className="mt-2">At the end you get its admin password once. It is also saved in your home folder, in apps/{id}-login.txt.</p>
      </>,
      action: 'Install it',
    })) return;
    const r = await run(() => api<{ id: string }>('/api/software/install', {
      placement: { mode, name: named ? clean : undefined }, id, title: title.trim(), adminUser: adminUser.trim(), adminEmail: adminEmail.trim(),
    }), 'Installing. It takes a few minutes.');
    if (r) navigate(`/software/${r.id}`);
  };

  return (
    <Page title="Install WordPress"
      intro={again
        ? <>Trying <strong>{again}</strong> again. Keep its name: what the first try made is kept, and it picks up from there. <InlineLink to="/help/wordpress">About WordPress</InlineLink></>
        : <>A new WordPress site of its own, beside your pages and the ones you have. <InlineLink to="/help/wordpress">About WordPress</InlineLink></>}
      actions={<Button asChild variant="ghost" size="sm"><Link to="/software"><ArrowLeft />Installed software</Link></Button>}>
      <Section title="Where it goes">
        <form className="grid gap-4" id="install-form" onSubmit={(e) => { e.preventDefault(); void install(); }}>
          <fieldset className="grid gap-1.5 text-sm">
            <legend className="sr-only">Where</legend>
            {([['subdomain', `Its own subdomain, like journal.${SITE.domain}`], ['path', `A folder of ${SITE.domain}, like ${SITE.domain}/journal/`], ['root', `The whole of ${SITE.domain}`], ['off', 'Nowhere yet (set it up first, put it somewhere later)']] as const).filter(([v]) => v !== 'root' || wholeSite).map(([v, label]) => (
              <label key={v} className="flex items-center gap-2"><input type="radio" name="install-mode" value={v} checked={mode === v} onChange={() => setMode(v)} />{label}</label>
            ))}
          </fieldset>
          {named ? (
            <Field label="Name" htmlFor="i-name" hint="Lowercase letters, digits and hyphens. Not the name of one of your folders.">
              <Input id="i-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={20} autoComplete="off" spellCheck={false} placeholder="journal" />
            </Field>
          ) : (
            <Field label="A short name for it" htmlFor="i-short" hint="How the panel calls it, like “shop”. Lowercase letters and digits.">
              <Input id="i-short" value={short} onChange={(e) => setShort(e.target.value)} maxLength={20} autoComplete="off" spellCheck={false} placeholder="shop" />
            </Field>
          )}
          <p className="text-sm text-muted-foreground">It will be at <strong>{where}</strong>.</p>
        </form>
      </Section>
      <Section title="The site">
        <div className="grid gap-4">
          <Field label="Its title" htmlFor="i-title" hint="Shown at the top of its pages. You can change it later in WordPress.">
            <Input id="i-title" form="install-form" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} required placeholder="Olivia’s journal" />
          </Field>
          <Field label="Admin name" htmlFor="i-user" hint="The name you sign in to its admin pages with.">
            <Input id="i-user" form="install-form" value={adminUser} onChange={(e) => setAdminUser(e.target.value)} maxLength={30} required autoComplete="off" spellCheck={false} />
          </Field>
          <Field label="Admin email" htmlFor="i-email" hint="Where WordPress writes to its admin, like for a forgotten password.">
            <Input id="i-email" form="install-form" type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} required autoComplete="off" />
          </Field>
          <div><Button type="submit" form="install-form"><Download />Install it</Button></div>
        </div>
      </Section>
    </Page>
  );
}
