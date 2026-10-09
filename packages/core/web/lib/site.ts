// The website this panel looks after, as the site's profile describes it
// (sites/<name>/src/profile.ts, handed to the pages at build time by the site's
// vite.config.ts, which checks it against this type). Every "pammy.org" the pages
// say comes from here.

// the core's SiteFacts (packages/core/src/profile.ts), as the pages see them
export type Site = {
  domain: string;             // pammy.org
  panelOrigin: string;        // https://panel.pammy.org
  name: string;               // "pammy.org"
  panelName: string;          // "pammy.org panel"
  front: 'cloudflare' | 'direct';
  folderSubdomains: boolean;
  modules: readonly string[];
  owner?: { user: string; name: string };
  mail?: { from: string; replyTo: string; notifyTo: string };
  uploads: { maxBytes: number };
  studioPorts?: { postgres?: number; mariadb?: number };    // where the Studio's engines answer
  studioUserPrefix?: string;  // what its logins start with, where there is one (lfdln: db_)
  words: Words;
  // the Help page's words, and which guide each topic of a link into Help is (docs/phase9-plan.md 9-1)
  // firstSteps: the first-steps card on Home, and the guide it asks everyone to read (9-3)
  help?: { intro: string; searchExample: string; topics: Partial<Record<GuideTopic, string>>; firstSteps?: { read: string } };
};
// what links into Help are about (packages/core/src/profile.ts GUIDE_TOPICS)
export type GuideTopic = 'forms' | 'form-or-database' | 'comments' | 'databases' | 'database-users' | 'media-api' | 'access' | 'hosts';
// the glossary (docs/adapters-plan.md A7), as packages/core/src/profile.ts has it
export type Words = {
  app: { one: string; a: string; many: string };
  website: { title: string; your: string; top: string };
  explain: boolean;
  admin: { one: string; a: string; many: string };
};

declare const __PANEL_SITE__: Site;
export const SITE: Site = __PANEL_SITE__;
// the site's words: `the ${W.app.one}`; cap() for the start of a sentence or a label
export const W: Words = SITE.words;
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
// "100 MB"
export const sizeWords = (bytes: number) => `${Math.floor(bytes / (1024 * 1024))} MB`;
export const isOn = (m: string) => m === 'core' || SITE.modules.includes(m);
// The site's guide about a topic, as an address ("/help/forms"), or null: Help is off, or the
// site has no guide about it, and the page shows no link.
export const guideTo = (topic: GuideTopic): string | null => {
  const at = isOn('help') ? SITE.help?.topics[topic] : undefined;
  return at ? `/help/${at}` : null;
};

// Where her pages are, as the panel's pages link to them: the domain, or, while
// the panel runs on another address (the browser tests), the address it runs on.
export const SITE_ORIGIN = location.hostname === new URL(SITE.panelOrigin).hostname
  ? `https://${SITE.domain}` : location.origin.replace('//panel.', '//');
