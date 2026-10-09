// What GET /api/api-keys sends.
export type ApiKey = {
  id: number; label: string; prefix: string; level: 'approved' | 'all'; forms: number[] | null; media: 'all' | string[] | null;
  createdAt: number; createdBy: string | null; lastUsedAt: number | null; revokedAt: number | null; revokedBy: string | null;
};
export type ApiKeysData = { keys: ApiKey[] };
