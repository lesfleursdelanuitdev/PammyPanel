// Domains as data (docs/domains-hosts-plan.md step 1): the rows the routing helper
// renders from. The site's own domain (the "home" one) is seeded from its profile by
// the installer (lfdln-panel seed-domain): once made, the row is what counts, and a
// later install never changes it. The hosts already there are put on it.
import { isOn, type SiteProfile } from '@panel/core/profile';
import { all, one, run, tx, type Db, type Sql } from '@panel/core/pg';
import type { Domain, Tls } from './render.ts';

export type DomainRow = {
  id: number; name: string; home: boolean; dns: 'cloudflare' | 'dreamhost' | 'manual'; front: 'cloudflare' | 'direct';
  cert: 'wildcard-dns' | 'per-host' | 'cloudflare-origin' | 'files' | 'names'; tls: Tls; wildcard_record: boolean; folder_hosts: boolean;
  cert_names: string[];      // cert 'names': what the certificate covers (step 7)
  zone_checked_at: number | null; zone_readable: boolean | null; created_by: string | null; created_at: number;
};

// The domains as the routing helper takes them (render.ts Domain).
export async function domainsFrom(q: Db): Promise<Domain[]> {
  return (await all<DomainRow>(q, 'SELECT * FROM domains ORDER BY home DESC, name'))
    .map((d) => ({
      name: d.name, home: d.home, tls: d.tls, front: d.front,
      ...(d.cert === 'names' ? { names: d.cert_names } : {}), ...(d.folder_hosts ? { folderHosts: true } : {}),
    }));
}

// The home domain's hosts, in SQL (step 7: the others are on another domain). Before the
// home domain is seeded, a host has none, and is the home one's too.
export const ON_HOME = '(domain_id IS NULL OR domain_id = (SELECT id FROM domains WHERE home))';

export const homeDomain = (q: Db) => one<DomainRow>(q, 'SELECT * FROM domains WHERE home');

export type Seeded = { made: boolean; name: string; hosts: number };

// The home domain's row from the profile, if there isn't one; and every host without a
// domain put on it. Safe to run on every install.
export async function seedHomeDomain(db: Sql, p: SiteProfile, now: number, actor = 'installer'): Promise<Seeded> {
  if (!p.hosts || !isOn(p, 'hosts')) throw new Error(`${p.name} has no hosts: the hosts module is off in its profile`);
  const d = p.hosts.domain ?? { dns: 'manual', cert: 'files', wildcardRecord: false };
  return tx(db, async (q) => {
    const had = await homeDomain(q);
    if (had && had.name !== p.domain) throw new Error(`the home domain is ${had.name}, but the profile says ${p.domain}`);
    const tls: Tls = { cert: p.hosts!.tls.cert, key: p.hosts!.tls.key, include: p.hosts!.tls.include, ...(p.hosts!.tls.dhparam ? { dhparam: p.hosts!.tls.dhparam } : {}) };
    const id = had?.id ?? (await one<{ id: number }>(q,
      `INSERT INTO domains (name, home, dns, front, cert, tls, wildcard_record, folder_hosts, created_by, created_at)
       VALUES (?, true, ?, ?, ?, ?::text::jsonb, ?, ?, ?, ?) RETURNING id`,
      p.domain, d.dns, p.front, d.cert, JSON.stringify(tls), d.wildcardRecord, p.folderSubdomains, actor, now))!.id;
    const hosts = await run(q, 'UPDATE hosts SET domain_id = ? WHERE domain_id IS NULL', id);
    return { made: !had, name: p.domain, hosts };
  });
}
