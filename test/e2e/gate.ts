// Everything under /_pammy/ in a browser test is the gate itself, which
// test/e2e/server.ts runs on its own port. node:http, not fetch, because the
// gate wants a Host of pammy.org and fetch will not send one -- these are the
// headers nginx sets in front of it.
import { request as httpRequest } from 'node:http';
import type { Page } from '@playwright/test';

const GATE_PORT = 3197;

const askTheGate = (method: string, path: string, body: string | null, type: string | null) =>
  new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1', port: GATE_PORT, method, path,
      headers: {
        host: 'pammy.org', 'x-pammy-base': '/', origin: 'https://pammy.org', 'x-real-ip': '198.51.100.9',
        ...(body !== null ? { 'content-type': type ?? 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 500, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });

export const routeGate = (page: Page) =>
  page.route('**/_pammy/**', async (route) => {
    const url = new URL(route.request().url());
    const post = route.request().postData();
    const res = await askTheGate(route.request().method(), `${url.pathname}${url.search}`, post ?? null, route.request().headers()['content-type'] ?? null);
    return route.fulfill({
      status: res.status,
      headers: {
        'content-type': String(res.headers['content-type'] ?? 'text/plain'),
        ...(res.headers.location ? { location: String(res.headers.location) } : {}),
      },
      body: res.body,
    });
  });
