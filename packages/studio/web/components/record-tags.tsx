// A record's tags and categories (docs/catalog-plan.md step 4, S4-6), on its page, the
// way a file's are in File Explorer: a name not there yet is made in the table's own.
import { useQueryClient } from '@tanstack/react-query';
import { Section } from '@panel/core/web/components/page';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi } from '@panel/core/web/hooks/useApi';
import { api } from '@panel/core/web/lib/api';
import { OneThingLabels } from '@panel/catalog/web/components/labels';
import type { LabelType, Names } from '@panel/catalog/web/lib/labels';
import type { TableTags } from '../lib/schema';

export function RecordTags({ base, tagsUrl, where, names, singular }: {
  base: string; tagsUrl: string; where: Record<string, string>; names: Names; singular: string;
}) {
  const tags = useApi<TableTags>(tagsUrl);
  const run = useAction();
  const qc = useQueryClient();
  const known = (type: LabelType) => [...new Set((tags.data?.labels ?? []).filter((l) => l.type === type).map((l) => l.name))].sort();
  return (
    <Section title="Tags and categories"
      intro={`Categories are the few broad shelves (like desserts); tags are the many specific words (like lemon or quick). They're only in the panel, for finding this ${singular.toLowerCase()} again: nothing on your website changes.`}>
      <OneThingLabels names={names} known={known} onSave={async (set) => {
        const r = await run(() => api<{ changed: boolean; created: string[] }>(`${base}/labels`, { where, set }),
          (res) => (res.changed ? `Saved${res.created.length ? `; made ${res.created.join(', ')}` : ''}.` : 'Nothing to change.'));
        if (r) await qc.invalidateQueries();
      }} />
    </Section>
  );
}
