// A protected folder's own public answers (docs/refactor-plan.md phase 4): what
// a signed-in visitor can open in a folder with no home page, and which sign-in
// pages it has. Signing in is @panel/people's, requests @panel/requests'.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { GateCtx } from '@panel/core/gate/context';
import { decide, encodePath, HOMES, PAGE_FILES, pageUrl, pathOnHost, resolve, safeNext, type Resolved } from '../policy.ts';
import { targetsFor } from '../targets.ts';

export function registerFolders(ctx: GateCtx) {
  const { app, cfg, live, hostOf, baseOf, visitorOf } = ctx;
  const { targetOf } = targetsFor(ctx);

  // What a signed-in visitor can open in a folder that has no home page: its
  // pages and the subfolders with an index.html, each only if they may open it.
  // path is the folder on this hostname (the welcome redirect passes it); without
  // it, or if it isn't a folder inside this area they may open, the area itself.
  app.get('/_pammy/folder', async (req, reply) => {
    const host = hostOf(req);
    const base = baseOf(req);
    if (!host || base === null) return reply.code(400).send({ error: 'bad-host' });
    const query = req.query as Record<string, unknown>;
    const t = targetOf(base, query);
    if (!t) return reply.code(404).send({ error: 'no-area' });
    const s = await visitorOf(req, host);
    const login = pageUrl({ dir: t.dir, rel: t.rel, token: t.area.token }, base, 'login');
    if (!s || !s.opens.has(t.area.id)) return reply.code(401).send({ error: 'signed-out', login });

    const inArea = (r: Resolved) => r.kind === 'ok' && r.exists && r.protections.some((p) => p.area?.id === t.area.id)
      && decide(r, s).allow && (() => { try { return statSync(r.real).isDirectory(); } catch { return false; } })();
    let hostPath: string | null = null;      // decoded, on this hostname, ending in /
    let dir = '';
    const asked = safeNext(query.path);
    if (asked && asked.endsWith('/') && !asked.includes('?')) {
      const r = resolve(live, cfg.publicRoot, `${base}${asked}`);
      if (inArea(r) && r.kind === 'ok') { hostPath = asked; dir = r.real; }
    }
    if (hostPath === null) {
      const onHost = pathOnHost(t.rel, base);
      const r = onHost === null ? null : resolve(live, cfg.publicRoot, `${base}${onHost}/`);
      if (r && inArea(r) && r.kind === 'ok') { hostPath = `${onHost}/`; dir = r.real; }
    }

    const items: { name: string; href: string; folder: boolean }[] = [];
    let entries: string[] = [];
    try { if (hostPath !== null) entries = readdirSync(dir).sort((a, b) => a.localeCompare(b)); } catch { /* gone */ }
    for (const name of entries) {
      if (items.length >= 100) break;
      if (name.startsWith('.') || PAGE_FILES.has(name) || name === 'login-files' || name === '404.html' || HOMES.includes(name) || name === 'media') continue;
      let st;
      try { st = statSync(join(dir, name)); } catch { continue; }
      const folder = st.isDirectory();
      // a folder with a home page (index.html or index.php), or a page (.html or .php)
      const home = folder ? HOMES.find((h) => { try { return statSync(join(dir, name, h)).isFile(); } catch { return false; } }) : undefined;
      if (folder ? !home : !st.isFile() || !/\.(html|php)$/.test(name)) continue;
      if (!decide(resolve(live, cfg.publicRoot, `${base}${hostPath}${name}${folder ? `/${home}` : ''}`), s).allow) continue;
      items.push({ name, folder, href: `${encodePath(`${hostPath}${name}`)}${folder ? '/' : ''}` });
    }
    return { username: s.visitor.username, items, login };
  });

  app.get('/_pammy/about', async (req, reply) => {
    const host = hostOf(req);
    const base = baseOf(req);
    if (!host || base === null) return reply.code(400).send({ error: 'bad-host' });
    const t = targetOf(base, req.query as Record<string, unknown>);
    if (!t) return reply.code(404).send({ error: 'no-area' });
    const p = { dir: t.dir, rel: t.rel, token: t.area.token };
    return {
      requestsOpen: t.area.requests_open === 1,
      pages: { login: pageUrl(p, base, 'login'), forgot: pageUrl(p, base, 'forgot'), request: pageUrl(p, base, 'request'), logout: pageUrl(p, base, 'logout') },
    };
  });
}
