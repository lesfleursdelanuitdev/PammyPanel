// The glossary (docs/adapters-plan.md A7): the few words the two sites say differently
// come from the profile's `words`, never from a page. pammy.org's are the words it has
// always said; a profile shaped like lfdln's builds pages that say its own.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { PROFILE } from '@panel/pammy/profile';
import { PROFILE as LFDLN } from './fixtures/lfdln-profile.ts';

const ROOT = join(import.meta.dirname, '..');

const filesUnder = (dir: string): string[] => readdirSync(dir, { withFileTypes: true, recursive: true })
  .filter((e) => e.isFile() && /\.tsx?$/.test(e.name)).map((e) => join(e.parentPath, e.name));
const dirs = (under: string, sub: string) => readdirSync(join(ROOT, under)).map((p) => join(ROOT, under, p, sub));
const exists = (d: string) => { try { return readdirSync(d) && true; } catch { return false; } };

// a glossary word written into the code instead of taken from `words`
const APP = /\b(the|this|your|its|an|any|one of my|no|their|small) apps?\b|\bapps? (name|settings)\b/i;
const WEBSITE = /'Website'|>Website<|the top of your website/;

function hardCoded(files: string[], patterns: RegExp[]) {
  const found: string[] = [];
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');   // what a comment says is for us, not for her
      if (/^\s*\*/.test(code)) return;
      if (patterns.some((p) => p.test(code))) found.push(`${relative(ROOT, f)}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  return found;
}

describe('the glossary', () => {
  it("pammy.org's words are the ones it has always said", () => {
    assert.deepEqual(PROFILE.words, {
      app: { one: 'app', a: 'an app', many: 'apps' },
      website: { title: 'Website', your: 'your website', top: 'the top of your website' },
      explain: true,
      admin: { one: 'account manager', a: 'an account manager', many: 'account managers' },
    });
  });

  it("lfdln's are plainly technical, every one of them its own", () => {
    assert.equal(LFDLN.words.explain, false);
    for (const k of ['one', 'a', 'many'] as const) assert.notEqual(LFDLN.words.app[k], PROFILE.words.app[k]);
    for (const k of ['title', 'your', 'top'] as const) assert.notEqual(LFDLN.words.website[k], PROFILE.words.website[k]);
    for (const k of ['one', 'a', 'many'] as const) assert.notEqual(LFDLN.words.admin[k], PROFILE.words.admin[k]);
  });

  it('no page says a glossary word itself', () => {
    const pages = [...dirs('packages', 'web'), join(ROOT, 'sites/pammy/web/src')].filter(exists).flatMap(filesUnder);
    assert.ok(pages.length > 50, 'the pages were found');
    assert.deepEqual(hardCoded(pages, [APP, WEBSITE]), []);
  });

  it("nor does the panel's server, in what it tells the pages", () => {
    const panel = dirs('packages', 'src/panel').filter(exists).flatMap(filesUnder);
    assert.ok(panel.length > 10, "the panel's routes were found");
    assert.deepEqual(hardCoded(panel, [APP]), []);
  });

  it("the pages build with lfdln's profile, and say its words", () => {
    const out = mkdtempSync(join(tmpdir(), 'panel-words-'));
    try {
      execFileSync(join(ROOT, 'node_modules/.bin/vite'), ['build', '--config', 'sites/pammy/web/vite.config.ts', '--logLevel', 'error'], {
        cwd: ROOT, stdio: 'pipe',
        env: { ...process.env, PANEL_PROFILE: join(ROOT, 'test/fixtures/lfdln-profile.ts'), PANEL_WEB_OUT: out },
      });
      const js = readdirSync(join(out, 'assets')).filter((f) => f.endsWith('.js'))
        .map((f) => readFileSync(join(out, 'assets', f), 'utf8')).join('\n');
      // a string in the bundle, in whichever quotes the minifier chose
      const has = (w: string) => ['"', "'", '`'].some((q) => js.includes(`${q}${w}${q}`));
      for (const w of ['database app', 'a database app', 'Site folders', 'the site folders', 'an admin']) assert.ok(has(w), `the pages carry "${w}"`);
      assert.ok(!has('an app') && !has('your website'), "and not pammy.org's");
      assert.match(readFileSync(join(out, 'index.html'), 'utf8'), /lesfleursdelanuit\.com panel/);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
