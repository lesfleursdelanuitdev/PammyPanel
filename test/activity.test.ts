// Every action the server writes into the activity log has a sentence on the
// Activity page (web/src/pages/Activity.tsx). Without one the page prints the
// bare action name -- "database-created Postgres: blog" -- which is what every
// database action did until slice 10 of the studio.
//
// The page is React and cannot be imported here, so both sides are read as
// text: the action names in the server's logActivity calls, and the keys of
// the page's ACTIONS table.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const root = new URL('../', import.meta.url).pathname;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith('.ts') ? [p] : [];
  });
}

// An action is a quoted hyphenated word on a line that writes one, or that
// picks which one to write (`const action = ...`). The media labels are the one
// templated name: `media-${type}-made` for tags and categories alike.
function written(): Set<string> {
  const out = new Set<string>();
  for (const file of ['packages', 'sites'].flatMap((d) => sources(join(root, d)))) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!/logActivity\(|\baction = /.test(line)) continue;
      for (const m of line.matchAll(/'([a-z]+(?:-[a-z]+)+)'/g)) out.add(m[1]!);
      for (const m of line.matchAll(/`media-\$\{type\}-([a-z]+)`/g)) {
        out.add(`media-tag-${m[1]}`);
        out.add(`media-category-${m[1]}`);
      }
    }
  }
  return out;
}

describe('the Activity page', () => {
  it('has a sentence for every action the server writes', () => {
    const page = readFileSync(join(root, 'packages/core/web/pages/Activity.tsx'), 'utf8');
    const worded = new Set([...page.matchAll(/^ {2}'([a-z-]+)':/gm)].map((m) => m[1]!));
    const actions = written();
    assert.ok(actions.has('schema-applied') && actions.has('media-tag-made'), 'the reader finds actions at all');
    assert.deepEqual([...actions].filter((a) => !worded.has(a)), []);
  });
});
