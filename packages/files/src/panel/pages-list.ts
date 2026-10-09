// Which addresses are pages of the panel, and where signing in goes next.
// Keep in step with the routes in web/src/App.tsx.
export const PAGE_PATHS = [
  '/', '/subdomains', '/protected-folders', '/access/:id', '/access/:id/:tab', '/people', '/requests', '/visitor-settings', '/forms', '/forms/new', '/forms/:id', '/forms/:id/database', '/responses', '/comments', '/files', '/files/edit', '/media',
  '/tags', '/media/tags', '/media/folders', '/media/examples', '/media/examples/:kind', '/examples', '/examples/:kind',
  '/databases', '/databases/users', '/databases/users/:engine/:user', '/databases/examples', '/databases/examples/:kind', '/databases/tutorial-examples',
  '/databases/:engine/:name', '/databases/:engine/:name/canvas', '/databases/:engine/:name/tables/:table', '/databases/:engine/:name/review',
  '/databases/:engine/:name/app', '/databases/:engine/:name/app/:table', '/databases/:engine/:name/programs',
  '/app/:engine/:name/:table', '/app/:engine/:name/:table/new', '/app/:engine/:name/:table/edit',
  '/software', '/software/new', '/software/:id', '/email', '/hosts', '/hosts/add-domain', '/services', '/backups', '/catalog', '/catalog/:service/:resource', '/monitoring', '/projects', '/projects/git-tokens', '/projects/:id/packages',
  '/api-keys', '/passkeys', '/accounts', '/activity', '/help', '/help/:guide', '/help/:guide/:section', '/getting-started',
];

// After signing in: back to a panel page, never somewhere else.
export function nextPage(next: unknown): string {
  if (typeof next !== 'string' || next.length > 500) return '/';
  return /^\/(?![/\\])[^\s\\]*$/.test(next) && !/^\/(login|invite|api|assets)\b/.test(next) ? next : '/';
}
