// What a list of schema changes means for an app that is switched on
// (docs/databases-plan.md 14, "changing an active schema", and 17 Phase 9:
// "this affects the Blog Post API").
//
// On a database whose app is off, a change is a change to a drawing and a
// database, and Review says so. Once the app is on, the same change is also a
// change to pages people are using and, if she let them in, to what programs
// are reading. That is worth saying before Apply rather than finding out after.
//
// Pure: the steps come from the diff, the rest from the panel's own tables, so
// nothing here waits on an engine.
import type { Step } from '../pammydb/patch.ts';

export type AppState = {
  active: boolean;
  title: string;
  // either API switch on: something outside the panel may be reading
  programs: boolean;
};

// One thing her app manages, by the table's name as the engine has it NOW --
// which is also the name every step uses (renames run last, src/pammydb/patch.ts).
export type Managed = { table: string; plural: string };

export type How = 'goes' | 'renamed' | 'changed';

export type Impact = {
  title: string;
  programs: boolean;
  // the things her app manages that these changes reach, worst first
  touched: { table: string; plural: string; how: How }[];
  // tables she is adding. They are NOT added to the app by themselves.
  added: string[];
};

// A table going is worse than it being renamed, which is worse than its fields
// changing: the one shown is the worst thing that happens to it.
const RANK: Record<How, number> = { goes: 0, renamed: 1, changed: 2 };

function howOf(step: Step): { table: string; how: How } | null {
  switch (step.kind) {
    case 'create-table': return null;
    case 'drop-table': return { table: step.table, how: 'goes' };
    case 'rename-table': return { table: step.table, how: 'renamed' };
    default: return { table: step.table, how: 'changed' };
  }
}

// null when the app is off: then there is nothing more to say than Review
// already says.
export function impactOf(steps: Step[], app: AppState, managed: Managed[]): Impact | null {
  if (!app.active) return null;
  const mine = new Map(managed.map((m) => [m.table, m]));
  const worst = new Map<string, How>();
  for (const step of steps) {
    const h = howOf(step);
    if (!h || !mine.has(h.table)) continue;
    const was = worst.get(h.table);
    if (was === undefined || RANK[h.how] < RANK[was]) worst.set(h.table, h.how);
  }
  const touched = [...worst].map(([table, how]) => ({ table, plural: mine.get(table)!.plural, how }))
    .sort((a, b) => RANK[a.how] - RANK[b.how] || a.plural.localeCompare(b.plural));
  const added = steps.flatMap((s) => (s.kind === 'create-table' ? [s.table.name] : []));
  return { title: app.title, programs: app.programs, touched, added };
}
