// The Help tab: the site's guides (pammy.org: the same text files Pamela has in her
// instructions folder), copied into the release by build.sh with the site's guides.map,
// one page each, formatted from the plain text and searchable.
//
// A guide looks like:
//   ==========      a rule
//    Title           the guide's title (more lines: a subtitle)
//   ==========
//   intro text...
//   ----------      a section heading: rule, title, rule
//   PART 1 -- ...
//   ----------
//   section text...
//
// Inside a section the text follows a few habits, which become formatting:
//   PARAGRAPHS         lines at the left edge, hard-wrapped
//   SUBHEADINGS        a line in capitals on its own
//   1. steps / a. / *  numbered, lettered and bulleted lists (continued by indenting)
//   term               a line followed straight away by more-indented lines:
//       explanation    a definition ("IF SOMETHING GOES WRONG" lists)
//     key     value    indented rows with a gap of 2+ spaces: a table
//     other indented   an example or code, shown as it is
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Block =
  | { t: 'p'; text: string }
  | { t: 'h'; text: string }
  | { t: 'code'; text: string }
  | { t: 'ol'; start: number; alpha: boolean; items: Block[][] }
  | { t: 'ul'; items: Block[][] }
  | { t: 'dl'; items: { term: string; body: Block[] }[] }
  | { t: 'table'; rows: { key: string; value: Block[] }[] };
export type HelpSection = { title: string; part: number | null; flag: string | null; text: string; blocks: Block[] };
// parts: opened part by part; listed: its parts on Help's front page; kept: an account kept to
// places sees it; rights: a kept account with one of these sees it (docs/phase9-plan.md 9-1)
export type GuideFlags = { parts: boolean; listed: boolean; kept: boolean; rights: string[] };
export type ParsedGuide = { file: string; title: string; subtitle: string; sections: HelpSection[] };
export type HelpGuide = ParsedGuide & GuideFlags;

const RULE = /^[-=]{20,}\s*$/;
const LIST_RE = /^(?:(\d{1,2})|([a-z]))[.)] +(?=\S)|^\* +(?=\S)/;

const blank = (l: string | undefined) => l === undefined || l.trim() === '';
const indentOf = (l: string) => l.length - l.trimStart().length;
const trimEndBlank = (lines: string[]) => {
  let n = lines.length;
  while (n > 0 && blank(lines[n - 1])) n--;
  return lines.slice(0, n);
};
// Remove the common indent, or up to `by` spaces from each line (never more than it has).
function dedent(lines: string[], by?: number): string[] {
  const min = Math.min(...lines.filter((l) => !blank(l)).map(indentOf));
  return lines.map((l) => (blank(l) ? '' : l.slice(by === undefined ? min : Math.min(by, indentOf(l)))));
}

// "PLUGINS AND THEMES:" -> "Plugins and themes"; mixed-case titles stay as they are.
export function sentenceCase(s: string): string {
  const t = s.trim().replace(/:$/, '');
  if (/[a-z]/.test(t)) return t;
  const lower = t.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

// Hard-wrapped lines back into one. Two spaces around a word mark it as
// something to type ("type  pamela  exactly"), so a word ending a line after
// two spaces keeps them across the join.
function joinLines(lines: string[]): string {
  let out = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!out) { out = line; continue; }
    if (/[A-Za-z]-$/.test(out) && /^[a-z]/.test(line)) { out += line; continue; }     // "behind-the-" + "scenes"
    out += / {2}\S+$/.test(out) ? `  ${line}` : ` ${line}`;
  }
  return out;
}

function isSubheading(lines: string[], i: number): boolean {
  const t = lines[i]!.trim();
  // at least two words, and something after it: a lone "SFTP" is a value, not a heading
  return t.length <= 70 && /[A-Z]{2}/.test(t) && !/[a-z]/.test(t) && !t.startsWith('"') && /\S\s+\S/.test(t)
    && blank(lines[i + 1]) && lines.slice(i + 1).some((l) => !blank(l));
}

// Everything from `from` that belongs to the line before it: following lines
// that are blank or indented, up to the last indented one.
function indentedRun(lines: string[], from: number): number {
  let last = from - 1;
  for (let k = from; k < lines.length && (blank(lines[k]) || indentOf(lines[k]!) > 0); k++) if (!blank(lines[k])) last = k;
  return last;
}

export function parseBlocks(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (blank(line)) { i++; continue; }

    // an indented passage: a table, an example, or definitions/lists to parse again
    if (indentOf(line) > 0) {
      const last = indentedRun(lines, i);
      out.push(...parseRegion(dedent(lines.slice(i, last + 1))));
      i = last + 1;
      continue;
    }

    const m = LIST_RE.exec(line);
    if (m) {
      const last = indentedRun(lines, i + 1);
      const body = [line.slice(m[0].length), ...dedent(lines.slice(i + 1, last + 1), m[0].length)];
      const item = parseBlocks(trimEndBlank(body));
      const prev = out.at(-1);
      if (m[1] || m[2]) {
        const alpha = !!m[2];
        if (prev?.t === 'ol' && prev.alpha === alpha) prev.items.push(item);
        else out.push({ t: 'ol', start: alpha ? m[2]!.charCodeAt(0) - 96 : Number(m[1]), alpha, items: [item] });
      } else if (prev?.t === 'ul') {
        prev.items.push(item);
      } else {
        out.push({ t: 'ul', items: [item] });
      }
      i = Math.max(last, i) + 1;
      continue;
    }

    if (isSubheading(lines, i)) {
      out.push({ t: 'h', text: sentenceCase(line) });
      i++;
      continue;
    }

    // a paragraph; if more-indented lines follow straight on, it's a term and its explanation
    let j = i;
    while (j < lines.length && !blank(lines[j]) && indentOf(lines[j]!) === 0 && (j === i || !LIST_RE.test(lines[j]!))) j++;
    const para = lines.slice(i, j);
    if (j < lines.length && !blank(lines[j]) && indentOf(lines[j]!) > 0 && !para.at(-1)!.trimEnd().endsWith(':')) {
      const last = indentedRun(lines, j);
      const item = { term: joinLines(para), body: parseBlocks(dedent(lines.slice(j, last + 1))) };
      const prev = out.at(-1);
      if (prev?.t === 'dl') prev.items.push(item); else out.push({ t: 'dl', items: [item] });
      i = last + 1;
      continue;
    }
    out.push({ t: 'p', text: joinLines(para) });
    i = j;
  }
  return out;
}

const GAP_RE = /^(\S.*?\S|\S) {2,}(\S.*)$/;

// Lines that were indented, now starting at the left edge.
function parseRegion(region: string[]): Block[] {
  const rows = region.map((l, k) => (!blank(l) && indentOf(l) === 0 ? k : -1)).filter((k) => k >= 0);
  if (LIST_RE.test(region[rows[0]!]!)) return parseBlocks(region);
  // HTML on the main lines is an example (a page, or GOOD/BAD lines); HTML only in an
  // explanation under a term is just part of that explanation. <?php and <?= are
  // HTML here too: a PHP page's own lines (docs/tutorials-plan.md T1)
  if (rows.some((r) => /<[A-Za-z!/?]/.test(region[r]!))) return [{ t: 'code', text: trimEndBlank(region).join('\n') }];
  // CSS (a style file, rules with { } and ;) is an example too, however it's indented
  if (rows.some((r) => /^\/\*|[{}]\s*$/.test(region[r]!))) return [{ t: 'code', text: trimEndBlank(region).join('\n') }];
  const rowEnd = (r: number) => { const n = rows.find((x) => x > r); return n === undefined ? region.length : n; };
  const continued = (r: number) => region.slice(r + 1, rowEnd(r)).some((l) => !blank(l));
  const gap = (r: number) => GAP_RE.test(region[r]!);

  if (rows.some(gap) && rows.every((r) => gap(r) || continued(r))) {
    return [{
      t: 'table',
      rows: rows.map((r) => {
        const m = GAP_RE.exec(region[r]!);
        const rest = trimEndBlank(region.slice(r + 1, rowEnd(r)));
        // lines under "Kind   what sort of answer:" keep their own indenting (a table inside);
        // under anything else they're just the rest of the sentence
        const valueAt = m && m[2]!.trimEnd().endsWith(':') ? region[r]!.length - m[2]!.length : undefined;
        const value = [...(m ? [m[2]!] : []), ...(rest.length ? dedent(rest, valueAt) : [])];
        return { key: (m ? m[1]! : region[r]!).trim(), value: parseBlocks(value) };
      }),
    }];
  }
  if (rows.some(continued)) return parseBlocks(region);
  return [{ t: 'code', text: trimEndBlank(region).join('\n') }];
}

function section(rawTitle: string, lines: string[]): HelpSection | null {
  const text = trimEndBlank(lines).join('\n').replace(/^\s*\n/, '');
  if (!text.trim()) return null;
  const m = rawTitle.match(/^PART (\d+) -- (.+?)(?:\s+\[([^\]]+)\])?$/);
  // "ALTERNATIVE -- FileZilla, if you already have it" -> "Alternative -- FileZilla, ..."
  const lead = rawTitle.match(/^([A-Z][A-Z ]*[A-Z]) -- (.*[a-z].*)$/);
  const title = m ? m[2]!.replace(/ {2,}/g, ' ') : lead ? `${sentenceCase(lead[1]!)} -- ${lead[2]}` : sentenceCase(rawTitle);
  return { title, part: m ? Number(m[1]) : null, flag: m?.[3] ? sentenceCase(m[3]) : null, text, blocks: parseBlocks(trimEndBlank(lines)) };
}

export function parseGuide(file: string, source: string): ParsedGuide {
  const lines = source.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  let title = file.replace(/^\d+-|\.txt$/g, '').replace(/-/g, ' ');
  let subtitle = '';
  const sections: HelpSection[] = [];
  let current: { title: string; lines: string[] } = { title: 'Introduction', lines: [] };
  const flush = () => { const s = section(current.title, current.lines); if (s) sections.push(s); };
  let first = true;
  for (let i = 0; i < lines.length; i++) {
    // a heading block: a rule, one to three lines of words, and a rule
    const close = RULE.test(lines[i]!) ? [2, 3, 4].map((n) => i + n).find((j) => j < lines.length && RULE.test(lines[j]!)) : undefined;
    const inner = close === undefined ? [] : lines.slice(i + 1, close);
    if (close === undefined || inner.some((l) => RULE.test(l)) || !inner.some((l) => l.trim())) {
      current.lines.push(lines[i]!);
      continue;
    }
    const words = inner.map((l) => l.trim()).filter(Boolean);
    if (first && sections.length === 0 && current.lines.every((l) => !l.trim())) {
      title = words[0]!;
      subtitle = words.slice(1).join(' ');
    } else {
      flush();
      current = { title: words.join(' '), lines: [] };
    }
    first = false;
    i = close;
  }
  flush();
  return { file, title, subtitle, sections };
}

// Every .txt in the folder, in file-name order (00-README.txt first). A missing
// folder (a development checkout without a build) is just an empty Help tab.
// A guides.map line: the master file, the name it has here, and (maybe) a comma list of
// words: kept, parts, listed, or a right's name.
export function parseMap(text: string): { src: string; file: string; flags: GuideFlags }[] {
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => {
    const [src = '', file = '', words = ''] = l.split(/\s+/);
    const w = words ? words.split(',') : [];
    return { src, file, flags: { parts: w.includes('parts'), listed: w.includes('listed'), kept: w.includes('kept'), rights: w.filter((x) => !['parts', 'listed', 'kept'].includes(x)) } };
  });
}

const NO_FLAGS: GuideFlags = { parts: false, listed: false, kept: false, rights: [] };

// The guides in the map's order, with its words; without a map, every .txt by name.
export function loadGuides(dir: string): HelpGuide[] {
  let entries: { file: string; flags: GuideFlags }[];
  try { entries = parseMap(readFileSync(join(dir, 'guides.map'), 'utf8')); } catch {
    try { entries = readdirSync(dir).sort().map((file) => ({ file, flags: NO_FLAGS })); } catch { return []; }
  }
  return entries.filter((e) => /^[A-Za-z0-9._-]+\.txt$/.test(e.file))
    .map((e) => ({ ...parseGuide(e.file, readFileSync(join(dir, e.file), 'utf8')), ...e.flags }));
}
