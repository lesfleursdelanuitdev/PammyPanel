// lfdln's menu (docs/lfdln-standup-plan.md): Home, the hosts, and the account's own pages.
import { House } from 'lucide-react';
import type { Menu, NavItem } from '@panel/core/web/components/shell';
import type { Me } from '@panel/core/web/lib/types';
import { isOn } from '@panel/core/web/lib/site';
import { menu as core } from '@panel/core/web/routes';
import { menu as hosts } from '@panel/hosts/web/routes';
import { menu as files } from '@panel/files/web/routes';
import { menu as media } from '@panel/media/web/routes';
import { menu as apiKeys } from '@panel/api-keys/web/routes';
import { menu as forms } from '@panel/forms/web/routes';
import { menu as comments } from '@panel/comments/web/routes';
import { menu as studio } from '@panel/studio/web/routes';
import { useAppGroups } from '@panel/studio/web/hooks/useApps';
import { menu as services } from '@panel/services/web/routes';
import { menu as catalog } from '@panel/catalog/web/routes';
import { menu as monitoring } from '@panel/monitoring/web/routes';
import { menu as projects } from '@panel/projects/web/routes';
import { menu as people } from '@panel/people/web/routes';
import { menu as requests } from '@panel/requests/web/routes';
import { menu as settings } from '@panel/settings/web/routes';
import { useWaiting } from '@panel/core/web/hooks/useWaiting';
import { menu as help } from '@panel/help/web/routes';

export const MENU: Menu = {
  // an item of a module switched off is left out, and so is a group left empty
  groups: ([
    { label: null, items: [['core', { to: '/', label: 'Home', icon: House, needs: 'signed-in' }]] },
    // what is waiting, as pammy.org's Inbox (docs/phase8-plan.md step 8-6): responses,
    // comments and visitors' requests, each with its count
    { label: 'Inbox', items: [['forms', forms.responses], ['comments', comments.comments], ['requests', requests.requests]] },
    // File Explorer over the site folders (docs/phase8-plan.md step 8-1); its tags are
    // "File tags" here, beside the services' Tags & categories
    // Projects (docs/phase8b-plan.md): code the panel builds and deploys, beside Services
    { label: 'Sites', items: [['hosts', hosts.hosts], ['services', services.services], ['projects', projects.projects], ['files', files.files], ['files', { ...files.tags, label: 'File tags' }],
      ['catalog+services', catalog.catalog], ['monitoring', monitoring.monitoring]] },
    // media folders in the site folders (docs/phase8-plan.md step 8-3); no media examples here
    { label: 'Media', items: [['media', media.media], ['media', media.mediaFolders]] },
    // forms (docs/phase8-plan.md step 8-5; their responses are in the Inbox since 8-6); no
    // form examples here
    { label: 'Forms', items: [['forms', forms.forms]] },
    // the Studio on lfdln-appdb (docs/phase8-plan.md step 8-4); no database examples here. Its
    // logins start with db_, the only ones lfdln-appdb admits besides the apps' (P8-15)
    { label: 'Databases', items: [['studio', studio.databases], ['studio', studio.users]] },
    // visitors' accounts (docs/roles-plan.md step 6); a route's Access page is reached from
    // Hosts, and their requests are in the Inbox (8-6)
    { label: 'Visitors', items: [['people', people.people]] },
    // Backups: how long the database copies are kept (docs/lfdln-mariadb-plan.md B1)
    { label: 'Settings', items: [['settings+mail', settings.email], ['settings+areas', settings.visitors], ['services+studio', services.backups]] },
    { label: 'Account', items: [['api-keys', apiKeys.apiKeys], ['core', core.passkeys], ['core', core.accounts], ['core', core.activity], ['help', help.help]] },
  ] satisfies { label: string | null; items: [string, NavItem][] }[])
    .map((g) => ({ label: g.label, items: g.items.filter(([m]) => m.split('+').every((x) => isOn(x))).map(([, item]) => item) }))
    .filter((g) => g.items.length > 0),
  // the Inbox's counts (step 8-6), as pammy.org's
  useCounts: (me: Me) => {
    const { requests, responses, comments } = useWaiting(me);
    return { requests, responses, comments };
  },
  // the Studio's apps that are switched on, one group each (as pammy.org's)
  useMore: isOn('studio') ? useAppGroups : () => [],
};
