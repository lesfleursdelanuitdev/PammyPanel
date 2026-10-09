// lfdln-panel command line. Run on the server through the wrapper, which switches to
// svc-lfdlnpanel and loads /etc/lfdln-panel/panel.env:
//
//   sudo lfdln-panel users
//   sudo lfdln-panel add-user <username> "<Name>" [--manager]
//   sudo lfdln-panel invite <username>          # passkey setup link, 24 hours
//   sudo lfdln-panel disable|enable|signout <username>
//   sudo lfdln-panel role <username> manager|member   # admins
//   sudo lfdln-panel access <username> <right,right,...>|none [<host> ...]
//   sudo lfdln-panel activity [count]
//   sudo lfdln-panel seed-domain              # the site's own domain as a row of panel.domains, from the
//                                            # profile, if it isn't one yet (docs/domains-hosts-plan.md step 1;
//                                            # the installer runs it)
//   sudo lfdln-panel adopt-folders            # the folders already in the site folders' root become
//                                            # site folders shown at their own host (the installer runs it)
//   sudo lfdln-panel take-over-host <name>    # a hand-written host becomes the panel's, if it answers the
//                                            # same (docs/adopt-plan.md V6; install-lfdln.sh --take-over-host)
//   sudo lfdln-panel mail-status              # whether lfdln-mail can send (docs/accounts-plan.md step 2)
//   sudo lfdln-panel mail-samples             # one of each visitor email, to the notice address, to read
//   sudo lfdln-panel media-sync [--all-hashes]  # the file records up to date with the site folders now
//   sudo lfdln-panel media-thumbs [--only <path>]  # every thumbnail still waiting (or that file's), now
//   sudo lfdln-panel projects-put-back [<project>]  # S1d undone: projects on slirp4netns, their database
//                                            # variables at 10.0.2.2, before an older release is installed (S1f)
//
// The way in when nobody can use the panel: the first account (docs/lfdln-standup-plan.md
// L5), and an admin who lost every passkey.
import { AccountError } from '@panel/core/accounts';
import { ACCOUNT_USAGE, accountCommand } from '@panel/core/cli-accounts';
import { loadConfig } from '@panel/core/config';
import { REGISTRY } from '@panel/modules/index';
import { callJsonLine, CallError } from '@panel/core/jsonline';
import { callSiteFs } from '@panel/files/sitefs/client';
import { callMail } from '@panel/mail/mail/client';
import { callServices, type PortOf } from '@panel/services/client';
import { adoptFolders } from '@panel/hosts/adopt';
import { seedHomeDomain } from '@panel/hosts/domains';
import { takeOverHost, type LinkOp } from '@panel/hosts/take-over';
import type { Table } from '@panel/hosts/render';
import { checkSchema, connectPg } from '@panel/core/pg';
import { PROFILE } from './profile.ts';
import { isOn } from '@panel/core/profile';
import { MEDIA_USAGE, mediaCommand } from '@panel/media/cli';
import { PROJECTS_USAGE, projectsCommand } from '@panel/projects/cli';

const config = loadConfig(PROFILE, REGISTRY);
const db = connectPg({ role: 'panel', passwordFile: config.pgPasswordFile, passwordFd: config.pgPasswordFd, host: config.pgHost, port: config.pgPort, database: config.pgDatabase, max: 2, app: 'lfdln-panel-cli' });
const [cmd, ...rest] = process.argv.slice(2);
const flags = rest.filter((a) => a.startsWith('--'));
const args = rest.filter((a) => !a.startsWith('--'));

try {
  await checkSchema(db);
  if (await accountCommand(db, config, 'lfdln-panel', cmd, args, flags)) {
    // done
  } else if (isOn(PROFILE, 'media') && await mediaCommand(db, config, 'lfdln-panel', cmd, rest, flags)) {
    // done (docs/phase8-plan.md step 8-3)
  } else if (isOn(PROFILE, 'projects') && await projectsCommand(config.projectsSocket, cmd, args)) {
    // done (docs/s1-plan.md S1f: S1d undone, before an older release is installed)
  } else if (cmd === 'seed-domain') {
    const r = await seedHomeDomain(db, PROFILE, config.now(), 'lfdln installer');
    console.log(`${r.name}: ${r.made ? 'made from the profile' : 'already a domain (its row is what counts)'}${r.hosts ? `; ${r.hosts} host(s) put on it` : ''}`);
  } else if (cmd === 'adopt-folders') {
    // docs/hosts-plan.md H10: what the stopgap catch-all served stays served
    const { folders } = await callSiteFs<{ folders: { name: string }[] }>(config.sitefsSocket, { op: 'list', actor: 'lfdln installer' });
    const { parts } = await callServices<{ parts: PortOf[] }>(config.servicesSocket!, { op: 'ports' });
    const r = await adoptFolders(db, {
      now: config.now(), onDisk: folders.map((f) => f.name), actor: 'lfdln installer',
      ports: parts.map(({ service, part, port }) => ({ service, part, port })),
      apply: (table) => callJsonLine(config.routesSocket!, { op: 'apply', table }, 'the routing helper', 150_000),
    });
    for (const n of r.shown) console.log(`adopted   ${n}: shown at https://${n}.${config.site.domain}/ as before`);
    for (const s of r.skipped) console.log(`LEFT      ${s.name}: ${s.why}`);
    console.log(`${r.adopted.length} folder(s) taken in; nginx has the hosts' files`);
  } else if (cmd === 'take-over-host' && args.length === 1) {
    const { parts } = await callServices<{ parts: PortOf[] }>(config.servicesSocket!, { op: 'ports' });
    const r = await takeOverHost(db, args[0]!, {
      now: config.now(), actor: 'lfdln installer',
      where: { ip: '127.0.0.1', http: 80, https: 443, domain: config.site.domain },
      ports: parts.map(({ service, part, port }) => ({ service, part, port })),
      apply: (table: Table, link: LinkOp) => callJsonLine(config.routesSocket!, { op: 'apply', table, ...link }, 'the routing helper', 150_000),
      log: (line) => console.log(line),
    });
    const shown = r.name;     // (its full name, on whichever domain it is)
    if (r.state === 'already') console.log(`${shown}: the panel's already`);
    else if (r.state === 'taken-over') console.log(`${shown}: taken over; the panel's block answers the same ${r.answers} requests as the hand-written one did`);
    else { console.log(`${shown}: NOT taken over -- the hand-written file is back, as it was`); process.exitCode = 1; }
  } else if (cmd === 'mail-status') {
    const st = await callMail<{ ready: boolean; why: string | null; from: string | null; notifyTo: string | null; sentToday: number; visitorSentToday: number; visitorPerDay: number }>(config.mailSocket, { op: 'status' });
    console.log(st.ready ? `ready: from ${st.from}, notices to ${st.notifyTo}` : `NOT ready: ${st.why}`);
    console.log(`sent today: ${st.sentToday} notices, ${st.visitorSentToday} of ${st.visitorPerDay} visitor emails`);
    if (!st.ready) process.exitCode = 1;
  } else if (cmd === 'mail-samples') {
    const r = await callMail<{ sent: string[] }>(config.mailSocket, { op: 'visitor-samples' });
    console.log(`sent to the notice address: ${r.sent.join(', ')}`);
  } else {
    console.error(`usage: lfdln-panel ${ACCOUNT_USAGE('lfdln-panel')} | seed-domain | adopt-folders | take-over-host <name> | mail-status | mail-samples | ${MEDIA_USAGE} | ${PROJECTS_USAGE}`);
    process.exitCode = 2;
  }
} catch (e) {
  if (!(e instanceof AccountError) && !(e instanceof CallError)) throw e;
  console.error(`lfdln-panel: ${e.message}`);
  process.exitCode = 1;
} finally {
  await db.end({ timeout: 5 });
}
