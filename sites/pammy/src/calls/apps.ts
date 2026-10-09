// Send one request to the software helper and print the reply.
// Used by the installer and verify-apps.sh (as each user that should and should not get in):
//   runuser -u svc-pammypanel -- node /opt/pammy-panel/src/apps/call.ts '{"op":"list"}'
// Exit 0 = the helper said ok, 1 = it refused, 2 = couldn't reach it.
import { callApps, AppsCallError } from '@panel/apps/apps/client';
import { PROFILE } from '../profile.ts';

const socket = process.env.APPS_SOCKET ?? PROFILE.services.sockets.apps;
try {
  const result = await callApps(socket, JSON.parse(process.argv[2] ?? '{"op":"list"}'));
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  if (!(e instanceof AppsCallError)) throw e;
  console.error(`${e.code}: ${e.message}`);
  process.exitCode = e.code === 'unavailable' || e.code === 'timeout' ? 2 : 1;
}
