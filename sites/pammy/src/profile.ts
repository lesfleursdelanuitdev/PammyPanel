// pammy.org (docs/packaging-plan.md step 5): Pamela's website and its panel.
// panel.env and the units set many of these too, and win; test/profile.test.ts
// checks that they say the same.
import { MODULES, type Module, type SiteProfile } from '@panel/core/profile';

// `satisfies`, not a type: pammy.org has every module's facts, and its own code reads
// them as there (a profile's type leaves out what a site with the module off lacks).
export const PROFILE = {
  domain: 'pammy.org',
  panelOrigin: 'https://panel.pammy.org',
  name: 'pammy.org',
  panelName: 'pammy.org panel',
  front: 'cloudflare',
  panelAccess: { kind: 'front' },
  tls: { panel: { cert: '/etc/ssl/cloudflare/pammy.org-wildcard.pem', key: '/etc/ssl/cloudflare/pammy.org-wildcard.key' } },
  uploads: { maxBytes: 100 * 1024 * 1024 },
  nginx: { panel: 'pammy-panel', panelDir: '/etc/nginx/pammy-panel', gateDir: '/etc/nginx/pammy-gate' },
  folderSubdomains: true,
  // every module but hosts, services, monitoring and projects: pammy.org's subdomains are its
  // folders (folderSubdomains), and the server's services and projects are lfdln's panel's
  // (docs/adopt-plan.md, docs/phase8b-plan.md)
  modules: MODULES.filter((m): m is Module => m !== 'hosts' && m !== 'services' && m !== 'monitoring' && m !== 'projects') as readonly Module[],
  words: {
    app: { one: 'app', a: 'an app', many: 'apps' },
    website: { title: 'Website', your: 'your website', top: 'the top of your website' },
    explain: true,
    admin: { one: 'account manager', a: 'an account manager', many: 'account managers' },
  },
  // her guides (../guides.map), the same as in her instructions folder
  help: {
    intro: 'Your guides: the same ones as in your instructions folder. Search them all, or open one.',
    searchExample: 'contact page, login page, captcha, passkey',
    topics: {
      forms: 'forms', 'form-or-database': 'forms-or-a-database', comments: 'comments', databases: 'databases-and-programs',
      'database-users': 'databases-and-programs', 'media-api': 'media-on-your-pages',
    },
  },
  // pammy.org on hosts (docs/phase8-plan.md 8-7): the routing helper's folder, her website as
  // the site folders' root, and Cloudflare's origin certificate for every name (it covers
  // pammy.org and *.pammy.org). The hosts module comes on in 8-7b; nginx follows in 8-7c.
  hosts: {
    dir: '/etc/nginx/pammy-hosts',
    sitesRoot: '/pamela/public',
    tls: { cert: '/etc/ssl/cloudflare/pammy.org-wildcard.pem', key: '/etc/ssl/cloudflare/pammy.org-wildcard.key', include: [] },
    domain: { dns: 'manual', cert: 'cloudflare-origin', wildcardRecord: true },
  },
  owner: { user: 'pamela', home: '/home/pamela', name: 'Pamela' },
  website: { root: '/pamela', public: '/pamela/public', trash: '/pamela/trash' },
  mail: { from: 'noreply@mail.lesfleursdelanuit.com', fromName: 'pammy.org panel', replyTo: 'hello@pammy.org', notifyTo: 'hello@pammy.org' },
  apps: { state: '/var/lib/pammy-apps' },
  services: {
    panel: { host: '127.0.0.1', port: 3044 },
    gate: { host: '127.0.0.1', port: 3045, snapshot: '/var/lib/svc-pammygate/areas.json' },
    pg: { host: '127.0.0.1', port: 5434, database: 'pammy' },
    // where the Studio's engines answer, for the logins it makes (docs/phase8-plan.md 8-4)
    studioPorts: { postgres: 5433, mariadb: 3307 },
    sockets: {
      sitefs: '/run/pammy-sitefs.sock', gateAdmin: '/run/pammy-gate-admin.sock', thumbs: '/run/pammy-thumbs.sock',
      pammydb: '/run/pammy-pammydb.sock', pammydbGate: '/run/pammy-pammydb-gate.sock', apps: '/run/pammy-apps.sock', mail: '/run/pammy-mail.sock',
      // pammy.org's nginx from the hosts rows (docs/phase8-plan.md 8-7b)
      routes: '/run/pammy-routes.sock',
    },
    mediaPublic: '/var/lib/pammy-media-public',
    tutorialExamples: '/var/lib/pammy-tutorial-examples',
    phpRun: '/run/pammy-php',
    mailSettings: '/etc/pammy-mail/settings.json',
    wordpressPlacement: '/etc/nginx/pammy-wordpress/placement',
    trashDays: 30,
  },
} satisfies SiteProfile;
