// lesfleursdelanuit.com (docs/lfdln-standup-plan.md): the panel for this server's
// other sites, at panel.lesfleursdelanuit.com. Plainly technical words (platform plan
// D4), nothing in front of nginx, the Let's Encrypt wildcard, open to anyone with a
// passkey (N2). Phase 5 has the hosts module (hosts, routes and site folders) and PHP
// in site folders (F5); the rest come on one at a time in phase 8.
// panel.env and the units say many of these again, and win; test/profile.test.ts
// checks that they say the same.
import { type Module, type SiteProfile } from '@panel/core/profile';

const WILDCARD = '/etc/letsencrypt/live/wildcard.lesfleursdelanuit.com';

export const PROFILE = {
  domain: 'lesfleursdelanuit.com',
  panelOrigin: 'https://panel.lesfleursdelanuit.com',
  name: 'lesfleursdelanuit.com',
  panelName: 'lesfleursdelanuit.com panel',
  front: 'direct',
  panelAccess: { kind: 'front' },
  tls: { panel: {
    cert: `${WILDCARD}/fullchain.pem`, key: `${WILDCARD}/privkey.pem`,
    include: ['/etc/letsencrypt/options-ssl-nginx.conf'], dhparam: '/etc/letsencrypt/ssl-dhparams.pem',
  } },
  // one file sent to File Explorer (phase 8); nginx's limit for it
  uploads: { maxBytes: 100 * 1024 * 1024 },
  nginx: { panel: 'lfdln-panel', panelDir: '/etc/nginx/lfdln-panel', gateDir: '/etc/nginx/lfdln-gate', installer: 'deploy/lfdln/install-lfdln.sh' },
  // a folder is only a folder: a name becomes an address through a route (hosts)
  folderSubdomains: false,
  // mail: its own mail service, lfdln-mail (docs/accounts-plan.md step 2), with a door
  // for the gate's visitor emails (step 4).
  // areas: its own gate, lfdln-gate (step 3); nginx asks it about routes with accounts (roles step 5).
  // people: signing in, and the accounts people make themselves (step 4), each behind a
  // switch on Settings > Visitors, all off until momolig turns them on (step 6)
  // requests and settings (roles plan step 6): People, Access, Requests and Settings > Visitors
  // in lfdln's own menu; every visitor switch still off until momolig turns it on there
  // catalog (docs/catalog-plan.md step 5): tags and categories on what the services offer
  // (exam prep's topics)
  // thumbs and files (docs/phase8-plan.md step 8-1): File Explorer over the site folders,
  // their files tagged, with pictures; the top stays Hosts' (P8-1)
  // api-keys and media (step 8-3): media folders in the site folders (no main site's, P8-5),
  // the media API through every host, and keys to read it
  // studio (step 8-4): databases on lfdln-appdb (P8-7) and lfdln-appmaria (docs/lfdln-mariadb-plan.md), the apps' own read-only (P8-9)
  // forms (step 8-5): a form's scope is a site folder (P8-10), and Settings > Email says which
  // notices go out (the key and addresses stay the installer's)
  // form-links and comments (step 8-6): a form's answers into a table of the Studio's, and
  // comments on a site folder's page or, by its address, on a service's (P8-10)
  // help (docs/phase9-plan.md 9-1): lfdln's own guides (../lfdln-guides/guides.map); not
  // getting-started, whose paths are pammy.org's examples
  // projects (docs/phase8b-plan.md): React, Vue, Svelte, Lit, Next.js and Laravel, built and
  // run by the projects helper as svc-lfdln-apps
  modules: ['hosts', 'php', 'services', 'catalog', 'mail', 'areas', 'people', 'requests', 'settings', 'monitoring', 'thumbs', 'files', 'api-keys', 'media', 'studio', 'forms', 'form-links', 'comments', 'help', 'projects'] as readonly Module[],
  // replies and notices to momolig; the key is a copy of pammy.org's (the same Resend
  // account and verified domain, decided 2026-09-26)
  mail: { from: 'noreply@mail.lesfleursdelanuit.com', fromName: 'lesfleursdelanuit.com panel', replyTo: 'owner@example.com', notifyTo: 'owner@example.com' },
  words: {
    app: { one: 'database app', a: 'a database app', many: 'database apps' },
    website: { title: 'Site folders', your: 'the site folders', top: 'the top of the site folders' },
    explain: false,
    admin: { one: 'admin', a: 'an admin', many: 'admins' },
  },
  // its guides (../lfdln-guides/guides.map); a topic gets its guide as 9-2 writes it
  help: {
    intro: "The panel's guides: plain words first, with parts for programmers. Search them all, or open one.",
    searchExample: 'route, passkey, open with accounts, deletion hook',
    topics: {
      access: 'visitors', hosts: 'domains-hosts-and-routes', 'media-api': 'site-folders#part-7',
      forms: 'forms-and-comments', comments: 'forms-and-comments#part-5', databases: 'databases', 'database-users': 'databases#part-8',
    },
    // the first-steps card on Home (docs/phase9-plan.md 9-3)
    firstSteps: { read: 'start-here' },
  },
  hosts: {
    dir: '/etc/nginx/lfdln-hosts',
    sitesRoot: '/var/www/lesfleursdelanuit-sub',
    tls: {
      cert: `${WILDCARD}/fullchain.pem`,
      key: `${WILDCARD}/privkey.pem`,
      include: ['/etc/letsencrypt/options-ssl-nginx.conf'],
      dhparam: '/etc/letsencrypt/ssl-dhparams.pem',
    },
    // /etc/nginx/conf.d/ratelimit.conf: 5 a minute per address (tutor's and Gonsalves's sign-ins)
    signInZone: 'login',
    // apps behind a route with accounts are told X-Lfdln-Account and the rest (roles plan step 5)
    identity: 'Lfdln',
    // the domain's row, seeded by the installer (docs/domains-hosts-plan.md step 1): DNS at
    // DreamHost (its zone read with dreamhost-dns.sh), a `*` record, the wildcard by DNS-01
    domain: { dns: 'dreamhost', cert: 'wildcard-dns', wildcardRecord: true },
  },
  // the site folders (D3: svc-lfdlnsites's, 2750, group lfdln-sites) and their trash,
  // inside them as .trash (700): a folder moves there in one rename, within the one
  // folder the helper may write, and no route can show a name starting with a dot
  website: { root: '/var/www/lesfleursdelanuit-sub', public: '/var/www/lesfleursdelanuit-sub', trash: '/var/www/lesfleursdelanuit-sub/.trash' },
  services: {
    panel: { host: '127.0.0.1', port: 3046 },
    // its own cookie: a browser signed in on pammy.org never sends it here, nor the other way
    gate: { host: '127.0.0.1', port: 3047, snapshot: '/var/lib/svc-lfdlngate/areas.json', cookie: '__Host-lfdln_visitor' },
    pg: { host: '127.0.0.1', port: 5435, database: 'lfdln' },
    // where the Studio's engines answer, for the logins it makes (docs/phase8-plan.md 8-4)
    studioPorts: { postgres: 5436, mariadb: 3308 },
    // the Studio's logins start with db_ (docs/phase8-plan.md P8-15; studio-site.ts)
    studioUserPrefix: 'db_',
    sockets: {
      sitefs: '/run/lfdln-sitefs.sock', routes: '/run/lfdln-routes.sock', services: '/run/lfdln-services.sock', mail: '/run/lfdln-mail.sock',
      gateAdmin: '/run/lfdln-gate-admin.sock', mailVisitor: '/run/lfdln-mail-visitor.sock',
      thumbs: '/run/lfdln-thumbs.sock', pammydb: '/run/lfdln-pammydb.sock', pammydbGate: '/run/lfdln-pammydb-gate.sock', projects: '/run/lfdln-projects.sock',
    },
    // the thumbnails (thumbs/, step 8-1) and the media API's index.db (step 8-3), read by the gate
    mediaPublic: '/var/lib/lfdln-media-public',
    mailSettings: '/etc/lfdln-mail/settings.json',
    phpRun: '/run/lfdln-php',
    trashDays: 30,
  },
} satisfies SiteProfile;
