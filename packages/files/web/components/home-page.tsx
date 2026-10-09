// A temporary home page for a folder that has none (docs/temporary-home-plan.md):
// what it says, and which of her stylesheets it wears. The website helper
// writes it, only in a folder that can be a subdomain, and never over a page of hers.
import { Save, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { ActionButton, ExternalLink, Field } from '@panel/core/web/components/page';
import { Button } from '@panel/core/web/components/ui/button';
import { Checkbox } from '@panel/core/web/components/ui/checkbox';
import { Input } from '@panel/core/web/components/ui/input';
import { NativeSelect } from '@panel/core/web/components/ui/native-select';
import { Textarea } from '@panel/core/web/components/ui/textarea';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi } from '@panel/core/web/hooks/useApi';
import { api } from '@panel/core/web/lib/api';

type Words = { heading: string; message: string; link: boolean; style: string };
type HomePageData = {
  kind: 'none' | 'own' | 'temporary'; words: Words | null; site: string;
  styles: { id: string; label: string }[]; limits: { heading: number; message: number };
};

// a start she can change: the words are hers either way
const SUGGESTIONS: { heading: string; message: string }[] = [
  { heading: 'Coming soon', message: 'This part of the website is on its way. Please come back soon.' },
  { heading: 'Under construction', message: "I'm working on this page. It will be ready before long." },
  { heading: 'Nothing here yet', message: '' },
];

export function HomePageEditor({ folder, onDone }: { folder: string; onDone: () => void }) {
  const q = useApi<HomePageData>(`/api/sites/${encodeURIComponent(folder)}/home-page`);
  const run = useAction();
  const id = useId();
  const [w, setW] = useState<Words | null>(null);
  const d = q.data;

  useEffect(() => {
    if (d && !w) {
      // the style it had, or the folder's own stylesheet, or the main site's: her look first (Q3)
      const firstOwn = d.styles.find((s) => s.id.startsWith('folder:')) ?? d.styles.find((s) => s.id.startsWith('site:'));
      setW(d.words ?? { ...SUGGESTIONS[0]!, link: true, style: firstOwn?.id ?? 'plain' });
    }
  }, [d, w]);

  if (!d || !w) return <div className="h-24 animate-pulse rounded bg-muted" role="status" aria-label="Loading" />;
  const save = async () => {
    const r = await run(() => api<{ made: boolean; address: string }>(`/api/sites/${encodeURIComponent(folder)}/home-page`, w),
      (x) => (x.made ? `"${folder}" has a temporary home page now.` : 'The temporary page is changed.'));
    if (r) onDone();
  };

  return (
    <form className="mt-2 grid gap-4 rounded-md border border-border bg-muted/30 p-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Start from:</span>
        {SUGGESTIONS.map((s) => (
          <Button key={s.heading} type="button" size="sm" variant="outline" onClick={() => setW({ ...w, heading: s.heading, message: s.message })}>{s.heading}</Button>
        ))}
      </div>
      <Field label="Heading" htmlFor={`${id}-h`}>
        <Input id={`${id}-h`} value={w.heading} maxLength={d.limits.heading} required onChange={(e) => setW({ ...w, heading: e.target.value })} />
      </Field>
      <Field label="What it says" htmlFor={`${id}-m`} hint="A few lines. Leave an empty line between paragraphs.">
        <Textarea id={`${id}-m`} rows={4} value={w.message} maxLength={d.limits.message} onChange={(e) => setW({ ...w, message: e.target.value })} />
      </Field>
      <Field label="Its look" htmlFor={`${id}-s`}
        hint={d.styles.length > 1 ? 'One of your own stylesheets makes it look like the rest of your site.' : 'This folder and your main site have no stylesheet yet, so it is plain.'}>
        <NativeSelect id={`${id}-s`} value={w.style} onChange={(e) => setW({ ...w, style: e.target.value })}>
          {d.styles.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </NativeSelect>
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={w.link} onCheckedChange={(v) => setW({ ...w, link: v === true })} />
        Add a link to {d.site}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit"><Save />{d.kind === 'temporary' ? 'Save the changes' : 'Make the page'}</Button>
        <Button type="button" variant="ghost" onClick={onDone}><X />Cancel</Button>
        {d.kind === 'temporary' && <ExternalLink href={`https://${folder}.${d.site}/`} className="text-sm">See it now</ExternalLink>}
      </div>
    </form>
  );
}

export function RemoveHomePage({ folder }: { folder: string }) {
  const run = useAction();
  return (
    <ActionButton variant="ghost" onClick={() => run(() => api(`/api/sites/${encodeURIComponent(folder)}/home-page/remove`, {}), 'The temporary page is gone.')}>
      Remove the temporary page
    </ActionButton>
  );
}
