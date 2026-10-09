// What test/adopt-compare.ts and test/adopt-takeover.ts share (docs/domains-hosts-plan.md
// step 7): Gonsalves's media and domains, moved into the harness.
import { join } from 'node:path';
import { TAKEOVERS, type Takeover } from '@panel/hosts/takeover';
import { SERVED_FOLDERS } from '@panel/services/known';

// Gonsalves's media folders, moved into the harness (known.ts's, with /mnt/storage/uploads/ swapped)
export const servedIn = (uploads: string) => ({
  roots: [`${uploads}/`],
  folders: Object.fromEntries(Object.entries(SERVED_FOLDERS).map(([k, v]) => [k, v.map((f) => ({ ...f, dir: f.dir.replace('/mnt/storage/uploads/', `${uploads}/`) }))])),
});
// the domains the takeovers are on, with the harness's one certificate
export const domainsFor = (cert: string, key: string) => [
  { name: 'lesfleursdelanuit.com', home: true, tls: { cert, key } },
  ...[...new Set(TAKEOVERS.flatMap((t) => (t.domain ? [t.domain] : [])))].map((name) => ({
    name, home: false, tls: { cert, key },
    names: [...new Set(TAKEOVERS.filter((t) => t.domain === name).flatMap((t) => (t.name === '@' ? [name, ...(t.host.withWww ? [`www.${name}`] : [])] : [`${t.name}.${name}`])))],
  })),
];
// where a takeover's checks take a few files from
export const probeDirOf = (t: Takeover, sitesRoot: string, uploads: string) => (t.folder ? join(sitesRoot, t.folder.name) : t.probeDir ? t.probeDir.replace('/mnt/storage/uploads', uploads) : null);
