import { AccountError } from '../accounts.ts';

// What the gate answers with, as the panel reads it (docs/refactor-plan.md
// phase 3). The gate is the one that owns forms, responses and comments; these
// are the shapes its admin socket sends back, named once so that the areas that
// pass them on -- Forms, forms into a database, comments in her apps, the
// tutorial examples -- all mean the same thing by them.
export type FormSummary = {
  id: number; name: string; title: string; kind?: 'form' | 'comments'; contentType?: string;
  enabled: boolean; approvable: boolean; publicApproved: boolean; autoApprove: boolean;
  version: number; fixture: string | null; trashedAt: number | null;
};

export type FormsState = {
  forms: (FormSummary & { responses: number; unread: number; pages: { page: string }[] })[];
  unread: number;
};

// Protected folders, the people who may open them, and what they have asked
// for: the gate's `state`, which the Protected folders, People and Requests
// pages all read, and the Application tab checks one folder against.
// kind 'route': a route's area (docs/roles-plan.md step 5), its label the route's address
export type GateArea = {
  id: number; token: string; path: string; createdAt: number; requestsOpen: boolean; visitors: number[];
  kind: 'folder' | 'route'; routeId: number | null; label: string | null;
};
export type GateVisitor = {
  id: number; username: string; name: string; contact: string; active: boolean; hasPassword: boolean; linkExpiresAt: number | null; areas: number[];
  // an account the person made themselves, and its address (docs/accounts-plan.md step 4)
  email: string | null; emailConfirmed: boolean; registered: boolean;
};
export type GateRequest = {
  id: number; kind: 'access' | 'reset'; areaId: number | null; visitorId: number | null; name: string; contact: string; message: string;
  createdAt: number; status: 'open' | 'done' | 'declined'; handledAt: number | null; handledBy: string | null;
};
export type GateState = { areas: GateArea[]; visitors: GateVisitor[]; requests: GateRequest[] };
export type GateLink = { url: string; expiresAt: number; visitor: { id: number; username: string; hasPassword: boolean }; areaPath: string | null };

export const areaOf = (st: GateState, id: number) => {
  const a = st.areas.find((x) => x.id === id);
  if (!a) throw new AccountError('That protected folder no longer exists.', 404);
  return a;
};
export const visitorOf = (st: GateState, id: number) => {
  const v = st.visitors.find((x) => x.id === id);
  if (!v) throw new AccountError('That person no longer exists.', 404);
  return v;
};

// A form with its questions, for the pages that pair them with fields.
export type FormFull = FormSummary & {
  items: { id: string; type: string; key?: string; label?: string; required?: boolean; public?: boolean; parts?: Record<string, boolean> }[];
};
