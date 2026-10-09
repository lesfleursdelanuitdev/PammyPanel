#!/usr/bin/env bash
# Put made-up media (tools/make-test-media.ts) into one of her folders' media
# folder, for trying the Media tab: pictures, a folder of trip pictures, two
# short videos, two tunes and a few files, with tags and categories on them
# (tools/test-media-labels.json). Nothing is downloaded; nothing that's already
# there is replaced, and running it again only adds what's missing.
#
#   sudo ~/pamela-setup/panel/tools/put-test-media.sh test-subdomain
#
# The folder must already exist in /pamela/public (make it on the Subdomains
# tab). Files end up pamela's, group www-data, like her own uploads; then the
# panel is told (media-sync) and makes the thumbnails (media-thumbs).
# To take it all away again: Media tab, choose them, Move to trash.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
P="$(readlink -f "$(dirname "$(readlink -f "$0")")/..")"
folder=${1:-}
[[ $folder =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || { echo "usage: sudo $0 <folder>   (a folder directly in /pamela/public, like test-subdomain)" >&2; exit 2; }
site=/pamela/public/$folder
[[ -d $site && ! -L $site ]] || { echo "there's no folder $site -- make it on the Subdomains tab first" >&2; exit 1; }
user=${SUDO_USER:-momolig}
tmp=$(runuser -u "$user" -- mktemp -d); trap 'rm -rf "$tmp"' EXIT

echo "--- making the test files (as $user)"
(cd "$P" && runuser -u "$user" -- /usr/bin/node --disable-warning=ExperimentalWarning tools/make-test-media.ts "$tmp/media")

echo "--- a media folder in $folder (through the panel's own helper)"
(cd / && runuser -u svc-pammypanel -- /usr/bin/node --disable-warning=ExperimentalWarning /opt/pammy-panel/src/sitefs/call.ts \
    "{\"op\":\"media-create\",\"folder\":\"$folder\",\"actor\":\"test media\"}") >/dev/null

echo "--- copying in, as pamela's (never replacing anything)"
added=0 kept=0
while IFS= read -r -d '' f; do
    rel=${f#"$tmp/media/"}
    dest=$site/media/$rel
    d=$(dirname "$dest")
    [[ -d $d ]] || install -d -o pamela -g www-data -m 2755 "$d"
    if [[ -e $dest || -L $dest ]]; then kept=$((kept+1)); continue; fi
    install -o pamela -g www-data -m 644 "$f" "$dest"
    added=$((added+1))
done < <(find "$tmp/media" -type f -print0 | sort -z)
echo "  added $added file(s)$( ((kept)) && echo ", left $kept already there" )"

echo "--- telling the panel"
/usr/local/sbin/pammy-panel media-sync --all-hashes

echo "--- tags and categories (tools/test-media-labels.json), made in $folder's own media folder"
# the panel's own code, as the panel's user, so the media rules all apply; adding
# a label a file already has changes nothing, so running this again is fine. The
# password is read as root and handed over as an open fd (the panel's user can't
# read /etc/pammy-panel/db/panel.pass).
labels=$(cat "$P/tools/test-media-labels.json")
(cd / && runuser -u svc-pammypanel -- /usr/bin/node --disable-warning=ExperimentalWarning --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { connectPg, all, one } from "/opt/pammy-panel/src/pg.ts";
  import { changeFileLabels } from "/opt/pammy-panel/src/media-labels.ts";
  const [folder, json] = process.argv.slice(1);
  const db = connectPg({ role: "panel", password: readFileSync(3, "utf8").trim(), app: "put-test-media" });
  const now = Math.floor(Date.now() / 1000);
  let files = 0, changed = 0, missing = [];
  const made = new Set();
  for (const [rel, l] of Object.entries(JSON.parse(json))) {
    if (rel === "_") continue;
    const rec = await one(db, "SELECT id FROM records WHERE path = ? AND state = ?", `${folder}/media/${rel}`, "present");
    if (!rec) { missing.push(rel); continue; }
    files++;
    const r = await changeFileLabels(db, now, "test media", [rec.id], { add: { tags: l.tags, categories: l.categories } });
    changed += r.changed;
    for (const c of r.created) made.add(c);
  }
  await db.end({ timeout: 5 });
  console.log(`  ${files} files labelled (${changed} changed now); made ${made.size ? [...made].join(", ") : "nothing new"}`);
  if (missing.length) console.log(`  not there (skipped): ${missing.join(", ")}`);
' "$folder" "$labels" 3</etc/pammy-panel/db/panel.pass)

/usr/local/sbin/pammy-panel media-thumbs
echo "done: https://panel.pammy.org/media?folder=$folder"
echo "      https://panel.pammy.org/media/tags?folder=$folder"
