// What a gate database moved from SQLite has that a new Postgres one doesn't: the
// sample contact form. gate.db's migration 3 made it, and migration 4 turned it
// into a form, switched off, as form 1. Many tests (and the browser tests) were
// written against it, so they start from the same place. Then the worked
// examples, as the gate itself does when it starts (main.ts).
import { installExamples } from '@panel/examples/gate/examples';
import { createForm } from '@panel/forms/gate/forms/store';
import { GateLive } from '@panel/core/gate/live';
import { visitorSessions } from '@panel/people/gate/session-cache';
import { run, type Db } from '@panel/core/pg';
import { migrate } from '@panel/core/pg-migrate';
import type { PgTest } from './pg-harness.ts';

export async function seedGate(db: Db, now: number) {
  const f = await createForm(db, now, {
    name: 'sample-contact-form',
    title: 'Sample contact form',
    items: [
      { id: 'i1', type: 'short-text', key: 'your-name', label: 'Your name', required: true },
      { id: 'i2', type: 'email', key: 'email-address', label: 'Email address', required: true },
      { id: 'i3', type: 'phone', key: 'phone-number', label: 'Phone number' },
      { id: 'i4', type: 'dropdown', key: 'what-is-it-about', label: 'What is it about?', options: ['A question', 'A booking', 'Something else'] },
      { id: 'i5', type: 'long-text', key: 'message', label: 'Message', required: true },
      { id: 'i6', type: 'checkbox', key: 'add-me-to-the-mailing-list', label: 'Add me to the mailing list' },
    ],
  }, null);
  await run(db, "UPDATE forms SET enabled = 0, updated_by = 'converted from a contact form' WHERE id = ?", f.id);
  await installExamples(db, now, 'pammy.org');
}

// A gate on a new database of a test container: migrated, seeded, its memory
// loaded, ready as main.ts leaves it. End it with gate.db.end().
export async function newGate(pg: PgTest, now: () => number): Promise<GateLive> {
  const database = pg.freshDatabase();
  const owner = pg.connect('owner', database, 1);
  await migrate(owner);
  await owner.end();
  const sql = pg.connect('gate', database, 4);
  await seedGate(sql, now());
  const gate = new GateLive(sql, { sessions: visitorSessions, now });
  gate.markReady();
  await gate.reloadAreas();
  return gate;
}
