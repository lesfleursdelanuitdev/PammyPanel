// What the gate keeps in memory so that "may this be served?" doesn't wait for
// Postgres (docs/postgres-plan.md P14, option b):
//
// - the protected folders (areas): the whole table, with what anyone may do in
//   each (its "not signed in" slot's privileges), reloaded after every change
//   the gate makes and every 60 s, and saved to a small file, so the gate can
//   answer from the moment it starts, even before Postgres is up; with them,
//   the visitor settings (visitor-settings.ts), in the same file;
// - visitor sessions it has checked lately: people's cache (people/src/gate/session-cache.ts,
//   docs/k-a-plan.md K-a2), which the host hands in as a SessionSource; GateLive asks it
//   who is signed in, and tells it to forget when something changes.
//
// Unprotected pages never touch Postgres at all (app.ts asks for the visitor only
// when a protection applies). The gate is the only writer of its tables (the
// panel goes through the admin socket), so its own changes clear what's kept
// here at once; the 60 s reload is for anything done by hand.
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { all, checkSchema, one, PgUnavailable, type Sql } from '../pg.ts';
import type { Access, Area } from './types.ts';
import { ALL_OFF, settingsOf, type VisitorSettings } from './visitor-settings.ts';
import type { SiteRoutes } from './site-routes.ts';

export type { Access } from './types.ts';

export interface AreaLookup {
  byToken(token: string): Area | undefined;
  byPath(path: string): Area | undefined;
  // on a site with hosts (docs/phase8-plan.md 8-2, P8-4): the areas of the routes with
  // accounts that show this site folder, null for a token the gate doesn't know (locked)
  routeAreasOf?(folder: string): (Area | null)[];
}

// Who is signed in, for the gate: a module's (people's visitor sessions) handed in by the
// host. It checks a session token on this host, from memory when it can; forget drops one
// token, forgetVisitor one visitor's sessions, forgetAll everything kept (after a change to who may open what).
export interface SessionSource {
  visitorFor(token: string | null, host: string): Promise<Access | null>;
  forget(token: string): void;
  forgetVisitor(visitorId: number): void;
  forgetAll(): void;
}
// What a session source is given: the gate's database, its clock, and whether Postgres
// has been reached with the schema this code expects (GateLive.ready).
export type SessionDeps = { db: Sql; now: () => number; ready: () => boolean };

export type LiveOptions = {
  now: () => number;                        // unix seconds (the gate's clock)
  snapshot?: string;                        // where the areas are saved between starts
  log?: (line: string) => void;
  // the site's routes, on a site with hosts (site-routes.ts): none on pammy.org
  routes?: SiteRoutes | null;
  // who is signed in (people's visitorSessions: docs/k-a-plan.md K-a2)
  sessions: (deps: SessionDeps) => SessionSource;
};

export class GateLive implements AreaLookup {
  readonly db: Sql;
  #opts: LiveOptions;
  #areas: { byToken: Map<string, Area>; byPath: Map<string, Area>; json: string } | null = null;
  // all off until Postgres or a saved copy says otherwise (docs/accounts-plan.md A5)
  #settings: { s: VisitorSettings; json: string } = { s: ALL_OFF, json: JSON.stringify(ALL_OFF) };
  #sessions: SessionSource;
  #ready = false;
  #timers: NodeJS.Timeout[] = [];
  #stopped = false;

  constructor(db: Sql, opts: LiveOptions) {
    this.db = db;
    this.#opts = opts;
    this.#sessions = opts.sessions({ db, now: opts.now, ready: () => this.#ready });
    if (opts.snapshot) this.#loadSnapshot(opts.snapshot);
  }

  // Postgres has been reached and has the schema this code expects.
  get ready() { return this.#ready; }
  get areasKnown() { return this.#areas !== null; }

  // Reach Postgres and check its schema, retrying with backoff until it works;
  // then keep the areas fresh. onReady runs once, when it first works.
  start(onReady?: () => Promise<void>) {
    let wait = 1;
    const attempt = async () => {
      if (this.#stopped) return;
      try {
        await checkSchema(this.db);
        this.#ready = true;
        await this.reloadAreas();
        this.#log('database ready');
        if (onReady) await onReady();
        this.#timers.push(setInterval(() => void this.reloadAreas().catch((e) => this.#log(`reloading the areas failed: ${(e as Error).message}`)), 60_000).unref());
      } catch (e) {
        this.#ready = false;
        this.#log(`database not ready (retrying in ${wait}s): ${(e as Error).message}`);
        this.#timers.push(setTimeout(() => void attempt(), wait * 1000).unref());
        wait = Math.min(wait * 2, 30);
      }
    };
    void attempt();
  }

  stop() {
    this.#stopped = true;
    for (const t of this.#timers) clearTimeout(t);
  }

  // Tests, and anything else that has checked the schema itself.
  markReady() { this.#ready = true; }

  // ---------------------------------------------------------------- areas
  byToken(token: string) { return this.#need().byToken.get(token); }
  byPath(path: string) { return this.#need().byPath.get(path); }

  // ---------------------------------------------------------------- routes (8-2)
  get siteRoutes(): SiteRoutes | null { return this.#opts.routes ?? null; }

  // Only on a site with hosts; a route's token the gate has no area for locks the
  // folder rather than opening it (the route and the area are made together).
  routeAreasOf(folder: string): (Area | null)[] {
    const routes = this.#opts.routes;
    if (!routes) return [];
    return routes.areasOverFolder(folder).map((t) => {
      const a = this.byToken(t);
      return a && a.kind === 'route' ? a : null;
    });
  }

  #need() {
    if (!this.#areas) throw new PgUnavailable('the protected folders are not known yet');
    return this.#areas;
  }

  // ---------------------------------------------------------------- visitor settings
  // What visitors may do for themselves: from memory, never waiting.
  get visitorSettings(): VisitorSettings { return this.#settings.s; }

  // The areas and the visitor settings, together.
  async reloadAreas() {
    const rows = await all<Area>(this.db, `SELECT a.*, coalesce((SELECT string_agg(p.privilege, ' ' ORDER BY p.privilege)
        FROM roles r JOIN role_all_privileges p ON p.role_id = r.id WHERE r.role_set_id = a.role_set_id AND r.slot = 'not-signed-in'), '') AS guest_privileges
      FROM areas a ORDER BY a.id`);
    const settings = settingsOf(await one<Record<string, unknown>>(this.db, 'SELECT * FROM visitor_settings WHERE id = 1'));
    this.#setAreas(rows, settings);
  }

  #setAreas(rows: Area[], settings: VisitorSettings) {
    const json = JSON.stringify(rows), sjson = JSON.stringify(settings);
    if (this.#areas?.json === json && this.#settings.json === sjson) return;
    if (this.#areas?.json !== json) {
      // a route's area (docs/roles-plan.md step 5) is found by its token only, never by a folder's path
      this.#areas = { byToken: new Map(rows.map((a) => [a.token, a])), byPath: new Map(rows.filter((a) => a.kind !== 'route').map((a) => [a.path, a])), json };
    }
    this.#settings = { s: settings, json: sjson };
    if (this.#opts.snapshot) this.#saveSnapshot(this.#opts.snapshot, json, sjson);
  }

  #loadSnapshot(file: string) {
    try {
      // a copy saved before there were visitor settings: all off
      const saved = JSON.parse(readFileSync(file, 'utf8')) as { areas: Area[]; visitorSettings?: Record<string, unknown> };
      if (Array.isArray(saved.areas)) this.#setAreas(saved.areas, settingsOf(saved.visitorSettings, false));
    } catch { /* none yet, or unreadable: wait for Postgres */ }
  }

  #saveSnapshot(file: string, json: string, sjson: string) {
    try {
      writeFileSync(`${file}.new`, `{"savedAt":${this.#opts.now()},"areas":${json},"visitorSettings":${sjson}}\n`, { mode: 0o600 });
      chmodSync(`${file}.new`, 0o600);
      renameSync(`${file}.new`, file);
    } catch (e) {
      this.#log(`couldn't save the areas snapshot: ${(e as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- sessions
  // Who is signed in on this host (the session source's, from memory when it can).
  visitorForSession(token: string | null, host: string): Promise<Access | null> {
    return this.#sessions.visitorFor(token, host);
  }

  forgetSession(token: string) {
    this.#sessions.forget(token);
  }

  // After anything that changes who may open what: areas, roles, a visitor
  // switched off or deleted, sessions revoked. Nothing kept can outlive it.
  // visitor: the change was to that one visitor only (their password, their sessions,
  // switched off or deleted, their role somewhere): only their sessions are forgotten
  // (review P2). Without it, everyone's.
  async changed(opts: { visitor?: number } = {}) {
    if (opts.visitor !== undefined) this.#sessions.forgetVisitor(opts.visitor);
    else this.#sessions.forgetAll();
    try {
      await this.reloadAreas();
    } catch (e) {
      // Only if Postgres went away just after the change. Kept areas are then too
      // strict (a deleted or moved folder stays protected; a new one's marker
      // locks it), except a new folder with no marker at all -- the panel always
      // writes one -- which waits for the 60 s reload.
      this.#log(`reloading the areas failed: ${(e as Error).message}`);
    }
  }

  #log(line: string) { this.#opts.log?.(`gate: ${line}`); }
}
