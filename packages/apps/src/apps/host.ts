// What the software helper reads of the machine, in one place (docs/apps-plan.md
// G2, phase 1). Everything is a read: files, folder sizes, the containers'
// control groups, free memory, and one request through nginx.
//
// `root` is "/" on the server. The tests point it at a folder laid out like the
// server's (test/apps.test.ts), so the code under test is this code, reading real
// files, with only the request through nginx stood in for.
import { lstat, readFile, readdir } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';

export type ProbeTarget = {
  url: string;                        // what a visitor would ask for
  connect: { host: string; port: number; tls: boolean };   // where to ask it on this machine
  timeoutMs: number;
};
export type ProbeResult = { status: number | null; ms: number; error: string | null };
export type Probe = (t: ProbeTarget) => Promise<ProbeResult>;

export type Host = {
  root: string;
  domain: string;                     // pammy.org
  nginx: { host: string; port: number };   // nginx's TLS side on this machine
  probe: Probe;
  now: () => number;                  // unix seconds
  // The nginx file WordPress's main.conf is read inside (sites-enabled/pamela): while it is
  // enabled, software can be the whole website. pammy.org on its hosts (docs/phase8-plan.md
  // 8-7d) has it out of sites-enabled, and "the whole website" is then refused. Not given:
  // always allowed (the tests that don't ask).
  wholeSite?: string;
};

const at = (h: Host, p: string) => join(h.root, p);

export async function readText(h: Host, p: string, max = 256 * 1024): Promise<string | null> {
  try {
    const b = await readFile(at(h, p));
    return b.length > max ? null : b.toString('utf8');
  } catch { return null; }
}

// Can software be the whole website here now? (See Host.wholeSite.)
export async function wholeSiteServed(h: Host): Promise<boolean> {
  if (!h.wholeSite) return true;
  try { await lstat(at(h, h.wholeSite)); return true; } catch { return false; }
}

// A new address, asked through nginx until it answers (< 400) or 90 seconds have gone: on
// pammy.org's hosts the route to a moved or new install is written by the panel within a
// minute of nginx's reload (sites/pammy/src/server.ts), not by the reload itself. The last
// answer.
export async function answerSoon(h: Host, url: string, sleep: (ms: number) => Promise<void>, tries = 18): Promise<ProbeResult> {
  for (let i = 1; ; i++) {
    const r = await h.probe({ url, connect: { ...h.nginx, tls: true }, timeoutMs: 8000 });
    if ((r.status !== null && r.status < 400) || i >= tries) return r;
    await sleep(5000);
  }
}

export async function listDir(h: Host, p: string): Promise<{ name: string; bytes: number; mtime: number }[] | null> {
  let names: string[];
  try { names = await readdir(at(h, p)); } catch { return null; }
  const out: { name: string; bytes: number; mtime: number }[] = [];
  for (const name of names) {
    try {
      const s = await lstat(join(at(h, p), name));
      if (s.isFile()) out.push({ name, bytes: s.size, mtime: Math.floor(s.mtimeMs / 1000) });
    } catch { /* gone meanwhile */ }
  }
  return out;
}

// The bytes under a folder, links not followed. A folder the size of a whole
// WordPress (a few thousand files, plus uploads) takes well under a second; the
// limit is for the day something holds millions, when "unknown" is the honest answer.
export async function treeSize(h: Host, p: string, maxEntries = 300_000): Promise<number | null> {
  let total = 0;
  let seen = 0;
  const walk = async (dir: string): Promise<boolean> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
      if (++seen > maxEntries) return false;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!await walk(full)) return false;
      } else if (e.isFile()) {
        try { total += (await lstat(full)).size; } catch { /* gone meanwhile */ }
      }
    }
    return true;
  };
  try {
    const s = await lstat(at(h, p));
    if (!s.isDirectory()) return null;
  } catch { return null; }
  return await walk(at(h, p)) ? total : null;
}

export async function uidOf(h: Host, user: string): Promise<number | null> {
  const passwd = await readText(h, '/etc/passwd', 4 * 1024 * 1024);
  for (const line of passwd?.split('\n') ?? []) {
    const f = line.split(':');
    if (f[0] === user && /^\d+$/.test(f[2] ?? '')) return Number(f[2]);
  }
  return null;
}

export async function memory(h: Host): Promise<{ total: number | null; available: number | null }> {
  const text = await readText(h, '/proc/meminfo');
  const kb = (key: string) => {
    const m = text?.match(new RegExp(`^${key}:\\s+(\\d+) kB$`, 'm'));
    return m ? Number(m[1]) * 1024 : null;
  };
  return { total: kb('MemTotal'), available: kb('MemAvailable') };
}

// A container is a service in its user's systemd manager (rootless Quadlet), and
// so a control group: there when it is running, with its memory counted. Read
// straight from the cgroup files -- no D-Bus into another user's manager, and
// nothing a sandboxed root needs a capability for.
export async function unitState(h: Host, uid: number, unit: string): Promise<{ running: boolean; memory: number | null }> {
  const dir = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${unit}.service`;
  const events = await readText(h, `${dir}/cgroup.events`);
  const running = /^populated 1$/m.test(events ?? '');
  if (!running) return { running, memory: null };
  // "anon" is what its programs hold; memory.current also counts the file cache,
  // which for a web server is most of it and is given back whenever asked
  const stat = await readText(h, `${dir}/memory.stat`);
  const m = stat?.match(/^anon (\d+)$/m);
  return { running, memory: m ? Number(m[1]) : null };
}

// One GET, as a visitor would ask it, but to nginx on this machine rather than
// through Cloudflare. The certificate is the Cloudflare origin one, which is not
// meant to be trusted by anyone but Cloudflare, and the connection never leaves
// loopback, so it isn't checked. Redirects are an answer, not followed.
export const realProbe: Probe = (t) => new Promise((resolve) => {
  const started = performance.now();
  const u = new URL(t.url);
  const done = (status: number | null, error: string | null) => resolve({ status, ms: Math.round(performance.now() - started), error });
  const opts = {
    host: t.connect.host, port: t.connect.port, method: 'GET', path: `${u.pathname}${u.search}`,
    headers: { host: u.host, 'user-agent': 'pammy-apps (health check)', accept: 'text/html' },
    timeout: t.timeoutMs,
  };
  const req = t.connect.tls
    ? httpsRequest({ ...opts, servername: u.hostname, rejectUnauthorized: false })
    : httpRequest(opts);
  req.on('response', (res) => { res.resume(); done(res.statusCode ?? null, null); req.destroy(); });
  req.on('timeout', () => { req.destroy(); done(null, 'no answer in time'); });
  req.on('error', (e) => done(null, (e as NodeJS.ErrnoException).code ?? 'could not connect'));
  req.end();
});
