// nginx's edge secret where it belongs, and nowhere else (docs/s1-plan.md S1c), in the
// files nginx has now. The verify scripts and the installers run it as root:
//   node tools/edge-check.ts <edge.conf> <port,port> <file>...
// <port,port>: the site's panel and gate. Each file is read as nginx would (blocks, quotes,
// comments), and for every location:
//   - to the panel or the gate (proxy_pass to 127.0.0.1, localhost, [::1] or an upstream
//     that names one of those ports): X-Real-IP is set there, and when it is the visitor's
//     ($remote_addr) the location includes <edge.conf>, so the app believes it;
//   - anywhere else: <edge.conf> is not in what it sends, its own or inherited from the
//     block around it (proxy_set_header is inherited only by a block that sets none).
// An include of <edge.conf> outside a location, or in one that doesn't proxy, is reported
// too. Another site's edge file is that site's to check. Prints "ok <how many>", or each
// problem and exits 1. (checkEdge: the same, for test/edge-secret.test.ts.)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Directive = { name: string; args: string[]; line: number; block?: Block };
type Block = { directives: Directive[] };

// nginx's syntax, enough for this: words, quoted strings, ; { } and # comments
function parse(text: string): Block {
  const root: Block = { directives: [] };
  const stack: Block[] = [root];
  let words: string[] = [];
  let first = 0;
  let line = 1;
  let i = 0;
  const end = (block?: Block) => {
    if (words.length) stack.at(-1)!.directives.push({ name: words[0]!, args: words.slice(1), line: first, block });
    words = [];
  };
  while (i < text.length) {
    const c = text[i]!;
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '#') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === ';') { end(); i++; continue; }
    if (c === '{') {
      const b: Block = { directives: [] };
      end(b);
      stack.push(b);
      i++;
      continue;
    }
    if (c === '}') { end(); if (stack.length > 1) stack.pop(); i++; continue; }
    if (!words.length) first = line;
    if (c === '"' || c === "'") {
      let w = '';
      i++;
      while (i < text.length && text[i] !== c) {
        if (text[i] === '\\' && i + 1 < text.length) { w += text[i + 1]; i += 2; continue; }
        if (text[i] === '\n') line++;
        w += text[i++];
      }
      i++;
      words.push(w);
      continue;
    }
    let w = '';
    while (i < text.length && !/[\s;{}]/.test(text[i]!) && !(text[i] === '#' && w === '')) w += text[i++];
    words.push(w);
  }
  end();
  return root;
}

export type EdgeSite = { edge: string; ports: string[] };
export type EdgeFile = { path: string; text: string };

export function checkEdge(site: EdgeSite, files: EdgeFile[]): { problems: string[]; count: number } {
  const problems: string[] = [];
  let count = 0;
  const parsed = files.map((f) => ({ path: f.path, root: parse(f.text) }));
  const ports = new Set(site.ports);
  // upstreams (in any of the files) that send to one of the site's ports
  const ours = new Set<string>();
  const walk = (b: Block, f: (d: Directive) => void) => { for (const d of b.directives) { f(d); if (d.block) walk(d.block, f); } };
  const local = (hostPort: string) => {
    const m = /^(?:127\.0\.0\.1|localhost|\[::1\]):([0-9]+)$/.exec(hostPort);
    return m && ports.has(m[1]!) ? m[1]! : null;
  };
  for (const { root } of parsed) walk(root, (d) => {
    if (d.name === 'upstream' && d.block && d.block.directives.some((s) => s.name === 'server' && local(s.args[0] ?? ''))) ours.add(d.args[0]!);
  });
  // where a proxy_pass goes: one of ours ("127.0.0.1:3045"), somewhere else, or nowhere
  const target = (b: Block): { ours: boolean; to: string } | null => {
    const p = b.directives.find((d) => d.name === 'proxy_pass');
    if (!p) return null;
    const m = /^https?:\/\/([^/]+)/.exec(p.args[0] ?? '');
    const hp = m?.[1] ?? '';
    return { ours: !!local(hp) || ours.has(hp), to: p.args[0] ?? '' };
  };
  const isEdge = (d: Directive) => d.name === 'include' && d.args[0] === site.edge;
  // the proxy_set_header lines a block sends: its own, or (when it has none) its parent's
  type Headers = { realIp: string | null; edge: boolean; from: string } | null;
  const headersOf = (b: Block, inherited: Headers, where: string): Headers => {
    const own = b.directives.filter((d) => d.name === 'proxy_set_header' || isEdge(d));
    if (!own.length) return inherited;
    const real = own.find((d) => d.name === 'proxy_set_header' && d.args[0]?.toLowerCase() === 'x-real-ip');
    return { realIp: real ? real.args[1] ?? '' : null, edge: own.some(isEdge), from: where };
  };
  for (const { path, root } of parsed) {
    const visit = (b: Block, inherited: Headers, inLocation: boolean) => {
      for (const d of b.directives) {
        if (isEdge(d) && !inLocation) problems.push(`${path}:${d.line}: the edge secret outside any location`);
        if (!d.block) continue;
        const where = `${path}:${d.line}`;
        const h = headersOf(d.block, inherited, where);
        if (d.name === 'location') {
          const t = target(d.block);
          const ownEdge = d.block.directives.find(isEdge);
          if (t?.ours) {
            if (!h || h.realIp === null) problems.push(`${where}: location ${d.args.join(' ')} goes to ${t.to} without setting X-Real-IP (a visitor's own would pass)`);
            else if (h.realIp !== '' && !h.edge) problems.push(`${where}: location ${d.args.join(' ')} hands X-Real-IP to ${t.to} without the edge secret`);
            else if (h.edge) count++;
          } else if (t && h?.edge) {
            problems.push(`${where}: location ${d.args.join(' ')} sends the edge secret to ${t.to}${ownEdge ? '' : ` (inherited from ${h.from})`}`);
          } else if (!t && ownEdge) {
            problems.push(`${path}:${ownEdge.line}: the edge secret in a location that proxies nowhere`);
          }
          visit(d.block, h, true);
        } else {
          visit(d.block, h, inLocation);
        }
      }
    };
    visit(root, null, false);
  }
  return { problems, count };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [edge, portList, ...paths] = process.argv.slice(2);
  if (!edge || !portList || !paths.length) {
    console.error('usage: edge-check.ts <edge.conf> <port,port> <file>...');
    process.exit(2);
  }
  // the edge file itself is the secret, not a place it goes
  const files = paths.filter((p) => p !== edge).map((p) => ({ path: p, text: readFileSync(p, 'utf8') }));
  const { problems, count } = checkEdge({ edge, ports: portList.split(',') }, files);
  if (problems.length) {
    for (const p of problems) console.log(p);
    process.exit(1);
  }
  console.log(`ok ${count}`);
}
