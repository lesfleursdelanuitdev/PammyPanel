// Changing what visitors may do for themselves (docs/accounts-plan.md A5; docs/k-a-plan.md
// K-a4 and KA-Q3, moved from core's gate/visitor-settings.ts): one switch on or off, as
// the panel asks through the gate's admin socket. gate.visitor_settings is people's (on
// paper: areas' 0001 made it); reading it into memory stays the kernel's until K-b's
// registered caches (@panel/core/gate/visitor-settings, live.ts). The two checks on
// areas' tables before a switch goes off are areas' (@panel/areas/gate/in-use).
import { one, run, tx, type Db } from '@panel/core/pg';
import { GateError } from '@panel/core/gate/ops';
import {
  BUILT, COLUMN, isSwitch, readVisitorSettings, settingsOf, SWITCHES, type SettingsState, type Switch,
} from '@panel/core/gate/visitor-settings';
import { ownRoleSetsInUse, routesOpenToAll } from '@panel/areas/gate/in-use';
import { NEEDS, whyNot, type Abilities } from '../shared/visitor-switches.ts';

// Everything that needs this one, directly or through another: what turning it off turns off too.
export function needing(s: Switch): Switch[] {
  const out: Switch[] = [];
  for (const other of SWITCHES) {
    for (let n = NEEDS[other]; n; n = NEEDS[n]) if (n === s) { out.push(other); break; }
  }
  return out;
}

type Row = Record<string, boolean | string | number | null>;

// Turn one switch on or off. Off also turns off every switch that needs it, and
// says which. Turning on something already on (or off, off) changes nothing.
export async function setVisitorSwitch(db: Db, now: number, key: unknown, on: unknown, by: string | null, can: Abilities):
  Promise<SettingsState & { alsoOff: Switch[]; changed: boolean }> {
  if (!isSwitch(key)) throw new GateError('invalid', 'There is no such setting.');
  if (typeof on !== 'boolean') throw new GateError('invalid', 'Expected on or off.');
  return tx(db, async (q) => {
    const row = await one<Row>(q, 'SELECT * FROM visitor_settings WHERE id = 1 FOR UPDATE');
    if (!row) throw new GateError('not-found', 'The visitor settings are missing: run the installer.');
    const built = can.built ?? BUILT;
    const cur = settingsOf(row, true, built);
    // off: every switch that needs it goes off too, and a true this code can't
    // carry out (left by a newer release) is written off as well
    const alsoOff = on ? [] : needing(key).filter((k) => row[COLUMN[k]] === true);
    if (on ? cur[key] : row[COLUMN[key]] !== true && alsoOff.length === 0) return { ...await readVisitorSettings(q, built), alsoOff: [], changed: false };
    if (on) {
      const why = whyNot(key, cur, can);
      if (why) throw new GateError('invalid', why);
    }
    // roles off: only once no folder uses roles of its own, so nothing the page
    // can no longer show stays in effect (docs/roles-plan.md step 4)
    if (!on && key === 'roles') {
      const own = await ownRoleSetsInUse(q);
      if (own.length) throw new GateError('invalid', `First put ${own.map((p) => `"${p}"`).join(', ')} back on the built-in roles (Access, Roles).`);
    }
    // "Open with accounts" off (or a switch it needs): only once no route uses it,
    // so nobody is shut out of a site that was open (docs/roles-plan.md step 5)
    if (!on && (key === 'openAreas' || alsoOff.includes('openAreas'))) {
      const open = await routesOpenToAll(q);
      if (open.length) throw new GateError('invalid', `First take accounts off ${open.map((p) => `"${p}"`).join(', ')} (Hosts), or make them "Only people let in".`);
    }
    const cols = [key, ...alsoOff].map((k) => `${COLUMN[k]} = ?`).join(', ');
    await run(q, `UPDATE visitor_settings SET ${cols}, changed_by = ?, changed_at = ? WHERE id = 1`, on, ...alsoOff.map(() => false), by, now);
    return { ...await readVisitorSettings(q, built), alsoOff, changed: true };
  });
}
