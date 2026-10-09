// A form's answers into a database table: its page (no menu item: it is opened from the form).
import { lazy } from 'react';
import { later, type PageRoute } from '@panel/core/web/lib/routes';

const FormDatabase = lazy(() => import('./pages/FormDatabase'));

export const routes: PageRoute[] = [
  { path: 'forms/:id/database', page: () => later(<FormDatabase />), needs: 'databases' },
];
