// lfdln-mail.service (docs/accounts-plan.md step 2): lfdln's emails, in its own name.
// Its visitor emails share a Resend account with pammy.org's (one 100 a day), so
// it keeps to fewer: 20 notices and 40 visitor emails a day.
import { runMail } from '@panel/mail/mail/main';
import { PROFILE } from '../profile.ts';

const env = process.env;
runMail({
  settingsFile: env.MAIL_SETTINGS ?? PROFILE.services.mailSettings,
  keyFile: env.MAIL_KEY_FILE ?? '/etc/lfdln-mail/resend.key',
  panelOrigin: env.MAIL_PANEL_ORIGIN ?? PROFILE.panelOrigin,
  names: { site: PROFILE.name, panel: PROFILE.mail.fromName },
  domain: PROFILE.domain,
  noticesPerDay: 20,
  visitorsPerDay: 40,
});
