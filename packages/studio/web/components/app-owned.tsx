// A database an app owns (lfdln, docs/phase8-plan.md P8-9): said at the top of its pages, so
// nobody draws a change the helper will refuse. Nothing on pammy.org is one.
import { Section } from '@panel/core/web/components/page';
import { useApi } from '@panel/core/web/hooks/useApi';
import type { DatabasesData } from '../lib/types';

export function AppOwnedNote({ engine, name }: { engine?: string; name?: string }) {
  const list = useApi<DatabasesData>(engine && name ? '/api/databases' : null, { staleTime: 60_000 });
  const card = list.data?.databases.find((d) => d.engine === engine && d.name === name);
  if (!card?.appOwned) return null;
  // a project's (lfdln Projects, docs/phase8b-plan.md 8b-5): its own code changes it
  const who = card.projectOwned ? 'project' : 'service';
  return (
    <Section title={`This database belongs to a ${who}`} plain>
      <p className="text-sm">The {who}{card.projectOwned ? "'s own code" : ''} looks after it: you can look at its tables and records here, but nothing here changes them.</p>
    </Section>
  );
}
