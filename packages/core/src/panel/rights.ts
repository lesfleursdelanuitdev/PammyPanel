// What a route needs, and who has it (docs/permissions-plan.md R2-R5).
//
// Every /api route of the panel says what it needs in its Fastify config,
// `{ config: { needs: 'forms' } }`, and need() (context.ts) reads it there. So the
// answer sits beside the route itself, and test/routes.snapshot.txt lists it for
// every route with who that lets in.
//
// What each person has is kept per person in the database (step 2): their rights
// (panel.user_rights) and the places they are kept to (panel.user_places),
// loaded with their session (sessions.ts). Account managers (admins) have
// every right and no places.

// The parts of the panel a person can be given (R2). Not the packages: a route
// belongs to the part a person would say it is in. (The web has the same list,
// core/web/lib/rights.ts; test/routes.test.ts keeps the two the same.)
export const RIGHTS = ['files', 'media', 'subdomains', 'forms', 'responses', 'comments', 'protected', 'databases', 'programs', 'software', 'examples', 'hosts', 'services', 'visitor-settings', 'monitoring', 'projects'] as const;
export type Right = (typeof RIGHTS)[number];
export const isRight = (v: unknown): v is Right => typeof v === 'string' && (RIGHTS as readonly string[]).includes(v);

// A right; or anyone signed in (their own passkeys, Help, their own Activity);
// or only an admin (accounts); or no one needs to be signed in at all.
export type Needs = Right | 'signed-in' | 'admin' | 'public';

declare module 'fastify' {
  interface FastifyContextConfig {
    needs?: Needs;
    // About the whole website, never about one place (the list of her folders,
    // the form examples, where a form works): not for a person kept to places,
    // whatever their rights (R5).
    wholeSite?: true;
  }
}

// The parts that can tell which place a thing belongs to, and so show a person
// with places only their places (R5, Q3). A person with places can't be given
// any other part (accounts.ts refuses it), and reaches none of them if one were
// written: databases, programs, software and examples can't tell yet
// (databases get hosts in phase 8). services is about the whole server, never
// one host (docs/adopt-plan.md V8).
export const PLACE_RIGHTS: readonly Right[] = ['files', 'media', 'subdomains', 'forms', 'responses', 'comments', 'protected', 'hosts'];

// What members reached before rights were kept per person, which the core's
// migration 0001 wrote down for them (R8).
export const MEMBER_RIGHTS: readonly Right[] = ['files', 'media', 'subdomains', 'forms', 'responses', 'comments', 'protected'];

export type Who = { role: 'manager' | 'member'; rights: readonly Right[]; places: readonly string[] };
export const isAdmin = (u: Pick<Who, 'role'>) => u.role === 'manager';
// Kept to places: sees only them, in every part it has.
export const isKept = (u: Pick<Who, 'places'>) => u.places.length > 0;
// A place is a website folder ("/olivia") or an installed software's files
// ("software:blog", docs/catalog-plan.md step 3b). The website's parts -- and the gate --
// only ever see the first kind.
export const SOFTWARE_PLACE_RE = /^software:([a-z0-9][a-z0-9-]{0,39})$/;
export const isWebsitePlace = (p: string) => p.startsWith('/');
export const websitePlaces = (u: Pick<Who, 'places'>) => u.places.filter(isWebsitePlace);
export const softwareOfPlaces = (u: Pick<Who, 'places'>) => u.places.map((p) => SOFTWARE_PLACE_RE.exec(p)?.[1]).filter((x): x is string => !!x);
// Kept only to software (QP1): File Explorer is all there is for them.
export const SOFTWARE_ONLY_RIGHTS: readonly Right[] = ['files'];
const softwareOnly = (u: Pick<Who, 'places'>) => isKept(u) && websitePlaces(u).length === 0;

// The parts this person can use.
export const rightsOf = (u: Who): readonly Right[] =>
  isAdmin(u) ? RIGHTS : u.rights.filter((r) => !isKept(u) || (softwareOnly(u) ? SOFTWARE_ONLY_RIGHTS : PLACE_RIGHTS).includes(r));

// May this person use a route that needs this?
export function mayUse(u: Who, needs: Needs, wholeSite = false): boolean {
  if (needs === 'public') return true;
  if (wholeSite && isKept(u)) return false;
  if (needs === 'signed-in') return true;
  if (needs === 'admin') return isAdmin(u);
  return rightsOf(u).includes(needs);
}

// The website places a person is kept to, or null for the whole site: what the panel
// sends the gate with each forms request (packages/gate/src/admin.ts). Someone kept only
// to software has none: [] (never null, which would be the whole site); they have no
// right that asks the gate (QP1), and an empty list reaches nothing where it is used.
export const keptTo = (u: Pick<Who, 'places'>): readonly string[] | null => (isKept(u) ? websitePlaces(u) : null);

// Is this path of her website ("olivia/menu", no leading slash) in one of these
// places ("/olivia")? null: the whole site, so yes.
export const inPlaces = (places: readonly string[] | null, path: string) =>
  places === null || places.some((p) => path === p.slice(1) || path.startsWith(`${p.slice(1)}/`));
