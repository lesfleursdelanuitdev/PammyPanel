// pammy.org's menu: which package's items go in which group, in what order.
import { House } from 'lucide-react';
import type { Me } from '@panel/core/web/lib/types';
import type { Menu, NavItem } from '@panel/core/web/components/shell';
import { isOn, SITE, W } from '@panel/core/web/lib/site';
import { menu as core } from '@panel/core/web/routes';
import { menu as areas } from '@panel/areas/web/routes';
import { menu as files } from '@panel/files/web/routes';
import { menu as mediaMenu } from '@panel/media/web/routes';
import { menu as forms } from '@panel/forms/web/routes';
import { menu as apiKeys } from '@panel/api-keys/web/routes';
import { menu as comments } from '@panel/comments/web/routes';
import { menu as studio } from '@panel/studio/web/routes';
import { menu as examples } from '@panel/examples/web/routes';
import { menu as apps } from '@panel/apps/web/routes';
import { menu as settings } from '@panel/settings/web/routes';
import { menu as people } from '@panel/people/web/routes';
import { menu as requests } from '@panel/requests/web/routes';
import { menu as help } from '@panel/help/web/routes';
import { menu as hosts } from '@panel/hosts/web/routes';
import { useAppGroups } from '@panel/studio/web/hooks/useApps';
import { useWaiting } from '@panel/core/web/hooks/useWaiting';

export const MENU: Menu = {
  // an item of a module switched off is left out, and so is a group left empty
  groups: ([
    { label: null, items: [['core', { to: '/', label: 'Home', icon: House, needs: 'signed-in' }]] },
    { label: 'Inbox', items: [['forms', forms.responses], ['comments', comments.comments], ['requests', requests.requests]] },
    // Subdomains only where folders are subdomains ('off' is no module, so never on)
    // Hosts where the site routes names to targets (lfdln; docs/hosts-plan.md)
    { label: W.website.title, items: [['hosts', hosts.hosts], [SITE.folderSubdomains ? 'files' : 'off', files.subdomains], ['files', files.files], ['files', files.tags]] },
    { label: 'Media', items: [['media', mediaMenu.media], ['media', mediaMenu.mediaFolders], ['media', mediaMenu.mediaExamples]] },
    { label: 'Forms', items: [['forms', forms.forms], ['forms', forms.examples]] },
    { label: 'Databases', items: [['studio', studio.databases], ['studio', studio.users], ['examples', examples.databases], ['examples', examples.tutorials]] },
    { label: 'Software', items: [['apps', apps.software]] },
    { label: 'Visitors', items: [['areas', areas.protectedFolders], ['people', people.people]] },
    // Settings (docs/roles-plan.md R1): each part with its own module on too
    { label: 'Settings', items: [['settings+mail', settings.email], ['settings+areas', settings.visitors]] },
    { label: 'Account', items: [[isOn('forms') || isOn('media') ? 'api-keys' : 'off', apiKeys.apiKeys], ['core', core.passkeys], ['core', core.accounts], ['core', core.activity], ['help', help.help]] },
  ] satisfies { label: string | null; items: [string, NavItem][] }[])
    .map((g) => ({ label: g.label, items: g.items.filter(([m]) => m.split('+').every((x) => isOn(x))).map(([, item]) => item) }))
    .filter((g) => g.items.length > 0),
  useCounts: (me: Me) => {
    const { requests, responses, comments } = useWaiting(me);
    return { requests, responses, comments };
  },
  // the apps she has switched on, one group each
  useMore: isOn('studio') ? useAppGroups : () => [],
};
