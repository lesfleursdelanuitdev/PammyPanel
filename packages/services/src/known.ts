// What already runs on the server and is taken in (docs/adopt-plan.md V7): the
// services' users, units, ports and health paths, as their own deploy folders
// have them (/srv/apps/*/deploy/quadlet, checked 2026-09-25). Adopting reads what
// systemd says of each unit and writes it down; it changes nothing (A1).
import type { ServedFolder } from '@panel/hosts/render';
import type { Part, Service } from './record.ts';

// manifest: its pammy-panel.json (docs/roles-plan.md step 6), where its own installer puts it
// accountDeleted: its path for "this account was deleted" (docs/accounts-plan.md Q1, step 4b), on
// its first part with a port; the lfdln installer makes its key, /etc/lfdln-panel/hooks/<id>.key
type Known = Omit<Service, 'adoptedAt' | 'parts'> & { parts: Omit<Part, 'source' | 'sha256'>[]; manifest?: string; accountDeleted?: string };
// what the Access page's Read again takes (the same as a folder's, @panel/areas/manifest)
export const MANIFEST_MAX = 64 * 1024;

export const KNOWN: Known[] = [
  {
    id: 'tutorstar',
    title: 'TutorStar',
    user: 'svc-tutorstar',
    about: 'tutor.lesfleursdelanuit.com. Code and runbook: /srv/apps/tutorstar (deploy/README.md).',
    parts: [
      { id: 'web', title: 'TutorStar', unit: 'tutorstar', port: 3041, health: '/', controls: true, requires: [] },
    ],
  },
  {
    id: 'gonsalves',
    title: 'Gonsalves family',
    user: 'svc-ligneous',
    about: 'gonsalvesfamily.com and admin.gonsalvesfamily.com (their nginx is hand-written until the panel takes them over, docs/domains-hosts-plan.md step 7). Code and runbook: /srv/apps/gonsalves (deploy/quadlet/README.md).',
    parts: [
      { id: 'gedcom-api', title: 'GEDCOM API', unit: 'ligneous-gedcom-api', port: 8091, health: '/health', controls: true, requires: [] },
      { id: 'flask-api', title: 'Flask API', unit: 'ligneous-flask-api', port: 5001, health: '/api/health', controls: true, requires: [] },
      { id: 'public', title: 'Public site', unit: 'ligneous-public', port: 3039, health: '/', controls: true, requires: ['gedcom-api', 'flask-api'] },
      { id: 'admin', title: 'Admin site', unit: 'ligneous-admin', port: 3040, health: '/api/health', controls: true, requires: ['gedcom-api', 'flask-api'] },
      // Prisma's migrations, run by hand at a deploy: shown, never started from the panel
      { id: 'migrator', title: 'Database migrations (one-shot)', unit: 'ligneous-migrator', port: null, health: null, controls: false, requires: [] },
    ],
  },
  {
    id: 'examprep',
    title: 'Placement Exam Prep',
    user: 'svc-lfdln-apps',
    about: 'examprep.lesfleursdelanuit.com (Next.js; progress of signed-in people in its database on lfdln-appdb). Code and runbook: ~momolig/apps/placement-exam-prep-nextjs (web/deploy/README.md).',
    // web/pammy-panel.json, copied here by web/deploy/install.sh (root 644)
    manifest: '/etc/lfdln-projects/examprep/pammy-panel.json',
    accountDeleted: '/_lfdln/account-deleted',
    parts: [
      { id: 'web', title: 'Exam prep (Next.js)', unit: 'examprep', port: 4101, health: '/api/health', controls: true, requires: [] },
    ],
  },
];

// Folders nginx serves itself on a route to a service part (docs/domains-hosts-plan.md
// step 7, 7-2), before the proxy: at `path` on the host, the files in `dir`, cached `days`
// days and marked immutable, as the hand-written files did. In code, so root decides the
// folders and a request never does; the routing helper takes only folders under
// SERVED_ROOTS. Gonsalves's public site: the GEDCOM and site media only (user-media is
// private, and the admin app checks who may see it).
export const SERVED_ROOTS = ['/mnt/storage/uploads/'];
export const SERVED_FOLDERS: Record<string, ServedFolder[]> = {
  'gonsalves/public': [
    { path: '/uploads/gedcom-admin/', dir: '/mnt/storage/uploads/gedcom-admin/', days: 30 },
    { path: '/uploads/site-media/', dir: '/mnt/storage/uploads/site-media/', days: 30 },
  ],
};

// Each service's own database (docs/data-move-plan.md M7). Where it is -- the server's
// own Postgres (:5432) or lfdln-appdb (:5436) -- is what move-db.sh writes down when it
// switches one (/var/lib/lfdln-services/databases.json); until then, :5432.
export const DATABASES: Record<string, string> = {
  tutorstar: 'tutorstar',
  gonsalves: 'ligneous_frontend',
};

// The nightly backups monitoring looks at (docs/monitoring-plan.md step 2): each folder's
// newest "<prefix>…-<stamp>-nightly.dump" batch, read by a root unit (storage.ts). The
// installers make these folders; the timers fill them (04:30, 04:45, 05:00 UTC).
// pruned: kept as long as the panel's Settings > Backups says (docs/lfdln-mariadb-plan.md B1-B2):
// the Studio's databases' engines, not the panels' own
export const BACKUPS: { id: string; title: string; dir: string; prefix: string; pruned?: true }[] = [
  { id: 'lfdln-pg', title: "The panel's database (lfdln-pg)", dir: '/var/lib/svc-lfdlnpanel-db/backups', prefix: 'lfdln-' },
  { id: 'lfdln-appdb', title: "The apps' databases (lfdln-appdb)", dir: '/var/lib/svc-lfdlnappdb/backups', prefix: '', pruned: true },
  { id: 'lfdln-appmaria', title: "The Studio's MariaDB (lfdln-appmaria)", dir: '/var/lib/svc-lfdlnmaria/backups', prefix: '', pruned: true },
  { id: 'pammy-pg', title: "pammy.org's panel database (pammy-pg)", dir: '/var/lib/svc-pammypanel-db/backups', prefix: 'pammy-' },
];
// The disks: / and /mnt/storage (one disk today: a folder on /, said as one)
export const DISKS = ['/', '/mnt/storage'];
