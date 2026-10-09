// One kind of a service's things (docs/catalog-plan.md step 5, S5-5): its items with their
// labels, found by search, sub-scope or label; each item's labels in the same editor as a
// file's or a record's; and the kind's own tags and categories, with what the service says
// each means (its `uses`), offering to make a use's label when there isn't one yet.
import { useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { ActionButton, Collapsible, Empty, Facts, List, Loading, Page, Row, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { Input } from '@panel/core/web/components/ui/input';
import { NativeSelect } from '@panel/core/web/components/ui/native-select';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { api } from '@panel/core/web/lib/api';
import { OneThingLabels } from '../components/labels';
import { LABEL_RULE, labelSlug, type LabelType, type Names, type ScopeLabel } from '../lib/labels';
import { openOf, type AppItem, type AppResourcePage } from '../lib/apps';

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;
const PAGE = 50;

export default function AppItems() {
  const { service, resource } = useParams<{ service: string; resource: string }>();
  const base = `/api/catalog/apps/${service}/${resource}`;
  const data = useApi<AppResourcePage>(base);
  const d = data.data;
  usePageTitle(d ? `${d.resource.label} (${d.service.title})` : 'Tags & categories');
  if (!d) return <Page title="Tags & categories"><Loading /></Page>;
  return (
    <Page title={d.resource.label}
      intro={<>{d.service.title}'s {d.resource.label.toLowerCase()}: {plural(d.counts.items, 'thing')}, {d.counts.labelled.toLocaleString('en')} with tags. <Link className="underline underline-offset-2" to="/catalog">All services</Link></>}>
      <Items base={base} d={d} />
      <OwnLabels base={base} d={d} />
    </Page>
  );
}

function Items({ base, d }: { base: string; d: AppResourcePage }) {
  const [params, setParams] = useSearchParams();
  const [typed, setTyped] = useState(params.get('q') ?? '');
  const q = params.get('q') ?? '', scope = params.get('scope') ?? '', label = params.get('label') ?? '';
  const offset = Number(params.get('offset') ?? 0) || 0;
  const query = new URLSearchParams();
  if (q) query.set('q', q);
  if (scope) query.set('scope', scope);
  const [lt, ln] = label.split(':');
  if (lt && ln) query.set(lt, ln);
  if (offset) query.set('offset', String(offset));
  const items = useApi<{ items: AppItem[]; total: number }>(`${base}/items?${query}`);
  const go = (ch: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(ch)) { if (v) p.set(k, v); else p.delete(k); }
    setParams(p, { replace: true });
  };
  const choices = [...new Map(d.labels.map((l) => [`${l.type}:${l.name}`, l])).values()];
  return (
    <Section flush title={items.data ? (q || scope || label ? `${items.data.total} of them match` : plural(items.data.total, 'thing')) : 'Things'}
      action={
        <div className="flex flex-wrap gap-2">
          {d.scopes.length > 0 && (
            <NativeSelect className="w-52" aria-label="Only the ones in" value={scope} onChange={(e) => go({ scope: e.target.value || null, offset: null })}>
              <option value="">All of them</option>
              {d.scopes.map((s) => <option key={s.id} value={String(s.id)}>{s.label} ({s.items})</option>)}
            </NativeSelect>
          )}
          {choices.length > 0 && (
            <NativeSelect className="w-48" aria-label="Only the ones with this tag or category" value={label} onChange={(e) => go({ label: e.target.value || null, offset: null })}>
              <option value="">Any tag or category</option>
              {(['category', 'tag'] as const).map((type) => (
                <optgroup key={type} label={type === 'tag' ? 'Tags' : 'Categories'}>
                  {choices.filter((l) => l.type === type).map((l) => <option key={l.name} value={`${type}:${l.name}`}>{type === 'tag' ? `#${l.name}` : l.name}{l.everywhere ? ' (everywhere)' : ''}</option>)}
                </optgroup>
              ))}
            </NativeSelect>
          )}
          <form className="relative" onSubmit={(e) => { e.preventDefault(); go({ q: typed.trim() || null, offset: null }); }}>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="w-48 pl-8" type="search" aria-label="Search them" placeholder="Search" value={typed} onChange={(e) => setTyped(e.target.value)} />
          </form>
        </div>
      }>
      {!items.data ? <Loading /> : (
        <>
          <List label={d.resource.label}>
            {items.data.items.length === 0 && <Empty>{q || scope || label ? 'Nothing matches.' : 'Nothing listed yet: Read again on the Tags & categories page.'}</Empty>}
            {items.data.items.map((it) => <ItemRow key={it.key} base={base} d={d} it={it} />)}
          </List>
          {items.data.total > PAGE && (
            <div className="flex items-center justify-between gap-3 p-3 text-sm">
              <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => go({ offset: offset - PAGE > 0 ? String(offset - PAGE) : null })}>Before</Button>
              <span className="text-muted-foreground">{offset + 1}-{Math.min(offset + PAGE, items.data.total)} of {items.data.total}</span>
              <Button variant="outline" size="sm" disabled={offset + PAGE >= items.data.total} onClick={() => go({ offset: String(offset + PAGE) })}>After</Button>
            </div>
          )}
        </>
      )}
    </Section>
  );
}

function ItemRow({ base, d, it }: { base: string; d: AppResourcePage; it: AppItem }) {
  const run = useAction();
  const qc = useQueryClient();
  const open = openOf(d.resource.open, it.key);
  const known = (type: LabelType) => [...new Set(d.labels.filter((l) => l.type === type).map((l) => l.name))].sort();
  const shown = [...it.labels.categories, ...it.labels.tags.map((t) => `#${t}`)];
  return (
    <Row title={it.title ?? it.key}
      badges={it.scope && <Badge variant="outline">{it.scope}</Badge>}
      meta={<Facts items={[<code key="k">{it.key}</code>, shown.length ? shown.join(', ') : 'no tags', open && (open.startsWith('https://')
        ? <a key="o" className="underline underline-offset-2" href={open} target="_blank" rel="noreferrer">open it</a> : <code key="o">{open}</code>)]} />}>
      <Collapsible summary="Tags and categories" className="mt-2">
        <div className="pt-3">
          <OneThingLabels names={it.labels} known={known} onSave={async (set: Names) => {
            const r = await run(() => api<{ changed: boolean; created: string[] }>(`${base}/labels-of`, { key: it.key, set }),
              (res) => (res.changed ? `Saved${res.created.length ? `; made ${res.created.join(', ')}` : ''}.` : 'Nothing to change.'));
            if (r) await qc.invalidateQueries();
          }} />
        </div>
      </Collapsible>
    </Row>
  );
}

function OwnLabels({ base, d }: { base: string; d: AppResourcePage }) {
  const run = useAction();
  const dialogs = useDialogs();
  const own = d.labels.filter((l) => !l.everywhere);
  const uses = Object.entries(d.resource.uses);
  const missing = uses.filter(([name, u]) => !d.labels.some((l) => l.name === name && l.type === u.kind));
  const useOf = (l: ScopeLabel) => { const u = d.resource.uses[l.name]; return u && u.kind === l.type ? u : null; };
  const rename = async (l: ScopeLabel) => {
    const n = await dialogs.prompt({ title: `Rename the ${l.type} "${l.name}"`, label: 'New name', value: l.name, action: 'Rename', hint: LABEL_RULE });
    if (n === null || labelSlug(n) === l.name) return;
    await run(() => api(`${base}/labels/${l.type}/${l.id}`, { name: labelSlug(n) }), `Renamed to "${labelSlug(n)}".`);
  };
  const remove = async (l: ScopeLabel) => {
    if (await dialogs.confirm({ title: `Delete the ${l.type} "${l.name}"?`, action: 'Delete', danger: true,
      body: l.count ? `It comes off ${plural(l.count, 'thing')}. The service's things themselves stay as they are.` : 'Nothing has it.' })) {
      await run(() => api(`${base}/labels/${l.type}/${l.id}`, { delete: true }), `Deleted "${l.name}".`);
    }
  };
  return (
    <Section title={`Tags and categories of ${d.resource.label.toLowerCase()}`}
      intro={`${d.service.title} reads these back. Some mean something to it: they say so beside them.`}>
      <div className="space-y-4">
        {missing.length > 0 && (
          <div className="space-y-2">
            {missing.map(([name, u]) => (
              <p key={name} className="flex flex-wrap items-center gap-2 text-sm">
                <span>{d.service.title} gives <strong>{u.kind === 'tag' ? `#${name}` : name}</strong> a meaning: <em>{u.label}</em>{u.means ? ` (${u.means})` : ''}. There's no such {u.kind} yet.</span>
                <Button variant="outline" size="sm" onClick={() => void run(() => api(`${base}/labels`, { type: u.kind, name }), `Made the ${u.kind} "${name}".`)}><Plus />Make it</Button>
              </p>
            ))}
          </div>
        )}
        {(['category', 'tag'] as const).map((type) => {
          const mine = own.filter((l) => l.type === type);
          return (
            <div key={type}>
              <h3 className="mb-2 text-base font-semibold">{type === 'tag' ? 'Tags' : 'Categories'}</h3>
              <List label={`${type === 'tag' ? 'Tags' : 'Categories'} of ${d.resource.label}`}>
                {mine.length === 0 && <Empty>None yet: type one on a thing above and it's made.</Empty>}
                {mine.map((l) => {
                  const u = useOf(l);
                  return (
                    <Row key={l.id} title={type === 'tag' ? `#${l.name}` : l.name}
                      badges={u && <Badge variant="ok">{u.label}</Badge>}
                      meta={<Facts items={[plural(l.count, 'thing'), u?.means]} />}
                      actions={<>
                        <ActionButton icon={Pencil} onClick={() => void rename(l)}>Rename</ActionButton>
                        <ActionButton icon={Trash2} variant="danger" onClick={() => void remove(l)}>Delete</ActionButton>
                      </>} />
                  );
                })}
              </List>
            </div>
          );
        })}
        {d.labels.some((l) => l.everywhere) && (
          <p className="text-sm">Also usable here: {d.labels.filter((l) => l.everywhere).map((l) => (
            <Badge key={`${l.type}${l.id}`} variant="outline" className="mr-1">{l.type === 'tag' ? `#${l.name}` : l.name}{useOf(l) ? `: ${useOf(l)!.label}` : ''}</Badge>
          ))} (everywhere)</p>
        )}
      </div>
    </Section>
  );
}
