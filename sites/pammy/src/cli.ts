// pammy-panel command line. Run on the server through the wrapper, which
// switches to svc-pammypanel and loads /etc/pammy-panel/panel.env:
//
//   sudo pammy-panel users
//   sudo pammy-panel add-user <username> "<Name>" [--manager]
//   sudo pammy-panel invite <username>          # passkey setup link, 24 hours
//   sudo pammy-panel disable <username>
//   sudo pammy-panel enable <username>
//   sudo pammy-panel signout <username>         # end all of their sessions
//   sudo pammy-panel role <username> manager|member   # account managers: momolig and Pamela
//   sudo pammy-panel access <username> <right,right,...>|none [<folder> ...]   # its parts, and the folders it is kept to
//   sudo pammy-panel activity [count]
//   sudo pammy-panel media-images               # media/photos -> media/images, once (the install runs it)
//   sudo pammy-panel media-sync [--all-hashes]  # bring the media records up to date with the media folders now
//   sudo pammy-panel media-thumbs [--only <path>]  # make every thumbnail still waiting (or just that file's), now
//   sudo pammy-panel hosts-seed                 # pammy.org's hosts rows, and /etc/nginx/pammy-hosts written (the install runs it)
//   sudo pammy-panel hosts-apply                # the software routes brought up to date, and the files written again
//   sudo pammy-panel switch-to-hosts            # pammy.org served from its hosts, compared before and after (install-panel.sh --switch-to-hosts)
//   sudo pammy-panel switch-back                # the pamela site serves pammy.org again
//
// This is the way in when nobody can use the panel: the first account, and a
// manager who lost every passkey.
import { AccountError } from '@panel/core/accounts';
import { ACCOUNT_USAGE, accountCommand } from '@panel/core/cli-accounts';
import { loadConfig } from '@panel/core/config';
import { REGISTRY } from '@panel/modules/index';
import { PROFILE } from './profile.ts';
import { CallError } from '@panel/core/jsonline';
import { renamePhotos } from '@panel/files/media-rename';
import { MEDIA_USAGE, mediaCommand } from '@panel/media/cli';
import { checkSchema, connectPg } from '@panel/core/pg';
import { callJsonLine } from '@panel/core/jsonline';
import { applyTable, followSoftware, pammyTable, seedHosts, type Install } from './nginx-hosts.ts';
import { switchBack, switchToHosts, type Listing } from './switch.ts';
import { callSiteFs } from '@panel/files/sitefs/client';

const config = loadConfig(PROFILE, REGISTRY);
const db = connectPg({ role: 'panel', passwordFile: config.pgPasswordFile, passwordFd: config.pgPasswordFd, host: config.pgHost, port: config.pgPort, database: config.pgDatabase, max: 2, app: 'pammy-panel-cli' });
const now = config.now();
const [cmd, ...rest] = process.argv.slice(2);
const flags = rest.filter((a) => a.startsWith('--'));
const args = rest.filter((a) => !a.startsWith('--'));

try {
  await checkSchema(db);
  // the accounts' commands are every site's (@panel/core/cli-accounts); the media ones pammy.org's
  if (!await accountCommand(db, config, 'pammy-panel', cmd, args, flags) && !await mediaCommand(db, config, 'pammy-panel', cmd, rest, flags)) switch (cmd) {
    case 'media-images': {
      const r = await renamePhotos(db, config.sitefsSocket, now);
      for (const m of r.renamed) console.log(`renamed   ${m}/photos -> ${m}/images`);
      for (const m of r.merged) console.log(`merged    ${m}/photos into ${m}/images`);
      for (const l of r.left) console.log(`LEFT      ${l} (its name is taken in images/; move it by hand)`);
      if (!r.renamed.length && !r.merged.length) console.log('nothing called photos/ in any media folder');
      if (r.left.length) process.exitCode = 3;
      break;
    }
    // pammy.org's nginx from the hosts rows (docs/phase8-plan.md 8-7b)
    case 'hosts-seed':
    case 'hosts-apply': {
      if (!config.routesSocket) throw new Error('pammy.org has no routing helper socket in its profile');
      const { apps } = await callJsonLine<{ apps: Install[] }>(config.appsSocket, { op: 'list', actor: 'pammy-panel' }, 'the software helper');
      if (cmd === 'hosts-seed') {
        const r = await seedHosts(db, apps, now);
        console.log(`${r.domain.made ? 'made' : 'kept'}      the domain ${r.domain.name} (folder hosts on)`);
        for (const m of r.made) console.log(`made      ${m}`);
        const a = await applyTable(config.routesSocket, r.table);
        console.log(`written   ${a.changed.length} file(s), ${a.removed.length} removed, in /etc/nginx/pammy-hosts`);
      } else {
        const changed = await followSoftware(db, config.routesSocket, apps, now, 'pammy-panel');
        for (const c of changed) console.log(`changed   ${c}`);
        const a = await applyTable(config.routesSocket, await pammyTable(db));
        console.log(`written   ${a.changed.length} file(s), ${a.removed.length} removed, in /etc/nginx/pammy-hosts`);
      }
      break;
    }
    // the switch (docs/phase8-plan.md 8-7c)
    case 'switch-to-hosts':
    case 'switch-back': {
      if (!config.routesSocket) throw new Error('pammy.org has no routing helper socket in its profile');
      const socket = config.routesSocket;
      const apply = (t: Parameters<typeof applyTable>[1], link: { takeOver?: string; giveBack?: string }) => applyTable(socket, t, link);
      if (cmd === 'switch-back') {
        await switchBack(db, { now, actor: 'pammy-panel', apply });
        console.log('switched back: the pamela site serves pammy.org again (pammy-hosts is out of sites-enabled)');
        break;
      }
      const { apps } = await callJsonLine<{ apps: Install[] }>(config.appsSocket, { op: 'list', actor: 'pammy-panel' }, 'the software helper');
      const r = await switchToHosts(db, {
        now, actor: 'pammy-panel', installs: apps, apply,
        where: { ip: '127.0.0.1', http: 80, https: 443, domain: config.site.domain },
        list: (dir) => callSiteFs<Listing>(config.sitefsSocket, { op: 'files-list', dir, actor: 'pammy-panel' }),
        log: (line) => console.log(line),
      });
      if (r.state === 'already') console.log('already: pammy.org is served from its hosts');
      else if (r.state === 'switched') console.log(`switched: pammy.org is served from its hosts; ${r.answers} answers the same before and after`);
      else {
        console.log(`given back: ${r.differences.length} of ${r.answers} answers differed, so the pamela site serves pammy.org again`);
        process.exitCode = 3;
      }
      break;
    }
    default:
      console.error(`usage: pammy-panel ${ACCOUNT_USAGE('pammy-panel')} | media-images | hosts-seed | hosts-apply | switch-to-hosts | switch-back | ${MEDIA_USAGE}`);
      process.exitCode = 2;
  }
} catch (e) {
  if (!(e instanceof AccountError) && !(e instanceof CallError)) throw e;
  console.error(`pammy-panel: ${e.message}`);
  process.exitCode = 1;
} finally {
  await db.end({ timeout: 5 });
}
