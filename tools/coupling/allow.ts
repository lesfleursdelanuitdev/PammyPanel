// The coupling allow list (docs/master-plan.md rules 1 and 5, step C1): every place a module
// touches another module's table, or calls another module's op without depending on it, as
// the code was when C1 started (K0's report). test/boundaries.test.ts fails on anything new,
// and on an entry that is gone, so the list only shrinks:
//
//   node tools/coupling/allow.ts --shrink   take out what the code no longer does (never adds)
//
// Something new belongs in the module that owns it (its functions, ops or events). Adding an
// entry by hand is a decision for review, with its reason in the commit.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeReport, type Report } from './scan.ts';

const ROOT = join(import.meta.dirname, '..', '..');
export const ALLOW_FILE = 'docs/coupling-allow.json';

export type Coupling = { sql: string[]; undeclared: string[] };
export type Allow = Coupling & { about: string };

// One line each, so a diff reads: "examples writes forms.forms", "areas -> files via sitefs:list"
export function couplingOf(r: Report): Coupling {
  return {
    sql: r.sqlCross.map((t) => `${t.module} ${t.access === 'write' ? 'writes' : 'reads'} ${t.table}`).sort(),
    undeclared: r.undeclared.flatMap((u) => u.via.map((v) => `${u.from} -> ${u.to} via ${v}`)).sort(),
  };
}

export const readAllow = (root = ROOT): Allow => JSON.parse(readFileSync(join(root, ALLOW_FILE), 'utf8')) as Allow;

// What the code does that the list doesn't allow (new), and what the list allows that the code no longer does (gone)
export function compare(allow: Coupling, now: Coupling) {
  const diff = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));
  return {
    added: { sql: diff(now.sql, allow.sql), undeclared: diff(now.undeclared, allow.undeclared) },
    gone: { sql: diff(allow.sql, now.sql), undeclared: diff(allow.undeclared, now.undeclared) },
  };
}

const write = (a: Allow) => writeFileSync(join(ROOT, ALLOW_FILE), `${JSON.stringify(a, null, 2)}\n`);
const ABOUT = 'C1\'s allow list (tools/coupling/allow.ts): coupling between modules as it was at C1. It only shrinks: node tools/coupling/allow.ts --shrink.';

if (import.meta.main) {
  const now = couplingOf(makeReport(ROOT));
  if (process.argv.includes('--init')) {
    // only once, at C1: after that, the list only shrinks
    if (existsSync(join(ROOT, ALLOW_FILE))) { console.error(`${ALLOW_FILE} is there already: it only shrinks (--shrink)`); process.exit(1); }
    write({ about: ABOUT, ...now });
    console.log(`wrote ${ALLOW_FILE}: ${now.sql.length} SQL, ${now.undeclared.length} undeclared op calls`);
  } else if (process.argv.includes('--shrink')) {
    const allow = readAllow();
    const { gone } = compare(allow, now);
    write({ about: ABOUT, sql: allow.sql.filter((x) => !gone.sql.includes(x)), undeclared: allow.undeclared.filter((x) => !gone.undeclared.includes(x)) });
    console.log(`took out ${gone.sql.length + gone.undeclared.length}: ${[...gone.sql, ...gone.undeclared].join('; ') || 'nothing'}`);
  } else {
    console.error('node tools/coupling/allow.ts --shrink');
    process.exit(2);
  }
}
