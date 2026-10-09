// pammy-mail.service (src/mail/main.ts): the panel's emails, in pammy.org's words.
import { runMail } from '@panel/mail/mail/main';
import { PROFILE } from '../profile.ts';

const env = process.env;
runMail({
  settingsFile: env.MAIL_SETTINGS ?? PROFILE.services.mailSettings,
  keyFile: env.MAIL_KEY_FILE ?? '/etc/pammy-mail/resend.key',
  panelOrigin: env.MAIL_PANEL_ORIGIN ?? PROFILE.panelOrigin,
  names: { site: PROFILE.name, panel: PROFILE.mail.fromName },
  domain: PROFILE.domain,
});
