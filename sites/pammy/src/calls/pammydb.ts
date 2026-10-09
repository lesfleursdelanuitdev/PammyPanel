// Send one request to the database helper and print the reply.
// Used by verify-panel.sh (as each user that should and should not get in):
//   runuser -u svc-pammypanel -- node /opt/pammy-panel/src/pammydb/call.ts '{"op":"list-databases"}'
// Exit 0 = the helper said ok, 1 = it refused, 2 = couldn't reach it.
import { callPammyDb, PammyDbCallError } from '@panel/studio/pammydb/client';
import { PROFILE } from '../profile.ts';

const socket = process.env.PAMMYDB_SOCKET ?? PROFILE.services.sockets.pammydb;
try {
  const result = await callPammyDb(socket, JSON.parse(process.argv[2] ?? '{"op":"list-databases"}'));
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  if (!(e instanceof PammyDbCallError)) throw e;
  console.error(`${e.code}: ${e.message}`);
  process.exitCode = e.code === 'unavailable' || e.code === 'timeout' ? 2 : 1;
}
