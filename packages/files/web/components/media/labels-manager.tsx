// "Tags & categories" for the whole website ("*"), its top ("/") or one folder
// (D21): each with how many files have it, and rename, delete and "show its
// files". Nothing on the website changes.
import { Filter, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ActionButton, Empty, Facts, Field, InlineLink, List, Loading, Row } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { Switch } from '@panel/core/web/components/ui/switch';
import { Input } from '@panel/core/web/components/ui/input';
import { NativeSelect } from '@panel/core/web/components/ui/native-select';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi } from '@panel/core/web/hooks/useApi';
import { api } from '@panel/core/web/lib/api';
import { isOn, W } from '@panel/core/web/lib/site';
import { LABEL_RULE, labelSlug, scopeLabel } from '../../lib/media';
import type { LabelType, MediaLabel, TagScope } from '../../lib/types';

export function LabelsManager({ scope, onShow }: { scope: string; onShow: (l: MediaLabel) => void }) {
  const labels = useApi<{ labels: MediaLabel[] }>(`/api/media/labels?scope=${encodeURIComponent(scope)}`);
  const scopes = useApi<{ scopes: TagScope[] }>(`/api/media/scopes?tree=${encodeURIComponent(scope)}`);
  const run = useAction();
  const dialogs = useDialogs();
  const [type, setType] = useState<LabelType>('tag');
  const [name, setName] = useState('');
  const [inScope, setInScope] = useState(scope === '*' ? '/' : scope);
  const slug = labelSlug(name);

  const rename = async (l: MediaLabel) => {
    const n = await dialogs.prompt({ title: `Rename the ${l.type} "${l.name}"`, label: 'New name', value: l.name, action: 'Rename', hint: LABEL_RULE });
    if (n === null || labelSlug(n) === l.name) return;
    await run(() => api(`/api/media/labels/${l.type}/${l.id}`, { name: labelSlug(n) }), `Renamed to "${labelSlug(n)}".`);
  };
  const remove = async (l: MediaLabel) => {
    const ok = await dialogs.confirm({
      title: `Delete the ${l.type} "${l.name}"?`, action: 'Delete', danger: true,
      body: l.count ? `It comes off ${l.count} file${l.count === 1 ? '' : 's'}. The files themselves stay as they are.` : 'No files have it.',
    });
    if (ok) await run(() => api(`/api/media/labels/${l.type}/${l.id}`, { delete: true }), `Deleted "${l.name}".`);
  };

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground">
        {scope === '*' ? `Every tag and category in ${W.website.your}` : `The tags and categories of ${scope === '/' ? W.website.top : scopeLabel(scope)}`}, grouped by the folder they belong to.
        Switch on "Anyone can list its files" for the ones your pages show{isOn('examples') && <> (<InlineLink to="/media/examples">Media examples</InlineLink>)</>}: only files in media folders are ever listed that way, never pages or other files. The rest stay in the panel.
      </p>
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => {
        e.preventDefault();
        if (slug) void run(() => api('/api/media/labels', { scope: inScope, type, name: slug }), `Made the ${type} "${slug}".`).then((r) => { if (r) setName(''); });
      }}>
        <Field label="New" htmlFor="label-type"><NativeSelect id="label-type" value={type} onChange={(e) => setType(e.target.value as LabelType)}>
          <option value="tag">Tag</option><option value="category">Category</option>
        </NativeSelect></Field>
        <Field label="In" htmlFor="label-scope" className="min-w-48">
          <NativeSelect id="label-scope" value={inScope} onChange={(e) => setInScope(e.target.value)}>
            {(scopes.data?.scopes ?? [{ path: inScope, automatic: true, created_at: 0, created_by: null, labels: 0 }]).map((s) => (
              <option key={s.path} value={s.path}>{scopeLabel(s.path)}</option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Name" htmlFor="label-name" hint={name && slug !== name ? (slug ? `Will be made as "${slug}".` : LABEL_RULE) : LABEL_RULE} className="min-w-56 flex-1">
          <Input id="label-name" value={name} maxLength={60} autoComplete="off" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Button type="submit" disabled={!slug} className="mb-6"><Plus />Add</Button>
      </form>
      {!labels.data ? <Loading rows={2} /> : (['category', 'tag'] as const).map((t) => {
        const mine = labels.data!.labels.filter((l) => l.type === t);
        const groups = [...new Set(mine.map((l) => l.scope))].sort((a, b) => a.localeCompare(b));
        return (
          <section key={t} aria-label={t === 'tag' ? 'Tags' : 'Categories'}>
            <h3 className="mb-2 text-base font-semibold">{t === 'tag' ? 'Tags' : 'Categories'}</h3>
            {groups.length === 0 && <List label={t === 'tag' ? 'Tags' : 'Categories'}><Empty>No {t === 'tag' ? 'tags' : 'categories'} yet.</Empty></List>}
            {groups.map((g) => (
              <div key={g} className="mb-4">
                {groups.length > 1 && <h4 className="mb-1.5 text-sm font-medium text-muted-foreground">{scopeLabel(g)}</h4>}
                <List label={`${t === 'tag' ? 'Tags' : 'Categories'} in ${scopeLabel(g)}`}>
                  {mine.filter((l) => l.scope === g).map((l) => (
                <Row key={l.id} title={t === 'tag' ? `#${l.name}` : l.name}
                  badges={l.public && <Badge variant="ok">anyone can list its files</Badge>}
                  meta={<Facts items={[`${l.count} file${l.count === 1 ? '' : 's'}`, <code key="a">{l.address}</code>]} />}
                  footer={
                    <label className="flex items-center gap-2.5 text-sm">
                      <Switch checked={l.public} aria-label={`Anyone can list the files with ${l.address}`} onCheckedChange={(on) => void run(
                        () => api(`/api/media/labels/${l.type}/${l.id}`, { public: on }),
                        on ? `Anyone can now list the files with "${l.name}" (your pages can show them).` : `Only you (and API keys) can list the files with "${l.name}" now.`)} />
                      Anyone can list its files <span className="text-muted-foreground">(its media files only, for your pages: galleries, slide shows… It asks for your passkey.)</span>
                    </label>
                  }
                  actions={<>
                    <ActionButton icon={Filter} onClick={() => onShow(l)}>Show files</ActionButton>
                    <ActionButton icon={Pencil} onClick={() => rename(l)}>Rename</ActionButton>
                    <ActionButton icon={Trash2} variant="danger" onClick={() => remove(l)}>Delete</ActionButton>
                  </>} />
                  ))}
                </List>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}
