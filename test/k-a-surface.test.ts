// K-a's map (docs/k-a-plan.md, "The rule that shapes the slices"): every name the gate's
// store, live cache, passwords and visitor settings exported at 711ae91 (before the store
// split), and where it lives now. Core can't re-export what moves into a module, so each
// slice moves a name and switches its callers at once, and updates this map in the same
// commit. Every name is imported from its home here, so none can get lost, and a branch
// rebasing onto K-a reads where its import went.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
// the types, checked by tsc (a type that moves without this list following fails the typecheck)
import type { SettingsState, Switch, VisitorSettings } from '@panel/core/gate/visitor-settings';
import type { Abilities } from '@panel/people/shared/visitor-switches';
import type { Access, AreaLookup, LiveOptions } from '@panel/core/gate/live';
import type { Area, AreaRole, Request, Visitor } from '@panel/core/gate/store';
import type { Link, LinkPurpose } from '@panel/people/gate/links';
import type { Registered } from '@panel/people/gate/self-service';

export type KaTypes = [Abilities, SettingsState, Switch, VisitorSettings, Access, AreaLookup, LiveOptions,
  Area, AreaRole, Link, LinkPurpose, Registered, Request, Visitor];

// name -> its home (a package entry). At 711ae91 every name was in one of the four core files.
const STORE = '@panel/core/gate/store';
const OPS = '@panel/core/gate/ops';
export const HOMES: Record<string, string> = {
  // the gate-op kit: stays in the kernel (K-a1)
  GateError: OPS, cleanLine: OPS, cleanMessage: OPS, cleanBy: OPS, int: OPS, logEvent: OPS,
  // not moved yet (areas: K-a6; requests: K-a5). housekeeping is requests' part only since
  // K-a4: people's is peopleHousekeeping (@panel/people/gate/housekeeping), the event log's
  // eventsHousekeeping (@panel/core/gate/ops)
  ...Object.fromEntries([
    'AREA_TOKEN_RE', 'MARKER', 'MAX_OPEN_REQUESTS', 'MAX_OPEN_REQUESTS_PER_FOLDER', 'PAGES_READ', 'addAccessRequest', 'addResetRequest',
    'areaById', 'areaByPath', 'areaByToken', 'cleanAreaPath', 'createArea', 'deleteArea', 'deleteRequest', 'guestPrivileges',
    'housekeeping', 'moveArea', 'openToAll', 'opensArea', 'requestById', 'resolveRequest', 'rolesOf', 'setMember', 'setRequestsOpen',
  ].map((n) => [n, STORE])),
  GateLive: '@panel/core/gate/live',
  // the session cache: people's (K-a2)
  SESSION_FRESH: '@panel/people/gate/session-cache', SESSION_STALE: '@panel/people/gate/session-cache',
  // people's store (K-a4). VISITOR_NAME_RE and cleanVisitorName are people's names for
  // core's objects (people re-exports the store's until requests' store moves, K-a5)
  VISITOR_COOKIE: '@panel/core/gate/context',
  ...Object.fromEntries(['VISITOR_SESSION', 'createVisitorSession', 'revokeSession', 'revokeVisitorSessions'].map((n) => [n, '@panel/people/gate/sessions'])),
  ...Object.fromEntries(['VISITOR_NAME_RE', 'cleanVisitorName', 'EMAIL_RE', 'cleanEmail', 'passwordProblem'].map((n) => [n, '@panel/people/gate/accounts-store'])),
  ...Object.fromEntries(['visitorById', 'createVisitor', 'setVisitorContact', 'setVisitorPassword', 'setVisitorActive', 'renameVisitor',
    'deleteVisitor'].map((n) => [n, '@panel/people/gate/visitors'])),
  ...Object.fromEntries(['visitorByLogin', 'checkCredentials', 'signInCheck'].map((n) => [n, '@panel/people/gate/sign-in-check'])),
  ...Object.fromEntries(['LINK_LIFETIME', 'LINK_LIFETIMES', 'cancelLinks', 'openLink', 'createLink', 'liveLink', 'linkForToken', 'useLink',
    'makeEmailedLink'].map((n) => [n, '@panel/people/gate/links'])),
  ...Object.fromEntries(['registerVisitor', 'forgetRegistration', 'UNCONFIRMED_KEPT', 'useConfirmLink', 'useResetLink', 'changeOwnPassword',
    'startEmailChange', 'deleteOwnAccount'].map((n) => [n, '@panel/people/gate/self-service'])),
  // passwords: the scrypt hashing is the kernel's, the rules people's (K-a4)
  hashPassword: '@panel/core/security', verifyPassword: '@panel/core/security',
  isCommonPassword: '@panel/people/gate/passwords',
  // visitor settings: the read side stays in the kernel until K-b, the rules and the writing
  // are people's (K-a4, KA-Q3/KA-Q4)
  ...Object.fromEntries(['ALL_OFF', 'BUILT', 'SWITCHES', 'isSwitch', 'readVisitorSettings', 'settingsOf'].map((n) => [n, '@panel/core/gate/visitor-settings'])),
  ...Object.fromEntries(['NEEDS', 'SWITCH_WORDS', 'whyNot'].map((n) => [n, '@panel/people/shared/visitor-switches'])),
  needing: '@panel/people/gate/visitor-settings', setVisitorSwitch: '@panel/people/gate/visitor-settings',
};

// What the four files exported at 711ae91 (values; the types are KaTypes above).
const AT_711AE91 = 84;   // store 67, live 3, passwords 3, visitor-settings 11

describe('K-a: every name the gate store had, at its new home', () => {
  it('lists every name once', () => {
    assert.equal(Object.keys(HOMES).length, AT_711AE91);
  });

  it('finds each one where the map says', async () => {
    const missing: string[] = [];
    for (const [name, home] of Object.entries(HOMES)) {
      const m = await import(home) as Record<string, unknown>;
      if (m[name] === undefined) missing.push(`${name} (${home})`);
    }
    assert.deepEqual(missing, []);
  });

  it("keeps core's gate/passwords naming the kernel's hashing until K-a7 drops it", async () => {
    const old = await import('@panel/core/gate/passwords') as Record<string, unknown>;
    const security = await import('@panel/core/security') as Record<string, unknown>;
    assert.deepEqual(Object.keys(old).sort(), ['hashPassword', 'verifyPassword']);
    for (const n of ['hashPassword', 'verifyPassword']) assert.equal(old[n], security[n], n);
  });

  it('keeps one object per name while the store still re-exports it (instanceof GateError holds across paths)', async () => {
    const store = await import(STORE) as Record<string, unknown>;
    for (const [name, home] of Object.entries(HOMES)) {
      if (home === STORE || store[name] === undefined) continue;
      const m = await import(home) as Record<string, unknown>;
      assert.equal(store[name], m[name], name);
    }
  });
});
