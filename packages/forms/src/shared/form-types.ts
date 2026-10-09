// What a form is made of: the kinds of question, the shape of an item, and the
// shape of an answer once it has been sent (docs/forms-plan.md).
//
// Here rather than in src/gate/forms/ because both sides need it: the gate
// (which cleans items and keeps answers) and src/studio/form-links.ts (which
// works out whether an answer fits a field, and must not import the gate --
// six gate files import the studio, so the other direction is a cycle).
//
// Pure: no database, no socket, no clock, and no imports of its own.

export const ANSWER_TYPES = [
  'short-text', 'long-text', 'email', 'phone', 'number', 'website', 'date', 'time',
  'dropdown', 'single-choice', 'multiple-choice', 'checkbox', 'name', 'address', 'rating', 'scale', 'hidden',
] as const;
export const LAYOUT_TYPES = ['heading', 'paragraph', 'divider', 'image'] as const;
export type AnswerType = (typeof ANSWER_TYPES)[number];
export type LayoutType = (typeof LAYOUT_TYPES)[number];
export type ItemType = AnswerType | LayoutType;
export const isAnswerType = (t: unknown): t is AnswerType => ANSWER_TYPES.includes(t as AnswerType);
export const isLayoutType = (t: unknown): t is LayoutType => LAYOUT_TYPES.includes(t as LayoutType);

export const NAME_PARTS = ['title', 'first', 'middle', 'last'] as const;
export const ADDRESS_PARTS = ['line1', 'line2', 'town', 'region', 'postcode', 'country'] as const;

// One thing on a form. Which properties are set depends on the type; cleanItems
// fills in every one that applies, so the component and the panel never guess.
export type Item = {
  id: string; type: ItemType;
  key?: string; label?: string; help?: string; required?: boolean; width?: 'full' | 'half'; public?: boolean;
  placeholder?: string; default?: string | number | boolean | string[] | null;
  minLength?: number | null; maxLength?: number | null; rows?: number;
  min?: number | null; max?: number | null; decimals?: number;
  earliest?: string; latest?: string; step?: number;
  options?: string[]; other?: boolean; columns?: 1 | 2; minPicks?: number | null; maxPicks?: number | null;
  parts?: Record<string, boolean>; defaultCountry?: string;
  stars?: number; from?: number; to?: number; lowLabel?: string; highLabel?: string;
  value?: string; param?: string;
  text?: string; size?: 'large' | 'medium' | 'small'; src?: string; alt?: string;
};

export type Settings = { submitText: string; sentText: string; signedInOnly: boolean; showSender: boolean };
export const DEFAULT_SETTINGS: Settings = { submitText: 'Send', sentText: 'Thank you. Your answers have been sent.', signedInOnly: false, showSender: false };

// An answer as it is kept with the response: what was asked, and what was said.
export type AnswerValue = string | number | boolean | string[] | Record<string, string> | null;
export type StoredAnswer = { key: string; label: string; type: AnswerType; value: AnswerValue };
