// Everywhere (docs/catalog-plan.md C5, step 4): tags and categories that go on anything --
// the website's files and the records of tables with tags on. Made here; put on a file in
// File Explorer or on a record on its page, like any other.
import { Filter, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { ActionButton, Empty, Facts, Field, List, Loading, Row } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { Switch } from '@panel/core/web/components/ui/switch';
import { Input } from '@panel/core/web/components/ui/input';
import { NativeSelect } from '@panel/core/web/components/ui/native-select';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi } from '@panel/core/web/hooks/useApi';
import { api } from '@panel/core/web/lib/api';
import { LABEL_RULE, labelSlug, type LabelType, type ScopeLabel } from '../lib/labels';

type Everywhere = { may: boolean; labels: ScopeLabel[]; sources: { kind: string; label: string; items: number }[] };
const things = (n: number) => `${n.toLocaleString('en')} thing${n === 1 ? '' : 's'}`;

// onShowFiles: File Explorer's filter (none where there is no File Explorer); intro: the
// words above the list, where the default speaks of her website and records; publicSwitch:
// "Anyone can see it" (the data API's, step 4b: none where there is no Studio)
export function EverywhereLabels({ onShowFiles, intro, publicSwitch = true }: { onShowFiles?: (l: ScopeLabel) => void; intro?: ReactNode; publicSwitch?: boolean }) {
  const data = useApi<Everywhere>('/api/catalog/everywhere');
  const run = useAction();
  const dialogs = useDialogs();
  const [type, setType] = useState<LabelType>('tag');
  const [name, setName] = useState('');
  const slug = labelSlug(name);
  const d = data.data;

  const rename = async (l: ScopeLabel) => {
    const n = await dialogs.prompt({ title: `Rename the ${l.type} "${l.name}"`, label: 'New name', value: l.name, action: 'Rename', hint: LABEL_RULE });
    if (n === null || labelSlug(n) === l.name) return;
    await run(() => api(`/api/catalog/everywhere/${l.type}/${l.id}`, { name: labelSlug(n) }), `Renamed to "${labelSlug(n)}".`);
  };
  const remove = async (l: ScopeLabel) => {
    const ok = await dialogs.confirm({
      title: `Delete the ${l.type} "${l.name}"?`, action: 'Delete', danger: true,
      body: l.count ? `It comes off ${things(l.count)}: files and records. The things themselves stay as they are.` : 'Nothing has it.',
    });
    if (ok) await run(() => api(`/api/catalog/everywhere/${l.type}/${l.id}`, { delete: true }), `Deleted "${l.name}".`);
  };

  if (!d) return <Loading rows={2} />;
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground">
        {intro ?? <>Tags and categories that go on anything: {d.sources.map((s) => s.label).join(', ') || 'your website files'}. Use one for something
        that cuts across them (featured, say, on photos and on recipes alike). Your pages can show them with your records (switch on "Anyone can see it"); the media API doesn't show them yet.</>}
      </p>
      {d.may && (
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => {
          e.preventDefault();
          if (slug) void run(() => api('/api/catalog/everywhere', { type, name: slug }), `Made the ${type} "${slug}".`).then((r) => { if (r) setName(''); });
        }}>
          <Field label="New" htmlFor="everywhere-type"><NativeSelect id="everywhere-type" value={type} onChange={(e) => setType(e.target.value as LabelType)}>
            <option value="tag">Tag</option><option value="category">Category</option>
          </NativeSelect></Field>
          <Field label="Name" htmlFor="everywhere-name" hint={name && slug !== name ? (slug ? `Will be made as "${slug}".` : LABEL_RULE) : LABEL_RULE} className="min-w-56 flex-1">
            <Input id="everywhere-name" value={name} maxLength={60} autoComplete="off" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Button type="submit" disabled={!slug} className="mb-6"><Plus />Add</Button>
        </form>
      )}
      {(['category', 'tag'] as const).map((t) => {
        const mine = d.labels.filter((l) => l.type === t);
        return (
          <section key={t} aria-label={t === 'tag' ? 'Tags everywhere' : 'Categories everywhere'}>
            <h3 className="mb-2 text-base font-semibold">{t === 'tag' ? 'Tags' : 'Categories'}</h3>
            <List label={t === 'tag' ? 'Tags everywhere' : 'Categories everywhere'}>
              {mine.length === 0 && <Empty>No {t === 'tag' ? 'tags' : 'categories'} that go everywhere yet.</Empty>}
              {mine.map((l) => (
                <Row key={l.id} title={t === 'tag' ? `#${l.name}` : l.name}
                  badges={l.public && <Badge variant="ok">anyone can see it</Badge>}
                  meta={<Facts items={[things(l.count), <code key="a">{l.address}</code>]} />}
                  footer={d.may && publicSwitch && (
                    <label className="flex items-center gap-2.5 text-sm">
                      <Switch checked={l.public} aria-label={`Anyone can see ${l.address}`} onCheckedChange={(on) => void run(
                        () => api(`/api/catalog/everywhere/${l.type}/${l.id}`, { public: on }),
                        on ? `Anyone reading your records on your pages can now see "${l.name}".` : `Only keys (and the panel) can see "${l.name}" now.`)} />
                      Anyone can see it <span className="text-muted-foreground">(on your pages, with your records. It asks for your passkey.)</span>
                    </label>
                  )}
                  actions={<>
                    {onShowFiles && <ActionButton icon={Filter} onClick={() => onShowFiles(l)}>Show files</ActionButton>}
                    {d.may && <ActionButton icon={Pencil} onClick={() => void rename(l)}>Rename</ActionButton>}
                    {d.may && <ActionButton icon={Trash2} variant="danger" onClick={() => void remove(l)}>Delete</ActionButton>}
                  </>} />
              ))}
            </List>
          </section>
        );
      })}
    </div>
  );
}
