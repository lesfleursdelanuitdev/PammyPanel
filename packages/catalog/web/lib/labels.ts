// Tags and categories as every page speaks of them (docs/catalog-plan.md): their names'
// rule, and a label as the catalog's routes send it.
export type LabelType = 'tag' | 'category';
export type Names = { tags: string[]; categories: string[] };
// A label of a source's scope or Everywhere's (@panel/catalog items.ts ScopeLabel).
export type ScopeLabel = { id: number; type: LabelType; name: string; address: string; everywhere: boolean; count: number; public: boolean };

export const LABEL_RULE = 'Lowercase letters, digits and hyphens, like summer-2026.';
export const labelSlug = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
export const KEY = { tag: 'tags', category: 'categories' } as const;
export const WORD = { tag: ['Tags', 'tag'], category: ['Categories', 'category'] } as const;
