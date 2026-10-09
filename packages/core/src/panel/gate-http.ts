// Asking the gate over its HTTP port, the way one of her pages would (N4 in
// docs/refactor-plan.md). The panel's other conversations with the gate go over
// the admin socket (ctx.gate); this is for the tutorial examples, which have to
// get exactly the answers a visitor's browser would get from her website.
//
// One client, one timeout, one way of reading the answer: there were two
// hand-written ones before, and they had already drifted apart.
import { request as httpRequest } from 'node:http';
import type { FastifyReply } from 'fastify';
import type { PanelCtx } from './context.ts';
import { edgeHeaders } from '../security.ts';

export type GateAnswer = { status: number; json: unknown };

const TIMEOUT = 15_000;

export function gateHttp(ctx: PanelCtx) {
  const { config } = ctx;
  // her site's name as the gate knows it
  const siteDomain = config.site.domain;

  // The bytes the gate sends back, whatever they are (a script, a page).
  const fetchBytes = (path: string) => new Promise<{ status: number; bytes: Buffer }>((resolve, reject) => {
    const u = new URL(config.gateUrl);
    const r = httpRequest({
      host: u.hostname, port: u.port, path, timeout: TIMEOUT,
      headers: { host: siteDomain, 'x-pammy-base': '/' },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 502, bytes: Buffer.concat(chunks) }));
    });
    r.on('timeout', () => r.destroy(new Error('the gate did not answer')));
    r.on('error', reject);
    r.end();
  });

  // An API question, with a key or a visitor's origin if there is one.
  const ask = (method: 'GET' | 'POST', path: string, o: { key?: string; body?: unknown; origin?: string; ip?: string } = {}) =>
    new Promise<GateAnswer>((resolve, reject) => {
      const u = new URL(config.gateUrl);
      const payload = o.body === undefined ? null : JSON.stringify(o.body);
      const req = httpRequest({
        host: u.hostname, port: u.port, method, path, timeout: TIMEOUT,
        headers: {
          host: siteDomain, 'x-pammy-base': '/', 'x-real-ip': o.ip ?? '127.0.0.1', ...edgeHeaders(),
          ...(o.key ? { authorization: `Bearer ${o.key}` } : {}),
          ...(o.origin ? { origin: o.origin } : {}),
          ...(payload !== null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          let json: unknown = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
          resolve({ status: res.statusCode ?? 502, json: json ?? { error: 'gate', message: 'The example could not be read just now.' } });
        });
      });
      req.on('timeout', () => req.destroy(new Error('the gate did not answer')));
      req.on('error', reject);
      if (payload !== null) req.write(payload);
      req.end();
    });

  // What the panel sends back to the example's page: the gate's own answer,
  // never cached, and "try again in a minute" if the gate is not there.
  const answer = async (reply: FastifyReply, got: Promise<GateAnswer>) => {
    try {
      const r = await got;
      return reply.code(r.status).header('Cache-Control', 'private, no-store').send(r.json);
    } catch {
      return reply.code(503).send({ error: 'gate', message: 'The example could not be reached just now. Try again in a moment.' });
    }
  };

  return { siteDomain, ask, answer, fetchBytes };
}
