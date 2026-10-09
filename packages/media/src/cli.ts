// The media folders' commands, for every site's command line (pammy-panel, lfdln-panel;
// docs/phase8-plan.md step 8-3): media-sync brings the file records up to date with the
// site now, media-thumbs makes every thumbnail still waiting (or one file's). Both write
// the media API's index for the gate afterwards, as the running panel does.
import { AccountError, COMMAND_LINE, logActivity } from '@panel/core/accounts';
import type { Config } from '@panel/core/config';
import { all, one, type Sql } from '@panel/core/pg';
import { describeSync, MediaSync } from '@panel/files/media-sync';
import { Thumbnailer } from '@panel/thumbs/media-thumbs';
import { publishIndex } from './media-public.ts';

export const MEDIA_USAGE = 'media-sync [--all-hashes] | media-thumbs [--only <path>]';

// true when cmd was one of these (done), false when it isn't
export async function mediaCommand(db: Sql, config: Config, bin: string, cmd: string | undefined, rest: string[], flags: string[]): Promise<boolean> {
  if (cmd === 'media-sync') {
    const sync = new MediaSync(db, config.sitefsSocket, config.now);
    let logged: Promise<void> = Promise.resolve();
    sync.onChange = (s, actor) => { logged = logActivity(db, config.now(), { id: null, label: actor }, 'media-synced', 'media folders', describeSync(s)); };
    const s = await sync.sync(COMMAND_LINE.label, { waitForHashes: true, hashBudget: flags.includes('--all-hashes') ? { bytes: Infinity, files: Infinity } : undefined });
    await logged;
    const counts = await all<{ state: string; n: number }>(db, "SELECT state, count(*) AS n FROM records GROUP BY state ORDER BY state");
    const noHash = (await one<{ n: number }>(db, "SELECT count(*) AS n FROM records WHERE state = 'present' AND hash IS NULL"))!.n;
    console.log(`${s.files} files in the media folders: ${describeSync(s)}; ${s.hashed} hashed now, ${noHash} still without a hash`);
    console.log(`records: ${counts.map((c) => `${c.n} ${c.state}`).join(', ') || 'none'}`);
    for (const x of s.strays) console.log(`OUT OF PLACE  ${x}`);
    // the media API's index, for the gate (the running panel also does this after its own changes)
    await publishIndex(db, config.mediaPublicDir, config.now());
    if (s.truncated) console.log('NOTE  more files than one sync lists; files beyond the limit were not checked');
    return true;
  }
  if (cmd === 'media-thumbs') {
    const thumbs = new Thumbnailer(db, config.thumbsSocket, config.thumbsDir, config.now);
    const only = rest[rest.indexOf('--only') + 1];
    if (flags.includes('--only')) {
      const rec = await one<{ id: number }>(db, "SELECT id FROM records WHERE path = ? AND state = 'present'", only ?? '');
      if (!rec) throw new AccountError(`no media record for '${only ?? ''}' (try: ${bin} media-sync)`);
      const t = await thumbs.makeOne(rec.id);
      console.log(t ? `${t.result} ${t.icon}${t.width ? ` ${t.width}x${t.height}` : ''}${t.why ? ` (${t.why})` : ''}` : `waiting for its hash (try: ${bin} media-sync)`);
      return true;
    }
    let problem: unknown = null;
    thumbs.log = (_msg, err) => { problem = err; };
    const made = await thumbs.kick();
    const rows = (await one<{ pictures: number; icons: number; waiting: number }>(db, `SELECT
        (SELECT count(*) FROM records m JOIN thumbs t ON t.item_id = m.id AND t.hash = m.hash WHERE m.state = 'present' AND t.result = 'picture') AS pictures,
        (SELECT count(*) FROM records m JOIN thumbs t ON t.item_id = m.id AND t.hash = m.hash WHERE m.state = 'present' AND t.result = 'icon') AS icons,
        (SELECT count(*) FROM records m LEFT JOIN thumbs t ON t.item_id = m.id AND t.hash = m.hash WHERE m.state = 'present' AND t.item_id IS NULL) AS waiting`))!;
    console.log(`made ${made} now; ${rows.pictures} pictures, ${rows.icons} icons, ${rows.waiting} still waiting (for a hash, or for the thumbnail service)`);
    await publishIndex(db, config.mediaPublicDir, config.now());
    if (problem) { console.log(`PROBLEM  ${problem instanceof Error ? problem.message : String(problem)}`); process.exitCode = 1; }
    return true;
  }
  return false;
}
