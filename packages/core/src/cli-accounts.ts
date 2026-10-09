// The command line's account commands, the same on every site (docs/lfdln-standup-plan.md
// L5): sites/<name>/src/cli.ts hands them what it doesn't handle itself. `prog` is how the
// site's command is called (pammy-panel, lfdln-panel), for the words it prints.
import {
  AccountError, COMMAND_LINE, createInvite, createUser, getUserByName, listPasskeys, personOf,
  cleanAccess, setAccess, setActive, setRole, signOutEverywhere, type UserRow,
} from './accounts.ts';
import { type Config } from './config.ts';
import { all, type Sql } from './pg.ts';

// "olivia", or "blog files" for installed software (docs/catalog-plan.md step 3b)
const placeWords = (p: string) => (p.startsWith('/') ? p.slice(1) : `${p.slice('software:'.length)} files`);

export const ACCOUNT_USAGE = (prog: string) => `users | add-user <username> "<Name>" [--manager] | invite <username> | disable <username> | enable <username> | signout <username> | role <username> manager|member | access <username> <rights>|none [<${prog === 'pammy-panel' ? 'folder' : 'place'}> ...] | activity [count]`;

export const when = (t: number | null) => (t ? new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '-');

// true when cmd was one of these (done), false when it is the site's own
export async function accountCommand(db: Sql, config: Config, prog: string, cmd: string | undefined, args: string[], flags: string[]): Promise<boolean> {
  const now = config.now();
  const userArg = async (): Promise<UserRow> => {
    const name = args[0];
    const u = name ? await getUserByName(db, name) : undefined;
    if (!u) throw new AccountError(`no account called '${name ?? ''}' (see: ${prog} users)`);
    return u;
  };
  // what an account that isn't an account manager has, and where (docs/permissions-plan.md R4-R5)
  const keptLine = async (u: UserRow) => {
    if (u.role === 'manager') return '';
    const p = await personOf(db, u);
    return `  ${p.places.length ? `only ${p.places.map(placeWords).join(', ')}: ` : ''}${p.rights.join(', ') || 'nothing yet'}`;
  };
  switch (cmd) {
    case 'users': {
      const users = await all<UserRow>(db, 'SELECT * FROM users ORDER BY role, username');
      if (!users.length) console.log(`no accounts yet -- start with: ${prog} add-user <username> "<Name>" --manager`);
      for (const u of users) {
        console.log(`${u.username.padEnd(16)} ${u.display_name.padEnd(20)} ${u.role.padEnd(8)} ${u.active ? 'on ' : 'OFF'}  passkeys: ${(await listPasskeys(db, u.id)).length}${await keptLine(u)}`);
      }
      return true;
    }
    case 'add-user': {
      const [username, name] = args;
      const u = await createUser(db, now, COMMAND_LINE, username, name, flags.includes('--manager') ? 'manager' : 'member');
      console.log(`created ${u.username} (${u.role}). Next: ${prog} invite ${u.username}`);
      return true;
    }
    case 'invite': {
      const u = await userArg();
      const { token, expiresAt } = await createInvite(db, now, COMMAND_LINE, u);
      console.log(`Passkey setup link for ${u.username} (works once, until ${when(expiresAt)}):\n\n  ${config.origin}/invite#${token}\n`);
      console.log('Anyone with this link can add a passkey to the account, so send it privately.');
      return true;
    }
    case 'disable':
    case 'enable': {
      const u = await userArg();
      await setActive(db, now, COMMAND_LINE, u, cmd === 'enable');
      console.log(`${u.username} is now ${cmd === 'enable' ? 'on' : 'off (signed out everywhere)'}`);
      return true;
    }
    case 'role': {
      const u = await userArg();
      await setRole(db, now, COMMAND_LINE, u, args[1]);
      console.log(`${u.username} is ${args[1] === 'manager' ? `${config.site.words.admin.a} (Accounts tab)` : `no longer ${config.site.words.admin.a}`}`);
      return true;
    }
    case 'access': {
      // the Accounts page's "What they can use", for when nobody can use the panel;
      // the folders' names are only checked for their shape here (the page asks the website)
      const u = await userArg();
      if (!args[1]) throw new AccountError(`usage: ${prog} access <username> <right,right,...>|none [<folder> ...]`);
      const rights = args[1] === 'none' ? [] : args[1].split(',').map((r) => r.trim()).filter(Boolean);
      // a folder ("olivia"), or installed software's files as "software:blog" (step 3b; its name only checked for shape here)
      const places = args.slice(2).map((f) => (/^software:/.test(f) ? f : `/${f.replace(/^\/+|\/+$/g, '')}`));
      const got = await setAccess(db, now, COMMAND_LINE, u, cleanAccess(rights, places));
      console.log(`${u.username}: ${got.rights.join(', ') || 'no parts of the panel'}${got.places.length ? `, kept to ${got.places.map(placeWords).join(', ')}` : ', the whole site'}`);
      return true;
    }
    case 'signout': {
      const u = await userArg();
      console.log(`ended ${await signOutEverywhere(db, now, COMMAND_LINE, u)} session(s) for ${u.username}`);
      return true;
    }
    case 'activity': {
      const n = Math.min(Math.max(Number(args[0] ?? 30) || 30, 1), 1000);
      const rows = await all<{ at: number; actor_label: string; action: string; target: string | null; detail: string | null; ip: string | null }>(db,
        'SELECT * FROM activity ORDER BY id DESC LIMIT ?', n);
      for (const r of rows.reverse()) {
        console.log(`${when(r.at)}  ${r.actor_label.padEnd(20)} ${r.action.padEnd(18)} ${r.target ?? ''} ${r.detail ? `(${r.detail})` : ''} ${r.ip ?? ''}`);
      }
      return true;
    }
    default:
      return false;
  }
}
