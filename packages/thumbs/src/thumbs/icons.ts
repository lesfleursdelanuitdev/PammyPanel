// Which icon stands in for a file that has no picture of its own (docs/media-plan.md
// D18): other files by their type, and anything whose picture couldn't be made.
// Shared by the thumbnail service, the panel and its pages (same names).
export const ICONS = ['image', 'video', 'audio', 'pdf', 'document', 'spreadsheet', 'presentation', 'archive', 'text', 'file'] as const;
export type IconName = (typeof ICONS)[number];

const BY_EXTENSION: Record<string, IconName> = {
  pdf: 'pdf',
  doc: 'document', docx: 'document', odt: 'document', rtf: 'document', pages: 'document',
  xls: 'spreadsheet', xlsx: 'spreadsheet', ods: 'spreadsheet', csv: 'spreadsheet', numbers: 'spreadsheet',
  ppt: 'presentation', pptx: 'presentation', odp: 'presentation', key: 'presentation',
  zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive', tgz: 'archive', bz2: 'archive', xz: 'archive',
  txt: 'text', md: 'text', json: 'text', log: 'text', html: 'text', htm: 'text', css: 'text', js: 'text', mjs: 'text', cjs: 'text',
};

export const extensionOf = (name: string) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '');

// A file in files/ that isn't a PDF never gets a picture: just its icon.
export const hasPicture = (kind: string, name: string) =>
  kind === 'images' || kind === 'video' || kind === 'audio' || extensionOf(name) === 'pdf';

export function iconFor(kind: string, name: string): IconName {
  if (kind === 'images') return 'image';
  if (kind === 'video') return 'video';
  if (kind === 'audio') return 'audio';
  return BY_EXTENSION[extensionOf(name)] ?? 'file';
}
