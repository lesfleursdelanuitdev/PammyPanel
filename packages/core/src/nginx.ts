// nginx files, rendered from a site's profile (docs/adapters-plan.md A4). The
// templates are today's files with the site's values as @@TOKENS@@ and what
// depends on the site as line blocks:
//   #@if cloudflare      (a flag, or !flag)
//   #@else
//   #@end
// For pammy.org's profile the result is byte for byte what is live
// (test/nginx.test.ts against test/nginx-snapshot/pammy/).
import { readFileSync } from 'node:fs';
import type { Module, SiteProfile } from './profile.ts';
import { isOn } from './profile.ts';

export type Flags = Record<string, boolean>;

export function renderTemplate(text: string, vars: Record<string, string>, flags: Flags, what = 'template'): string {
  const out: string[] = [];
  // each open #@if: is it showing, and was the part before #@else showing
  const stack: { on: boolean; outer: boolean }[] = [];
  const showing = () => stack.every((s) => s.on);
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const m = /^#@(if|else|end)(?:\s+(!?)([a-z-]+))?\s*$/.exec(line);
    if (!m) { if (showing()) out.push(line); return; }
    const where = `${what}:${i + 1}`;
    if (m[1] === 'if') {
      if (!m[3]) throw new Error(`${where}: #@if needs a flag`);
      if (!(m[3] in flags)) throw new Error(`${where}: no flag "${m[3]}"`);
      const outer = showing();
      stack.push({ on: m[2] === '!' ? !flags[m[3]] : flags[m[3]]!, outer });
    } else if (m[1] === 'else') {
      const top = stack.at(-1);
      if (!top) throw new Error(`${where}: #@else without #@if`);
      top.on = !top.on;
    } else {
      if (!stack.pop()) throw new Error(`${where}: #@end without #@if`);
    }
  });
  if (stack.length) throw new Error(`${what}: #@if without #@end`);
  const text2 = out.join('\n').replace(/@@([A-Z_]+)@@/g, (_, k: string) => {
    const v = vars[k];
    if (v === undefined) throw new Error(`${what}: no value for @@${k}@@`);
    return v;
  });
  return text2;
}

// What the templates are told about the site
export function nginxVars(p: SiteProfile): Record<string, string> {
  const sv = p.services;
  return {
    DOMAIN: p.domain,
    INSTALLER: p.nginx.installer ?? 'deploy/install-panel.sh',
    SITE_NAME: p.name,
    PANEL_HOST: new URL(p.panelOrigin).hostname,
    PANEL_NAME: p.nginx.panel,
    PANEL_ADDR: `${sv.panel.host}:${sv.panel.port}`,
    // what only the gate's and PHP's files say: '' on a site without them (no template of
    // theirs is rendered there)
    GATE_ADDR: sv.gate ? `${sv.gate.host}:${sv.gate.port}` : '',
    PANEL_CERT: p.tls.panel.cert,
    PANEL_KEY: p.tls.panel.key,
    PANEL_TLS_MORE: [...(p.tls.panel.include ?? []).map((f) => `    include ${f};`), ...(p.tls.panel.dhparam ? [`    ssl_dhparam ${p.tls.panel.dhparam};`] : [])].join('\n'),
    NGX_PANEL: p.nginx.panelDir,
    NGX_GATE: p.nginx.gateDir,
    // nginx's edge secret (docs/s1-plan.md S1c): root-only, made by the installer, kept
    EDGE: `${p.nginx.panelDir}/edge.conf`,
    UPLOAD_MB: String(Math.floor(p.uploads.maxBytes / (1024 * 1024))),
    VPN_SUBNET: p.panelAccess.kind === 'vpn' ? p.panelAccess.subnet : '',
    PHP_RUN: sv.phpRun ?? '',
    TUTORIAL_EXAMPLES: sv.tutorialExamples ?? '',
    // git over HTTPS for the projects (docs/phase8b-plan.md 8b-7): only its own file says it
    GIT_HOST: `git.${p.domain}`,
  };
}

export function nginxFlags(p: SiteProfile): Flags {
  return {
    cloudflare: p.front === 'cloudflare',
    direct: p.front === 'direct',
    vpn: p.panelAccess.kind === 'vpn',
    php: isOn(p, 'php'),
    examples: isOn(p, 'examples'),
    'folder-subdomains': p.folderSubdomains,
    'tls-more': !!(p.tls.panel.include?.length || p.tls.panel.dhparam),
    projects: isOn(p, 'projects'),
  };
}

// Cloudflare's ranges (deploy/cloudflare-ips.txt) as nginx's real-IP trust list and
// the only-Cloudflare-may-connect list. (Was render-cloudflare.sh; its header line is
// kept word for word, so the files stay what they were.)
export function cloudflareRanges(text: string, extra: string[] = []): string[] {
  const ranges = [...text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')), ...extra];
  if (ranges.length < 10) throw new Error('suspiciously few Cloudflare ranges');
  for (const r of ranges) if (!/^[0-9a-f.:]+\/[0-9]+$/.test(r)) throw new Error(`bad range '${r}'`);
  return ranges;
}
const GENERATED = '# generated from cloudflare-ips.txt by render-cloudflare.sh -- do not edit\n';
export const realIpConf = (ranges: string[]) =>
  `${GENERATED}${ranges.map((r) => `set_real_ip_from ${r};\n`).join('')}real_ip_header CF-Connecting-IP;\n`;
export const cloudflareGeo = (ranges: string[]) => `${GENERATED}${ranges.map((r) => `${r} 1;\n`).join('')}`;

// One file a site installs: its template, where it goes (relative to the output
// folder: site/, panel/, gate/), and the module it belongs to, if any.
export type NginxFile = { template: string; out: string; module?: Module };

// Every file for this site, rendered. cloudflare: the ranges file's text, when
// Cloudflare is in front (plus any extra ranges, for tests).
export function renderNginx(p: SiteProfile, files: NginxFile[], cloudflare?: { text: string; extra?: string[] }): Map<string, string> {
  const vars = nginxVars(p);
  const flags = nginxFlags(p);
  const out = new Map<string, string>();
  for (const f of files) {
    if (f.module && !isOn(p, f.module)) continue;
    out.set(f.out, renderTemplate(readFileSync(f.template, 'utf8'), vars, flags, f.out));
  }
  if (p.front === 'cloudflare') {
    if (!cloudflare) throw new Error('Cloudflare is in front, but no ranges were given');
    const ranges = cloudflareRanges(cloudflare.text, cloudflare.extra);
    out.set('panel/cloudflare-realip.conf', realIpConf(ranges));
    out.set('panel/cloudflare-ips.geo', cloudflareGeo(ranges));
  }
  return out;
}
