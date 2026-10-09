// What the Getting started checks read (docs/getting-started-plan.md G1): the
// site as it is now, gathered once per request. The panel's own tables are read
// directly; the gate's (forms, the pages they were seen on, protected folders)
// through its admin socket, as the other routes do; her files through the
// website helper; her own databases through the database helper, and only when
// `deep` (the Getting started page, never Home).
import type { Engine } from '@panel/studio/pammydb/ident';
import { all, type Db } from '@panel/core/pg';

export type DbFact = {
  id: number; engine: Engine; name: string; title: string; active: boolean; adoptedAt: number;
  example: string | null; copiedFrom: 'recipes' | 'blog' | null; page: string | null; copiedRows: boolean;
};
export type TableFact = { databaseId: number; table: string; enabled: boolean | null; publicRead: boolean; visitorArea: number | null; canCreate: boolean };
export type FormFact = {
  id: number; name: string; title: string; kind: 'form' | 'comments'; contentType: string | null; fixture: string | null;
  enabled: boolean; publicApproved: boolean; autoApprove: boolean; createdAt: number;
  responses: number; approved: number; pages: string[]; keys: string[];
};
export type AreaFact = { id: number; path: string; createdAt: number; visitors: number };
export type FormLinkFact = { formId: number; table: string; enabled: boolean; when: string; mode: string };

export type Facts = {
  deep: boolean;
  databases: DbFact[];
  tables: TableFact[];
  forms: FormFact[];
  areas: AreaFact[];
  // media files present, by kind (images, audio, video, files, ...)
  media: Record<string, number>;
  // the forms that save into one of her databases (asked of the gate once per database)
  formLinks: (databaseId: number) => Promise<FormLinkFact[]>;
  // null: the website helper did not answer
  pageThere: (path: string) => Promise<boolean | null>;
  // how many records a table holds; null when not deep, or her database did not answer in time
  count: (engine: Engine, name: string, table: string) => Promise<number | null>;
};

// The gate's answers, as far as the checks need them.
type GateForm = {
  id: number; name: string; title: string; kind?: 'form' | 'comments'; contentType?: string | null; fixture: string | null;
  enabled: boolean; publicApproved: boolean; autoApprove: boolean; createdAt: number; trashedAt: number | null;
  responses: number; approved: number; pages: { page: string }[]; items: { key?: string }[];
};
type GateArea = { id: number; path: string; createdAt: number; visitors: number[] };

export type FactSources = {
  db: Db;
  deep: boolean;
  gate: <T>(req: Record<string, unknown>) => Promise<T>;
  helper: <T>(req: Record<string, unknown>) => Promise<T>;
  studio: <T>(req: Record<string, unknown>) => Promise<T>;
  actor: string;
  // how long her own database may take before a step says "can't tell right now"
  countTimeoutMs?: number;
};

export async function gatherFacts(src: FactSources): Promise<Facts> {
  const { db } = src;
  const [databases, tables, mediaRows, forms, areas] = await Promise.all([
    all<{ id: number; engine: Engine; name: string; display_name: string; status: string; adopted_at: number; example: string | null; copied_from: 'recipes' | 'blog' | null; page: string | null; copied_rows: boolean }>(db,
      'SELECT id, engine, name, display_name, status, adopted_at, example, copied_from, page, copied_rows FROM studio_databases ORDER BY adopted_at DESC, id DESC'),
    all<{ database_id: number; table_name: string; enabled: boolean | null; public_read: boolean; visitor_area: number | null; can_create: boolean }>(db,
      'SELECT database_id, table_name, enabled, public_read, visitor_area, can_create FROM studio_resources'),
    all<{ kind: string; n: number }>(db, "SELECT kind, count(*) AS n FROM records WHERE state = 'present' GROUP BY kind"),
    src.gate<{ forms: GateForm[] }>({ op: 'forms.state' }).then((s) => s.forms),
    src.gate<{ areas: GateArea[] }>({ op: 'state' }).then((s) => s.areas),
  ]);

  const linkCache = new Map<number, Promise<FormLinkFact[]>>();
  const pageCache = new Map<string, Promise<boolean | null>>();
  return {
    deep: src.deep,
    databases: databases.map((d) => ({
      id: d.id, engine: d.engine, name: d.name, title: d.display_name || d.name, active: d.status === 'active', adoptedAt: d.adopted_at,
      example: d.example, copiedFrom: d.copied_from, page: d.page, copiedRows: d.copied_rows,
    })),
    tables: tables.map((t) => ({ databaseId: t.database_id, table: t.table_name, enabled: t.enabled, publicRead: t.public_read, visitorArea: t.visitor_area, canCreate: t.can_create })),
    forms: forms.filter((f) => !f.trashedAt).map((f) => ({
      id: f.id, name: f.name, title: f.title, kind: f.kind ?? 'form', contentType: f.contentType ?? null, fixture: f.fixture,
      enabled: f.enabled, publicApproved: f.publicApproved, autoApprove: f.autoApprove, createdAt: f.createdAt,
      responses: f.responses, approved: f.approved,
      pages: f.pages.map((p) => p.page.replace(/^\/+/, '')),
      keys: f.items.map((i) => i.key).filter((k): k is string => typeof k === 'string'),
    })),
    areas: areas.map((a) => ({ id: a.id, path: a.path.replace(/^\/+|\/+$/g, ''), createdAt: a.createdAt, visitors: a.visitors.length })),
    media: Object.fromEntries(mediaRows.map((r) => [r.kind, r.n])),
    formLinks(databaseId) {
      let p = linkCache.get(databaseId);
      if (!p) {
        p = src.gate<{ links: { formId: number; table: string; enabled: boolean | number; when: string; mode: string }[] }>({ op: 'formlinks.for-database', databaseId })
          .then((r) => r.links.map((l) => ({ formId: l.formId, table: l.table, enabled: !!l.enabled, when: l.when, mode: l.mode })))
          .catch(() => []);
        linkCache.set(databaseId, p);
      }
      return p;
    },
    pageThere(path) {
      let p = pageCache.get(path);
      if (!p) {
        const cut = path.lastIndexOf('/');
        const dir = cut < 0 ? '' : path.slice(0, cut);
        const file = path.slice(cut + 1);
        p = src.helper<{ files: { name: string }[] }>({ op: 'files-list', dir, actor: src.actor })
          .then((r) => r.files.some((f) => f.name === file))
          // a folder that is not there any more is an answer, not a failure
          .catch((e: unknown) => ((e as { status?: number }).status === 404 ? false : null));
        pageCache.set(path, p);
      }
      return p;
    },
    async count(engine, name, table) {
      if (!src.deep) return null;
      const ask = src.studio<{ total: number }>({
        op: 'list-rows', engine, name, actor: src.actor,
        query: { table, columns: ['id'], limit: 1, offset: 0, order: null, search: null, filters: [] },
      }).then((r) => r.total).catch(() => null);
      const late = new Promise<null>((r) => { setTimeout(() => r(null), src.countTimeoutMs ?? 2000).unref(); });
      return Promise.race([ask, late]);
    },
  };
}
