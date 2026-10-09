// The kinds of software the panel knows (docs/apps-plan.md G9). v1 has one,
// WordPress (A5); a second is a new entry here and its tests, not a rewrite.
//
// Phase 1 needs only what a kind looks like from outside: its name, where its
// version is written, and what counts as "answering". Install, update and backup
// steps join the entry in the phases that use them.

export type KindInfo = {
  name: string;                       // what she sees: "WordPress"
  // a file under its files, and the pattern that finds the version in it
  version: { file: string; pattern: RegExp };
  // an answer to a plain GET of its address that means "it is up": WordPress
  // sends 200, or a redirect to its own address (http -> https, a trailing slash)
  answers: (status: number) => boolean;
  // where its own admin pages are, under its address ("Sign in to its admin")
  admin: string;
};

export const CATALOG = {
  wordpress: {
    name: 'WordPress',
    version: { file: 'wp-includes/version.php', pattern: /^\$wp_version\s*=\s*'([0-9][0-9A-Za-z.-]{0,30})';/m },
    answers: (status: number) => status >= 200 && status < 400,
    admin: 'wp-admin/',
  },
} satisfies Record<string, KindInfo>;

export type Kind = keyof typeof CATALOG;

export const isKind = (v: unknown): v is Kind => typeof v === 'string' && Object.hasOwn(CATALOG, v);
