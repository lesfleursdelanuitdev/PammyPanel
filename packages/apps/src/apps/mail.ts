// Mail settings, as the software helper keeps them (docs/apps-plan.md phase 3):
// the Resend key and who mail comes from and goes to, for pammy-mail
// (/etc/pammy-mail) and for each WordPress (its mail.json and the pammy-mail.php
// must-use plugin). Only the helper writes these, as root; the panel asks.
import { readFileSync, writeFileSync, chmodSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { ADDRESS_RE, KEY_RE, checkSettings, type MailSettings } from '@panel/mail/mail/settings';
import { readText, uidOf, type Host } from './host.ts';
import { AppsError, type AppRecord } from './record.ts';
import type { Runner } from './runner.ts';
import { configWriter } from './config-files.ts';

export const MAIL_DIR = '/etc/pammy-mail';
export const PLUGIN = new URL('./wp/pammy-mail.php', import.meta.url).pathname;
const SMTP = { host: 'smtp.resend.com', port: 587, user: 'resend' };

export type MailView = {
  keySet: boolean;
  keyEnds: string | null;            // the last 4, so she can tell which key it is
  settings: MailSettings | null;
  wordpress: { id: string; configured: boolean; plugin: boolean }[];
};

export function mail(h: Host, run: Runner) {
  const at = (p: string) => join(h.root, p);
  const putConfig = configWriter(h, run);
  // a new file beside the old, then a rename; modes set before it is seen
  const put = (p: string, text: string, mode: number) => {
    const tmp = `${at(p)}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, at(p));
  };
  const keyNow = () => {
    try {
      const k = readFileSync(at(`${MAIL_DIR}/resend.key`), 'utf8').trim();
      return KEY_RE.test(k) ? k : null;
    } catch { return null; }
  };
  const settingsNow = async () => {
    try { return checkSettings(JSON.parse(await readText(h, `${MAIL_DIR}/settings.json`) ?? '')); } catch { return null; }
  };
  const pluginPath = (a: AppRecord) => `${a.files}/wp-content/mu-plugins/pammy-mail.php`;

  // WordPress's copy: its settings folder is mounted read-only into its
  // containers, root 644 inside svc-pammywp's 700 home (M2: a key only pammy uses)
  const configure = async (a: AppRecord, key: string, s: MailSettings) => {
    await putConfig(a, 'mail.json', `${JSON.stringify({ ...SMTP, pass: key, from: s.from, replyTo: s.replyTo }, null, 1)}\n`);
    const uid = await uidOf(h, a.user);
    if (uid === null) throw new AppsError('unavailable', `Its system user (${a.user}) is missing.`);
    // as WordPress's own user, the way install-wordpress.sh put auto-updates.php there
    const r = await run({
      as: { user: a.user, uid, home: `/var/lib/${a.user}` }, what: 'mail-plugin', timeoutSec: 60, stdin: readFileSync(PLUGIN, 'utf8'),
      argv: ['sh', '-euc', 'mkdir -p "$(dirname "$1")"; cat > "$1.new"; chmod 664 "$1.new"; mv "$1.new" "$1"', 'mail-plugin', pluginPath(a)],
    });
    if (r.code !== 0) throw new AppsError('internal', 'The mail settings were saved, but WordPress could not be given its mail plugin.');
  };

  return {
    async view(apps: AppRecord[]): Promise<MailView> {
      const key = keyNow();
      const wordpress = [];
      for (const a of apps.filter((x) => x.kind === 'wordpress')) {
        const conf = await readText(h, `${a.config}/mail.json`);
        wordpress.push({ id: a.id, configured: !!conf && !!key && conf.includes(key), plugin: await readText(h, pluginPath(a)) !== null });
      }
      return { keySet: !!key, keyEnds: key ? key.slice(-4) : null, settings: await settingsNow(), wordpress };
    },

    async set(apps: AppRecord[], req: { key?: unknown; from?: unknown; replyTo?: unknown; notifyTo?: unknown }) {
      const s = { from: req.from, replyTo: req.replyTo, notifyTo: req.notifyTo };
      for (const [k, v] of Object.entries(s)) {
        if (typeof v !== 'string' || !ADDRESS_RE.test(v)) throw new AppsError('invalid', `That doesn't look like an email address (${k === 'from' ? 'sent from' : k === 'replyTo' ? 'replies go to' : 'notices go to'}).`);
      }
      let key = keyNow();
      if (req.key !== undefined && req.key !== '') {
        if (typeof req.key !== 'string' || !KEY_RE.test(req.key.trim())) throw new AppsError('invalid', 'That is not a Resend API key (they start with re_).');
        key = req.key.trim();
      }
      if (!key) throw new AppsError('invalid', 'Paste the Resend API key made for pammy.');
      const settings = checkSettings(s);
      put(`${MAIL_DIR}/resend.key`, `${key}\n`, 0o600);
      put(`${MAIL_DIR}/settings.json`, `${JSON.stringify(settings, null, 1)}\n`, 0o644);
      for (const a of apps.filter((x) => x.kind === 'wordpress')) await configure(a, key, settings);
      // it reads its key once, from systemd (LoadCredential): start it again
      const r = await run({ as: 'root', argv: ['systemctl', 'try-restart', 'pammy-mail.service'], what: 'mail-restart', timeoutSec: 60 });
      if (r.code !== 0) throw new AppsError('internal', 'The mail settings were saved, but the mail service could not be restarted.');
      return this.view(apps);
    },

    // A new install gets WordPress's mail settings too, when there are any (4b).
    async forNewInstall(a: AppRecord) {
      const key = keyNow();
      const s = await settingsNow();
      if (key && s) await configure(a, key, s);
    },

    // A test email through WordPress itself, with wp-cli: its own wp_mail, its
    // plugin, its SMTP. To the notice address (checked again here).
    async testScript(): Promise<{ to: string; php: string }> {
      const s = await settingsNow();
      if (!s || !keyNow()) throw new AppsError('invalid', 'Set up mail first.');
      if (!ADDRESS_RE.test(s.notifyTo)) throw new AppsError('invalid', 'The notice address is not right.');
      const php = [
        'add_action("wp_mail_failed", function ($e) { echo "failed: ", $e->get_error_message(), "\\n"; });',
        `$ok = wp_mail("${s.notifyTo}", "${h.domain}: a test from WordPress", "This is a test from WordPress on ${h.domain}. If you can read it, WordPress can send email (password resets, comment notices).");`,
        'echo $ok ? "sent\\n" : "not sent\\n";',
      ].join(' ');
      return { to: s.notifyTo, php };
    },
  };
}
