# Storage: buckets for every project, on local disk or S3

DECIDED 2026-10-06: G-Q1, G-Q2, V2-Q7 (S3 first, ST2 right after ST1) **firm**; ST-Q1..7 **provisional** (momolig took the suggestions
"for now"; each confirmed before the step named, docs/master-plan.md section 2); ST-Q6 answered by
master's Track R (R1). Analysis only, no code. Part of the goal in docs/master-plan.md section 0
(the panel is Supabase-like over Postgres and MariaDB); milestone **M3** (master section 0). Order
and dependencies: master section 5, Track ST (master wins on order; this file on how a step works).

momolig, 2026-10-06: *"Yes we can have storage for apps. Check the system (particularly the
gonsalves family app which uses a storage area) for a storage area. But also allow different
storage backends. We should support S3 to start with."* Also: **the panel does not allow direct
SQL editing** (G-Q1, decided: no SQL editor).

## What there is today (checked 2026-10-06)

### Gonsalves: a storage area by hand

- **Where**: `/mnt/storage/uploads`, **on the root disk** (`/dev/vda3`; nothing is mounted at
  `/mnt`), owner `svc-admin:svc-media`, mode `2770`, ACLs for `svc-ligneous` and uid 296608 (the
  containers' user). About **170 MB**: `gedcom-admin/` 163 MB, `site-media/` 6.5 MB.
- **Three areas, in the admin app's code** (`the-gonsalves-family-admin/lib/admin/media-upload-storage.ts`):

  | Area | Files | Who may read | Served by |
  |---|---|---|---|
  | `gedcom-admin/{images,documents,audio,videos}[/originals]/` | the tree's media | anyone | nginx directly (the panel's `SERVED_FOLDERS`, 30 days, immutable) and the public app (for Next's image optimizer) |
  | `site-media/` | site assets | anyone | the same |
  | `user-media/<userId>/` | per-account uploads | that account | the admin app, after its own sign-in check (the folder doesn't exist yet) |

- **The admin app writes** (volume `rw`), **the public app only reads** (`ro`); both read the root
  from an env variable (`ADMIN_MEDIA_FILES_ROOT`, `MEDIA_FILES_ROOT`) that must be under `/mnt/`.
- **The database stores where a file is as its address**: `file_ref` = `/uploads/gedcom-admin/images/x.jpg`.
  The storage's location is baked into the data, so moving it means rewriting references (the app
  has a script for that: `npm run migrate-admin-uploads`).
- **Not backed up by the panel**: Backups (`packages/services/src/known.ts` `BACKUPS`) has the
  four databases only; no timer or unit on the server copies `/mnt/storage/uploads`.
- **Possible loss, to check**: the public app's "contributions" (visitors' attachments, up to
  125 MB each) go to `PUBLIC_INTAKE_STORAGE_DIR`, by default `storage/public-intake` **inside the
  container**. Neither Quadlet sets it or mounts a volume there, so if that feature is in use,
  its files live in the container's own layer and go when the container is made again
  (every deploy). Not the panel's code. **momolig, 2026-10-06: the feature is not in use**, so
  nothing is being lost; if it is turned on, its attachments need a volume or a private bucket
  (`gonsalves/contributions`) first.

### Elsewhere in the panel

- **pammy.org**: Media folders (`<folder>/media`), File Explorer, thumbnails, the public media API;
  files in her website folder, served by nginx.
- **lfdln**: site folders (`/var/www/lesfleursdelanuit-sub/<name>`), File Explorer, media folders.
- Code projects (8b) keep Laravel's `storage/` per project; Next.js projects have none.
- Nothing speaks S3 anywhere on the server; no S3 credentials exist.

## The design

### Words

| Word | Is | Example |
|---|---|---|
| **Storage backend** | where bytes live: a kind and its settings | "this server's disk", "S3: bucket `lfdln-media` in `eu-central-1`" |
| **Bucket** | a named place for files, owned by a project, on one storage backend, public or private, with rules and limits | `party/photos`, `gonsalves/site-media` |
| **Object** | one file in a bucket: key, size, type, checksum, owner, when | `photos/2026/ana.jpg` |

**Storage backend kinds** are an extension point (phase 0, owned by the `storage` module),
like data store kinds:

| Kind | First? | How it stores | Credentials |
|---|---|---|---|
| **local** | yes | folders under a storage root on this server | none |
| **s3** | the first new kind, **right after local** (ST2; V2-Q7, firm: S3 first) | any S3-compatible service: AWS S3, Cloudflare R2, Backblaze B2, DreamHost DreamObjects, Wasabi, MinIO | an S3 **connection** (endpoint, region, access key, secret; path-style on or off), kept by `connections` and used only by `lfdln-remote` (docs/external-backends-plan.md) |
| later | | Google Cloud Storage, Azure Blob, … | as their own kinds |

### A new module: `storage`

- **Owns**: storage backend kinds (point), buckets, the **objects index** (a table per site:
  bucket, key, size, type, checksum, owner, created, updated; what lists, quotas and policies use,
  like Supabase's `storage.objects`), the Storage pages, the `lfdln-storage` helper.
- **`lfdln-storage` helper**: its own service user, may write only under the storage roots
  (`/srv/lfdln-storage/` and the roots of adopted areas, read-only unless decided otherwise);
  streams uploads and downloads for local buckets; no network. Like sitefs, it refuses `..`,
  dot-names and links at every step.
- **S3 goes through `lfdln-remote`** (the egress helper), which holds the secrets: it **signs
  URLs** (presigned GET / PUT, short-lived) and does server-side work (list, head, delete, copy).
  File bytes for S3 don't pass through the server: browsers and apps upload and download
  **directly to S3 with a signed URL** (ST-Q4).
- **Needs**: kernel, `thumbs` (pictures for local images); `connections` only with s3 (ST2).
- **Events**: `storage.object.created`, `.deleted`, `storage.bucket.changed`.
- **Project tab**: **Storage** on every project (contract 7, project tab, in docs/module-contracts-plan.md): its buckets,
  size, Add bucket, what the project is told (below).

### How each kind of project uses storage

| Project | How it reaches its buckets |
|---|---|
| **A project's Backend tab** (docs/backend-plan.md) | `client.storage` in `@lfdln/client`, with the project's **policies** deciding read / write / list / delete (the same policy language as tables: `owner_id = auth.uid()`, path prefixes) |
| **Code** and **Connected** projects | environment variables, the S3 way, so the app uses any S3 library: `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`, `STORAGE_PUBLIC_URL`; or for a local bucket `STORAGE_DIR` (a folder mounted into its container) and `STORAGE_PUBLIC_URL` |
| **Files** (site folders) | public buckets serve under an address the project picks (`/uploads/`), by nginx for local, by the bucket's public URL or a redirect for S3 |
| **Installed** (WordPress) | its own `wp-content/uploads` as a local bucket (seen, backed up); offloading to S3 later through a plugin, its settings filled in by the panel |

```ts
// a backend's app
const { data, error } = await db.storage.from('photos').upload(`${user.id}/ana.jpg`, file);
const { data: { signedUrl } } = await db.storage.from('photos').createSignedUrl(`${user.id}/ana.jpg`, 3600);
const url = db.storage.from('site-media').getPublicUrl('logo.png');
```

```
# a bucket's policy (backend-plan's language, on the bucket's objects)
photos   read    using  bucket_public or owner = auth.uid()
photos   write   check  path_starts_with(auth.uid() || '/') and size < 10_000_000 and type like 'image/%'
```

Components (Lit, L-Q3): `<pammy-upload bucket="photos">` and `<pammy-gallery bucket="photos">` on
the project's own pages (`project="party"` only from elsewhere), adapters per provider as the other
components.

**Addresses** (the namespace, docs/backend-plan.md): a project's storage is at
`<project host>/_api/v1/storage/<bucket>/<key>` on each of its addresses, and
`api.<domain>/v1/<project>/storage/<bucket>/<key>` as the fallback. Public local buckets can also be
served by nginx at an address the project picks (`/uploads/`), as Gonsalves' are today.

- **Caching**: every storage answer under `/_api/` sends **`Cache-Control: private, no-store`**
  (as the data API, so Cloudflare or any proxy never keeps one person's file), unless the bucket
  is **public**; then a long cache (`public, max-age=31536000, immutable`) only for
  **content-addressed names** (the key carries the checksum, `logo.3f9a1c.png`), and a short one
  otherwise.
- **Cloudflare's 100 MB body limit** (tutorlumi.com today; master N5): an upload **through the
  server** above 100 MB on a Cloudflare-fronted domain is **refused with a clear message** before
  it starts ("files over 100 MB can't be sent through tutorlumi.com"); the limit is shown on the
  Storage tab for buckets on such domains. **S3 presigned uploads avoid it** (the bytes go
  straight to S3, ST-Q4), so a project that needs larger files there uses an S3 bucket (ST2).

### Public and private

- **Public bucket**: local, served by nginx at the project's address, `immutable` cache for
  content-addressed names; S3, the bucket's public URL (or the project's address proxying it, if
  wanted, ST-Q4).
- **Private bucket**: never served as files. A **signed URL** with an expiry (local: an HMAC-signed
  address nginx checks with `secure_link`, or the gate; S3: a presigned URL), handed out only after
  the policy allows it.
- Uploads: local, streamed through `lfdln-storage` (size and type limits, checksum); S3, a
  presigned PUT for exactly one key, size and type, after the policy allows it. The objects index
  is updated when the upload is confirmed (S3: a HEAD on the key).

### Moving between backends

A bucket can move: **copy every object, check every checksum, switch, keep the old copy for 14
days**, as the data-move plan does for databases. The objects index makes the copy resumable.
Apps that store **addresses** in their database (Gonsalves' `file_ref`) also need their references
rewritten; the panel can't do that for them, so for Connected projects a move is the app's own
job, with the panel's copy step as a tool (ST-Q5).

### Backups

Buckets join Backups (contract 10, backup, in docs/module-contracts-plan.md): local buckets get a nightly copy (incremental, with
retention from Settings > Backups); a bucket on S3 relies on the provider's versioning (the panel
can switch it on and show it).

**Off-server copies are not this module's job**: they are master's **Track R**. **R1** copies the
database dumps, the panel's settings, Gonsalves' `/mnt/storage/uploads` and Pamela's website to
**Cloudflare R2** and **Backblaze B2** (two S3-compatible copies), encrypted before they leave, from a root timer, with
**no `storage` module needed**, so it comes long before ST1. Once ST1 exists, new local buckets
under `/srv/lfdln-storage/` join R1's list. (ST-Q6, answered by R1.)

### Disk

Local buckets share this server's disk with the databases, dumps and builds. Two limits:

| Limit | Default | Where |
|---|---|---|
| per project | 10 GB (ST-Q7), 50 MB per file | Storage tab |
| **all local buckets together** | **≤ 300 GB** (master section 9) | Settings; an upload that would pass it is refused |
| the disk | alert at **85% full** (O1 gauge, Monitoring) | whatever fills it |

Gonsalves' areas (about 170 MB) count toward both.

## Gonsalves under the new design

- Its three areas are **registered as local buckets** of the Gonsalves project, **where they
  are** (no files move): `gonsalves/gedcom-admin` (public), `gonsalves/site-media` (public),
  `gonsalves/user-media` (private). The panel indexes them, shows them on its Storage tab, backs
  them up, and replaces `SERVED_FOLDERS` with the buckets' public addresses (same nginx output).
- The app keeps writing as it does today (its own volume and env). The panel writes nothing there
  unless momolig turns that on (ST-Q5).
- Moving it to S3 later: the app reads `STORAGE_*` and uses an S3 library, its `file_ref`s become
  keys (or are rewritten by its script), then the panel's copy and switch. An app change first.
- The public intake attachments (above): check, then give them a bucket (`gonsalves/contributions`,
  private) or a volume, so they survive deploys.

## Steps

As docs/master-plan.md section 5, Track ST (each its own release; pammy.org unchanged). **Order
(decided 2026-10-08)**: Track ST (milestone M3) starts after M4's C5, and X1 and X2 (with PD1) are
built before ST1 ends, so ST2 can follow ST1 at once.

| Step | What | Needs |
|---|---|---|
| **ST1** | `storage` module, local backend, `lfdln-storage` helper, buckets and the objects index, Storage page and the project's **Storage tab**, public buckets through nginx, Backups for local buckets, the global disk cap; **Gonsalves' areas registered as buckets** where they are (`SERVED_FOLDERS` gone, same nginx output) | C2-rest (project tabs, backups contract, gauges) |
| **ST3** | Projects: env variables for Code and Connected projects (`STORAGE_DIR` for local buckets), WordPress uploads seen | ST1, N3 |
| **ST4** 🔒 | Backend tab: `client.storage`, bucket policies, signed URLs, uploads, `<pammy-upload>`, `<pammy-gallery>`, **local buckets first** (it must not need S3; S3 buckets join when ST2 exists); `storage.object.*` events and realtime once C5 / B5 are in | ST1, B4 |
| **ST2** | **S3 backend**, **right after ST1** (V2-Q7: S3 first, not deferred): S3 connections, presign / list / head / delete / copy in `lfdln-remote`, health check, a test bucket per provider | ST1, X2 (connections, lfdln-remote) |
| **ST5** | **Deferred** (master section 11): moving a bucket between backends; image sizes for S3 images. (Off-server backups are **not** here any more: Track R, R1.) | ST2 |

**Release safety** (master section 7): ST1 registers Gonsalves' areas **side by side** with
`SERVED_FOLDERS` first (the nginx output compared, as 8-7a did), and removes `SERVED_FOLDERS` in
the next release; it writes nothing into those areas (ST-Q5).

## Questions for momolig

**All questions below answered 2026-10-06: momolig took the suggested answers "for now"
(ST-Q1..ST-Q7), as provisional decisions, each confirmed (or changed) with momolig before the
step named in its heading** (docs/master-plan.md section 2). Where the review
(docs/security-performance-review.md) changed a suggestion, the changed one is the answer.

### ST-Q1. Where new local buckets live (provisional: (a); confirm before ST1)

**(a)** `/srv/lfdln-storage/<project>/<bucket>/`, a root of the panel's own (the helper may write
only there). **(b)** Under `/mnt/storage/` beside Gonsalves'. *Suggested: (a)*; existing areas
stay where they are and are registered from there. If a separate disk is added later, the root
moves with one setting.

### ST-Q2. Should "local" speak S3 too (provisional: (a); confirm before ST1)

**(a) Plain folders** (as Gonsalves uses): simple, nginx serves them, nothing new runs.
**(b) A local S3-compatible server** (Garage, SeaweedFS, MinIO): every app uses one S3 library
whether the bucket is here or at AWS, at the cost of one more service to run and back up.
*Suggested: (a) now*; apps that want one API across both can use an S3 bucket, and (b) can be
added later as just another backend kind.

### ST-Q3. Which S3 service to support and test first (provisional; confirm before ST2)

S3 is one API, but providers differ in details (path-style addresses, checksums, CORS, public
access). Examples: **AWS S3**, **Cloudflare R2** (no egress fees), **Backblaze B2**, **DreamHost
DreamObjects** (you already use DreamHost for DNS). **Answer: AWS S3 as the reference, and
Cloudflare R2** (R1's off-server copies use it, with Backblaze B2 as the second copy, so both
accounts exist; was DreamObjects until 2026-10-06, when momolig chose R2 + B2 for R1).

### ST-Q4. Do file bytes pass through this server (provisional: (a); confirm before ST2)

**(a) Direct to S3 with signed URLs** (uploads and downloads never touch the server; S3's
bandwidth and speed) **(b) Through the server** (one address for everything, every byte checked,
but the server's bandwidth and disk I/O carry it). *Suggested: (a)*, with (b) only for a public
bucket shown under the project's own address when wanted. Direct uploads also avoid
Cloudflare's 100 MB body limit (Addresses, above).

### ST-Q5. Gonsalves' storage (provisional: (a); confirm before ST1)

**(a) Register its areas as buckets where they are**, read-only for the panel (seen, indexed,
backed up, served as today), app unchanged. **(b) Also let the panel write there** (uploads from
the panel). **(c) Move it to S3** (an app change first). *Suggested: (a) now.*

### ST-Q6. An S3 bucket as the off-server backup (answered by R1)

Today every backup (database dumps) stays on this server's disk. The suggestion was an S3 bucket
in ST5. **Answered by master's Track R instead**: R1 copies the dumps, settings, Gonsalves'
uploads and Pamela's website to Cloudflare R2 and Backblaze B2, encrypted before they leave, without the
`storage` module (V2-Q3, firm), so off-server copies don't wait for ST2 / ST5.

### ST-Q7. Limits (provisional; confirm before ST1)

Per bucket: largest file, allowed types, total size; per project: total size.
*Suggested: per bucket (largest file 50 MB, any type) and per project (10 GB) by default, changed
on the Storage tab.* Beside these, a **global cap** for all local buckets (≤ 300 GB, master
section 9) and the disk alert at 85% (Disk, above).
