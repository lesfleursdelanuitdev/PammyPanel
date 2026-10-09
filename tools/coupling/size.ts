// Size and copies (docs/master-plan.md rule 8, step C1): no new file over ~400 lines or 25 KB,
// no new copied block over 6 meaningful lines. A report for now: test/boundaries.test.ts prints
// what is new against docs/size-allow.json (the files over the limit at C1) and fails nothing.
// Copies become a failing check when K is done (module-contracts-plan rule 8).
//
//   node tools/coupling/size.ts            the report: big files (new ones marked) and copied blocks
//   node tools/coupling/size.ts --shrink   take out of the allow list files that are small now
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
export const SIZE_ALLOW_FILE = 'docs/size-allow.json';
export const MAX_LINES = 400, MAX_BYTES = 25 * 1024, COPY_LINES = 7;

function sources(root: string, rel: string): string[] {
  if (!existsSync(join(root, rel))) return [];
  return readdirSync(join(root, rel), { withFileTypes: true }).flatMap((e) =>
    e.name === 'node_modules' ? [] : e.isDirectory() ? sources(root, join(rel, e.name)) : /\.tsx?$/.test(e.name) ? [join(rel, e.name)] : []);
}
const codeFiles = (root: string) => ['packages', 'sites'].flatMap((top) => readdirSync(join(root, top)).sort()
  .flatMap((p) => ['src', 'web', 'widgets'].flatMap((part) => sources(root, `${top}/${p}/${part}`))));

export type Big = { file: string; lines: number; bytes: number };
export function bigFiles(root = ROOT): Big[] {
  return codeFiles(root).map((file) => {
    const text = readFileSync(join(root, file), 'utf8');
    return { file, lines: text.split('\n').length, bytes: statSync(join(root, file)).size };
  }).filter((b) => b.lines > MAX_LINES || b.bytes > MAX_BYTES);
}

// A copied block: the same COPY_LINES or more meaningful lines (no blank lines, comments,
// imports or lone brackets) in two places or more, reported once with its length.
export type Copy = { lines: number; at: string[] };
export function copies(root = ROOT): Copy[] {
  const windows = new Map<string, { key: string; at: string }[]>();   // file -> its windows, in order
  const seen = new Map<string, string[]>();                            // window -> where it is
  for (const file of codeFiles(root)) {
    const lines = readFileSync(join(root, file), 'utf8').split('\n').map((l, i) => [l.trim(), i + 1] as const)
      .filter(([l]) => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*') && !l.startsWith('import ') && !/^[\])};,]+$/.test(l));
    const ws: { key: string; at: string }[] = [];
    for (let i = 0; i + COPY_LINES <= lines.length; i++) {
      const key = lines.slice(i, i + COPY_LINES).map(([l]) => l).join('\n');
      const at = `${file}:${lines[i]![1]}`;
      ws.push({ key, at });
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key)!.push(at);
    }
    windows.set(file, ws);
  }
  // a run of copied windows in a row is one copied block, COPY_LINES + (run - 1) lines long
  const out = new Map<string, Copy>();
  for (const ws of windows.values()) {
    for (let i = 0; i < ws.length; i++) {
      if (seen.get(ws[i]!.key)!.length < 2) continue;
      let j = i;
      while (j + 1 < ws.length && seen.get(ws[j + 1]!.key)!.length >= 2) j++;
      const first = ws[i]!.key;
      const lines = COPY_LINES + j - i;
      if ((out.get(first)?.lines ?? 0) < lines) out.set(first, { lines, at: seen.get(first)! });
      i = j;
    }
  }
  return [...out.values()].sort((a, z) => z.lines - a.lines);
}

export const readSizeAllow = (root = ROOT): string[] => (JSON.parse(readFileSync(join(root, SIZE_ALLOW_FILE), 'utf8')) as { files: string[] }).files;
const ABOUT = 'Files over 400 lines or 25 KB at C1 (tools/coupling/size.ts, rule 8). It only shrinks: node tools/coupling/size.ts --shrink.';

if (import.meta.main) {
  const big = bigFiles();
  if (process.argv.includes('--init') || process.argv.includes('--shrink')) {
    const now = big.map((b) => b.file);
    const init = process.argv.includes('--init');
    if (init && existsSync(join(ROOT, SIZE_ALLOW_FILE))) { console.error(`${SIZE_ALLOW_FILE} is there already: it only shrinks (--shrink)`); process.exit(1); }
    const files = init ? now : readSizeAllow().filter((f) => now.includes(f));
    writeFileSync(join(ROOT, SIZE_ALLOW_FILE), `${JSON.stringify({ about: ABOUT, files }, null, 2)}\n`);
    console.log(`${SIZE_ALLOW_FILE}: ${files.length} files`);
  } else {
    const allow = new Set(readSizeAllow());
    console.log(`files over ${MAX_LINES} lines or ${MAX_BYTES / 1024} KB: ${big.length} (${big.filter((b) => !allow.has(b.file)).length} new)`);
    for (const b of big.sort((a, z) => z.lines - a.lines)) console.log(`${allow.has(b.file) ? '   ' : 'NEW'} ${String(b.lines).padStart(5)} lines ${String(Math.round(b.bytes / 1024)).padStart(4)} KB  ${b.file}`);
    const c = copies();
    console.log(`\ncopied blocks of ${COPY_LINES}+ meaningful lines: ${c.length}`);
    for (const x of c) console.log(`  ${String(x.lines).padStart(3)} lines  ${x.at.join('  ')}`);
  }
}
