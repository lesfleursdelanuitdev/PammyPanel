// Adopting what already runs (docs/adopt-plan.md V7, A1): for each service in
// known.ts whose user and units are on this server, what systemd says of each
// unit (its Quadlet file, and that file's checksum) is written into the services
// helper's record. Nothing of the service is changed: no unit, file, container,
// secret or nginx line. Run by lfdln's installer, as root, never through the socket.
// Adopting again keeps each service's first adoption time, and refreshes the rest.
import type { Runner } from '@panel/core/runner';
import { KNOWN } from './known.ts';
import { emptyRecord, type Part, type Service, type ServicesRecord } from './record.ts';

export type AdoptDeps = {
  run: Runner;
  passwd: () => string;                // /etc/passwd
  now: () => number;
};

export async function adopt(d: AdoptDeps, before: ServicesRecord = emptyRecord()): Promise<{ record: ServicesRecord; said: string[] }> {
  const said: string[] = [];
  const services: Service[] = [];
  for (const k of KNOWN) {
    const line = d.passwd().split('\n').map((l) => l.split(':')).find((f) => f[0] === k.user);
    if (!line) { said.push(`note ${k.title}: no user ${k.user} on this server, not taken in`); continue; }
    const as = { user: k.user, uid: Number(line[2]), home: line[5] || `/var/lib/${k.user}` };
    const show = await d.run({ as, what: 'adopt-show', timeoutSec: 30,
      argv: ['systemctl', '--user', 'show', '-p', 'Id,LoadState,SourcePath', ...k.parts.map((p) => `${p.unit}.service`)] });
    if (show.code !== 0) { said.push(`note ${k.title}: its user's systemd didn't answer (${(show.stderr || show.stdout).trim().slice(0, 200)}), not taken in`); continue; }
    const units = new Map<string, Record<string, string>>();
    for (const block of show.stdout.split(/\n\s*\n/)) {
      const kv: Record<string, string> = {};
      for (const l of block.split('\n')) { const i = l.indexOf('='); if (i > 0) kv[l.slice(0, i)] = l.slice(i + 1); }
      if (kv.Id) units.set(kv.Id, kv);
    }
    // a unit systemd doesn't know (never installed): the service isn't taken in
    const missing = k.parts.filter((p) => !['loaded', 'masked'].includes(units.get(`${p.unit}.service`)?.LoadState ?? ''));
    if (missing.length) { said.push(`note ${k.title}: ${missing.map((p) => p.unit).join(', ')} not in ${k.user}'s systemd, not taken in`); continue; }
    const sources = k.parts.map((p) => units.get(`${p.unit}.service`)?.SourcePath || null);
    const sums = new Map<string, string>();
    const files = [...new Set(sources.filter((x): x is string => !!x))];
    if (files.length) {
      const r = await d.run({ as, what: 'adopt-checksum', timeoutSec: 30, argv: ['sha256sum', '--', ...files] });
      for (const l of r.stdout.split('\n')) { const m = l.match(/^([0-9a-f]{64}) [ *](.+)$/); if (m) sums.set(m[2]!, m[1]!); }
    }
    const parts: Part[] = k.parts.map((p, i) => ({ ...p, source: sources[i]!, sha256: sources[i] ? sums.get(sources[i]!) ?? null : null }));
    const was = before.services.find((s) => s.id === k.id);
    // (its pammy-panel.json's place is the code's to know, not the record's: known.ts)
    const { manifest: _manifest, ...service } = k;
    services.push({ ...service, parts, adoptedAt: was?.adoptedAt ?? d.now() });
    said.push(`ok   ${k.title}: ${was ? 'taken in already, since' : 'taken in'} ${new Date((was?.adoptedAt ?? d.now()) * 1000).toISOString().slice(0, 10)} (${parts.map((p) => p.unit).join(', ')}); nothing of it changed`);
  }
  return { record: { version: 1, services }, said };
}
