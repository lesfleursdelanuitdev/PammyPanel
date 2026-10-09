// A site's database helper (pammy-pammydb.service, lfdln-pammydb.service): the only thing
// that speaks to the site's studio engines (config.ts). It needs loopback network, so its
// unit must NOT have PrivateNetwork=yes, and all it holds is the studio passwords. It
// listens on the socket systemd hands it (<unit>.socket, which the site's clients group may
// open), or on PAMMYDB_SOCKET when run by hand for testing. The gate's helper is the same
// code started with door 'gate' (main-gate.ts, <site>-pammydb-gate.service, S2): its socket
// only the gate's user may open, and it answers row ops only (service.ts GATE_OPS).
import { chmodSync, unlinkSync } from 'node:fs';
import { loadHelperConfig, type HelperSite } from './config.ts';
import { createMariaDriver } from './maria.ts';
import type { Drivers } from './ops.ts';
import { createPgDriver } from './pg.ts';
import { createPammyDbServer, GATE_MAX_OPEN, type Door } from './service.ts';

export function startPammyDb(site: HelperSite, env: NodeJS.ProcessEnv = process.env, door: Door = 'panel') {
  // A refused port or a missing password is a configuration mistake: say so and
  // stop, rather than answering requests it can never serve.
  let cfg;
  try {
    cfg = loadHelperConfig(env, site);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
  // the gate's helper keeps at most GATE_MAX_OPEN databases open per engine (S2 review L1)
  const opts = door === 'gate' ? { maxOpen: GATE_MAX_OPEN } : {};
  const drivers: Drivers = {
    ...(cfg.postgres ? { postgres: createPgDriver(cfg.postgres, site.rules?.postgres, opts) } : {}),
    ...(cfg.mariadb ? { mariadb: createMariaDriver(cfg.mariadb, site.rules?.mariadb, opts) } : {}),
  };
  console.log(`${site.name}: ${[cfg.postgres && `postgres ${cfg.postgres.host}:${cfg.postgres.port}`, cfg.mariadb && `mariadb ${cfg.mariadb.host}:${cfg.mariadb.port}`].filter(Boolean).join(', ')}, as ${(cfg.postgres ?? cfg.mariadb)?.user}${door === 'gate' ? "; the gate's door: row ops only" : ''}`);

  const server = createPammyDbServer(drivers, (line) => console.log(line), door);
  if (env.LISTEN_FDS === '1' && env.LISTEN_PID === String(process.pid)) {
    server.listen({ fd: 3 });
  } else if (env.PAMMYDB_SOCKET) {
    try { unlinkSync(env.PAMMYDB_SOCKET); } catch { /* not there */ }
    server.listen(env.PAMMYDB_SOCKET, () => chmodSync(env.PAMMYDB_SOCKET!, 0o600));
  } else {
    console.error(`${site.name}: no socket (expected systemd socket activation or PAMMYDB_SOCKET)`);
    process.exit(2);
  }
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      server.close(() => Promise.all(Object.values(drivers).map((d) => d!.close())).then(() => process.exit(0), () => process.exit(0)));
    });
  }
}
