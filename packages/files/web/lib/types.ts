// What the panel API sends back for this module (its routes are the source of truth).

export type MediaKind = 'images' | 'files' | 'audio' | 'video';
export type FileKind = MediaKind | 'pages' | 'other';
export type MediaSite = { folder: string; hasMedia: boolean };
// when the panel last compared its records with the media folders, and what it found out of place
export type MediaSyncInfo = { at: number; strays: string[]; truncated: boolean };
export type MediaSites = { folders: MediaSite[]; sync: MediaSyncInfo | null; limitedTo?: string[] | null };
// A file's thumbnail: a picture's address, or the icon to show (null: not made yet).
export type MediaIcon = 'image' | 'video' | 'audio' | 'pdf' | 'document' | 'spreadsheet' | 'presentation' | 'archive' | 'text' | 'file';
export type MediaThumb = { src: string; icon: MediaIcon; width: number | null; height: number | null } | { src: null; icon: MediaIcon } | null;
export type MediaFile = { id: number; name: string; size: number; fits: boolean; createdAt: number; addedBy: string | null; thumb: MediaThumb };
export type MediaList = { path: string; buckets: { name: string; items: number }[]; files: MediaFile[] };
export type MediaInfo = {
  name: string; path: string; site: string; size: number; fits: boolean; createdAt: number; modifiedAt: number;
  addedBy: string | null; addedAt: number | null; how: string | null; dimensions: { width: number; height: number } | null; thumb: MediaThumb;
  id: number | null; scope: string | null; tags: string[]; categories: string[]; title: string | null; alt: string | null;
};
// One file in the Media page's list (GET /api/media/items).
export type MediaItem = {
  id: number; path: string; scope: string; site: string; kind: FileKind; folder: string; name: string; size: number;
  addedAt: number; modifiedAt: number; addedBy: string | null; how: string | null; fits: boolean; thumb: MediaThumb;
  tags: string[]; categories: string[]; title: string | null; alt: string | null;
};
export type MediaItems = { mode: 'browse' | 'all'; dir: string | null; folders: { name: string; items: number }[]; items: MediaItem[]; total: number; offset: number; limit: number };
export type LabelType = 'tag' | 'category';
export type MediaLabel = { id: number; type: LabelType; scope: string; name: string; address: string; count: number; public: boolean };
export type TagScope = { path: string; automatic: boolean; created_at: number; created_by: string | null; labels: number };
export type MediaTrashItem = { id: string; name: string; path: string; isDir: boolean; trashedAt: number; purgeAt: number };
