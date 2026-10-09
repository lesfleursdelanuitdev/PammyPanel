// "Tags and categories" on a table's settings (docs/catalog-plan.md step 4, S4-1): the
// switch, the picture field, how many records there are and have labels, "Read again",
// and the table's own tags and categories (rename, delete). Everywhere's labels are on
// the Tags page; its records can have them too.
import { Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { ActionButton, Empty, Facts, Field, InlineLink, List, Loading, Row, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { NativeSelect } from '@panel/core/web/components/ui/native-select';
import { Switch } from '@panel/core/web/components/ui/switch';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi } from '@panel/core/web/hooks/useApi';
import { api } from '@panel/core/web/lib/api';
import { LABEL_RULE, labelSlug } from '@panel/catalog/web/lib/labels';
import type { TableLabel as ScopeLabel, TableTags as Tags } from '../lib/schema';

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;
const when = (at: number) => new Date(at * 1000).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

export function TableTags({ base, singular, pluralName }: { base: string; singular: string; pluralName: string }) {
  const url = `${base}/tags`;
  const tags = useApi<Tags>(url);
  const run = useAction();
  const dialogs = useDialogs();
  const t = tags.data;
  const lower = pluralName.toLowerCase();

  const turn = async (on: boolean) => {
    if (!t) return;
    if (!on) {
      const n = t.counts?.labelled ?? 0;
      const ok = await dialogs.confirm({
        title: `Switch off tags for ${lower}?`, action: 'Switch off', danger: n > 0,
        body: n ? `The tags and categories come off ${plural(n, singular.toLowerCase(), lower)}, and ${lower}' own tags and categories are deleted. Tags that go everywhere stay, on everything else. Your records themselves stay as they are.`
          : `No ${lower} have tags yet. Your records stay as they are.`,
      });
      if (!ok) return;
    }
    await run(() => api(url, { on }), on ? `Tags are on for ${lower}.` : `Tags are off for ${lower}.`);
  };
  const own = (t?.labels ?? []).filter((l) => !l.everywhere);
  const rename = async (l: ScopeLabel) => {
    const n = await dialogs.prompt({ title: `Rename the ${l.type} "${l.name}"`, label: 'New name', value: l.name, action: 'Rename', hint: LABEL_RULE });
    if (n === null || labelSlug(n) === l.name) return;
    await run(() => api(`${url}/labels/${l.type}/${l.id}`, { name: labelSlug(n) }), `Renamed to "${labelSlug(n)}".`);
  };
  const remove = async (l: ScopeLabel) => {
    const ok = await dialogs.confirm({
      title: `Delete the ${l.type} "${l.name}"?`, action: 'Delete', danger: true,
      body: l.count ? `It comes off ${plural(l.count, singular.toLowerCase(), lower)}. The records themselves stay as they are.` : `No ${lower} have it.`,
    });
    if (ok) await run(() => api(`${url}/labels/${l.type}/${l.id}`, { delete: true }), `Deleted "${l.name}".`);
  };

  return (
    <Section title="Tags and categories"
      intro={<>Words for finding {lower} again, the way you tag pictures and pages: put them on each {singular.toLowerCase()} on its page, then filter the list by them. Your pages can ask for them too, through the data API (guide 14, PART 17): only the ones you switch to "Anyone can see it", unless the page has a key. Tags that go everywhere (<InlineLink to="/tags?folder=everywhere%2F">Tags &amp; categories</InlineLink>) work here too.</>}>
      {!t ? <Loading rows={2} /> : !t.hasKey ? (
        <p className="text-sm text-muted-foreground">{pluralName} have no field that tells one record from another, so they can't have tags. Give the table a primary key on the Tables page first.</p>
      ) : (
        <div className="space-y-4">
          <label className="flex items-start gap-3 text-sm">
            <Switch checked={t.on} onCheckedChange={(v) => void turn(v)} aria-label={`Let me tag ${lower}`} />
            <span>Let me tag these <span className="text-muted-foreground">(tables of up to {t.max.toLocaleString('en')} records)</span></span>
          </label>
          {t.on && <>
            <Field label="Picture" htmlFor="tags-picture" className="max-w-sm"
              hint={`A field holding a picture's address on your website, like media/lemon-tart.jpg: the ${singular.toLowerCase()} is shown with that picture's thumbnail.`}>
              <NativeSelect id="tags-picture" value={t.pictureField ?? ''}
                onChange={(e) => void run(() => api(url, { pictureField: e.target.value }), 'Saved.')}>
                <option value="">none</option>
                {t.pictureChoices.map((f) => <option key={f.name} value={f.name}>{f.label}</option>)}
              </NativeSelect>
            </Field>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <Facts items={[
                t.counts ? plural(t.counts.items, singular.toLowerCase(), lower) : null,
                t.counts ? `${t.counts.labelled.toLocaleString('en')} with tags` : null,
                t.state ? `read ${when(t.state.at)}` : null,
                t.state?.missing ? `${t.state.missing} gone since (their tags are kept 30 days)` : null,
              ].filter(Boolean) as string[]} />
              <Button variant="outline" size="sm" onClick={() => void run(() => api(`${url}/read`, {}), 'Read again.')}><RefreshCw />Read again</Button>
            </div>
            {t.state?.error && <p className="text-sm text-destructive" role="status">{t.state.error}</p>}
            <p className="text-sm text-muted-foreground">
              New and changed {lower} show up at once when made here, within a minute from a form or a program, and within 15 minutes from anywhere else (your own pages, for example). Read again does it now.
            </p>
            {(['category', 'tag'] as const).map((type) => {
              const mine = own.filter((l) => l.type === type);
              return (
                <div key={type}>
                  <h3 className="mb-2 text-base font-semibold">{type === 'tag' ? 'Tags' : 'Categories'} of {lower}</h3>
                  <List label={`${type === 'tag' ? 'Tags' : 'Categories'} of ${lower}`}>
                    {mine.length === 0 && <Empty>None yet: type one on a {singular.toLowerCase()}'s page and it's made.</Empty>}
                    {mine.map((l) => (
                      <Row key={l.id} title={type === 'tag' ? `#${l.name}` : l.name}
                        badges={l.public && <Badge variant="ok">anyone can see it</Badge>}
                        meta={<Facts items={[plural(l.count, singular.toLowerCase(), lower)]} />}
                        footer={<PublicSwitch label={l} onChange={(on) => void run(() => api(`${url}/labels/${l.type}/${l.id}`, { public: on }),
                          on ? `Anyone reading ${lower} on your pages can now see "${l.name}".` : `Only keys (and the panel) can see "${l.name}" now.`)} />}
                        actions={<>
                          <ActionButton icon={Pencil} onClick={() => void rename(l)}>Rename</ActionButton>
                          <ActionButton icon={Trash2} variant="danger" onClick={() => void remove(l)}>Delete</ActionButton>
                        </>} />
                    ))}
                  </List>
                </div>
              );
            })}
            {(t.labels ?? []).some((l) => l.everywhere) && (
              <p className="text-sm">
                Also usable here: {(t.labels ?? []).filter((l) => l.everywhere).map((l) => (
                  <Badge key={`${l.type}${l.id}`} variant="outline" className="mr-1">{l.type === 'tag' ? `#${l.name}` : l.name}</Badge>
                ))} (everywhere)
              </p>
            )}
          </>}
        </div>
      )}
    </Section>
  );
}

// "Anyone can see it" (docs/catalog-plan.md step 4b): on her pages that read the records
// without a key. Asks for the passkey, as the media labels' switch does.
export function PublicSwitch({ label, onChange }: { label: ScopeLabel; onChange: (on: boolean) => void }) {
  return (
    <label className="flex items-center gap-2.5 text-sm">
      <Switch checked={label.public} aria-label={`Anyone can see ${label.address}`} onCheckedChange={onChange} />
      Anyone can see it <span className="text-muted-foreground">(on your pages, with the records. It asks for your passkey.)</span>
    </label>
  );
}
