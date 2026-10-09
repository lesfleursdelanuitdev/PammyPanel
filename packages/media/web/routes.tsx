// Media folders (docs/catalog-plan.md C1): the Media grid, making media folders,
// and the media examples. Built on File Explorer's pieces (@panel/files).
import { lazy } from 'react';
import { FolderPlus, GalleryHorizontalEnd, Images } from 'lucide-react';
import type { NavItem } from '@panel/core/web/components/shell';
import { later, type PageRoute } from '@panel/core/web/lib/routes';

const Media = lazy(() => import('./pages/Media'));
const MediaFolders = lazy(() => import('./pages/MediaFolders'));
const MediaExamples = lazy(() => import('./pages/MediaExamples'));
const MediaExample = lazy(() => import('./pages/MediaExamples').then((m) => ({ default: m.MediaExample })));

export const routes: PageRoute[] = [
  { path: 'media', page: () => later(<Media />), needs: 'media' },
  { path: 'media/folders', page: () => later(<MediaFolders />), needs: 'media', wholeSite: true },
  { path: 'media/examples', page: () => later(<MediaExamples />), needs: 'media' },
  { path: 'media/examples/:kind', page: () => later(<MediaExample />), needs: 'media' },
];

export const menu = {
  media: { to: '/media', label: 'Media', icon: Images, needs: 'media' },
  mediaFolders: { to: '/media/folders', label: 'Make media folders', icon: FolderPlus, needs: 'media', wholeSite: true },
  mediaExamples: { to: '/media/examples', label: 'Media examples', icon: GalleryHorizontalEnd, needs: 'media' },
} satisfies Record<string, NavItem>;
