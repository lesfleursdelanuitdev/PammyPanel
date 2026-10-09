// For test/run-adopt-nginx-test.sh (docs/adopt-plan.md step 1): renders the panel's
// files for the takeovers (packages/hosts/src/takeover.ts), or, with "compare", runs a
// stand-in for TutorStar and sends every takeover's requests to both nginx servers --
// the hand-written files and the rendered ones -- and compares every answer.
//   node test/adopt-compare.ts render <out> <sites-root> <http> <https> <cert> <key> <backend-port> <uploads>
//   node test/adopt-compare.ts compare <sites-root> <old-http> <old-https> <new-http> <new-https> <backend-port> <uploads>
//
// <uploads>: the harness's stand-in for /mnt/storage/uploads (Gonsalves's media, step 7)
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { hostsConfigOf } from '@panel/lfdln/hosts';
import { renderAll, type Table } from '@panel/hosts/render';
import { compare, fullName, probe, TAKEOVERS, type Answer } from '@panel/hosts/takeover';
import { domainsFor, probeDirOf, servedIn } from './adopt-compare-lib.ts';
import { PROFILE } from './fixtures/lfdln-profile.ts';
import { edgeFile } from './edge-file.ts';


const [mode, ...a] = process.argv.slice(2);
const D = 'lesfleursdelanuit.com';

if (mode === 'render') {
  const [out, sitesRoot, http, https, cert, key, backend, uploads] = a as [string, string, string, string, string, string, string, string];
  const table: Table = {
    hosts: TAKEOVERS.map((t) => t.host),
    folders: TAKEOVERS.flatMap((t) => (t.folder ? [{ name: t.folder.name, runPhp: t.folder.runPhp }] : [])),
    routes: TAKEOVERS.flatMap((t) => t.routes),
    // the stand-in answers where TutorStar would
    services: TAKEOVERS.flatMap((t) => t.services ?? []).map((s) => ({ ...s, port: Number(backend) })),
    domains: domainsFor(cert, key),
  };
  const cfg = {
    ...hostsConfigOf(PROFILE, out),
    dir: out, sitesRoot, edge: edgeFile(dirname(out)),
    tls: { cert, key, include: ['/etc/letsencrypt/options-ssl-nginx.conf'], dhparam: '/etc/letsencrypt/ssl-dhparams.pem' },
    tlsRoots: [`${dirname(cert)}/`, '/etc/letsencrypt/'],
    php: { socket: `${out}/no-php.sock` },
    listen: { http: `127.0.0.1:${http}`, https: `127.0.0.1:${https}`, v6: false },
    signInZone: 'login',
    acmeRoot: `${dirname(cert)}/acme`,
    served: servedIn(uploads),
  };
  for (const [f, text] of renderAll(cfg, table)) {
    mkdirSync(dirname(join(out, f)), { recursive: true });
    writeFileSync(join(out, f), text);
  }
  process.exit(0);
}

const [sitesRoot, oh, os, nh, ns, backend, uploads] = a as [string, string, string, string, string, string, string];
// TutorStar's stand-in: says what it was sent, a 404 for /nope-*, and takes a websocket
const echo = createServer((req, res) => {
  let bytes = 0;
  req.on('data', (d: Buffer) => { bytes += d.length; });
  req.on('end', () => {
    const said = JSON.stringify({
      method: req.method, url: req.url, host: req.headers.host, realIp: req.headers['x-real-ip'], xff: req.headers['x-forwarded-for'],
      proto: req.headers['x-forwarded-proto'], connection: req.headers.connection, upgrade: req.headers.upgrade ?? null, bytes,
    });
    res.writeHead(req.url?.startsWith('/nope') ? 404 : 200, { 'Content-Type': 'application/json' }).end(said);
  });
});
echo.on('upgrade', (req, socket) => {
  socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
});
await new Promise<void>((r) => echo.listen(Number(backend), '127.0.0.1', r));

let pass = 0, fail = 0;
const ok = (what: string) => { console.log(`  ok    ${what}`); pass++; };
const bad = (what: string) => { console.log(`  FAIL  ${what}`); fail++; };
const answer = (list: { what: string; answer: Answer | string }[], starts: string, n = 0) => {
  const hit = list.filter((x) => x.what.startsWith(starts))[n];
  return typeof hit?.answer === 'object' ? hit.answer : null;
};

for (const t of TAKEOVERS) {
  const dir = probeDirOf(t, sitesRoot, uploads);
  console.log(`--- ${fullName(t, D)}: the hand-written file (${t.link}) and the panel's, the same requests`);
  const before = await probe(t, { ip: '127.0.0.1', http: Number(oh), https: Number(os), domain: D }, { harness: true, folderDir: dir });
  const after = await probe(t, { ip: '127.0.0.1', http: Number(nh), https: Number(ns), domain: D }, { harness: true, folderDir: dir });
  const noAnswer = before.filter((b) => typeof b.answer === 'string');
  noAnswer.length ? bad(`the hand-written file gave no answer: ${noAnswer.map((b) => `${b.what}: ${b.answer}`).join('; ')}`) : ok(`the hand-written file answered all ${before.length}`);
  const diffs = compare(before, after);
  diffs.length ? diffs.forEach((d) => bad(d)) : ok(`the panel's answers are the same, all ${after.length} (status, headers, bodies)`);

  // ...and the requests really showed what they were meant to
  if (t.name === 'instastylr') {
    const top = answer(before, 'GET https://instastylr.');
    top?.headers['content-security-policy']?.includes("default-src 'self'") ? ok('(it was the strict CSP that matched)') : bad(`instastylr / had no CSP: ${JSON.stringify(top)}`);
    const asset = answer(before, 'GET https://instastylr.lesfleursdelanuit.com/assets/index-');
    asset?.headers['cache-control']?.includes('immutable') && asset.headers.expires && asset.headers['x-frame-options'] === 'DENY'
      ? ok('(and an asset cached for good, the headers repeated)') : bad(`instastylr asset: ${JSON.stringify(asset)}`);
    answer(before, 'GET https://instastylr.lesfleursdelanuit.com/some/client/route')?.body === top?.body ? ok('(and an unknown path gave index.html)') : bad('the SPA fallback wasn\'t index.html');
  }
  if (t.link === 'lesfleursdelanuit') {
    answer(before, `GET https://${D}/`)?.status === 403 ? ok('(the top answered 403, no index.html, as today)') : bad(`${D}/ was ${JSON.stringify(answer(before, `GET https://${D}/`))}`);
    answer(before, `GET https://www.${D}/stefanie/`)?.status === 200 ? ok('(www serves the same folder)') : bad('www /stefanie/ wasn\'t 200');
  }
  if (t.name === 'tutor') {
    const signIns = before.filter((b) => b.what.startsWith('POST https://tutor.lesfleursdelanuit.com/api/auth/sign-in/email')).map((b) => (typeof b.answer === 'object' ? b.answer.status : 0));
    signIns.join() === '200,200,200,200,503,503' ? ok(`(the sign-in limit: ${signIns.join(' ')})`) : bad(`sign-in statuses: ${signIns.join(' ')}`);
    const up = before.filter((b) => b.what.startsWith('POST https://tutor.lesfleursdelanuit.com/upload')).map((b) => (typeof b.answer === 'object' ? b.answer.status : 0));
    up.join() === '200,413' ? ok('(20 MB went through, 30 MB was refused: 413)') : bad(`uploads: ${up.join(' ')}`);
    answer(before, 'GET https://tutor.lesfleursdelanuit.com/ws')?.status === 101 ? ok('(a websocket was switched through)') : bad(`ws: ${JSON.stringify(answer(before, 'GET https://tutor.lesfleursdelanuit.com/ws'))}`);
  }
  if (t.domain) {
    const on = fullName(t, D);
    const signIns = before.filter((b) => b.what.startsWith(`POST https://${on}/api/auth/login`)).map((b) => (typeof b.answer === 'object' ? b.answer.status : 0));
    // (one "login" limit for every host from one address: tutor's tries came first, so only that it holds)
    signIns.length === 6 && signIns.at(-1) === 503 ? ok(`(the sign-in limit: ${signIns.join(' ')})`) : bad(`sign-in statuses: ${signIns.join(' ')}`);
    const up = before.filter((b) => b.what.startsWith(`POST https://${on}/upload`)).map((b) => (typeof b.answer === 'object' ? b.answer.status : 0));
    up.join() === '200,413' ? ok('(20 MB went through, 30 MB was refused: 413)') : bad(`uploads: ${up.join(' ')}`);
    answer(before, `GET https://${on}/ws`)?.status === 101 ? ok('(a websocket was switched through)') : bad(`ws: ${JSON.stringify(answer(before, `GET https://${on}/ws`))}`);
    answer(before, `GET http://${on}/`)?.status === 301 ? ok('(http went to https)') : bad(`http: ${JSON.stringify(answer(before, `GET http://${on}/`))}`);
  }
  if (t.link === 'gonsalves-public') {
    const media = before.filter((b) => b.what.includes('/uploads/') && !b.what.includes('missing'));
    media.length === 3 && media.every((m) => typeof m.answer === 'object' && m.answer.status === 200 && /\bpublic, immutable$/.test(m.answer.headers['cache-control'] ?? '') && m.answer.headers.expires)
      ? ok('(three media files from disk, cached 30 days, immutable)') : bad(`media: ${JSON.stringify(media)}`);
    answer(before, 'GET https://gonsalvesfamily.com/uploads/site-media/missing')?.status === 404 ? ok('(a missing one: 404)') : bad('missing media wasn\'t 404');
    answer(before, 'GET https://www.gonsalvesfamily.com/')?.status === 200 ? ok('(www answers the same site)') : bad('www / wasn\'t 200');
  }
}

// Gonsalves's private media, and a hidden file among the public: never served, before or after
{
  const pub = TAKEOVERS.find((x) => x.link === 'gonsalves-public')!;
  const odd = { ...pub, checks: () => [{ path: '/uploads/user-media/7/letter.pdf' }, { path: '/uploads/site-media/images/.hidden' }] };
  const [ub, hb] = await probe(odd, { ip: '127.0.0.1', http: Number(oh), https: Number(os), domain: D }, { harness: true, folderDir: null });
  const [ua, ha] = await probe(odd, { ip: '127.0.0.1', http: Number(nh), https: Number(ns), domain: D }, { harness: true, folderDir: null });
  // user-media isn't a folder from disk: it goes to the app (the stand-in's JSON), both times
  const echoed = (x: typeof ub) => typeof x?.answer === 'object' && x.answer.status === 200 && x.answer.headers['content-type'] === 'application/json';
  echoed(ub) && echoed(ua) ? ok('user-media goes to the app, before and after (never from disk)') : bad(`user-media: before ${JSON.stringify(ub?.answer)}, after ${JSON.stringify(ua?.answer)}`);
  (hb?.answer as Answer)?.status === 200 && (ha?.answer as Answer)?.status === 403
    ? ok('on purpose: a hidden file in the media was served, now 403') : bad(`.hidden: before ${JSON.stringify(hb?.answer)}, after ${JSON.stringify(ha?.answer)}`);
}

// DIFFERENCES, on purpose: a hidden path is refused where instastylr's single-page app answered
const t = TAKEOVERS.find((x) => x.name === 'instastylr')!;
const hidden = { ...t, checks: () => [{ path: '/.env' }] };
const [hb] = await probe(hidden, { ip: '127.0.0.1', http: Number(oh), https: Number(os), domain: D }, { harness: true, folderDir: null });
const [ha] = await probe(hidden, { ip: '127.0.0.1', http: Number(nh), https: Number(ns), domain: D }, { harness: true, folderDir: null });
(hb?.answer as Answer)?.status === 200 && (ha?.answer as Answer)?.status === 403 && (ha?.answer as Answer).headers['x-frame-options'] === 'DENY'
  ? ok('on purpose: /.env was the app\'s page, now 403 (with the headers)') : bad(`/.env: before ${JSON.stringify(hb?.answer)}, after ${JSON.stringify(ha?.answer)}`);

echo.close();
console.log(`\n  adopt nginx test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
