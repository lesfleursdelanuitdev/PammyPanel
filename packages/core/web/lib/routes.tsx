// A page of the panel, as a package offers it to the site (sites/pammy/web/src/App.tsx).
// needs: the part of the panel it is in, as its API asks (rights.ts); wholeSite:
// about the whole website, so not for a person kept to places. The site shows a
// route when the person may have it.
import { Suspense, type ReactNode } from 'react';
import type { PageNeeds } from './rights';
import type { Me } from './types';

export type PageRoute = { path: string; page: (me: Me) => ReactNode; needs: PageNeeds; wholeSite?: true };

// a page fetched the first time it is opened (React.lazy)
export const later = (page: ReactNode) => <Suspense fallback={null}>{page}</Suspense>;
