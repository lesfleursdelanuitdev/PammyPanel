// The proof on the day for the catalog move (docs/catalog-plan.md step 2, S2-5): what the
// media API answers, and everything in the index the panel publishes for it, taken before
// the install and again after, and compared. Label ids may change (categories are
// renumbered), so the index is compared by names; every answer by its status and bytes.
//
//   node tools/media-api-proof.ts capture <index.db> <gate http://127.0.0.1:port> <host> <out.json>
//   node tools/media-api-proof.ts compare <before.json> <after.json>
//
// The answers are asked without a key, as a visitor would (public labels only), from one
// test address, at most 100 a minute (the open limit is 120).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export type Proof = { index: { files: string[]; labels: string[]; links: string[] }; answers: Record<string, { status: number; sha256: string; start: string }> };

// The index by names: every file with every column, every label, every label on a file.
export function readIndex(file: string): Proof['index'] & { urls: string[] } {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const files = (db.prepare('SELECT * FROM files ORDER BY id').all() as Record<string, unknown>[]).map((r) => JSON.stringify(r));
    const labels = (db.prepare('SELECT type, scope, name, public FROM labels ORDER BY type, scope, name').all() as { type: string; scope: string; name: string; public: number }[]);
    const links = (db.prepare(`SELECT x.file_id, l.type, l.scope, l.name FROM file_labels x JOIN labels l ON l.type = x.type AND l.id = x.label_id
      ORDER BY x.file_id, l.type, l.scope, l.name`).all() as { file_id: number; type: string; scope: string; name: string }[]).map((r) => `${r.file_id}|${r.type}|${r.scope}|${r.name}`);
    // what a visitor may ask: each folder's labels, and each public label in its folder
    const tops = [...new Set((db.prepare('SELECT DISTINCT scope FROM files').all() as { scope: string }[]).map((r) => r.scope))].sort();
    const base = (scope: string) => {
      const top = scope === '/' || scope.startsWith('/media/') ? null : scope.slice(1).split('/')[0]!;
      return top === null ? '/_pammy/api/media/main' : `/_pammy/api/media/in/${encodeURIComponent(top)}`;
    };
    const urls = new Set<string>(['/_pammy/api/media/main/labels']);
    for (const s of tops) urls.add(`${base(s)}/labels`);
    for (const l of labels.filter((x) => x.public === 1)) urls.add(`${base(l.scope)}/${l.type === 'tag' ? 't' : 'c'}/${encodeURIComponent(l.name)}`);
    return { files, labels: labels.map((l) => `${l.type}|${l.scope}|${l.name}|${l.public}`), links, urls: [...urls].sort() };
  } finally { db.close(); }
}

export async function capture(indexFile: string, gate: string, host: string, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<Proof> {
  const { urls, ...index } = readIndex(indexFile);
  const answers: Proof['answers'] = {};
  let n = 0;
  for (const u of urls) {
    if (n && n % 100 === 0) await sleep(61_000);
    n++;
    const r = await fetch(`${gate}${u}`, { headers: { Host: host, 'X-Pammy-Base': '/', 'X-Real-IP': '192.0.2.201' }, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    const body = Buffer.from(await r.arrayBuffer());
    answers[u] = { status: r.status, sha256: createHash('sha256').update(body).digest('hex'), start: body.toString('utf8', 0, 200) };
  }
  return { index, answers };
}

// One line per difference; none: the same.
export function compare(before: Proof, after: Proof): string[] {
  const out: string[] = [];
  for (const k of ['files', 'labels', 'links'] as const) {
    const b = new Set(before.index[k]);
    const a = new Set(after.index[k]);
    for (const x of b) if (!a.has(x)) out.push(`index ${k}: gone: ${x.slice(0, 300)}`);
    for (const x of a) if (!b.has(x)) out.push(`index ${k}: new: ${x.slice(0, 300)}`);
  }
  for (const u of new Set([...Object.keys(before.answers), ...Object.keys(after.answers)])) {
    const b = before.answers[u];
    const a = after.answers[u];
    if (!b || !a) { out.push(`${u}: asked ${b ? 'before' : 'after'} only`); continue; }
    if (b.status !== a.status || b.sha256 !== a.sha256) out.push(`${u}: was ${b.status} ${b.start.slice(0, 120)}; now ${a.status} ${a.start.slice(0, 120)}`);
  }
  return out;
}

if (import.meta.main) {
  const [mode, ...a] = process.argv.slice(2);
  if (mode === 'capture' && a.length === 4) {
    const p = await capture(a[0]!, a[1]!, a[2]!);
    writeFileSync(a[3]!, `${JSON.stringify(p)}\n`, { mode: 0o600 });
    console.log(`${p.index.files.length} files, ${p.index.labels.length} labels, ${p.index.links.length} labels on files; ${Object.keys(p.answers).length} answers kept`);
  } else if (mode === 'compare' && a.length === 2) {
    const d = compare(JSON.parse(readFileSync(a[0]!, 'utf8')) as Proof, JSON.parse(readFileSync(a[1]!, 'utf8')) as Proof);
    if (d.length) { console.log(`${d.length} difference(s):`); for (const x of d.slice(0, 50)) console.log(`  ${x}`); process.exit(1); }
    console.log('the same: every file, label and label on a file in the index, and every answer');
  } else {
    console.error('usage: media-api-proof.ts capture <index.db> <gate-url> <host> <out.json> | compare <before.json> <after.json>');
    process.exit(2);
  }
}
