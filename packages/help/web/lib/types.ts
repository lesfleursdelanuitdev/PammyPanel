// What the panel API sends back for this module (its routes are the source of truth).
export type Block =
  | { t: 'p'; text: string }
  | { t: 'h'; text: string }
  | { t: 'code'; text: string }
  | { t: 'ol'; start: number; alpha: boolean; items: Block[][] }
  | { t: 'ul'; items: Block[][] }
  | { t: 'dl'; items: { term: string; body: Block[] }[] }
  | { t: 'table'; rows: { key: string; value: Block[] }[] };
export type Section = { title: string; part: number | null; flag: string | null; text: string; blocks: Block[] };
// parts: a page per part; listed: its parts listed on the Help page itself (the site's guides.map)
export type Guide = { file: string; title: string; subtitle: string | null; sections: Section[]; parts: boolean; listed: boolean };
