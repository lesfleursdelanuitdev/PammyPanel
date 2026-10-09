// Subdomains, File Explorer and tags: pages and menu items. The Media pages are
// @panel/media's (docs/catalog-plan.md C1).
import { lazy } from 'react';
import { FolderTree, Globe, Tags } from 'lucide-react';
import type { NavItem } from '@panel/core/web/components/shell';
import { later, type PageRoute } from '@panel/core/web/lib/routes';
import { SITE } from '@panel/core/web/lib/site';
import { Subdomains } from './pages/Subdomains';

const Files = lazy(() => import('./pages/Files'));
const FileEditor = lazy(() => import('./pages/FileEditor'));
const MediaTags = lazy(() => import('./pages/MediaTags'));
const OldTagsAddress = lazy(() => import('./pages/MediaTags').then((m) => ({ default: m.OldTagsAddress })));

export const routes: PageRoute[] = [
  // folders that are subdomains (the profile's folderSubdomains); on a routed site, phase 4's hosts
  ...(SITE.folderSubdomains ? [{ path: 'subdomains', page: () => <Subdomains />, needs: 'subdomains' as const }] : []),
  { path: 'files', page: () => later(<Files />), needs: 'files' },
  { path: 'files/edit', page: () => later(<FileEditor />), needs: 'files' },
  { path: 'tags', page: () => later(<MediaTags />), needs: 'files' },
  { path: 'media/tags', page: () => later(<OldTagsAddress />), needs: 'files' },
];

export const menu = {
  subdomains: { to: '/subdomains', label: 'Subdomains', icon: Globe, needs: 'subdomains' },
  files: { to: '/files', label: 'File Explorer', icon: FolderTree, needs: 'files' },
  tags: { to: '/tags', label: 'Tags & categories', icon: Tags, needs: 'files' },
} satisfies Record<string, NavItem>;
