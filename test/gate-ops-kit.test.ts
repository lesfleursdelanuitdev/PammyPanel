// The gate-op kit (docs/k-a-plan.md K-a1; module-dependency-graph section 3): the errors and
// input cleaning every gate op uses, and the gate's event log. Pinned word for word before
// K-a names it and keeps it in the kernel, so the move changes nothing ten modules rely on.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import Fastify from 'fastify';
import { all, type Sql } from '@panel/core/pg';
import { migrate } from '@panel/core/pg-migrate';
import { gateCtx } from '@panel/core/gate/context';
import type { GateLive } from '@panel/core/gate/live';
import { cleanBy, cleanLine, cleanMessage, GateError, int, logEvent } from '@panel/core/gate/ops';
import { startPg, type PgTest } from './pg-harness.ts';

describe('the gate-op kit: cleaning what people type', () => {
  it('cleanLine: one line, no control characters, white space squeezed, trimmed, capped in characters', () => {
    assert.equal(cleanLine('  Jo \t Smith \n ', 60), 'Jo Smith');
    assert.equal(cleanLine('a\x00b\x07c\x7fd', 60), 'a b c d');
    assert.equal(cleanLine('line one\r\nline two', 60), 'line one line two');
    assert.equal(cleanLine('abcdef', 3), 'abc');
    // counted in code points, so an emoji is never cut in half
    assert.equal(cleanLine('😀😀😀😀', 2), '😀😀');
    // NFC: e + combining acute becomes é (one character)
    assert.equal(cleanLine('é', 1), 'é');
    for (const v of [undefined, null, 42, {}, ['x'], true]) assert.equal(cleanLine(v, 10), '');
    assert.equal(cleanLine('   ', 10), '');
  });

  it('cleanMessage: keeps line breaks, CRLF to LF, at most one blank line, trailing spaces gone, capped', () => {
    assert.equal(cleanMessage('Hello\r\nthere  \r\n\r\n\r\n\r\nbye\t', 1000), 'Hello\nthere\n\nbye');
    assert.equal(cleanMessage('a\x00b\x0bc\x1fd\x7fe', 100), 'a b c d e');
    // tabs become spaces; leading spaces of a line stay (only the ends of lines are trimmed)
    assert.equal(cleanMessage('one\n\ttwo', 100), 'one\n two');
    assert.equal(cleanMessage('\n\n  hi  \n\n', 100), 'hi');
    assert.equal(cleanMessage('😀😀😀', 2), '😀😀');
    assert.equal(cleanMessage('abc\rdef', 100), 'abc\ndef');
    for (const v of [undefined, null, 7, {}]) assert.equal(cleanMessage(v, 10), '');
  });

  it('cleanBy: who did it, as the panel names them: a line of at most 40, or null', () => {
    assert.equal(cleanBy('  momolig '), 'momolig');
    assert.equal(cleanBy('x'.repeat(50)), 'x'.repeat(40));
    for (const v of ['', '   ', undefined, null, 3]) assert.equal(cleanBy(v), null);
  });

  it('int: a safe whole number, or null', () => {
    assert.equal(int(0), 0);
    assert.equal(int(-12), -12);
    assert.equal(int(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
    for (const v of [1.5, '3', NaN, Infinity, 2 ** 53, null, undefined, [1]]) assert.equal(int(v), null);
  });
});

describe('the gate-op kit: GateError', () => {
  it('carries a code, its message, and the field when there is one', () => {
    const e = new GateError('invalid', 'Please type a password.', 'password');
    assert.ok(e instanceof Error);
    assert.equal(e.code, 'invalid');
    assert.equal(e.message, 'Please type a password.');
    assert.equal(e.field, 'password');
    const f = new GateError('not-found', 'Gone.');
    assert.equal(f.field, undefined);
  });

  it('becomes the same answer through the gate context, for every code', async () => {
    const app = Fastify();
    const ctx = gateCtx(app, { publicRoot: '/nowhere', domain: 'pammy.org', now: () => 0, mediaIndex: '', mediaThumbs: '', pammydbSocket: '' }, {} as GateLive);
    const codes = { invalid: 400, exists: 409, 'not-found': 404, closed: 403, full: 503, stale: 409, unavailable: 503 } as const;
    app.get('/:code', async (req, reply) => {
      const code = (req.params as { code: keyof typeof codes }).code;
      return ctx.refuse(reply, new GateError(code, `said ${code}`, code === 'invalid' ? 'name' : undefined));
    });
    app.get('/other', async (_req, reply) => ctx.refuse(reply, new Error('not a gate error')));
    for (const [code, status] of Object.entries(codes)) {
      const res = await app.inject({ url: `/${code}` });
      assert.equal(res.statusCode, status, code);
      assert.deepEqual(res.json(), { error: code, message: `said ${code}`, ...(code === 'invalid' ? { field: 'name' } : {}) });
    }
    // anything else is thrown on, to the error handler
    assert.equal((await app.inject({ url: '/other' })).statusCode, 500);
    await app.close();
  });
});

describe('the gate-op kit: the event log', () => {
  let pg: PgTest;
  let db: Sql;
  before(async () => {
    pg = await startPg();
    const database = pg.freshDatabase();
    const owner = pg.connect('owner', database, 1);
    await migrate(owner);
    await owner.end();
    db = pg.connect('gate', database, 2);
  });
  after(async () => {
    await db?.end({ timeout: 1 });
    pg?.stop();
  });

  it('writes one row per event, the username cut at 80, the rest null when not given', async () => {
    await logEvent(db, 1_800_000_000, 'login-failed', { username: 'u'.repeat(100), host: 'pammy.org', ip: '198.51.100.1' });
    await logEvent(db, 1_800_000_001, 'request-spam', {});
    const rows = await all<Record<string, unknown>>(db, 'SELECT at, visitor_id, username, area_id, event, host, ip FROM events ORDER BY id');
    assert.deepEqual(rows.map((r) => ({ ...r })), [
      { at: 1_800_000_000, visitor_id: null, username: 'u'.repeat(80), area_id: null, event: 'login-failed', host: 'pammy.org', ip: '198.51.100.1' },
      { at: 1_800_000_001, visitor_id: null, username: null, area_id: null, event: 'request-spam', host: null, ip: null },
    ]);
  });
});
