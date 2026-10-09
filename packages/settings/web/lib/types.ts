// What the panel API sends back for this module (its routes are the source of truth).
// Email (docs/apps-plan.md phase 3): each part may be missing on its own
export type MailPage = {
  sending: { keySet: boolean; keyEnds: string | null; settings: { from: string; replyTo: string; notifyTo: string } | null; wordpress: { id: string; configured: boolean; plugin: boolean }[] } | { error: string } | { installer: true };
  sender: { ready: boolean; why: string | null; from: string | null; notifyTo: string | null; sentToday: number } | { error: string };
  notices: { forms: number[]; commentAreas: number[]; requests: boolean; lastSentAt: number | null; lastProblem: string | null; lastProblemAt: number | null };
  forms: { id: number; title: string; name: string; kind: string; approvable: boolean }[];
};

// Settings > Visitors (docs/accounts-plan.md A5): what visitors may do for themselves.
export type VisitorSwitch = { key: string; label: string; on: boolean; blocked: string | null };
export type VisitorSettingsData = { switches: VisitorSwitch[]; changedBy: string | null; changedAt: number | null; alsoOff?: string[] };
