// Run by deploy/install-panel.sh, as root, after the software helper is in
// place (docs/apps-plan.md G3):
//   node /opt/pammy-panel/src/apps/adopt-cli.ts [--dry-run]
// Prints one line. Exit 0 = adopted, already adopted, or nothing to adopt;
// 1 = something is wrong and nothing was written.
import { adoptWordPress } from '@panel/apps/apps/adopt';
import { PROFILE } from '../profile.ts';

const env = process.env;
const dryRun = process.argv.includes('--dry-run');
try {
  const r = await adoptWordPress(
    { root: env.APPS_ROOT ?? '/', domain: env.APPS_DOMAIN ?? PROFILE.domain },
    env.APPS_STATE ?? PROFILE.apps.state,
    Math.floor(Date.now() / 1000), dryRun);
  if (r.done === 'adopted') console.log(`${dryRun ? 'would adopt' : 'adopted'}: WordPress as "${r.record.id}" (${r.address ?? 'served nowhere'}); nothing of it was changed`);
  else if (r.done === 'already') console.log(`already adopted: WordPress as "${r.record.id}", since ${new Date((r.record.adoptedAt ?? r.record.installedAt) * 1000).toISOString().slice(0, 10)}`);
  else console.log(`nothing to adopt: ${r.why}`);
} catch (e) {
  console.error(`adopting WordPress failed, nothing written: ${(e as Error).message}`);
  process.exitCode = 1;
}
