// The thumbnail service's socket: one JSON request per connection (jsonline.ts),
// one answer. The only one who can open the socket is the panel.
//   {op: 'thumb', path, kind} -> {webp: <base64>, width, height} or {icon, why}
//   {op: 'tools'}             -> which tools it has (for the install's checks)
// One thumbnail at a time: the service's memory limit is for one file, not several.
import { existsSync } from 'node:fs';
import type { Server } from 'node:net';
import sharp from 'sharp';
import { createJsonLineServer } from '@panel/core/jsonline';
import { makeThumb, ThumbError, type ThumbsConfig } from './make.ts';

let queue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

export function createThumbsServer(cfg: ThumbsConfig, log: (line: string) => void = () => {}): Server {
  return createJsonLineServer((req) => {
    if (req.op === 'tools') {
      return { sharp: sharp.versions.sharp, vips: sharp.versions.vips, ffmpeg: existsSync(cfg.tools.ffmpeg), pdftoppm: existsSync(cfg.tools.pdftoppm) };
    }
    throw new ThumbError('invalid', 'Unknown request.');
  }, log, { describe: (req) => JSON.stringify(req.path ?? '').slice(0, 120), streams: {
    // a stream op only for its longer timeout: a thumbnail can wait behind others
    thumb: async (req) => {
      const t = await oneAtATime(() => makeThumb(cfg, req.path, req.kind));
      if ('icon' in t) {
        log(`op=thumb target=${JSON.stringify(req.path).slice(0, 120)} icon=${t.icon} why=${JSON.stringify(t.why).slice(0, 200)}`);
        return t;
      }
      return { webp: t.webp.toString('base64'), width: t.width, height: t.height };
    },
  } });
}
