// What the studio package adds to the panel's context (docs/packaging-plan.md step
// 1a): reading an engine, a database, a table or a field out of an address, and an
// app's name out of a form; and which databases are the panel's examples (the
// examples package says, through the site: step 1d).
import type { FastifyRequest } from 'fastify';
import { AccountError } from '@panel/core/accounts';
import { isEngine, NAME_RE, type Engine } from '../pammydb/ident.ts';
import type { PanelCtx } from '@panel/core/panel/context';
import type { Words } from '@panel/core/profile';
import type { RecordKeeper } from './tagging.ts';

export type StudioParams = {
  engineParam: (req: FastifyRequest) => Engine;
  dbNameParam: (req: FastifyRequest) => string;
  tableParam: (req: FastifyRequest) => string;
  fieldParam: (req: FastifyRequest) => string;
  appNameOf: (v: unknown) => string;
} & ExampleGuard;
export type ExampleGuard = {
  // names kept for the example databases, refused for new ones
  exampleNames: ReadonlySet<string>;
  // throws when that database is one of the examples, which can't be `doing`
  refuseExample: (engine: Engine, name: string, doing: string) => Promise<void>;
};
// keeper: her records in the catalog (docs/catalog-plan.md step 4), with the catalog on
export type StudioCtx = PanelCtx & StudioParams & { keeper?: RecordKeeper };

export function studioParams(guard: ExampleGuard, words: Words): StudioParams {
  const app = words.app.one;
  const named = (v: unknown): string => {
    // an address the engines could not name is simply not a page
    if (typeof v !== 'string' || !NAME_RE.test(v)) throw new AccountError('Not found.', 404);
    return v;
  };
  return {
    ...guard,
    engineParam(req) {
      const v = (req.params as { engine?: string }).engine;
      // an address with an engine the panel doesn't have is simply not a page
      if (!isEngine(v)) throw new AccountError('Not found.', 404);
      return v;
    },
    dbNameParam: (req) => named((req.params as { name?: string }).name),
    tableParam: (req) => named((req.params as { table?: string }).table),
    fieldParam: (req) => named((req.params as { field?: string }).field),
    appNameOf(v) {
      if (typeof v !== 'string') throw new AccountError(`Please type a name for the ${app}, or leave it empty.`, 400);
      const s = v.trim().replace(/\s+/g, ' ');
      if (s.length > 60) throw new AccountError(`${app[0]!.toUpperCase()}${app.slice(1)} names can be at most 60 characters.`, 400);
      return s;
    },
  };
}
