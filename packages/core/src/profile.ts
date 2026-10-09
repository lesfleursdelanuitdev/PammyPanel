// What a site is (docs/packaging-plan.md step 5): the facts the packages used to
// have written into them. A site (sites/<name>/src/profile.ts) gives its own; the
// packages get them from the site, never the other way round.
//
// The environment still wins over any of these (panel.env and the units set most
// of them, and so do the tests); test/profile.test.ts checks the two agree.

// Every module a site may switch on. The core is always on. Each module says what it needs
// in its own src/module.ts (docs/module-contracts-plan.md step C1), put together in
// @panel/modules, which test/modules.test.ts checks against this list; the kernel stops
// naming them in K-b.
export const MODULES = ['mail', 'areas', 'people', 'requests', 'settings', 'catalog', 'files', 'thumbs', 'media', 'forms', 'api-keys', 'studio', 'form-links', 'comments', 'apps', 'php', 'examples', 'help', 'getting-started', 'hosts', 'services', 'monitoring', 'projects'] as const;
export type Module = (typeof MODULES)[number];

export type SiteProfile = {
  domain: string;              // pammy.org: her website, and its folder subdomains
  panelOrigin: string;         // https://panel.pammy.org: the panel, and its passkeys' origin
  name: string;                // "pammy.org": how the panel's words name the website
  panelName: string;           // "pammy.org panel": how they name the panel
  front: 'cloudflare' | 'direct';   // who stands in front of nginx: its real-IP rules, and words about caches
  // who may reach the panel: only through the front (Cloudflare, for pammy.org), or only the VPN
  panelAccess: { kind: 'front' } | { kind: 'vpn'; subnet: string };
  // the panel's certificate, and (a site with nothing in front) the TLS settings that go
  // with it, as certbot's own sites have them
  tls: { panel: { cert: string; key: string; include?: string[]; dhparam?: string } };
  uploads: { maxBytes: number };                   // one file sent to the panel (Media, File Explorer)
  // nginx: the panel's site name (sites-available/<panel>, its logs), and where its includes go
  // (and the installer that puts them there, as the files' headers say: deploy/install-panel.sh when not given)
  nginx: { panel: string; panelDir: string; gateDir: string; installer?: string };
  // recipes/ is also recipes.pammy.org (pammy.org); off, a folder is only ever a folder, and a
  // name becomes an address through a route (lfdln, phase 4; docs/adapters-plan.md A5)
  folderSubdomains: boolean;
  modules: readonly Module[];  // switched on (the core always is)
  words: Words;                // the glossary: the words that differ between sites
  // the Help page (docs/phase9-plan.md 9-1): the line under its title, the search box's
  // example, and which guide each topic is (a page's link into Help names a topic; a topic
  // the site has no guide for shows no link)
  help?: HelpFacts;
  // hosts, routes and site folders (the hosts module, docs/hosts-plan.md): where the
  // routing helper writes nginx, where the site folders live, the certificate that
  // covers every <name>.<domain>, and the TLS includes that go with it
  // signInZone: the limit_req zone a service route's sign-in paths use (docs/adopt-plan.md V3),
  // defined outside the panel's files (lfdln: conf.d/ratelimit.conf's "login")
  // identity: what apps behind a route with accounts are told who is signed in as
  // ("Lfdln": X-Lfdln-Account, LFDLN_ACCOUNT; docs/roles-plan.md step 5)
  // domain: what the installer seeds the site's own domain's row with (docs/domains-hosts-plan.md step 1)
  hosts?: { dir: string; sitesRoot: string; tls: { cert: string; key: string; include: string[]; dhparam?: string }; signInZone?: string; identity?: string;
    domain?: { dns: 'cloudflare' | 'dreamhost' | 'manual'; cert: 'wildcard-dns' | 'per-host' | 'cloudflare-origin' | 'files'; wildcardRecord: boolean } };
  // What only some modules use is left out by a site that has them off; each module's
  // definition says which facts it needs (its facts), and checkFacts refuses a profile that is missing one.
  owner?: { user: string; home: string; name: string };     // her Unix user, its home, her name (apps)
  // what the folder helper looks after: pammy.org's website (/pamela, what is served, the
  // trash); lfdln's site folders and their trash
  website: { root: string; public: string; trash: string };
  mail?: { from: string; fromName: string; replyTo: string; notifyTo: string };
  apps?: { state: string };    // the software helper's own record (/var/lib/pammy-apps)
  services: {
    panel: { host: string; port: number };
    // cookie: the visitor cookie's name (docs/accounts-plan.md step 3): __Host-pammy_visitor when not given
    gate?: { host: string; port: number; snapshot: string; cookie?: string };
    pg: { host: string; port: number; database: string };
    // services: the services helper (docs/adopt-plan.md V7), lfdln-services.socket
    // mailVisitor: the mail service's second door, the gate's, for the fixed visitor
    // emails only (docs/accounts-plan.md step 4); without it, emailed links can't go on
    // pammydbGate: the database helper's door for the gate, row ops only (S2, docs/s2-plan.md);
    // pammydb is the panel's, every op
    sockets: { sitefs: string; gateAdmin?: string; thumbs?: string; pammydb?: string; pammydbGate?: string; apps?: string; mail?: string; mailVisitor?: string; routes?: string; services?: string; projects?: string };
    // where the Studio's engines answer, for the database logins it makes (shown with a new
    // password); the helper's own config is its site's (docs/phase8-plan.md 8-4)
    studioPorts?: { postgres?: number; mariadb?: number };
    // what every login the Studio makes starts with, where the engine admits only those (lfdln: db_)
    studioUserPrefix?: string;
    mediaPublic?: string;      // the media API's index and thumbnails (read by the gate)
    tutorialExamples?: string;
    phpRun?: string;           // the PHP pool's sockets (fpm.sock, and pammy.org's examples.sock)
    mailSettings?: string;
    wordpressPlacement?: string;
    trashDays: number;
  };
};

// The glossary (docs/adapters-plan.md A7): the few words the two sites say differently.
// pammy.org's are Pamela's, lfdln's plainly technical (platform plan D4). The pages take
// them from SITE.words; the full pass over every page is phase 8, a module at a time.
export type Words = {
  app: { one: string; a: string; many: string };   // a database's pages in the panel: "app", "an app", "apps"
  // the files the panel looks after: "Website" (a title), "your website", "the top of your website"
  website: { title: string; your: string; top: string };
  explain: boolean;                     // the lines that explain a technical word ("A database is a tidy place for lists")
  // someone who can do everything, accounts too (docs/permissions-plan.md R1): "account manager" / "admin"
  admin: { one: string; a: string; many: string };
};

// What links into Help are about, and the guide (its address under /help/, with a #part or
// /part-N if wanted) each site has for one.
export const GUIDE_TOPICS = ['forms', 'form-or-database', 'comments', 'databases', 'database-users', 'media-api', 'access', 'hosts'] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number];
// firstSteps (docs/phase9-plan.md 9-3): a first-steps card on Home, and the guide it asks
// everyone to read first (its address under /help/)
export type HelpFacts = { intro: string; searchExample: string; topics: Partial<Record<GuideTopic, string>>; firstSteps?: { read: string } };

// What the pages are told at build time (sites/<name>/web/vite.config.ts): no paths, users
// or ports, only what they say and link to.
export type SiteFacts = Pick<SiteProfile, 'domain' | 'panelOrigin' | 'name' | 'panelName' | 'front' | 'folderSubdomains' | 'modules' | 'uploads' | 'words' | 'help'>
  & { owner?: { user: string; name: string }; mail?: Pick<NonNullable<SiteProfile['mail']>, 'from' | 'replyTo' | 'notifyTo'>; studioPorts?: { postgres?: number; mariadb?: number }; studioUserPrefix?: string };

export function siteFacts(p: SiteProfile): SiteFacts {
  return {
    domain: p.domain, panelOrigin: p.panelOrigin, name: p.name, panelName: p.panelName, front: p.front,
    folderSubdomains: p.folderSubdomains, modules: p.modules, uploads: { maxBytes: p.uploads.maxBytes }, words: p.words,
    ...(p.help && { help: p.help }),
    ...(p.owner && { owner: { user: p.owner.user, name: p.owner.name } }),
    ...(p.mail && { mail: { from: p.mail.from, replyTo: p.mail.replyTo, notifyTo: p.mail.notifyTo } }),
    ...(p.services.studioPorts && { studioPorts: p.services.studioPorts }),
    ...(p.services.studioUserPrefix && { studioUserPrefix: p.services.studioUserPrefix }),
  };
}

// "100 MB": the upload limit as the panel's words say it
export const sizeWords = (bytes: number) => `${Math.floor(bytes / (1024 * 1024))} MB`;

// A fact a module needs, from code that only runs with the module on (checkFacts made sure).
export function fact<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`the site's profile has no ${what}`);
  return v;
}

export const isOn = (p: { modules: readonly Module[] }, m: Module | 'core') => m === 'core' || p.modules.includes(m);
