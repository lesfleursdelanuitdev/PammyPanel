// What the signed-in person may open (docs/permissions-plan.md R4-R5): the web's
// side of core/src/panel/rights.ts. /api/session sends the parts they have
// (every one for an account manager, already narrowed for a person kept to
// places); the server refuses the rest whatever the page shows.
import { isOn, SITE } from './site';
import type { Me } from './types';

// The parts of the panel (the server's list, core/src/panel/rights.ts: the web
// can't import it, so test/routes.test.ts keeps the two the same).
export const RIGHTS = ['files', 'media', 'subdomains', 'forms', 'responses', 'comments', 'protected', 'databases', 'programs', 'software', 'examples', 'hosts', 'services', 'visitor-settings', 'monitoring', 'projects'] as const;
export type Right = (typeof RIGHTS)[number];
// A part of the panel, or only an account manager, or anyone signed in.
export type PageNeeds = Right | 'admin' | 'signed-in';
// Kept to places: sees only them, in every part it has.
export const isKept = (me: Me) => me.places.length > 0;
// their website places as folder names ("olivia"); installed software's files are places
// too ("software:blog", docs/catalog-plan.md step 3b), never a folder
export const placeFolders = (me: Me) => me.places.filter((p) => p.startsWith('/')).map((p) => p.slice(1));
// every place as people read it: "olivia", "blog files"
export const placeWords = (me: Me) => me.places.map((p) => (p.startsWith('/') ? p.slice(1) : `${p.slice('software:'.length)} files`));
// wholeSite: about the whole website, never one place, so not for a person kept to places
export const may = (me: Me, needs: PageNeeds, wholeSite = false) =>
  !(wholeSite && isKept(me)) && (needs === 'signed-in' || (needs === 'admin' ? me.role === 'manager' : me.rights.includes(needs)));

// Each part as the Accounts page names it, what it covers, and the module that
// brings it (a site without that module has no such part to give).
export const RIGHT_WORDS: Record<Right, { label: string; about: string; module: string }> = {
  files: { label: 'File Explorer', about: 'Files, the editor, tags and categories', module: 'files' },
  media: { label: 'Media', about: `Pictures and other media${isOn('examples') ? ', and the media examples' : ''}`, module: 'media' },
  subdomains: { label: 'Subdomains', about: 'The folders at the top of the website and their temporary pages', module: 'files' },
  forms: { label: 'Forms', about: `Forms and the form builder${isOn('examples') ? ', and the form examples' : ''}`, module: 'forms' },
  responses: { label: 'Responses', about: 'What people sent with the forms', module: 'forms' },
  comments: { label: 'Comments', about: 'Comment areas and the comments waiting', module: 'comments' },
  // on a site with hosts, visitors' accounts are on routes: no protected folders (lfdln)
  protected: isOn('hosts')
    ? { label: 'Visitors', about: "People and Requests: the visitors' accounts on the sites", module: 'areas' }
    : { label: 'Protected folders', about: 'Protected folders, People and Requests', module: 'areas' },
  databases: { label: 'Databases', about: 'Databases, their logins, tables and apps, and forms saved into them', module: 'studio' },
  programs: { label: 'API keys', about: 'Letting programs read forms, media and data', module: 'api-keys' },
  software: { label: 'Installed software', about: 'WordPress and the Email settings', module: 'apps' },
  examples: { label: 'Examples', about: 'Setting up and resetting the database and tutorial examples', module: 'examples' },
  hosts: { label: 'Hosts', about: 'Hosts, their routes, and the site folders they show', module: 'hosts' },
  'visitor-settings': { label: 'Visitor settings', about: 'What visitors may do for themselves: register, emailed links, their own password and account', module: 'settings' },
  monitoring: { label: 'Monitoring', about: 'What is checked every 5 minutes, what is down, and its history', module: 'monitoring' },
  services: { label: 'Services', about: 'What runs on the server (TutorStar, the Gonsalves apps): start, stop, restart, logs', module: 'services' },
  projects: { label: 'Projects', about: 'Making, building and deploying projects (React, Vue, Svelte, Lit, Next.js, Laravel)', module: 'projects' },
};

// The parts this site has to give: its module on, and Subdomains only where a folder is also
// a subdomain (pammy.org; lfdln's names come from Hosts)
export const partOn = (r: Right) => isOn(RIGHT_WORDS[r].module) && (r !== 'subdomains' || SITE.folderSubdomains);

// The parts a person kept to places can have (the server's PLACE_RIGHTS): the
// others can't tell which place a thing is in yet.
export const PLACE_RIGHTS: readonly Right[] = ['files', 'media', 'subdomains', 'forms', 'responses', 'comments', 'protected', 'hosts'];
