// Taking in what already runs (docs/adopt-plan.md V7): run by lfdln's installer, as
// root. Reads what systemd says of each known service and writes the services
// helper's record; changes nothing of the services. Prints what it did.
//   node sites/lfdln/src/helpers/services-adopt.ts [<record>]
import { readFileSync } from 'node:fs';
import { systemdRunner } from '@panel/core/runner';
import { adopt } from '@panel/services/adopt';
import { RECORD } from '@panel/services/helper/main';
import { loadRecord, saveRecord } from '@panel/services/record';

const path = process.argv[2] ?? RECORD;
const { record, said } = await adopt({
  run: systemdRunner('lfdln-services'),
  passwd: () => readFileSync('/etc/passwd', 'utf8'),
  now: () => Math.floor(Date.now() / 1000),
}, loadRecord(path));
saveRecord(path, record);
for (const line of said) console.log(line);
