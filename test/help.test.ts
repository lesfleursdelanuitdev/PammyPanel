// The Help tab's formatting of Pamela's plain-text guides: each habit of the
// text on its own, then every real guide (per ../guides.map).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseBlocks, parseGuide, type Block } from '@panel/help/help';

const parse = (text: string) => parseBlocks(text.split('\n'));

describe('formatting the guides', () => {
  it('joins hard-wrapped paragraphs, keeping words set off by two spaces', () => {
    assert.deepEqual(parse('Type the Name exactly like that -- just  zoho._domainkey\nCloudflare adds the rest. behind-the-\nscenes'),
      [{ t: 'p', text: 'Type the Name exactly like that -- just  zoho._domainkey  Cloudflare adds the rest. behind-the-scenes' }]);
  });

  it('makes a capitals line with something after it a subheading, but not a lone value', () => {
    assert.deepEqual(parse('PLUGINS AND THEMES:\n\nText.'), [{ t: 'h', text: 'Plugins and themes' }, { t: 'p', text: 'Text.' }]);
    assert.deepEqual(parse('SFTP'), [{ t: 'p', text: 'SFTP' }]);
    assert.deepEqual(parse('ONE WORD\n'), [{ t: 'p', text: 'ONE WORD' }]);
  });

  it('numbered steps continue after a paragraph, and hold examples inside them', () => {
    const b = parse('Now:\n\n4. Click "Advanced".\n\n5. Type this:\n\n       %USERPROFILE%\\.ssh\\id\n\n   (That file.)\n\nThen:\n\n  a. first\n  b. second');
    assert.equal(b[0]!.t, 'p');
    const ol = b[1] as Extract<Block, { t: 'ol' }>;
    assert.deepEqual([ol.t, ol.start, ol.alpha, ol.items.length], ['ol', 4, false, 2]);
    assert.deepEqual(ol.items[1], [{ t: 'p', text: 'Type this:' }, { t: 'code', text: '%USERPROFILE%\\.ssh\\id' }, { t: 'p', text: '(That file.)' }]);
    assert.deepEqual(b[3], { t: 'ol', start: 1, alpha: true, items: [[{ t: 'p', text: 'first' }], [{ t: 'p', text: 'second' }]] });
  });

  it('bullets, definitions and their explanations', () => {
    assert.deepEqual(parse('  * one\n    more\n  * two'), [{ t: 'ul', items: [[{ t: 'p', text: 'one more' }], [{ t: 'p', text: 'two' }]] }]);
    assert.deepEqual(parse('"Permission denied"\n    Check the user.\n\nLocked out\n    Ask me.'), [{ t: 'dl', items: [
      { term: '"Permission denied"', body: [{ t: 'p', text: 'Check the user.' }] },
      { term: 'Locked out', body: [{ t: 'p', text: 'Ask me.' }] },
    ] }]);
    assert.deepEqual(parse('  Home\n      What is there.\n\n  People\n      Everyone.'), [{ t: 'dl', items: [
      { term: 'Home', body: [{ t: 'p', text: 'What is there.' }] }, { term: 'People', body: [{ t: 'p', text: 'Everyone.' }] },
    ] }]);
  });

  it('keeps a whole style file, blank lines and all, as one example', () => {
    const css = ['/* A look. */', '', 'body {', '  margin: 0;', '}', '', '.card,', '.box {', '  color: red;', '}'];
    assert.deepEqual(parse(css.map((l) => (l ? `    ${l}` : '')).join('\n')), [{ t: 'code', text: css.join('\n') }]);
  });

  it('tables, with wrapped values and a table inside a value', () => {
    const b = parse([
      '  /pamela/public     Your website. Live on',
      '                     the internet.',
      '  Kind        what sort of answer:',
      '                Short answer    a line',
      '                Number          digits',
      '  Must be filled in',
      '              tick it.',
    ].join('\n'));
    assert.deepEqual(b, [{ t: 'table', rows: [
      { key: '/pamela/public', value: [{ t: 'p', text: 'Your website. Live on the internet.' }] },
      { key: 'Kind', value: [{ t: 'p', text: 'what sort of answer:' }, { t: 'table', rows: [
        { key: 'Short answer', value: [{ t: 'p', text: 'a line' }] }, { key: 'Number', value: [{ t: 'p', text: 'digits' }] }] }] },
      { key: 'Must be filled in', value: [{ t: 'p', text: 'tick it.' }] },
    ] }]);
  });

  it('shows HTML and other indented examples exactly as written', () => {
    assert.deepEqual(parse('    <head>\n      <title>x</title>\n    </head>'), [{ t: 'code', text: '<head>\n  <title>x</title>\n</head>' }]);
    // a piece of a PHP page: its <?php lines are the main ones
    assert.deepEqual(parse("    <?php if ($a): ?>\n      <li>x</li>\n    <?php endif; ?>"), [{ t: 'code', text: "<?php if ($a): ?>\n  <li>x</li>\n<?php endif; ?>" }]);
    assert.deepEqual(parse('    save a checkpoint\n\n    undo the last change'), [{ t: 'code', text: 'save a checkpoint\n\nundo the last change' }]);
  });

  it('reads titles, subtitles and PART headings', () => {
    const rule = '='.repeat(30);
    const dash = '-'.repeat(30);
    const g = parseGuide('04-x.txt', `${rule}\n Settings\n About 10 minutes.\n${rule}\n\nIntro.\n\n${dash}\nPART 2 -- Make it  (Tab 2)   [ONLY IF I ASK]\n${dash}\n\nText.\n\n${rule}\n ALTERNATIVE -- FileZilla, if you have it\n${rule}\n\nMore.\n`);
    assert.deepEqual([g.title, g.subtitle], ['Settings', 'About 10 minutes.']);
    assert.deepEqual(g.sections.map((s) => [s.title, s.part, s.flag]), [
      ['Introduction', null, null], ['Make it (Tab 2)', 2, 'Only if i ask'], ['Alternative -- FileZilla, if you have it', null, null]]);
  });
});

describe('the real guides', () => {
  const setup = new URL('../../', import.meta.url).pathname;
  const guides = readFileSync(join(setup, 'guides.map'), 'utf8').split('\n').map((l) => l.trim().split(/\s+/))
    .filter(([src, dst]) => src && dst && !src.startsWith('#')).map(([src, dst]) => parseGuide(dst!, readFileSync(join(setup, src!), 'utf8')));
  const all = (blocks: Block[]): Block[] => blocks.flatMap((b) => [b, ...(
    b.t === 'ol' || b.t === 'ul' ? b.items.flatMap(all) : b.t === 'dl' ? b.items.flatMap((i) => all(i.body)) : b.t === 'table' ? b.rows.flatMap((r) => all(r.value)) : [])]);
  const guide = (file: string) => guides.find((g) => g.file === file)!;

  it('all twenty-one parse, every section has content, and no step or heading is left looking like an example', () => {
    assert.equal(guides.length, 21);
    for (const g of guides) {
      assert.ok(g.title && g.sections.length, g.file);
      for (const s of g.sections) {
        assert.ok(s.blocks.length, `${g.file}: ${s.title}`);
        for (const b of all(s.blocks)) {
          if (b.t === 'code') assert.doesNotMatch(b.text, /^(\d{1,2}\.|\*) \S/m, `${g.file}: ${s.title}: a list inside an example`);
          if (b.t === 'p') assert.doesNotMatch(b.text, /^[-=]{10,}/, `${g.file}: a rule left in the text`);
        }
      }
    }
  });

  it('spot checks', () => {
    const upload = guide('01-uploading-files.txt').sections.find((s) => s.part === 2)!;
    assert.ok(upload.blocks.some((b) => b.t === 'table' && b.rows[0]!.key === 'File protocol:'));
    assert.ok(upload.blocks.some((b) => b.t === 'ol' && b.start === 4 && b.items.length === 8));
    const tabs = guide('08-control-panel.txt').sections.find((s) => s.part === 4)!;
    // the tabs by the menu's groups (9-4): Home, then a heading per group
    assert.deepEqual(tabs.blocks.flatMap((b) => (b.t === 'dl' ? b.items.map((i) => i.term) : [])).slice(0, 2), ['Home', 'Responses']);
    assert.ok(tabs.blocks.some((b) => b.t === 'h' && b.text === 'Under inbox'));
    const forms = guide('10-forms.txt').sections.find((s) => s.part === 3)!;
    assert.ok(all(forms.blocks).some((b) => b.t === 'code' && b.text.startsWith('<!doctype html>')));
    const cloudflare = guide('07-wordpress.txt').sections.find((s) => s.part === 2)!;
    const dl = cloudflare.blocks.find((b) => b.t === 'dl') as Extract<Block, { t: 'dl' }>;
    assert.deepEqual(dl.items.map((i) => [i.term, i.body.some((b) => b.t === 'ol')]), [['A) Never store copies of blog pages', true], ['B) Slow down password guessing', true]]);
    const email = guide('05-email-address.txt').sections.find((s) => s.part === 4)!;
    assert.equal(email.blocks.filter((b) => b.t === 'table').length, 1);
    const look = guide('09-protected-folders.txt').sections.find((s) => s.part === 7)!;
    assert.ok(all(look.blocks).some((b) => b.t === 'table' && b.rows.some((r) => r.key === '.pammy-button')), 'the class names are a table');
    assert.ok(all(look.blocks).some((b) => b.t === 'code' && b.text.includes('styles="off"')));
    const words = guide('10-forms.txt').sections.find((s) => s.part === 5)!;
    assert.ok(all(words.blocks).some((b) => b.t === 'table' && b.rows.some((r) => r.key === 'optional-text')));
    assert.equal(guide('01-uploading-files.txt').subtitle, "One-time setup: about 15 minutes. After that it's drag-and-drop.");
    const studio = guide('14-databases-in-the-control-panel.txt');
    assert.deepEqual(studio.sections.filter((s) => s.part).map((s) => s.part), Array.from({ length: 17 }, (_, i) => i + 1));
    const roles = studio.sections.find((s) => s.part === 9)!.blocks.find((b) => b.t === 'dl') as Extract<Block, { t: 'dl' }>;
    assert.deepEqual(roles.items.map((i) => i.term), ['Read only', 'Read & write', 'Structure editor', 'Administrator'],
      'the four roles, in the words on the page (src/pammydb/roles.ts ROLE_NAMES)');
    const connect = studio.sections.find((s) => s.part === 5)!;
    assert.ok(all(connect.blocks).some((b) => b.t === 'table' && b.rows.some((r) => r.key === 'What kind of connection?')));
  });
});
