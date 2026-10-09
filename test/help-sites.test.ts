// Help per site (docs/phase9-plan.md 9-1): each site's guides.map, its words (kept, a
// right, parts, listed), the loader, who sees which guide, and the profiles' topics.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { GUIDE_TOPICS } from '@panel/core/profile';
import { RIGHTS, type Right } from '@panel/core/panel/rights';
import { loadGuides, parseGuide, parseMap, type HelpGuide } from '@panel/help/help';
import { guidesFor } from '@panel/help/panel/routes/help';
import { PROFILE as LFDLN } from '@panel/lfdln/profile';
import { PROFILE as PAMMY } from '@panel/pammy/profile';

const SETUP = new URL('../../', import.meta.url).pathname;
const SITES = [
  { name: 'pammy.org', dir: SETUP, profile: PAMMY },
  { name: 'lfdln', dir: join(SETUP, 'lfdln-guides'), profile: LFDLN },
] as const;
const mapOf = (dir: string) => parseMap(readFileSync(join(dir, 'guides.map'), 'utf8'));
const WORDS = new Set<string>(['kept', 'parts', 'listed', ...RIGHTS]);
const slug = (file: string) => file.replace(/^\d+-/, '').replace(/\.txt$/, '');

const who = (o: { role?: 'manager' | 'member'; rights?: Right[]; places?: string[] }) =>
  ({ role: o.role ?? 'member', rights: o.rights ?? [], places: o.places ?? [] });

describe('a guides.map', () => {
  it('reads a line as the master file, its name here and the words for Help', () => {
    assert.deepEqual(parseMap('# a comment\n\n  a.txt   01-a.txt\nb.txt 02-b.txt   kept,forms,parts\nc.txt 03-c.txt listed\n'), [
      { src: 'a.txt', file: '01-a.txt', flags: { parts: false, listed: false, kept: false, rights: [] } },
      { src: 'b.txt', file: '02-b.txt', flags: { parts: true, listed: false, kept: true, rights: ['forms'] } },
      { src: 'c.txt', file: '03-c.txt', flags: { parts: false, listed: true, kept: false, rights: [] } },
    ]);
  });

  const dir = mkdtempSync(join(tmpdir(), 'help-sites-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const guide = (title: string) => `${'='.repeat(30)}\n ${title}\n${'='.repeat(30)}\n\nWords.\n`;

  it("loads the guides in the map's order, with its words, and nothing the map doesn't name", () => {
    writeFileSync(join(dir, '01-a.txt'), guide('A'));
    writeFileSync(join(dir, '02-b.txt'), guide('B'));
    writeFileSync(join(dir, '03-stray.txt'), guide('Stray'));
    writeFileSync(join(dir, 'guides.map'), 'b.txt 02-b.txt kept\na.txt 01-a.txt parts,listed\n');
    const gs = loadGuides(dir);
    assert.deepEqual(gs.map((g) => [g.file, g.title, g.kept, g.parts, g.listed]), [['02-b.txt', 'B', true, false, false], ['01-a.txt', 'A', false, true, true]]);
  });

  it('without a map, every .txt by name, none of them for a kept account', () => {
    rmSync(join(dir, 'guides.map'));
    const gs = loadGuides(dir);
    assert.deepEqual(gs.map((g) => g.file), ['01-a.txt', '02-b.txt', '03-stray.txt']);
    assert.deepEqual(guidesFor(gs, who({ places: ['/x'], rights: ['forms'] })), []);
  });
});

describe('who sees which guide', () => {
  const g = (file: string, o: Partial<HelpGuide> = {}): HelpGuide => ({ file, title: file, subtitle: '', sections: [], parts: false, listed: false, kept: false, rights: [], ...o });
  const gs = [g('01-all.txt'), g('02-kept.txt', { kept: true }), g('03-forms.txt', { rights: ['forms'] }), g('04-hosts.txt', { rights: ['hosts'] })];
  const files = (u: ReturnType<typeof who>) => guidesFor(gs, u).map((x) => x.file);

  it('everyone not kept to places sees every guide, whatever their rights', () => {
    assert.deepEqual(files(who({ role: 'manager' })), ['01-all.txt', '02-kept.txt', '03-forms.txt', '04-hosts.txt']);
    assert.deepEqual(files(who({ rights: ['forms'] })), ['01-all.txt', '02-kept.txt', '03-forms.txt', '04-hosts.txt']);
  });

  it('an account kept to places sees the "kept" ones and those of rights it has there', () => {
    assert.deepEqual(files(who({ places: ['/a'] })), ['02-kept.txt']);
    assert.deepEqual(files(who({ places: ['/a'], rights: ['forms'] })), ['02-kept.txt', '03-forms.txt']);
    // a right a kept account can't use (databases) gives it no guide
    assert.deepEqual(files(who({ places: ['/a'], rights: ['databases'] })), ['02-kept.txt']);
  });

  it("pammy.org's kept accounts see what they did before the map had words", () => {
    const real = mapOf(SETUP).map((e) => g(e.file, e.flags));
    const of = (rights: Right[]) => guidesFor(real, who({ places: ['/olivia'], rights })).map((x) => x.file);
    assert.deepEqual(of([]), ['10-forms.txt', '11-one-folder.txt', '12-media-on-your-pages.txt', '20-comments.txt']);
    assert.deepEqual(of(['subdomains', 'protected']),
      ['06-folders-and-subdomains.txt', '09-protected-folders.txt', '10-forms.txt', '11-one-folder.txt', '12-media-on-your-pages.txt', '20-comments.txt']);
    // and the long ones open part by part, as GUIDES_BY_PART had them
    assert.deepEqual(real.filter((x) => x.parts).map((x) => x.file), ['08-control-panel.txt', '09-protected-folders.txt', '10-forms.txt']);
    assert.deepEqual(real.filter((x) => x.listed).map((x) => x.file), ['08-control-panel.txt']);
  });
});

for (const site of SITES) {
  describe(`${site.name}'s guides`, () => {
    const map = mapOf(site.dir);

    it('every line names a guide that is there, under a numbered name of its own, with known words', () => {
      assert.ok(map.length > 0);
      for (const e of map) {
        assert.match(e.file, /^\d\d-[A-Za-z0-9-]+\.txt$/, e.file);
        const g = parseGuide(e.file, readFileSync(join(site.dir, e.src), 'utf8'));
        assert.ok(g.title && g.sections.length && g.sections.every((s) => s.blocks.length), e.file);
      }
      assert.equal(new Set(map.map((e) => e.file)).size, map.length, 'names');
      for (const line of readFileSync(join(site.dir, 'guides.map'), 'utf8').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'))) {
        const words = line.trim().split(/\s+/)[2];
        for (const w of words ? words.split(',') : []) assert.ok(WORDS.has(w), `${line}: "${w}"`);
      }
    });

    it("has Help's words in its profile, and each topic is one of its guides", () => {
      const help = site.profile.help;
      assert.ok(help?.intro && help.searchExample);
      const slugs = new Set(map.map((e) => slug(e.file)));
      for (const [topic, at] of Object.entries(help.topics)) {
        assert.ok((GUIDE_TOPICS as readonly string[]).includes(topic), topic);
        assert.ok(slugs.has(at!.split(/[#/]/)[0]!), `${topic}: ${at}`);
      }
    });
  });
}

describe('two sites, two sets of guides', () => {
  it("lfdln shows none of Pamela's guides, and says nothing of her instructions folder", () => {
    const pammy = new Set(mapOf(SETUP).map((e) => e.src));
    for (const e of mapOf(join(SETUP, 'lfdln-guides'))) assert.ok(!pammy.has(e.src), e.src);
    assert.doesNotMatch(LFDLN.help!.intro, /instructions folder/);
    assert.match(PAMMY.help!.intro, /instructions folder/);
  });

  it("Getting started is pammy.org's alone, and Help needs nothing else on", () => {
    assert.ok(PAMMY.modules.includes('getting-started') && PAMMY.modules.includes('help'));
    assert.ok(LFDLN.modules.includes('help') && !LFDLN.modules.includes('getting-started'));
  });
});
