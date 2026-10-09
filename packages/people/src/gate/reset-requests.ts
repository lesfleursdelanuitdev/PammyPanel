// People's socket for the requests module's "forgot my password" list (docs/k-a-plan.md
// KA-Q2): when someone chooses a new password with a link, their open reset requests are
// closed in the same transaction; with emailed links on, an account without an address
// that asks for a reset link becomes a request for the owner. People names no table of
// requests': the gate host fills this in when requests is on (as forms' responseKept),
// and with requests off nothing is closed or filed.
import type { Db } from '@panel/core/pg';
import type { Area } from '@panel/core/gate/types';

export type ResetRequests = {
  // inside the transaction that sets the password (q), so both happen or neither
  close: (q: Db, visitorId: number, now: number) => Promise<unknown>;
  // null: nothing recorded (no such username, or too many requests waiting)
  add: (db: Db, now: number, area: Area | null, username: string, message: string, host: string, ip: string | null) => Promise<object | null>;
};
export const NO_RESET_REQUESTS: ResetRequests = { close: async () => 0, add: async () => null };

// What the host hands people's gate routes (registerSignIn, registerAccounts).
export type PeopleSockets = { resetRequests: ResetRequests };
