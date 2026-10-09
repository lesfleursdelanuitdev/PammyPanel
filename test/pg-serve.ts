// A throwaway Postgres for the shell tests (run-nginx-test.sh, run-gate-nginx-test.sh):
// the test container and one database, as live (the panel's and the gate's schemas
// side by side), migrated and seeded as the gate tests have it, plus the settings.
// Runs until it gets SIGTERM, then removes the container.
//   node test/pg-serve.ts <dir>     writes <dir>/pg.env, gate.pass and panel.pass, then waits
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrate } from '@panel/core/pg-migrate';
import { seedGate } from './gate-seed.ts';
import { startPg } from './pg-harness.ts';

const dir = process.argv[2];
if (!dir) { console.error('usage: node test/pg-serve.ts <dir>'); process.exit(2); }
const pg = await startPg();
const stop = () => { pg.stop(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
try {
  const database = pg.freshDatabase();
  const owner = pg.connect('owner', database, 1);
  await migrate(owner);
  await owner.end();
  const gate = pg.connect('gate', database, 1);
  await seedGate(gate, Math.floor(Date.now() / 1000));
  await gate.end();
  writeFileSync(join(dir, 'gate.pass'), pg.passwords.gate, { mode: 0o600 });
  writeFileSync(join(dir, 'panel.pass'), pg.passwords.panel, { mode: 0o600 });
  // written last: the script waits for this file
  writeFileSync(join(dir, 'pg.env'), `PGPORT=${pg.port}\nPGDATABASE=${database}\n`);
} catch (e) {
  console.error(e);
  pg.stop();
  process.exit(1);
}
setInterval(() => {}, 1 << 30);
