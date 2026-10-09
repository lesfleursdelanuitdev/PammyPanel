// Rich text (docs/rich-text-plan.md): what may be in a field she marked "Rich
// text", and the one function that makes anything else into that.
//
// A rich-text field is HTML, and HTML is not just words: it can carry scripts,
// tracking pictures, forms and links that run code. Every other field is put on
// a page as words (textContent). A rich-text field is put on a page AS HTML --
// that is the point of it -- so the promise has to be that **whatever is in a
// rich-text field, from whoever, is safe to show as HTML.** Three rules keep it:
//
//  * **An allowlist, never a blocklist.** RICH below is every tag and attribute
//    there can be. Anything else is removed and the words inside it kept.
//  * **A real HTML parser** (sanitize-html, on htmlparser2), never patterns
//    over the text. Broken HTML is read the way a parser reads it.
//  * **Cleaned on every way in AND on the way out.** The panel's forms and the
//    data API clean what they are sent (T6), and the data API cleans what it
//    answers (T7), because her databases can be written by anything -- her own
//    SQL, her WordPress, a program with an older catalog. What is stored is not
//    proof it came through here.
//
// The editor (web/src/components/rich-text.tsx) can only make these same
// things. That is a convenience, not the defence: anyone can send anything.
//
// Pure: no database, no socket, no clock.
import { Parser } from 'htmlparser2';
import sanitizeHtml from 'sanitize-html';

// What can be refused: too big, or a table past its limits. In her words, for
// the panel to hand on as an AccountError and the gate as a 400.
export class RichTextError extends Error {}

// The whole of what may be in a rich-text field (T4, T17). Levels 2-4 only:
// level 1 is the page's own title. Underline and strikethrough as the editor
// writes them (<u>, <s>).
const TAGS = [
  'p', 'br', 'h2', 'h3', 'h4', 'strong', 'em', 'u', 's',
  'ul', 'ol', 'li', 'blockquote', 'hr', 'a',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
];

// Other spellings of the same things, so what she pastes from elsewhere keeps
// its bold rather than losing it. A heading 1 becomes a 2, a 5 or 6 a 4.
const SAME_AS: Record<string, string> = {
  b: 'strong', i: 'em', strike: 's', del: 's', h1: 'h2', h5: 'h4', h6: 'h4',
};

// Tags whose CONTENTS go too, not just the tag: their text is code or
// machinery, never her words.
const DROP_WITH_CONTENTS = [
  'script', 'style', 'textarea', 'option', 'noscript', 'template', 'title', 'head',
  'iframe', 'object', 'embed', 'svg', 'math', 'select', 'xmp', 'noembed', 'noframes',
];

// T5: where a link may go. An address on her own site (`/recipes.html`,
// `recipes.html`, `#method`) has no scheme and is always allowed.
const SCHEMES = ['https', 'http', 'mailto', 'tel'];

// T19: at most this big. Past it the save is refused rather than the table cut.
export const MAX_COLUMNS = 30;
export const MAX_ROWS = 500;
const MAX_SPAN = 20;

// The same limit every text field has (src/studio/records.ts), on the HTML.
export const MAX_RICH = 100_000;


// Where a link goes, as a browser would read it: entities are already decoded
// by the parser; tabs, newlines and other control characters inside a scheme
// are ignored by browsers (`java\tscript:`), so they are ignored here too.
function safeHref(raw: string | undefined): { ok: boolean; outside: boolean } {
  if (raw === undefined) return { ok: false, outside: false };
  const href = raw.replace(/[\u0000-\u0020\u007f-\u009f\u00a0\u2028\u2029]/g, '');
  if (href === '') return { ok: false, outside: false };
  // `//other.site/...` borrows the page's scheme and leaves the site; so does
  // `\\other.site`, which browsers read as `//`
  if (/^[\\/]{2}/.test(href)) return { ok: false, outside: false };
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href);
  if (!scheme) return { ok: true, outside: false };
  const s = scheme[1]!.toLowerCase();
  if (!SCHEMES.includes(s)) return { ok: false, outside: false };
  return { ok: true, outside: s === 'http' || s === 'https' };
}

// colspan / rowspan: a whole number from 1 to 20, or nothing.
const span = (v: string | undefined): string | null =>
  (v !== undefined && /^\s*\d{1,2}\s*$/.test(v) && Number(v) >= 1 && Number(v) <= MAX_SPAN ? String(Number(v)) : null);

// Clean one piece of HTML. Returns null for "nothing in it" (T10), so an empty
// editor is stored as NULL and "required" keeps working.
//
// `limits: false` is for the way OUT: what is already stored is cleaned just
// the same, but a table that is too big is still shown -- refusing to READ
// something because of how big it is would lose her nothing but the page.
export function cleanRich(html: string, o: { limits?: boolean } = {}): string | null {
  const limits = o.limits ?? true;
  // Where the parser is, as a stack of the tags it has opened (every open
  // has a close in htmlparser2, implied or not). T18 needs it: a table or a
  // heading inside a table's cell is flattened.
  const open: string[] = [];
  const inCell = () => open.slice(0, -1).some((t) => t === 'td' || t === 'th');
  // T19, counted as the parser goes: rows of each outermost table, and the
  // width of each row (a cell spanning three columns counts three)
  let rows = 0;
  let width = 0;
  let tooBig = false;
  // Tags to take away while keeping their words. Not by renaming them to
  // something disallowed: sanitize-html then writes that name on the NEXT
  // tag's closing tag at the same depth (`<a ...>ok</pammy-unwrap>`, found
  // by test). Instead the tag keeps its name, and the attributes object it
  // was given -- the frame keeps that very object -- marks it for the
  // exclusiveFilter below, which drops the tag and keeps what is inside.
  const unwrap = new WeakSet<sanitizeHtml.Attributes>();
  type Tag = { tagName: string; attribs: sanitizeHtml.Attributes };
  const away = (name: string): Tag => { const attribs: sanitizeHtml.Attributes = {}; unwrap.add(attribs); return { tagName: name, attribs }; };

  const cellOrPart = (name: string, attribs: sanitizeHtml.Attributes): Tag => {
    if (inCell()) return away(name);
    if (name !== 'td' && name !== 'th') return { tagName: name, attribs: {} };
    const out: sanitizeHtml.Attributes = {};
    const c = span(attribs.colspan);
    const r = span(attribs.rowspan);
    if (c && c !== '1') out.colspan = c;
    if (r && r !== '1') out.rowspan = r;
    return { tagName: name, attribs: out };
  };

  const clean = sanitizeHtml(html, {
    allowedTags: TAGS,
    allowedAttributes: { a: ['href', 'rel'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'], ol: ['start'] },
    allowedSchemes: SCHEMES,
    allowedSchemesAppliedToAttributes: ['href'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    nonTextTags: DROP_WITH_CONTENTS,
    // no class, no id, no style, no data-* -- and no comments, which
    // sanitize-html never keeps
    allowedClasses: {},
    allowedStyles: {},
    parser: { lowerCaseTags: true, lowerCaseAttributeNames: true, decodeEntities: true },
    onOpenTag(name) {
      open.push(name);
      // a new outermost table starts its own count
      if (name === 'table' && open.indexOf('table') === open.length - 1) rows = 0;
      const table = open.lastIndexOf('table');
      const outermost = open.indexOf('table') === table;
      if (name === 'tr' && table !== -1 && outermost && !inCell()) {
        rows++;
        width = 0;
        if (rows > MAX_ROWS) tooBig = true;
      }
    },
    onCloseTag() { open.pop(); },
    transformTags: {
      ...Object.fromEntries(Object.entries(SAME_AS).map(([from, to]) => [from, (_: string, attribs: sanitizeHtml.Attributes) => {
        // a heading in a cell is a paragraph there (T18)
        if (to.startsWith('h') && inCell()) return { tagName: 'p', attribs: {} };
        return { tagName: to, attribs };
      }])),
      h2: (n) => ({ tagName: inCell() ? 'p' : n, attribs: {} }),
      h3: (n) => ({ tagName: inCell() ? 'p' : n, attribs: {} }),
      h4: (n) => ({ tagName: inCell() ? 'p' : n, attribs: {} }),
      blockquote: (n) => (inCell() ? away(n) : { tagName: n, attribs: {} }),
      hr: (n) => (inCell() ? away(n) : { tagName: n, attribs: {} }),
      table: cellOrPart, thead: cellOrPart, tbody: cellOrPart, tr: cellOrPart,
      td: (n, a) => {
        const t = cellOrPart(n, a);
        if (!unwrap.has(t.attribs)) { width += Number(t.attribs.colspan ?? 1); if (width > MAX_COLUMNS) tooBig = true; }
        return t;
      },
      th: (n, a) => {
        const t = cellOrPart(n, a);
        if (!unwrap.has(t.attribs)) { width += Number(t.attribs.colspan ?? 1); if (width > MAX_COLUMNS) tooBig = true; }
        return t;
      },
      ol: (n, attribs) => {
        const start = attribs.start !== undefined && /^\s*\d{1,6}\s*$/.test(attribs.start) ? String(Number(attribs.start)) : null;
        const out: sanitizeHtml.Attributes = {};
        if (start && start !== '1') out.start = start;
        return { tagName: n, attribs: out };
      },
      // T5: a link that may not be kept is removed and its words kept. The
      // `rel` is always ours, never what was sent; one to another website
      // is not vouched for either (Q4, nofollow). No `target`: it opens
      // where it is.
      a: (_, attribs) => {
        const where = safeHref(attribs.href);
        if (!where.ok) return away('a');
        return {
          tagName: 'a',
          attribs: { href: attribs.href!.trim(), rel: where.outside ? 'noopener noreferrer nofollow' : 'noopener noreferrer' },
        };
      },
    },
    // what was marked above goes, its words kept -- and sanitize-html's own
    // scheme check is the second lock on the same door: a link it took the
    // address off is not left behind as an empty <a>
    exclusiveFilter: (frame) =>
      (unwrap.has(frame.attribs) || (frame.tag === 'a' && !frame.attribs.href) ? 'excludeTag' : false),
  });

  if (tooBig && limits) {
    throw new RichTextError(`A table can have at most ${MAX_COLUMNS} columns and ${MAX_ROWS} rows. Split it into smaller tables.`);
  }
  if (isEmpty(clean)) return null;
  if (limits && clean.length > MAX_RICH) throw new RichTextError('This is too long to store. Split it into more than one record.');
  return clean;
}

// Nothing a reader would see: no words, and no dividing line.
function isEmpty(clean: string): boolean {
  if (/<hr\b/i.test(clean)) return false;
  return plainOf(clean).trim() === '';
}

// Is this HTML at all, or writing from before the field was rich text (T11)?
// A tag has to look like one: `I <3 you` and `a < b` are writing.
export const looksLikeHtml = (v: string): boolean => /<\/?[a-z][a-z0-9]*(\s[^<>]*)?\/?>/i.test(v);

// Writing as HTML, word for word: a blank line starts a paragraph, a single
// line break stays one. Nothing in it becomes a tag -- a `<` typed is a `<`.
export function fromPlain(text: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return text.replace(/\r\n?/g, '\n').split(/\n\s*\n/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => `<p>${para.split('\n').map(esc).join('<br>')}</p>`)
    .join('');
}

// A rich-text field's value, however it was stored, as clean HTML -- for
// every way in and out. Writing from before the field was rich text becomes
// paragraphs; anything else goes through the cleaner. Not text at all (a
// number in a text column, say) is left to the caller's usual rules.
export function asRich(v: unknown, o: { limits?: boolean } = {}): string | null {
  if (v === null || v === undefined) return null;
  const text = typeof v === 'string' ? v : String(v);
  return cleanRich(looksLikeHtml(text) ? text : fromPlain(text), o);
}

// What arrives from outside can be far bigger than what is kept -- a page
// pasted from a word processor is mostly styles the cleaner takes away -- but
// not without end.
export const MAX_RICH_SENT = 500_000;

// The words only, for lists, the record picker and anywhere HTML is not
// shown (T15). A space where one block ends and the next begins, so
// "<p>one</p><p>two</p>" reads "one two", not "onetwo".
const BLOCKS = new Set(['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th', 'tr', 'blockquote', 'hr', 'div']);
export function plainOf(html: string, max = Infinity): string {
  let out = '';
  let skipping = 0;
  const parser = new Parser({
    onopentag(name) {
      if (DROP_WITH_CONTENTS.includes(name)) skipping++;
      if (BLOCKS.has(name)) out += ' ';
    },
    onclosetag(name) {
      if (DROP_WITH_CONTENTS.includes(name)) skipping = Math.max(0, skipping - 1);
      if (BLOCKS.has(name)) out += ' ';
    },
    ontext(t) { if (!skipping) out += t; },
  }, { decodeEntities: true, lowerCaseTags: true });
  parser.write(html);
  parser.end();
  const words = out.replace(/[\s\u00a0]+/g, ' ').trim();
  return words.length > max ? `${words.slice(0, max).trimEnd()}…` : words;
}
