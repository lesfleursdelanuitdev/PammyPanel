import { useInfiniteQuery } from '@tanstack/react-query';
import { ChevronsDown } from 'lucide-react';
import { Empty, List, Loading, Page, Section } from '../components/page';
import { Button } from '../components/ui/button';
import { usePageTitle } from '../hooks/useApi';
import { api, formatTime } from '../lib/api';
import { W } from '../lib/site';
import type { ActivityEntry } from '../lib/types';

// How each entry reads: "<who> <sentence>". target is what it happened to.
const quoted = (s: string | null) => `"${s}"`;
const forOther = (e: ActivityEntry) => (e.target && e.target !== e.actor_label ? ` for ${e.target}` : '');
const paren = (s: string | null) => (s ? ` (${s})` : '');
// The studio writes its target as "Postgres: blog" (src/app.ts); read as "blog on Postgres".
const onEngine = (s: string | null) => {
  const m = /^(Postgres|MariaDB): (.+)$/.exec(s ?? '');
  return m ? `${m[2]} on ${m[1]}` : (s ?? '');
};
const ACTIONS: Record<string, (e: ActivityEntry) => string> = {
  'login': (e) => `signed in${paren(e.detail)}`,
  'login-failed': () => 'failed to sign in',
  'logout': () => 'signed out',
  'confirm-failed': () => 'failed a passkey check',
  'passkey-added': (e) => `added a passkey${forOther(e)}${paren(e.detail)}`,
  'passkey-renamed': (e) => `renamed a passkey${forOther(e)}${e.detail ? ` to ${quoted(e.detail)}` : ''}`,
  'passkey-removed': (e) => `removed a passkey${forOther(e)}${paren(e.detail)}`,
  'session-revoked': (e) => `signed out another browser${forOther(e)}`,
  'sessions-revoked': (e) => `signed ${e.target} out everywhere`,
  'invite-created': (e) => `created a setup link for ${e.target} (valid 24 hours)`,
  'invite-used': () => 'used their setup link',
  'invite-cancelled': (e) => `cancelled the setup link for ${e.target}`,
  'user-created': (e) => `added the account ${e.target}${paren(e.detail)}`,
  'user-disabled': (e) => `switched off the account ${e.target}`,
  'user-enabled': (e) => `switched on the account ${e.target}`,
  'user-role-changed': (e) => `made ${e.target} ${e.detail === 'now an account manager' ? W.admin.a : `no longer ${W.admin.a}`}`,
  'subdomain-created': (e) => `created the subdomain ${e.target}${paren(e.detail)}`,
  // installed software (docs/apps-plan.md phase 2); target is its id, like "blog"
  'software-backup': (e) => `started a backup of WordPress${paren(e.target)}`,
  'software-restore': (e) => `put back ${e.detail ?? 'a backup'} of WordPress${paren(e.target)}`,
  'software-backup-downloaded': (e) => `downloaded ${e.detail ?? 'a backup'} of WordPress${paren(e.target)}`,
  'software-install': (e) => `installed a new WordPress, "${e.target}"${e.detail ? `, ${e.detail}` : ''}`,
  'software-delete': (e) => `deleted the WordPress "${e.target}" (kept 30 days)`,
  'software-undelete': (e) => `restored the deleted WordPress "${e.target}"`,
  'software-purge': (e) => `deleted the WordPress "${e.target}" for good${e.detail ? ` (${e.detail})` : ''}`,
  'software-move': (e) => `moved WordPress${paren(e.target)} ${e.detail ?? ''}`.trimEnd(),
  'software-offline': (e) => `took WordPress${paren(e.target)} offline`,
  'software-online': (e) => `put WordPress${paren(e.target)} online again`,
  'mail-settings-changed': (e) => `changed how email is sent${paren(e.detail)}`,
  'mail-notices-changed': (e) => `changed which emails the panel sends${paren(e.detail)}`,
  'mail-test': (e) => `sent a test email to ${e.target}${paren(e.detail)}`,
  'software-admin-password': (e) => `made a new WordPress admin password${paren(e.detail)}`,
  'home-page-made': (e) => `put a temporary home page in ${quoted(e.target)}${paren(e.detail)}`,
  'home-page-changed': (e) => `changed the temporary home page in ${quoted(e.target)}${paren(e.detail)}`,
  'home-page-removed': (e) => `removed the temporary home page from ${quoted(e.target)}`,
  'folder-trashed': (e) => `moved ${quoted(e.target)} to the trash${paren(e.detail)}`,
  'folder-restored': (e) => `restored ${quoted(e.target)}${paren(e.detail)}`,
  'trash-purged': (e) => `deleted ${quoted(e.target)} for good${paren(e.detail)}`,
  'folder-protected': (e) => `protected ${quoted(e.target)}${paren(e.detail)}`,
  'folder-unprotected': (e) => `stopped protecting ${quoted(e.target)}`,
  'protection-followed': (e) => `kept ${quoted(e.target)} protected${paren(e.detail)}`,
  'access-granted': (e) => `let ${e.detail} open ${quoted(e.target)}`,
  'access-removed': (e) => `stopped ${e.detail} opening ${quoted(e.target)}`,
  // the Access page (docs/roles-plan.md step 4)
  'roles-copied': (e) => `gave ${quoted(e.target)} roles of its own${paren(e.detail)}`,
  'roles-reset': (e) => `put ${quoted(e.target)} back on the built-in roles${paren(e.detail)}`,
  'privileges-changed': (e) => `changed the privileges of ${quoted(e.target)}${paren(e.detail)}`,
  'group-saved': (e) => `saved a group of privileges in ${quoted(e.target)}${paren(e.detail)}`,
  'group-removed': (e) => `removed a group of privileges from ${quoted(e.target)}${paren(e.detail)}`,
  'role-saved': (e) => `saved the role ${e.detail ?? ''} in ${quoted(e.target)}`,
  'role-removed': (e) => `removed the role ${e.detail ?? ''} from ${quoted(e.target)}`,
  'roles-slot': (e) => `changed who counts as what in ${quoted(e.target)}${paren(e.detail)}`,
  'roles-never': (e) => `changed which roles go together in ${quoted(e.target)}${paren(e.detail)}`,
  'person-role': (e) => `gave ${e.detail ?? 'someone'} a role in ${quoted(e.target)}`,
  'person-role-removed': (e) => `took ${e.detail ?? 'someone'}'s role in ${quoted(e.target)} away`,
  'manifest-read': (e) => `read pammy-panel.json for ${quoted(e.target)}${paren(e.detail)}`,
  'person-added': (e) => `added the person ${e.target}${paren(e.detail)}`,
  'person-password-changed': (e) => `gave ${e.target} a new password${paren(e.detail)}`,
  'person-switched-off': (e) => `switched off ${e.target}`,
  'person-switched-on': (e) => `switched on ${e.target}`,
  'person-renamed': (e) => `renamed ${e.target}${paren(e.detail)}`,
  'person-signed-out': (e) => `signed ${e.target} out everywhere`,
  'person-removed': (e) => `removed ${e.target}`,
  'person-contact-changed': (e) => `changed how to reach ${e.target}`,
  'person-link-created': (e) => `made a setup link for ${e.target}${paren(e.detail)}`,
  'person-link-cancelled': (e) => `cancelled the setup link for ${e.target}`,
  'person-reset-link-sent': (e) => `emailed ${e.target} a link to choose a new password`,
  'person-confirm-link-sent': (e) => `emailed ${e.target} their confirmation link again`,
  'signin-pages-added': (e) => `added starter sign-in pages to ${quoted(e.target)}${paren(e.detail)}`,
  'requests-opened': (e) => `let people ask for access to ${quoted(e.target)}`,
  'requests-closed': (e) => `stopped taking requests for ${quoted(e.target)}`,
  'request-approved': (e) => `approved a request to open ${quoted(e.target)}${paren(e.detail)}`,
  'request-declined': (e) => `declined ${e.target}'s request${e.detail ? ` to open ${quoted(e.detail)}` : ''}`,
  'reset-request-dismissed': (e) => `dismissed ${e.target}'s forgot-password request`,
  'request-deleted': (e) => `deleted a request from ${e.target} as junk`,
  'visitor-setting-on': (e) => `turned on the visitor setting ${quoted(e.target)}${paren(e.detail)}`,
  'visitor-setting-off': (e) => `turned off the visitor setting ${quoted(e.target)}${paren(e.detail)}`,
  'form-created': (e) => `made the form ${quoted(e.target)}${paren(e.detail)}`,
  'form-saved': (e) => `saved changes to the form ${quoted(e.target)}`,
  'form-duplicated': (e) => `made the form ${quoted(e.target)}${paren(e.detail)}`,
  'form-switched': (e) => `changed the form ${quoted(e.target)}${paren(e.detail)}`,
  'form-linked': (e) => `set the form ${quoted(e.target)} to save its answers in a database${paren(e.detail)}`,
  'form-unlinked': (e) => `stopped the form ${quoted(e.target)} saving its answers in a database`,
  'form-earlier-saved': (e) => `saved the earlier answers of the form ${quoted(e.target)} in its database${paren(e.detail)}`,
  'comments-switched-on': (e) => `set up comments in ${e.target}${paren(e.detail)}`,
  'form-trashed': (e) => `moved the form ${quoted(e.target)} to the trash${paren(e.detail)}`,
  'form-restored': (e) => `brought the form ${quoted(e.target)} back from the trash`,
  'example-reset': (e) => `put the example ${quoted(e.target)} back as it was${paren(e.detail)}`,
  'example-installed': (e) => `put an example page on the website at ${quoted(e.target)}${paren(e.detail)}`,
  'response-approved': (e) => `approved a response to ${quoted(e.target)}${paren(e.detail)}`,
  'response-unapproved': (e) => `took approval off a response to ${quoted(e.target)}${paren(e.detail)}`,
  'responses-unapproved': (e) => `took approval off responses to ${quoted(e.target)}${paren(e.detail)}`,
  'api-key-created': (e) => `made the API key ${quoted(e.target)}${paren(e.detail)}`,
  'api-key-revoked': (e) => `revoked the API key ${quoted(e.target)}${paren(e.detail)}`,
  'response-trashed': (e) => `moved a response to ${quoted(e.target)} to the trash${paren(e.detail)}`,
  'response-restored': (e) => `restored a response to ${quoted(e.target)}${paren(e.detail)}`,
  'media-folder-made': (e) => `made a media folder in ${e.target === 'the main site' ? e.target : quoted(e.target)}${paren(e.detail)}`,
  'media-uploaded': (e) => `uploaded ${e.target}${paren(e.detail)}`,
  'media-bucket-made': (e) => `made the media folder ${e.target}`,
  'media-copied': (e) => `copied ${e.target}${paren(e.detail)}`,
  'media-moved': (e) => `moved ${e.target}${paren(e.detail)}`,
  'media-renamed': (e) => `renamed ${e.target}${paren(e.detail)}`,
  'media-trashed': (e) => `moved ${e.target} to the trash${paren(e.detail)}`,
  'media-photos-renamed': (e) => `renamed photos to images in the media folders of ${e.target}${paren(e.detail)}`,
  'media-restored': (e) => `restored ${e.target}${paren(e.detail)}`,
  'media-synced': (e) => `checked the media folders for changes${paren(e.detail)}`,
  'media-labels-changed': (e) => `changed the tags and categories of ${e.target}${paren(e.detail)}`,
  'media-tag-made': (e) => `made the tag ${e.target}`,
  'media-tag-renamed': (e) => `renamed the tag ${e.target}${paren(e.detail)}`,
  'media-tag-deleted': (e) => `deleted the tag ${e.target}${paren(e.detail)}`,
  'media-category-made': (e) => `made the category ${e.target}`,
  'media-category-renamed': (e) => `renamed the category ${e.target}${paren(e.detail)}`,
  'media-category-deleted': (e) => `deleted the category ${e.target}${paren(e.detail)}`,
  'media-label-public': (e) => `let anyone list the files with ${e.target}`,
  'media-label-private': (e) => `stopped letting anyone list the files with ${e.target}`,
  'media-details-changed': (e) => `changed the title and description of ${e.target}`,
  'media-example-installed': (e) => `put a media example page on the website at ${quoted(e.target)}${paren(e.detail)}`,
  'media-scope-made': (e) => `started using ${quoted(e.target)} as a tag scope`,
  'media-scope-removed': (e) => `stopped using ${quoted(e.target)} as a tag scope`,
  'file-uploaded': (e) => `uploaded ${e.target}${paren(e.detail)}`,
  'file-folder-made': (e) => `made the folder ${e.target}`,
  'file-copied': (e) => `copied ${e.target}${paren(e.detail)}`,
  'file-moved': (e) => `moved ${e.target}${paren(e.detail)}`,
  'file-renamed': (e) => `renamed ${e.target}${paren(e.detail)}`,
  'file-trashed': (e) => `moved ${e.target} to the trash${paren(e.detail)}`,
  'file-restored': (e) => `restored ${e.target}${paren(e.detail)}`,
  'file-created': (e) => `made ${e.target} in the editor`,
  'file-saved': (e) => `changed ${e.target} in the editor`,
  'file-version-restored': (e) => `put back an earlier version of ${e.target}${paren(e.detail)}`,
  'user-scope-changed': (e) => `changed what ${e.target} sees${paren(e.detail)}`,
  'user-rights-changed': (e) => `changed what ${e.target} can use${paren(e.detail)}`,
  'user-places-changed': (e) => `changed where ${e.target} works${paren(e.detail)}`,
  // hosts, routes and site folders (lfdln, docs/hosts-plan.md)
  'host-created': (e) => `made the host ${e.target}`,
  'host-started': (e) => `switched on the host ${e.target}`,
  'host-stopped': (e) => `switched off the host ${e.target}`,
  'host-deleted': (e) => `deleted the host ${e.target}${paren(e.detail)}`,
  'domain-added': (e) => `added the domain ${e.target}${paren(e.detail)}`,
  'domain-removed': (e) => `removed the domain ${e.target}`,
  'monitoring-quiet': (e) => `made ${e.target} quiet for maintenance${paren(e.detail)}`,
  'monitoring-quiet-ended': (e) => `ended the quiet for ${e.target}`,
  'monitoring-mail-on': () => 'turned monitoring emails on',
  'monitoring-mail-off': () => 'turned monitoring emails off',
  'monitoring-record-kept': (e) => `kept the DNS record ${e.target} as it is now (monitoring)`,
  'route-created': (e) => `added a route at ${e.target}${paren(e.detail)}`,
  'route-changed': (e) => `changed the route at ${e.target}${paren(e.detail)}`,
  'route-deleted': (e) => `removed the route at ${e.target}`,
  'route-accounts': (e) => `set accounts on ${e.target}: ${e.detail ?? ''}`,
  'site-folder-created': (e) => `made the site folder ${e.target}${paren(e.detail)}`,
  'site-folder-changed': (e) => `changed the site folder ${e.target}${paren(e.detail)}`,
  'site-folder-deleted': (e) => `put the site folder ${e.target} in the trash${paren(e.detail)}`,
  'site-folder-adopted': (e) => `took in the site folder ${e.target}${paren(e.detail)}`,
  'host-taken-over': (e) => `took over ${e.target} from its hand-written nginx file${paren(e.detail)}`,
  'host-given-back': (e) => `gave ${e.target} back to its hand-written nginx file${paren(e.detail)}`,
  // services (lfdln, docs/adopt-plan.md V9)
  'service-started': (e) => `started ${e.target}${paren(e.detail)}`,
  'service-stopped': (e) => `stopped ${e.target}${paren(e.detail)}`,
  'service-restarted': (e) => `restarted ${e.target}${paren(e.detail)}`,
  // projects (lfdln, docs/phase8b-plan.md 8b-2): asked for; the job's own log says how it went
  'project-created': (e) => `made the project ${e.target}${paren(e.detail)}`,
  'project-built': (e) => `rebuilt the project ${e.target}${paren(e.detail)}`,
  'project-rolled-back': (e) => `put an earlier release of ${e.target} live${paren(e.detail)}`,
  'project-deleted': (e) => `deleted the project ${e.target}${paren(e.detail)}`,
  // 8b-3: git and the dev branch
  'project-dev-live': (e) => `put ${e.target}'s dev branch live${paren(e.detail)}`,
  'project-dev-on': (e) => `turned on ${e.target}'s dev branch${paren(e.detail)}`,
  'project-dev-off': (e) => `turned off ${e.target}'s dev branch${paren(e.detail)}`,
  // 8b-4a: a project's server
  'project-start': (e) => `started ${e.target}'s server${paren(e.detail)}`,
  'project-stop': (e) => `stopped ${e.target}'s server${paren(e.detail)}`,
  'project-restart': (e) => `restarted ${e.target}'s server${paren(e.detail)}`,
  'project-env-set': (e) => `set a variable in ${e.target}'s environment${paren(e.detail)}`,
  'project-env-removed': (e) => `removed a variable from ${e.target}'s environment${paren(e.detail)}`,
  'project-env-shown': (e) => `showed the values of ${e.target}'s environment${paren(e.detail)}`,
  'project-database': (e) => `gave ${e.target} a database${paren(e.detail)}`,
  'project-database-shared': (e) => `let ${e.target}'s dev branch use the live database${paren(e.detail)}`,
  'project-database-unshared': (e) => `stopped ${e.target}'s dev branch using the live database${paren(e.detail)}`,
  'project-packages': (e) => `changed ${e.target}'s packages${paren(e.detail)}`,
  'project-script': (e) => `ran a script of ${e.target}'s${paren(e.detail)}`,
  'project-auto-update-on': (e) => `had ${e.target}'s packages updated each night`,
  'project-auto-update-off': (e) => `stopped ${e.target}'s packages being updated each night`,
  'project-owners': (e) => `changed who owns the project ${e.target}${paren(e.detail)}`,
  // git over HTTPS (docs/phase8b-plan.md 8b-7): never the token itself
  'git-token-made': (e) => `made a git token, "${e.target}"${paren(e.detail)}`,
  'git-token-revoked': (e) => `revoked their git token "${e.target}"`,
  // Settings > Backups (docs/lfdln-mariadb-plan.md B3)
  'backup-days-changed': (e) => `chose to keep the database backups ${e.target}${paren(e.detail)}`,
  'backups-pruned': (e) => `deleted ${e.target}${paren(e.detail)}`,
  'form-scope-changed': (e) => `changed where the form ${quoted(e.target)} works${paren(e.detail)}`,
  // databases (guide 14). Never one per record she adds or changes: only the
  // shape of things, switching on and off, and the ways in (databases-plan C15).
  'database-created': (e) => `made the database ${onEngine(e.target)}${paren(e.detail)}`,
  'database-example-set-up': (e) => `set up the example database ${onEngine(e.target)}${paren(e.detail)}`,
  'database-example-reset': (e) => `put the example database ${onEngine(e.target)} back as it was${paren(e.detail)}`,
  'database-example-copied': (e) => `made the database ${onEngine(e.target)}${paren(e.detail)}`,
  // docs/tutorial-examples-plan.md
  'tutorial-examples-set-up': (e) => `set up the tutorial examples${paren(e.detail)}`,
  'tutorial-examples-reset': (e) => `put the tutorial examples back as they were${paren(e.detail)}`,
  'database-renamed': (e) => `changed the ${W.app.one} name for the database ${onEngine(e.target)}${paren(e.detail)}`,
  'database-adopted': (e) => `started looking after the database ${onEngine(e.target)}${paren(e.detail)}`,
  'database-unmanaged': (e) => `stopped looking after the database ${onEngine(e.target)}${paren(e.detail)}`,
  'database-deleted': (e) => `deleted the database ${onEngine(e.target)}${paren(e.detail)}`,
  'db-user-created': (e) => `made the database login ${onEngine(e.target)}${paren(e.detail)}`,
  'db-user-password-reset': (e) => `gave the database login ${onEngine(e.target)} a new password${paren(e.detail)}`,
  'db-user-deleted': (e) => `removed the database login ${onEngine(e.target)}${paren(e.detail)}`,
  'db-access-granted': (e) => `changed what the database login ${onEngine(e.target)} may do${paren(e.detail)}`,
  'db-access-revoked': (e) => `took a database away from the login ${onEngine(e.target)}${paren(e.detail)}`,
  'schema-applied': (e) => `applied changes to the database ${onEngine(e.target)}${paren(e.detail)}`,
  'database-activated': (e) => `switched on the ${W.app.one} for ${onEngine(e.target)}${paren(e.detail)}`,
  'database-deactivated': (e) => `switched off the ${W.app.one} for ${onEngine(e.target)}${paren(e.detail)}`,
  'database-api-changed': (e) => `changed whether programs can reach ${onEngine(e.target)}${paren(e.detail)}`,
  'app-key-made': (e) => `made a key for programs to use ${onEngine(e.target)}${paren(e.detail)}`,
  'app-key-revoked': (e) => `stopped the key ${quoted(e.detail)} for ${onEngine(e.target)}`,
  'record-deleted': (e) => `deleted a record${paren(e.target)}`,
  // tags on her records (docs/catalog-plan.md step 4)
  'record-tags-on': (e) => `switched on tags for ${e.target}${paren(e.detail)}`,
  'record-tags-off': (e) => `switched off tags for ${e.target}${paren(e.detail)}`,
  'record-labels-gone': (e) => `took the tags off ${e.target}, which was deleted${paren(e.detail)}`,
  // tags on the services' things (docs/catalog-plan.md step 5); the service itself is the actor when it tags
  'app-tags-on': (e) => `switched on tags for ${e.target}'s things${paren(e.detail)}`,
  'app-tags-off': (e) => `switched off tags for ${e.target}'s things${paren(e.detail)}`,
  'app-items-gone': (e) => `let go of what ${e.target} no longer offers${paren(e.detail)}`,
  'app-items-missing': (e) => `read ${e.target} again${paren(e.detail)}`,
  'app-item-gone': (e) => `deleted ${e.target}, and its tags with it${paren(e.detail)}`,
  'app-tagged': (e) => `tagged ${e.target}${paren(e.detail)}`,
  'app-untagged': (e) => `took a tag off ${e.target}${paren(e.detail)}`,
};
export const describe = (e: ActivityEntry) => (ACTIONS[e.action] ? ACTIONS[e.action]!(e) : `${e.action}${e.target ? ` ${e.target}` : ''}${paren(e.detail)}`);

export function Activity() {
  usePageTitle('Activity');
  const q = useInfiniteQuery({
    queryKey: ['/api/activity'],
    queryFn: ({ pageParam }) => api<{ entries: ActivityEntry[]; own: boolean }>(`/api/activity${pageParam ? `?before=${pageParam}` : ''}`),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.entries.length < 100 ? undefined : last.entries[last.entries.length - 1]!.id),
  });
  const entries = q.data?.pages.flatMap((p) => p.entries) ?? [];
  // not an account manager: the server sends only what they did themselves
  const own = q.data?.pages[0]?.own ?? false;

  return (
    <Page title="Activity" intro={`${own ? 'What you have done in the panel' : 'Everything done in the panel'}, newest first. Times are shown in your own time zone.`}>
      <Section flush>
      {!q.data ? <Loading rows={6} /> : (
        <List label="Activity">
          {entries.length === 0 && <Empty>{own ? 'You have not done anything here yet.' : 'Nothing yet.'}</Empty>}
          {entries.map((e) => (
            <li key={e.id} className="flex flex-col gap-1 px-4 py-3 text-sm sm:flex-row sm:items-baseline sm:gap-4 sm:px-5">
              <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                <strong>{e.actor_label}</strong> {describe(e)}
                {e.ip && <div className="text-sm text-muted-foreground">{e.ip}</div>}
              </div>
              <time dateTime={new Date(e.at * 1000).toISOString()} className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatTime(e.at)}</time>
            </li>
          ))}
        </List>
      )}
      {q.hasNextPage && (
        <div className="border-t border-border p-3 text-center">
          <Button variant="ghost" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}><ChevronsDown />Show older</Button>
        </div>
      )}
      </Section>
    </Page>
  );
}
