// What the panel API sends back for this module (its routes are the source of truth).
// Installed software (docs/apps-plan.md): what the software helper says, as it says it
export type SoftwarePlacement = { mode: 'off' | 'root' | 'subdomain' | 'path'; name: string | null };
export type SoftwareSummary = {
  id: string; kind: string; kindName: string;
  placement: SoftwarePlacement | null; address: string | null; adminAddress: string | null;
  version: string | null; running: boolean;
  setup: { state: 'installing' | 'failed'; step: string; message: string | null } | null;
  deleted: { at: number; by: string; until: number } | null;
};
export type SoftwareStatus = SoftwareSummary & {
  state: 'running' | 'offline' | 'stopped' | 'trouble' | 'installing' | 'failed' | 'deleted';
  problems: string[];
  siteAddress: string | null;
  filesPath: string;
  installedAt: number;
  adoptedAt: number | null;
  containers: { role: 'web' | 'db'; unit: string; running: boolean; memory: number | null }[];
  answering: { ok: boolean; status: number | null; ms: number | null; url: string | null; error: string | null; checkedAt: number } | null;
  disk: { files: number | null; database: number | null; backups: number | null; measuredAt: number };
  backups: { count: number; last: { at: number; bytes: number } | null };
  server: { memoryTotal: number | null; memoryAvailable: number | null };
  offline: { at: number } | null;
  job: SoftwareJob | null;
  recent: SoftwareJob[];
};
export type SoftwareJob = {
  app: string; op: 'backup' | 'restore' | 'offline' | 'online' | 'admin-password' | 'mail-test' | 'move' | 'install' | 'delete' | 'undelete' | 'purge'; by: string;
  startedAt: number; step: string; endedAt: number | null; ok: boolean | null; message: string | null;
};
export type SoftwareBackup = { stamp: string; at: number; bytes: number; address: string | null };
