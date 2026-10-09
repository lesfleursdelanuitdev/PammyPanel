// A started path as the page shows it (docs/getting-started-plan.md G1, G4): each
// step's check run against the site, what she said on top (skipped, ticked by
// hand), and the next thing to do.
import type { Facts } from './facts.ts';
import { bind, guide19, PATHS, type Ctx, type Href, type Links, type PathDef, type Step } from './paths.ts';
import { recommend, type Answers, type PathKey } from './questions.ts';
import type { StartedPath } from './store.ts';

export type StepView = {
  key: string; title: string; why: string; to: Href | null; guide: Href | null;
  state: 'done' | 'todo' | 'unknown' | 'skipped' | 'done-by-hand';
  found?: string; note?: string;
  // "I've done this" is only offered where the site can't tell (Q3)
  canTick: boolean;
};
export type PathView = {
  id: number; path: PathKey; title: string; what: string; startedBy: string; startedAt: number;
  finished: boolean; steps: StepView[]; next: string | null;
  // what it is holding on to, for "That's not the one"
  holding: { what: 'db' | 'form' | 'area'; label: string }[];
  guide19: Href;
};

const DONE = new Set<StepView['state']>(['done', 'skipped', 'done-by-hand']);

async function stepView(s: Step, c: Ctx, said: StartedPath['steps'][string] | undefined): Promise<StepView> {
  const base = { key: s.key, title: s.title, why: s.why, to: s.to?.(c) ?? null, guide: s.guide ?? null, canTick: !s.check };
  // a skip always stands; a tick by hand only where there is no check
  if (said?.state === 'skipped') return { ...base, state: 'skipped' };
  if (!s.check) return { ...base, state: said?.state === 'done-by-hand' ? 'done-by-hand' : 'todo' };
  try {
    const r = await s.check(c);
    return { ...base, state: r.state, ...(r.found ? { found: r.found } : {}), ...(r.note ? { note: r.note } : {}) };
  } catch {
    return { ...base, state: 'unknown', note: 'The panel could not check this just now.' };
  }
}

export async function pathView(p: StartedPath, f: Facts, site: string): Promise<{ view: PathView; links: Links; finished: boolean }> {
  const def: PathDef = PATHS[p.path];
  const found = bind(def, f, p.links, p.startedAt, p.answers);
  const c: Ctx = { f, a: p.answers, since: p.startedAt, site, ...found };
  const steps = await Promise.all(def.steps(p.answers).map((s) => stepView(s, c, p.steps[s.key])));
  const finished = steps.every((s) => DONE.has(s.state));
  const holding: PathView['holding'] = [];
  if (found.db) holding.push({ what: 'db', label: `${found.db.title} (${found.db.name})` });
  if (found.form) holding.push({ what: 'form', label: `"${found.form.title}" (${found.form.name})` });
  if (found.area) holding.push({ what: 'area', label: found.area.path });
  return {
    view: {
      id: p.id, path: p.path, title: def.title, what: def.what, startedBy: p.startedBy, startedAt: p.startedAt,
      finished, steps, next: steps.find((s) => !DONE.has(s.state))?.key ?? null, holding, guide19: guide19(def.guide19),
    },
    links: found.links,
    finished,
  };
}

// The recommendation screen (G2): what it is, why, the steps it will take, and guide 19.
export function recommendation(a: Answers) {
  const r = recommend(a);
  const def = PATHS[r.path];
  return { path: r.path, title: def.title, what: def.what, why: r.why, steps: def.steps(a).map((s) => s.title), guide19: guide19(def.guide19) };
}
