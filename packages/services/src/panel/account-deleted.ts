// Passing deleted accounts on to the apps (docs/accounts-plan.md Q1, "Step 4b: as built").
// The gate notes every deleted account (areas/0006); every minute the panel tells each service
// that is behind a route with accounts and has the hook (known.ts accountDeleted), straight on
// 127.0.0.1:<port>, signed with that service's own key (/etc/lfdln-panel/hooks/<id>.key, given
// to the panel as a credential): HMAC-SHA256 over "<ms>.<body>", sent as X-Lfdln-Timestamp and
// X-Lfdln-Signature "v1=<hex>". A service that answers 200 is told; the rest are tried again
// later (the gate's backoff). An app deletes what it keeps for the account; telling it twice
// is harmless.
import { readFile } from 'node:fs/promises';
import { all, type Db } from '@panel/core/pg';
import { sign } from '@panel/core/signed';
import type { PortOf } from '../client.ts';
import { KNOWN } from '../known.ts';

export type Deletion = { visitor_id: number; username: string; deleted_at: number; told: string[]; tries: number; next_at: number; last_error: string | null };
export type Target = { service: string; title: string; url: string };

export type DeletionDeps = {
  db: Db;
  gate: <T>(req: Record<string, unknown>) => Promise<T>;
  ports: () => Promise<PortOf[]>;
  keyFile: (service: string) => string; // its key's file (the panel's credential hooks_<service>.key)
  now: () => number;                 // seconds
  fetch?: typeof fetch;
  log?: (msg: string) => void;
};

export { sign };

/** The services to tell: behind a route with accounts, with the hook, and a port the helper knows. */
export async function deletionTargets(db: Db, ports: PortOf[]): Promise<Target[]> {
  const rows = await all<{ service: string; service_part: string | null }>(db,
    `SELECT DISTINCT target_ref->>'service' AS service, target_ref->>'part' AS service_part FROM routes
      WHERE target_kind = 'service' AND area_token IS NOT NULL AND target_ref->>'service' IS NOT NULL ORDER BY 1, 2`);
  const out = new Map<string, Target>();
  for (const r of rows) {
    const k = KNOWN.find((s) => s.id === r.service);
    if (!k?.accountDeleted || out.has(r.service)) continue;
    const part = ports.find((p) => p.service === r.service && (r.service_part === null || p.part === r.service_part));
    if (!part) continue;
    out.set(r.service, { service: r.service, title: k.title, url: `http://127.0.0.1:${part.port}${k.accountDeleted}` });
  }
  return [...out.values()];
}

async function tell(d: DeletionDeps, t: Target, row: Deletion): Promise<string | null> {
  let key: string;
  try {
    key = (await readFile(d.keyFile(t.service), 'utf8')).trim();
  } catch {
    return `${t.title}: no key (${t.service}.key)`;
  }
  const body = JSON.stringify({ account: row.visitor_id, deletedAt: row.deleted_at });
  const ts = String(Date.now());
  try {
    const r = await (d.fetch ?? fetch)(t.url, {
      method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json', 'X-Lfdln-Timestamp': ts, 'X-Lfdln-Signature': sign(key, ts, body) },
    });
    return r.status === 200 ? null : `${t.title}: answered ${r.status}`;
  } catch (e) {
    return `${t.title}: ${(e as Error).message}`;
  }
}

/** One round: every deletion that is due, to every service not told yet. */
export async function passOnDeletions(d: DeletionDeps): Promise<{ done: number; waiting: number }> {
  const { deletions } = await d.gate<{ deletions: Deletion[] }>({ op: 'deletions.list' });
  const now = d.now();
  const due = deletions.filter((x) => x.next_at <= now);
  if (!due.length) return { done: 0, waiting: deletions.length };
  const targets = await deletionTargets(d.db, await d.ports());
  let done = 0;
  for (const row of due) {
    const told = new Set(row.told);
    const errors: string[] = [];
    for (const t of targets) {
      if (told.has(t.service)) continue;
      const err = await tell(d, t, row);
      if (err) errors.push(err);
      else told.add(t.service);
    }
    const finished = errors.length === 0;
    await d.gate({ op: 'deletions.told', id: row.visitor_id, told: [...told], done: finished, error: finished ? null : errors.join('; ') });
    if (finished) done++;
    else d.log?.(`account ${row.visitor_id} (${row.username}) not passed on yet: ${errors.join('; ')}`);
  }
  return { done, waiting: deletions.length - done };
}
