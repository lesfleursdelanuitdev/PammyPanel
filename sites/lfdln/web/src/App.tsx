import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { DialogsProvider } from '@panel/core/web/components/dialogs';
import { Shell } from '@panel/core/web/components/shell';
import { useApi } from '@panel/core/web/hooks/useApi';
import type { PageRoute } from '@panel/core/web/lib/routes';
import { isOn } from '@panel/core/web/lib/site';
import { may } from '@panel/core/web/lib/rights';
import type { Me } from '@panel/core/web/lib/types';
import { Invite } from '@panel/core/web/pages/Invite';
import { Login } from '@panel/core/web/pages/Login';
import { routes as core } from '@panel/core/web/routes';
import { routes as hosts } from '@panel/hosts/web/routes';
import { routes as files } from '@panel/files/web/routes';
import { routes as mediaPages } from '@panel/media/web/routes';
import { routes as apiKeys } from '@panel/api-keys/web/routes';
import { mediaCover } from '@panel/media/web/api-key-cover';
import { routes as studio } from '@panel/studio/web/routes';
import { routes as forms } from '@panel/forms/web/routes';
import { formsCover } from '@panel/forms/web/api-key-cover';
import { routes as formLinks } from '@panel/form-links/web/routes';
import { routes as comments } from '@panel/comments/web/routes';
import { routes as services } from '@panel/services/web/routes';
import { appRoutes as catalog } from '@panel/catalog/web/routes';
import { routes as monitoring } from '@panel/monitoring/web/routes';
import { routes as projects } from '@panel/projects/web/routes';
import { routes as areas } from '@panel/areas/web/routes';
import { routes as people } from '@panel/people/web/routes';
import { routes as requests } from '@panel/requests/web/routes';
import { parts as settings } from '@panel/settings/web/routes';
import { routes as help } from '@panel/help/web/routes';
import { MENU } from './menu';
import { Home } from './pages/Home';

// lfdln's pages (docs/lfdln-standup-plan.md): the core's and those of the modules its
// profile switches on. Phase 5: hosts. Which ones an account gets is its rights'.
// Visitors (docs/roles-plan.md step 6): a route's Access page, People, Requests and
// Settings > Visitors; no Protected folders page (lfdln's accounts are on routes).
// Tags & categories on the services' things (docs/catalog-plan.md step 5). File Explorer,
// its editor and the files' tags (docs/phase8-plan.md step 8-1). Media folders (without the
// media examples: examples are off here, P8-12) and API keys, which read them (step 8-3). The
// Studio on lfdln-appdb (step 8-4). Help, with lfdln's own guides (docs/phase9-plan.md 9-1).
const MODULE_ROUTES: [string, PageRoute[]][] = [
  ['core', core], ['hosts', hosts], ['files', files], ['media', mediaPages.filter((r) => !r.path.startsWith('media/examples'))],
  ['forms', forms.filter((r) => !r.path.startsWith('examples'))], ['form-links', formLinks], ['comments', comments], ['settings+mail', settings.mail],
  ['api-keys', apiKeys([...(isOn('forms') ? [formsCover] : []), ...(isOn('media') ? [mediaCover] : [])])], ['studio', studio], ['services', services], ['catalog+services', catalog], ['monitoring', monitoring], ['projects', projects],
  ['areas', areas.filter((r) => r.path.startsWith('access/'))], ['people', people], ['requests', requests], ['settings+areas', settings.areas],
  ['help', help],
];
const ROUTES: PageRoute[] = MODULE_ROUTES.flatMap(([m, r]) => (m.split('+').every((x) => isOn(x)) ? r : []));

export function App() {
  return (
    <BrowserRouter>
      <DialogsProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/invite" element={<Invite />} />
          <Route path="*" element={<SignedIn />} />
        </Routes>
      </DialogsProvider>
    </BrowserRouter>
  );
}

function SignedIn() {
  const session = useApi<{ user: Me }>('/api/session', { staleTime: Infinity, refetchOnWindowFocus: false });
  if (!session.data) return null;
  const me = session.data.user;
  const shown = ROUTES.filter((r) => may(me, r.needs, r.wholeSite));
  return (
    <Routes>
      <Route element={<Shell me={me} menu={MENU} />}>
        <Route index element={<Home me={me} />} />
        {shown.map((r) => <Route key={r.path} path={r.path} element={r.page(me)} />)}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
