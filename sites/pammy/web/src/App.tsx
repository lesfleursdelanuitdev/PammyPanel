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
import { routes as areas } from '@panel/areas/web/routes';
import { routes as files } from '@panel/files/web/routes';
import { routes as mediaPages } from '@panel/media/web/routes';
import { routes as forms } from '@panel/forms/web/routes';
import { routes as apiKeys } from '@panel/api-keys/web/routes';
import { formsCover } from '@panel/forms/web/api-key-cover';
import { mediaCover } from '@panel/media/web/api-key-cover';
import { routes as formLinks } from '@panel/form-links/web/routes';
import { routes as comments } from '@panel/comments/web/routes';
import { routes as studio } from '@panel/studio/web/routes';
import { routes as examples } from '@panel/examples/web/routes';
import { routes as apps } from '@panel/apps/web/routes';
import { parts as settings } from '@panel/settings/web/routes';
import { routes as people } from '@panel/people/web/routes';
import { routes as requests } from '@panel/requests/web/routes';
import { routes as help } from '@panel/help/web/routes';
import { routes as gettingStarted } from '@panel/getting-started/web/routes';
import { routes as hosts } from '@panel/hosts/web/routes';
import { MENU } from './menu';
import { Home } from './pages/Home';

// The pages of every module the profile has switched on (docs/packaging-plan.md P5.5).
// Which ones an account gets is decided below, from each page's own manager/limited marks.
// API keys: for what the modules on let a key read (docs/catalog-plan.md step 3c)
const KEY_COVERS = [...(isOn('forms') ? [formsCover] : []), ...(isOn('media') ? [mediaCover] : [])];
const MODULE_ROUTES: [string, PageRoute[]][] = [
  ['areas', areas], ['files', files], ['media', mediaPages], ['forms', forms], ['api-keys', apiKeys(KEY_COVERS)], ['form-links', formLinks], ['comments', comments], ['studio', studio],
  ['examples', examples], ['apps', apps],
  ['people', people], ['requests', requests],
  // a Settings page shows with its own module on too
  ['settings+mail', settings.mail], ['settings+areas', settings.areas], ['core', core], ['help', help], ['getting-started', gettingStarted], ['hosts', hosts],
];
const ROUTES: PageRoute[] = MODULE_ROUTES.flatMap(([m, r]) => (m.split('+').every((x) => isOn(x)) ? r : []));

// The server sends this same page for every address below (PAGE_PATHS in src/app.ts),
// plus /login and /invite.
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
  // only the pages of the parts they have (docs/permissions-plan.md R4)
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
