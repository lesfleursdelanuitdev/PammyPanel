// Her databases: the list, database users, the designer and the app made from it
// (docs/databases-plan.md). Account managers only.
import { lazy } from 'react';
import { Database, UserLock } from 'lucide-react';
import type { NavItem } from '@panel/core/web/components/shell';
import { later, type PageRoute } from '@panel/core/web/lib/routes';

const Databases = lazy(() => import('./pages/Databases'));
const DatabaseUsers = lazy(() => import('./pages/DatabaseUsers'));
const DatabaseUser = lazy(() => import('./pages/DatabaseUser'));
const DatabaseTables = lazy(() => import('./pages/DatabaseTables'));
const DatabaseTable = lazy(() => import('./pages/DatabaseTable'));
const DatabaseReview = lazy(() => import('./pages/DatabaseReview'));
const DatabaseCanvas = lazy(() => import('./pages/DatabaseCanvas'));
const DatabaseApp = lazy(() => import('./pages/DatabaseApp'));
const DatabaseAppTable = lazy(() => import('./pages/DatabaseAppTable'));
const DatabaseKeys = lazy(() => import('./pages/DatabaseKeys'));
const AppRecords = lazy(() => import('./pages/AppRecords'));
const AppRecord = lazy(() => import('./pages/AppRecord'));

export const routes: PageRoute[] = [
  { path: 'databases', page: () => later(<Databases />), needs: 'databases' },
  { path: 'databases/users', page: () => later(<DatabaseUsers />), needs: 'databases' },
  { path: 'databases/users/:engine/:user', page: () => later(<DatabaseUser />), needs: 'databases' },
  // the designer: tables, one table's fields, and Review (docs/databases-plan.md 6, 8, 10)
  { path: 'databases/:engine/:name', page: () => later(<DatabaseTables />), needs: 'databases' },
  { path: 'databases/:engine/:name/canvas', page: () => later(<DatabaseCanvas />), needs: 'databases' },
  { path: 'databases/:engine/:name/app', page: () => later(<DatabaseApp />), needs: 'databases' },
  { path: 'databases/:engine/:name/app/:table', page: () => later(<DatabaseAppTable />), needs: 'databases' },
  { path: 'databases/:engine/:name/programs', page: () => later(<DatabaseKeys />), needs: 'programs' },
  // the generated app: one list and one form per Resource
  { path: 'app/:engine/:name/:table', page: () => later(<AppRecords />), needs: 'databases' },
  { path: 'app/:engine/:name/:table/new', page: () => later(<AppRecord mode="create" />), needs: 'databases' },
  { path: 'app/:engine/:name/:table/edit', page: () => later(<AppRecord mode="edit" />), needs: 'databases' },
  { path: 'databases/:engine/:name/tables/:table', page: () => later(<DatabaseTable />), needs: 'databases' },
  { path: 'databases/:engine/:name/review', page: () => later(<DatabaseReview />), needs: 'databases' },
];

export const menu = {
  databases: { to: '/databases', label: 'Your databases', icon: Database, needs: 'databases' },
  users: { to: '/databases/users', label: 'Database users', icon: UserLock, needs: 'databases' },
} satisfies Record<string, NavItem>;
