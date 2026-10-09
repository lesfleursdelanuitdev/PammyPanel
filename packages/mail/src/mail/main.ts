// pammy-mail.service: sends the panel's emails through Resend (docs/apps-plan.md
// phase 3). Its own user, no files of its own, and the only service on this
// machine allowed off it -- to Resend's API. The key arrives by LoadCredential;
// the settings are /etc/pammy-mail/settings.json. Listens on the socket systemd
// hands it (pammy-mail.socket, only the panel's user may open it), or on
// MAIL_SOCKET when run by hand for testing. A second socket named <unit>-visitor.socket
// (lfdln-mail-visitor.socket: only the gate's user may open it) is the gate's door,
// for the fixed visitor emails only (docs/accounts-plan.md step 4).
import { chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createMailDoors, type MailNames } from './service.ts';
import { readKey, readSettings } from './settings.ts';

// The site says where the settings are, the panel's address and what to call things
// (sites/<name>/src/helpers/mail.ts). The key file is systemd's to hand over.
export type MailRun = { settingsFile: string; keyFile: string; panelOrigin: string; names: MailNames; domain: string; noticesPerDay?: number; visitorsPerDay?: number };
export function runMail(r: MailRun, env: NodeJS.ProcessEnv = process.env) {
const keyFile = env.CREDENTIALS_DIRECTORY ? join(env.CREDENTIALS_DIRECTORY, 'resend.key') : r.keyFile;

const doors = createMailDoors({
  settings: () => readSettings(r.settingsFile),
  key: () => readKey(keyFile),
  fetch,
  panelOrigin: r.panelOrigin,
  names: r.names,
  domain: r.domain,
  noticesPerDay: r.noticesPerDay,
  visitorsPerDay: r.visitorsPerDay,
  now: () => Math.floor(Date.now() / 1000),
  log: (line) => console.log(line),
});

const server = doors.panel;
// the sockets systemd hands over, by name (LISTEN_FDNAMES): the one ending -visitor.socket
// is the gate's; any other (or a lone unnamed one) the panel's, as before
let visitorDoor = false;
if (env.LISTEN_PID === String(process.pid) && Number(env.LISTEN_FDS ?? 0) >= 1) {
  const names = (env.LISTEN_FDNAMES ?? '').split(':');
  for (let i = 0; i < Number(env.LISTEN_FDS); i++) {
    if (names[i]?.endsWith('-visitor.socket')) { doors.visitor.listen({ fd: 3 + i }); visitorDoor = true; } else server.listen({ fd: 3 + i });
  }
} else if (env.MAIL_SOCKET) {
  try { unlinkSync(env.MAIL_SOCKET); } catch { /* not there */ }
  server.listen(env.MAIL_SOCKET, () => chmodSync(env.MAIL_SOCKET!, 0o600));
  if (env.MAIL_VISITOR_SOCKET) {
    try { unlinkSync(env.MAIL_VISITOR_SOCKET); } catch { /* not there */ }
    doors.visitor.listen(env.MAIL_VISITOR_SOCKET, () => chmodSync(env.MAIL_VISITOR_SOCKET!, 0o600));
    visitorDoor = true;
  }
} else {
  console.error('mail: no socket (expected systemd socket activation or MAIL_SOCKET)');
  process.exit(2);
}
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (visitorDoor) doors.visitor.close();
    server.close(() => process.exit(0));
  });
}
}
