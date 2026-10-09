// The names that already have a DNS record of their own at DreamHost (webmail,
// ftp, ...), which a new host may never take (docs/hosts-plan.md H6): the
// wildcard `*` sends every other name here, but a name with its own record goes
// wherever that record says, so a host of that name would never be reached --
// or, worse, would quietly start answering if the record were removed.
//
// The routing helper reads the zone by running DreamHost's script as a root unit
// of its own (`dreamhost-dns.sh list`, the one certbot's hook uses): the API key
// never enters the helper, and the helper itself has no network. The answer is
// kept for ten minutes. If it can't be read, no new host is allowed (Q3);
// the hosts already there are never touched by this.
import type { Runner } from '@panel/core/runner';
import { LABEL_RE } from './names.ts';

export const ZONE_TTL = 10 * 60;

// `dreamhost-dns.sh list` prints "<record> <type> <editable> <value>" per line.
// The label right under the domain, from every record below it: "webmail" from
// webmail.<domain>, and from x.webmail.<domain> too (a name with anything under
// it exists in DNS). The wildcard and _acme-challenge are not names anyone takes.
export function takenLabels(listing: string, domain: string): Set<string> {
  const out = new Set<string>();
  const tail = `.${domain}`;
  for (const line of listing.split('\n')) {
    const record = line.trim().split(/\s+/)[0]?.toLowerCase().replace(/\.$/, '') ?? '';
    if (!record.endsWith(tail)) continue;
    const label = record.slice(0, -tail.length).split('.').pop() ?? '';
    if (label === '*' || label.startsWith('_') || !LABEL_RE.test(label)) continue;
    out.add(label);
  }
  return out;
}

export type ZoneReader = {
  // the labels taken, or null when the zone can't be read now
  taken(): Promise<{ labels: Set<string>; readAt: number } | null>;
};

export function zoneReader(run: Runner, command: string[], domain: string, now: () => number, log: (line: string) => void = () => {}): ZoneReader {
  let cached: { labels: Set<string>; readAt: number } | null = null;
  return {
    async taken() {
      if (cached && now() - cached.readAt < ZONE_TTL) return cached;
      const r = await run({ as: 'root', argv: command, what: 'zone', timeoutSec: 60 });
      // a listing with not one record in the domain is a failure too (a changed
      // script, an empty answer): the apex always has one
      const labels = r.code === 0 ? takenLabels(r.stdout, domain) : null;
      if (!labels || !r.stdout.split('\n').some((l) => l.trim().split(/\s+/)[0]?.toLowerCase().replace(/\.$/, '') === domain)) {
        // why, for the helper's journal: no unit at all shows up anywhere else
        const why = r.code !== 0 ? `exit ${r.code}: ${(r.stderr.trim().split('\n').pop() ?? '').slice(0, 300)}` : `no record for ${domain} in the listing`;
        log(`zone: can't be read (${why})`);
        return null;
      }
      cached = { labels, readAt: now() };
      return cached;
    },
  };
}
