// Cloudflare's ranges, refreshed from Cloudflare (docs/security-performance-review.md S6):
// deploy/cloudflare-ips.txt (pammy.org's panel, WordPress) and packages/hosts/src/cloudflare.ts
// (the hosts' real-IP file and the domain checks) rewritten together, so the test that
// compares them still passes. Nothing is fetched when nginx files are written: the ranges are
// part of a release, so a refresh is: run this, look at the diff, commit, build, install.
//   node tools/refresh-cloudflare-ips.ts            (rewrites both files, prints what changed)
//   node tools/refresh-cloudflare-ips.ts --check    (exit 1 if Cloudflare's lists differ)
import { readFileSync, writeFileSync } from 'node:fs';
import { isIPv4, isIPv6 } from 'node:net';
import { join } from 'node:path';
import { CLOUDFLARE_RANGES } from '@panel/hosts/cloudflare';

const ROOT = join(import.meta.dirname, '..');
const TXT = join(ROOT, 'deploy', 'cloudflare-ips.txt');
const TS = join(ROOT, 'packages', 'hosts', 'src', 'cloudflare.ts');
const check = process.argv.includes('--check');

async function list(url: string, ok: (a: string) => boolean): Promise<string[]> {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  const out = (await r.text()).split('\n').map((l) => l.trim()).filter(Boolean);
  for (const c of out) {
    const [a, n] = c.split('/');
    if (!a || !ok(a) || !/^\d{1,3}$/.test(n ?? '') || Number(n) < 8) throw new Error(`${url}: "${c.slice(0, 60)}" is not a range`);
  }
  return out;
}

const v4 = await list('https://www.cloudflare.com/ips-v4', isIPv4);
const v6 = await list('https://www.cloudflare.com/ips-v6', isIPv6);
const ranges = [...v4, ...v6];
if (v4.length < 5 || v6.length < 3) throw new Error(`suspiciously few ranges (${v4.length} + ${v6.length}); nothing changed`);

const added = ranges.filter((r) => !CLOUDFLARE_RANGES.includes(r));
const gone = CLOUDFLARE_RANGES.filter((r) => !ranges.includes(r));
if (!added.length && !gone.length) { console.log(`Cloudflare's ${ranges.length} ranges are the ones we have; nothing to do.`); process.exit(0); }
for (const r of added) console.log(`+ ${r}`);
for (const r of gone) console.log(`- ${r}`);
if (check) process.exit(1);

const today = new Date().toISOString().slice(0, 10);
const txt = readFileSync(TXT, 'utf8');
const head = txt.split('\n').filter((l) => l.startsWith('#'))
  .map((l) => (/^# (Copied|Refreshed) /.test(l) ? `# Refreshed ${today} from Cloudflare by tools/refresh-cloudflare-ips.ts. install-panel.sh turns` : l));
writeFileSync(TXT, `${head.join('\n')}\n${ranges.join('\n')}\n`);

const ts = readFileSync(TS, 'utf8');
const start = ts.indexOf('export const CLOUDFLARE_RANGES: readonly string[] = [');
const end = ts.indexOf('];', start);
if (start < 0 || end < 0) throw new Error(`${TS}: CLOUDFLARE_RANGES not found; nothing changed there`);
writeFileSync(TS, `${ts.slice(0, start)}export const CLOUDFLARE_RANGES: readonly string[] = [\n${ranges.map((r) => `  '${r}',\n`).join('')}${ts.slice(end)}`);
console.log(`\nWrote ${TXT} and ${TS}. Next: git diff, commit, build.sh, then both installers.`);
