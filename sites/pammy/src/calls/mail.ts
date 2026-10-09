// Send one request to pammy-mail and print the reply. Used by the installer and
// verify-mail checks:  runuser -u svc-pammypanel -- node /opt/pammy-panel/src/mail/call.ts '{"op":"status"}'
// Exit 0 = ok, 1 = refused, 2 = couldn't reach it.
import { callMail, MailCallError } from '@panel/mail/mail/client';
import { PROFILE } from '../profile.ts';

const socket = process.env.MAIL_SOCKET ?? PROFILE.services.sockets.mail;
try {
  console.log(JSON.stringify(await callMail(socket, JSON.parse(process.argv[2] ?? '{"op":"status"}')), null, 2));
} catch (e) {
  if (!(e instanceof MailCallError)) throw e;
  console.error(`${e.code}: ${e.message}`);
  process.exitCode = e.code === 'unavailable' || e.code === 'timeout' ? 2 : 1;
}
