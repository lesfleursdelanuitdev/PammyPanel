// Send one request to the website folder helper and print the reply.
// Used by verify-panel.sh (as svc-pammypanel) and for debugging:
//   runuser -u svc-pammypanel -- node /opt/pammy-panel/src/sitefs/call.ts '{"op":"list"}'
// Exit 0 = the helper said ok, 1 = it refused, 2 = couldn't reach it.
import { callSiteFs, SiteFsCallError } from '@panel/files/sitefs/client';
import { PROFILE } from '../profile.ts';

const socket = process.env.SITEFS_SOCKET ?? PROFILE.services.sockets.sitefs;
try {
  const result = await callSiteFs(socket, JSON.parse(process.argv[2] ?? '{"op":"list"}'));
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  if (!(e instanceof SiteFsCallError)) throw e;
  console.error(`${e.code}: ${e.message}`);
  process.exitCode = e.code === 'unavailable' || e.code === 'timeout' ? 2 : 1;
}
