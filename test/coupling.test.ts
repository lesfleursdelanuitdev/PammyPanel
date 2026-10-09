// The coupling report (docs/master-plan.md K0; tools/coupling/): committed, and the one the
// code makes. A commit that adds or removes coupling regenerates it, so its diff shows what
// changed: `node tools/coupling/report.ts`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { committed, JSON_FILE, markdown, MD_FILE } from '../tools/coupling/report.ts';
import { makeReport, sqlRefs, sqlTexts } from '../tools/coupling/scan.ts';

const ROOT = join(import.meta.dirname, '..');

describe('coupling report', () => {
  it('reads tables out of SQL, and whether it writes them', () => {
    assert.deepEqual(sqlRefs('SELECT v.id FROM gate.visitors v JOIN links l ON l.visitor_id = v.id'), [
      { schema: 'gate', name: 'visitors', access: 'read' },
      { schema: null, name: 'links', access: 'read' },
    ]);
    assert.deepEqual(sqlRefs('INSERT INTO forms (a) VALUES (?) ON CONFLICT (a) DO UPDATE SET a = excluded.a'), [
      { schema: null, name: 'forms', access: 'write' },
    ]);
    assert.deepEqual(sqlRefs('DELETE FROM sessions WHERE expires_at < ?').map((r) => r.access), ['write']);
    assert.deepEqual(sqlRefs('SELECT id FROM roles WHERE id = ? FOR UPDATE').map((r) => r.name), ['roles']);
  });

  it('reads a template literal whole, and leaves SQLite out', () => {
    const src = [
      "import { DatabaseSync } from 'node:sqlite';",
      'const a = sql`SELECT * FROM ${t} JOIN visitors v ON true`;',
      "out.prepare('INSERT INTO files VALUES (?)');",
      "// SELECT * FROM forms",
    ].join('\n');
    assert.deepEqual(sqlTexts('x.ts', src), ['SELECT * FROM  ?  JOIN visitors v ON true']);
  });

  it('is committed as the code makes it (node tools/coupling/report.ts)', () => {
    const r = makeReport(ROOT);
    assert.equal(readFileSync(join(ROOT, JSON_FILE), 'utf8'), `${JSON.stringify(committed(r), null, 2)}\n`, `${JSON_FILE} is out of date`);
    assert.equal(readFileSync(join(ROOT, MD_FILE), 'utf8'), markdown(r), `${MD_FILE} is out of date`);
  });
});
