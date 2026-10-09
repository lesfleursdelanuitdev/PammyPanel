// What the panel API sends back for this module (its routes are the source of truth).
// Forms (src/gate/forms/ is the source of truth for every rule here).
export const ANSWER_TYPES = [
  'short-text', 'long-text', 'email', 'phone', 'number', 'website', 'date', 'time',
  'dropdown', 'single-choice', 'multiple-choice', 'checkbox', 'name', 'address', 'rating', 'scale', 'hidden',
] as const;
export const LAYOUT_TYPES = ['heading', 'paragraph', 'divider', 'image'] as const;
export type AnswerType = (typeof ANSWER_TYPES)[number];
export type LayoutType = (typeof LAYOUT_TYPES)[number];
export type ItemType = AnswerType | LayoutType;
export const isAnswerType = (t: ItemType): t is AnswerType => (ANSWER_TYPES as readonly string[]).includes(t);

export type FormItem = {
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
export type FormSettings = { submitText: string; sentText: string; signedInOnly: boolean; showSender: boolean };
export type Form = {
  id: number; name: string; title: string; items: FormItem[]; settings: FormSettings;
  // docs/comments-plan.md: an ordinary form, or a comment area, and what its comments are about
  kind?: 'form' | 'comments'; contentType?: string;
  enabled: boolean; approvable: boolean; publicApproved: boolean; autoApprove: boolean; version: number;
  // one of the three worked examples ("guestbook", "rsvp", "pinboard"), or null for hers
  fixture: string | null;
  // where it works (docs/media-plan.md D22): '/' every page, '/olivia' only olivia's pages
  scope: string;
  createdAt: number; createdBy: string | null; updatedAt: number; updatedBy: string | null;
  trashedAt: number | null; trashedBy: string | null;
};
export type FormInList = Form & { responses: number; unread: number; approved: number; lastResponseAt: number | null; pages: { page: string; lastSeen: number }[] };
export type FormsData = { forms: FormInList[]; unread: number; trashDays: number };

// The worked examples (docs/examples-plan.md)
export type ExampleKind = 'guestbook' | 'rsvp' | 'pinboard';
export type ExampleInList = {
  kind: ExampleKind; heading: string; about: string; pageName: string; guidePart: number;
  formId: number | null; formName: string; starter: string;
  responses: number; waiting: number; switchedOn: boolean;
};
export type Starter = { kind: string; label: string; about: string; title: string };
export type ExamplesData = { examples: ExampleInList[]; starters: Starter[]; maxResponses: number; domain: string };

export type Answer = { key: string; label: string; type: AnswerType; value: unknown };
export type FormResponse = {
  id: number; formId: number | null; formName: string; page: string; createdAt: number; answers: Answer[];
  readAt: number | null; readBy: string | null; trashedAt: number | null; trashedBy: string | null;
  approvedAt: number | null; approvedBy: string | null; approvedAuto: boolean; approvable: boolean;
  // docs/form-to-database-plan.md: the record it made in her database, or why not yet
  savedTo?: { engine: string; name: string; table: string; plural: string; key: Record<string, unknown>; label: string; at: number } | null;
  saveProblem?: string | null; saveRetry?: boolean;
  // how the last try ended: 'unsure' means it may be in her table already
  saveState?: 'waiting' | 'saved' | 'problem' | 'retrying' | 'unsure' | null;
  thread?: { type: string; id: string } | null;
  sender: { username: string; name: string } | null;
};
export type ResponsesData = { responses: FormResponse[]; more: boolean; unread: number; trashDays: number };
