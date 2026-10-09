// What the files package adds to the panel's context (docs/packaging-plan.md step
// 1a): the media records' sync and the thumbnail service. (The media API's index
// is kept up to date by the site, which wires @panel/media's Publisher to them.)
import type { FastifyInstance } from 'fastify';
import type { MediaSync } from '../media-sync.ts';
import type { Thumbnailer } from '@panel/thumbs/media-thumbs';
import type { PanelCtx } from '@panel/core/panel/context';
import type { Authed } from '@panel/core/sessions';
import { isKept, isWebsitePlace, websitePlaces } from '@panel/core/panel/rights';

export type FilesParts = {
  media: MediaSync;
  thumbs: Thumbnailer;
  // A whole folder (and its media folder) went to the trash or came back: the
  // records follow at once rather than at the next sync.
  syncSoon: () => void;
};
export type FilesCtx = PanelCtx & FilesParts;

export function filesParts(app: FastifyInstance, services: { media: MediaSync; thumbs: Thumbnailer }): FilesParts {
  return {
    ...services,
    syncSoon() {
      services.media.sync('automatic check').catch((e: unknown) => app.log.warn({ err: e }, 'media sync after a folder change failed'));
    },
  };
}

// A site whose places aren't folders (lfdln, docs/phase8-plan.md P8-2: a place is a host)
// says which folders each person's places show; File Explorer's routes then see those as
// the person's places ("/tutor" the host -> "/tutorstar-site" the folder). A person whose
// places show no folder is kept to one that can't exist, so they still see nothing.
export const NO_FOLDER = '/.none';
export function withFolderPlaces<C extends PanelCtx>(ctx: C, foldersOf: (places: readonly string[]) => Promise<string[]>): C {
  const map = async (a: Authed | null): Promise<Authed | null> => {
    if (!a || !isKept(a.user)) return a;
    const folders = await foldersOf(websitePlaces(a.user));
    const others = a.user.places.filter((p) => !isWebsitePlace(p));
    return { ...a, user: { ...a.user, places: [...(folders.length ? folders.map((f) => `/${f}`) : [NO_FOLDER]), ...others] } };
  };
  return {
    ...ctx,
    authOf: async (req) => map(await ctx.authOf(req)),
    need: async (req, reply, opts) => map(await ctx.need(req, reply, opts)),
  };
}
