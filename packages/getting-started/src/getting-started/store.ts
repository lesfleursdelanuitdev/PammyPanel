// What Getting started keeps (docs/getting-started-plan.md G1, migration 0017):
// the paths she started, a step skipped or ticked by hand, and the Home block
// open or closed. Whether a step is done is never stored: the checks decide.
import { AccountError } from '@panel/core/accounts';
import { all, one, run, tx, type Db } from '@panel/core/pg';
import type { Links } from './paths.ts';
import type { Answers, PathKey } from './questions.ts';

export type StartedPath = {
  id: number; path: PathKey; answers: Answers; links: Links;
  startedBy: string; startedAt: number; finishedAt: number | null; putAwayAt: number | null;
  steps: Record<string, { state: 'skipped' | 'done-by-hand'; by: string; at: number }>;
};
type Row = { id: number; path: string; answers: string; links: string; started_by: string; started_at: number; finished_at: number | null; put_away_at: number | null };

const parse = <T>(s: string, fallback: T): T => {
  try { const v = JSON.parse(s) as unknown; return v && typeof v === 'object' ? v as T : fallback; } catch { return fallback; }
};

export async function listPaths(db: Db): Promise<StartedPath[]> {
  const rows = await all<Row>(db, 'SELECT * FROM started_paths WHERE put_away_at IS NULL ORDER BY started_at, id');
  const steps = await all<{ started_path_id: number; step: string; state: 'skipped' | 'done-by-hand'; by: string; at: number }>(db,
    'SELECT started_path_id, step, state, by, at FROM path_steps WHERE started_path_id IN (SELECT id FROM started_paths WHERE put_away_at IS NULL)');
  return rows.map((r) => ({
    id: r.id, path: r.path as PathKey, answers: parse<Answers>(r.answers, {}), links: parse<Links>(r.links, {}),
    startedBy: r.started_by, startedAt: r.started_at, finishedAt: r.finished_at, putAwayAt: r.put_away_at,
    steps: Object.fromEntries(steps.filter((s) => s.started_path_id === r.id).map((s) => [s.step, { state: s.state, by: s.by, at: s.at }])),
  }));
}

export async function startPath(db: Db, o: { path: PathKey; answers: Answers; by: string; at: number }): Promise<number> {
  const r = await one<{ id: number }>(db, 'INSERT INTO started_paths (path, answers, started_by, started_at) VALUES (?, ?, ?, ?) RETURNING id',
    o.path, JSON.stringify(o.answers), o.by, o.at);
  return r!.id;
}

async function mustHave(db: Db, id: number): Promise<Row> {
  const r = await one<Row>(db, 'SELECT * FROM started_paths WHERE id = ? AND put_away_at IS NULL', id);
  if (!r) throw new AccountError('That is not one of the things you started.', 404);
  return r;
}

export async function setStep(db: Db, id: number, step: string, state: 'skipped' | 'done-by-hand' | null, by: string, at: number) {
  await mustHave(db, id);
  if (state === null) await run(db, 'DELETE FROM path_steps WHERE started_path_id = ? AND step = ?', id, step);
  else {
    await run(db, `INSERT INTO path_steps (started_path_id, step, state, by, at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (started_path_id, step) DO UPDATE SET state = excluded.state, by = excluded.by, at = excluded.at`, id, step, state, by, at);
  }
}

export async function putAway(db: Db, id: number, at: number) {
  await mustHave(db, id);
  await run(db, 'UPDATE started_paths SET put_away_at = ? WHERE id = ?', at, id);
}

// What a look at the site found, kept for next time (only written when it changed).
export async function saveFound(db: Db, id: number, links: Links, finishedAt: number | null) {
  await run(db, 'UPDATE started_paths SET links = ?, finished_at = ? WHERE id = ?', JSON.stringify(links), finishedAt, id);
}

// "That's not the one": let go of it, and don't take it again.
export async function notTheOne(db: Db, id: number, what: 'db' | 'form' | 'area') {
  await tx(db, async (q) => {
    const r = await mustHave(q, id);
    const links = parse<Links>(r.links, {});
    const held = links[what];
    if (held === undefined) throw new AccountError('It has not found one yet.', 409);
    delete links[what];
    links.not = { ...links.not, [what]: [...(links.not?.[what] ?? []), held] };
    await run(q, 'UPDATE started_paths SET links = ? WHERE id = ?', JSON.stringify(links), id);
  });
}

export async function homeOpen(db: Db, userId: number): Promise<boolean> {
  return (await one<{ o: boolean }>(db, 'SELECT getting_started_open AS o FROM users WHERE id = ?', userId))?.o ?? true;
}
export async function setHomeOpen(db: Db, userId: number, open: boolean) {
  await run(db, 'UPDATE users SET getting_started_open = ? WHERE id = ?', open, userId);
}
