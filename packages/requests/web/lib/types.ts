// What the panel API sends back for this module (its routes are the source of truth).
import type { Person } from '@panel/areas/web/lib/types';

export type GateRequest = {
  id: number; kind: 'access' | 'reset'; name: string; contact: string; message: string; createdAt: number;
  areaPath: string | null; person: Person | null; status: string; handledBy: string | null; handledAt: number | null;
  // with roles on, the roles to give on approving (docs/roles-plan.md step 5)
  roles?: { id: number; key: string; label: string }[];
};
export type RequestsData = { open: GateRequest[]; recent: GateRequest[]; visitors: Person[] };
