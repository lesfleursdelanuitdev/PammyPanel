// A file's little picture (made by the panel's thumbnail service), or its icon:
// while the picture is being made, when there can't be one, and if it fails to load.
import { File, FileArchive, FileSpreadsheet, FileText, Film, Image, Music, Presentation } from 'lucide-react';
import { useState } from 'react';
import type { FileKind, MediaIcon, MediaThumb } from '../../lib/types';
import { cn } from '@panel/core/web/lib/utils';

export const THUMB_ICONS: Record<MediaIcon, typeof File> = {
  image: Image, video: Film, audio: Music, pdf: FileText, document: FileText, spreadsheet: FileSpreadsheet, presentation: Presentation,
  archive: FileArchive, text: FileText, file: File,
};
export const KIND_ICONS: Record<string, typeof File> = { images: Image, files: FileText, audio: Music, video: Film, pages: FileText, other: File };

// `original`: the file itself, shown while an image's thumbnail is still being made.
export function Thumb({ thumb, kind, alt, className, iconClass = 'size-10', original }:
  { thumb: MediaThumb; kind: FileKind | string; alt: string; className?: string; iconClass?: string; original?: string }) {
  const [failed, setFailed] = useState(false);
  const Icon = THUMB_ICONS[thumb?.icon ?? (kind === 'images' ? 'image' : kind === 'audio' ? 'audio' : kind === 'video' ? 'video' : 'file')];
  const src = thumb === null ? original : thumb.src;
  if (src && !failed) return <img src={src} alt={alt} loading="lazy" decoding="async" onError={() => setFailed(true)} className={className} />;
  return <Icon aria-hidden className={cn(iconClass, 'text-muted-foreground')} />;
}

// Tags and categories as small chips (categories tinted, tags outlined).
export function LabelChips({ tags, categories, className }: { tags: string[]; categories: string[]; className?: string }) {
  if (!tags.length && !categories.length) return null;
  return (
    <span className={cn('flex flex-wrap gap-1', className)}>
      {categories.map((c) => <span key={`c-${c}`} className="rounded-full bg-primary-soft px-2 py-0.5 text-xs font-semibold text-primary" title={`category ${c}`}>{c}</span>)}
      {tags.map((t) => <span key={`t-${t}`} className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground" title={`tag ${t}`}>#{t}</span>)}
    </span>
  );
}
