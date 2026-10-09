// The website folder helper's socket protocol: one JSON request per connection,
// one JSON line back. It trusts nothing in the request: every name is checked
// again in ops.ts, whatever the panel already checked.
import type { Server } from 'node:net';
import { createJsonLineServer, SENT } from '@panel/core/jsonline';
import {
  mediaBuckets, mediaCopy, mediaCreate, mediaHash, mediaInfo, mediaList, mediaMkdir, mediaMove, mediaRead, mediaRenamePhotos, mediaRestore, mediaScan,
  mediaSites, mediaTrash, mediaTrashList, mediaUpload, purgeMediaTrash,
  filesCopy, filesHash, filesList, filesMkdir, filesMove, filesRead, filesRestore, filesStat, filesTrash, filesTree, filesUpload,
} from './media.ts';
import { homePageGet, homePageRemove, homePageSave } from './home-page.ts';
import { filesVersionRead, filesVersionRestore, filesVersions, filesWrite, purgeVersions } from './edit.ts';
import {
  createFolder, installPages, listDirs, listFolders, markers, protectDir, purgeTrash, restoreFolder, SiteFsError, trashFolder,
  unprotectDir, type SiteFsConfig,
} from './ops.ts';

export type SiteFsRequest = {
  op: string; name?: unknown; entry?: unknown; as?: unknown; path?: unknown; token?: unknown; paths?: unknown; pages?: unknown; folder?: unknown;
  files?: unknown; words?: unknown; site?: unknown;
  thankYouOnly?: unknown; dir?: unknown; from?: unknown; to?: unknown; id?: unknown; actor?: unknown; expect?: unknown; session?: unknown;
  code?: unknown;   // a software root: the person is a panel admin, so code may be written (docs/catalog-plan.md step 3)
};

// What a software root's helper does (docs/catalog-plan.md step 3): File Explorer and
// the editor only. Media folders, protected folders, top-level folders and their home
// pages are the website's.
export const SOFTWARE_OPS: ReadonlySet<string> = new Set([
  'purge', 'media-trash-list', 'files-stat', 'files-list', 'files-tree', 'files-mkdir', 'files-copy', 'files-move', 'files-trash', 'files-restore',
  'files-versions', 'files-upload', 'files-read', 'files-hash', 'files-write', 'files-version-read', 'files-version-restore',
]);
const refuseOnSoftware = (cfg: SiteFsConfig, op: unknown) => {
  if (cfg.kind === 'software' && !SOFTWARE_OPS.has(String(op))) throw new SiteFsError('invalid', 'That is only for the website.');
};

export function handle(cfg: SiteFsConfig, req: SiteFsRequest): unknown {
  refuseOnSoftware(cfg, req.op);
  const as = { code: req.code === true };
  switch (req.op) {
    case 'list': return listFolders(cfg);
    case 'create': return createFolder(cfg, req.name);
    case 'trash': return trashFolder(cfg, req.name);
    case 'restore': return restoreFolder(cfg, req.entry, req.as);
    case 'purge': return { ...(cfg.kind === 'software' ? { purged: [] as string[], failed: [] as string[] } : purgeTrash(cfg)), media: purgeMediaTrash(cfg).purged, versions: purgeVersions(cfg).purged };
    case 'dirs': return listDirs(cfg);
    case 'markers': return markers(cfg, req.paths);
    case 'protect': return protectDir(cfg, req.path, req.token, req.pages);
    case 'unprotect': return unprotectDir(cfg, req.path, req.token);
    case 'install-pages': return installPages(cfg, req.path, req.files);
    case 'media-sites': return mediaSites(cfg);
    case 'media-create': return mediaCreate(cfg, req.folder);
    case 'media-list': return mediaList(cfg, req.dir);
    case 'media-buckets': return mediaBuckets(cfg, req.dir);
    case 'media-info': return mediaInfo(cfg, req.path);
    case 'media-mkdir': return mediaMkdir(cfg, req.dir, req.name);
    case 'media-copy': return mediaCopy(cfg, req.from, req.to, req.name);
    case 'media-move': return mediaMove(cfg, req.from, req.to, req.name);
    case 'media-trash': return mediaTrash(cfg, req.path);
    case 'media-trash-list': return mediaTrashList(cfg);
    case 'media-restore': return mediaRestore(cfg, req.id, req.as);
    case 'media-rename-photos': return mediaRenamePhotos(cfg);
    case 'media-scan': return mediaScan(cfg);
    case 'files-stat': return filesStat(cfg, req.path);
    case 'files-list': return filesList(cfg, req.dir);
    case 'files-tree': return filesTree(cfg);
    case 'files-mkdir': return filesMkdir(cfg, req.dir, req.name);
    case 'files-copy': return filesCopy(cfg, req.from, req.to, req.name, as);
    case 'files-move': return filesMove(cfg, req.from, req.to, req.name, as);
    case 'files-trash': return filesTrash(cfg, req.path, as);
    case 'files-restore': return filesRestore(cfg, req.id, req.as, as);
    case 'files-versions': return filesVersions(cfg, req.path);
    // a temporary home page for a folder that has none (home-page.ts)
    case 'home-page-get': return homePageGet(cfg, req.name);
    case 'home-page-save': return homePageSave(cfg, req.name, req.words, req.site);
    case 'home-page-remove': return homePageRemove(cfg, req.name);
    default: throw new SiteFsError('invalid', 'Unknown request.');
  }
}

export function createSiteFsServer(cfg: SiteFsConfig, log: (line: string) => void = () => {}): Server {
  const guard = <R>(req: SiteFsRequest, run: () => R): R => { refuseOnSoftware(cfg, req.op); return run(); };
  return createJsonLineServer((req) => handle(cfg, req), log, { streams: {
    // {op, dir, name, size} then exactly `size` bytes
    'media-upload': (req, { body }) => guard(req, () => mediaUpload(cfg, { dir: req.dir, name: req.name, size: req.size }, body)),
    // {op, path, start?, end?}: a JSON line (name, size, range) then the bytes
    'media-read': async (req, { send }) => {
      refuseOnSoftware(cfg, req.op);
      const { info, stream } = mediaRead(cfg, req.path, req.start, req.end);
      send(info, stream);
      return SENT;
    },
    // {op, path}: a stream op only for its longer timeout (a big video takes a while to read)
    'media-hash': (req) => guard(req, () => mediaHash(cfg, req.path)),
    'files-upload': (req, { body }) => filesUpload(cfg, { dir: req.dir, name: req.name, size: req.size, code: req.code }, body),
    // view: the editor's preview, which may also read a sign-in page's login-files
    'files-read': async (req, { send }) => {
      const { info, stream } = filesRead(cfg, req.path, req.start, req.end, req.view === true);
      send(info, stream);
      return SENT;
    },
    'files-hash': (req) => filesHash(cfg, req.path),
    // the editor (edit.ts): {op, path, expect, create, session, size} then the text
    'files-write': (req, { body }) => filesWrite(cfg, req, body),
    'files-version-read': async (req, { send }) => {
      const { info, stream } = filesVersionRead(cfg, req.id);
      send(info, stream);
      return SENT;
    },
    // a stream op only for its longer timeout (it hashes the file first)
    'files-version-restore': (req) => filesVersionRestore(cfg, req.id, req.expect ?? null, req.actor, req.code),
  } });
}
