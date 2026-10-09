// The site's guides as pages: the server parses the plain-text files into blocks
// (src/help.ts); this turns blocks into HTML, links, and search marks.
import { Check, Copy, ExternalLink, Eye, EyeOff } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Button } from '@panel/core/web/components/ui/button';
import { copyText } from '@panel/core/web/hooks/useAction';
import { Badge } from '@panel/core/web/components/ui/badge';
import type { Block, Guide, Section } from './types';

// Long guides get a page per part (g.parts, from the site's guides.map): the guide's own
// page is its introduction and a list of its parts. The rest are one page each, scrolled to
// the part asked for. Some are listed part by part on the Help page itself (g.listed).

export const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const helpWords = (q: string) => fold(q || '').split(/\s+/).filter((w) => w.length > 1);

// Addresses: /help/control-panel (08-control-panel.txt), and a section either as its
// own page, /help/control-panel/part-9 (long guides), or as a place on the guide's
// page, /help/wordpress#part-2. ?q= marks search words.
export const guideSlug = (file: string) => file.replace(/^\d+-/, '').replace(/\.txt$/, '').toLowerCase();
export const sectionSlug = (s: Section) => (s.part ? `part-${s.part}` : s.title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
export const isIntro = (g: Guide, i: number) => i === 0 && g.sections[0]?.title === 'Introduction';

export function guideHref(guides: Guide[], file: string, section?: number | null, q?: string) {
  const g = guides.find((x) => x.file === file);
  const s = g && section !== null && section !== undefined ? g.sections[section] : null;
  const base = `/help/${guideSlug(file)}`;
  const query = q ? `?q=${encodeURIComponent(q)}` : '';
  if (!g || !s || isIntro(g, section!)) return `${base}${query}`;
  return g.parts ? `${base}/${sectionSlug(s)}${query}` : `${base}${query}#${sectionSlug(s)}`;
}
export const guideNumber = (g: Guide) => (g.file.match(/^\d+/) || [''])[0];
// the plain-text guides write a dash as "--"
export const dashes = (text: string) => text.replace(/ -- /g, ' – ');

export function marked(text: string, words: string[]): ReactNode[] {
  if (!words.length) return [text];
  const re = new RegExp(`(${words.map(escapeRe).join('|')})`, 'gi');
  return String(text).split(re).map((piece, i) => (i % 2 ? <mark key={i} className="rounded-sm bg-yellow-200 px-0.5 text-inherit dark:bg-yellow-500/40">{piece}</mark> : piece)).filter((x) => x !== '');
}

export type Ctx = { guides: Guide[]; guide: Guide | null; words: string[] };

// Links to web addresses, other guides and their parts; words set off by two
// spaces ("type  pamela  exactly") shown as something to type.
const INLINE_RE = /(PART (\d+) of (\d\d-[a-z0-9-]+\.txt))|((\d\d-[a-z0-9-]+\.txt),? PART (\d+))|(\d\d-[a-z0-9-]+\.txt)|(\bPART (\d+)\b)|(https?:\/\/[^\s)"'<>]+[^\s)"'<>.,;:])|((?<= {2})(?=\S*[A-Za-z0-9])\S+(?= {2}|$))/g;
const linkClass = 'font-medium text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary';

export function Inline({ text, ctx }: { text: string; ctx: Ctx }) {
  const out: ReactNode[] = [];
  let at = 0;
  let k = 0;
  const partLink = (file: string, n: number, label: string) => {
    const g = ctx.guides.find((x) => x.file === file);
    const i = g ? g.sections.findIndex((s) => s.part === n) : -1;
    return g ? <Link key={k++} to={guideHref(ctx.guides, file, i >= 0 ? i : null)} className={linkClass}>{marked(label, ctx.words)}</Link> : label;
  };
  for (const m of text.matchAll(INLINE_RE)) {
    if (m.index > at) out.push(...marked(dashes(text.slice(at, m.index)), ctx.words));
    if (m[1]) out.push(partLink(m[3]!, Number(m[2]), m[1]));
    else if (m[4]) out.push(partLink(m[5]!, Number(m[6]), m[4]));
    else if (m[7]) out.push(ctx.guides.some((g) => g.file === m[7]) ? <Link key={k++} to={guideHref(ctx.guides, m[7])} className={linkClass}>{marked(m[7], ctx.words)}</Link> : m[7]);
    else if (m[8]) out.push(ctx.guide ? partLink(ctx.guide.file, Number(m[9]), m[8]) : m[8]);
    else if (m[10]) out.push(<a key={k++} href={m[10]} target="_blank" rel="noopener" className={`${linkClass} [overflow-wrap:anywhere]`}>{marked(m[10], ctx.words)}</a>);
    else out.push(<code key={k++} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.9em] text-foreground">{marked(m[11]!, ctx.words)}</code>);
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(...marked(dashes(text.slice(at)), ctx.words));
  return <>{out.map((x, i) => (typeof x === 'string' ? <span key={`t${i}`}>{x}</span> : x))}</>;
}

// A list item or table cell that's one short paragraph needs no paragraph around it.
function BlocksInline({ blocks, ctx }: { blocks: Block[]; ctx: Ctx }) {
  return blocks.length === 1 && blocks[0]!.t === 'p' ? <Inline text={blocks[0]!.text} ctx={ctx} /> : <Blocks blocks={blocks} ctx={ctx} />;
}

export function Blocks({ blocks, ctx }: { blocks: Block[]; ctx: Ctx }) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'p': {
            const preview = PREVIEW_RE.exec(b.text);
            if (preview) return <Preview key={i} url={preview[1]!} />;
            return /^(IMPORTANT|ONE WARNING|WARNING|NOTE):/.test(b.text)
              ? <p key={i} className="rounded-md border border-primary/20 bg-primary-soft/60 px-4 py-3"><Inline text={b.text} ctx={ctx} /></p>
              : <p key={i}><Inline text={b.text} ctx={ctx} /></p>;
          }
          case 'h': return <h3 key={i} className="pt-2 text-base font-semibold">{marked(b.text, ctx.words)}</h3>;
          case 'code':
            if (/^https?:\/\/\S+$/.test(b.text)) return <p key={i}><a href={b.text} target="_blank" rel="noopener" className={`${linkClass} [overflow-wrap:anywhere]`}>{b.text}</a></p>;
            return <CodeBlock key={i} text={b.text} words={ctx.words} />;
          case 'ol': return (
            <ol key={i} start={b.start === 1 ? undefined : b.start} type={b.alpha ? 'a' : undefined} className={b.alpha ? 'list-[lower-alpha] space-y-2 pl-7' : 'list-decimal space-y-2 pl-7 marker:font-semibold marker:text-primary'}>
              {b.items.map((item, j) => <li key={j} className="pl-1"><BlocksInline blocks={item} ctx={ctx} /></li>)}
            </ol>
          );
          case 'ul': return <ul key={i} className="list-disc space-y-2 pl-7 marker:text-primary">{b.items.map((item, j) => <li key={j} className="pl-1"><BlocksInline blocks={item} ctx={ctx} /></li>)}</ul>;
          case 'dl': return (
            <dl key={i} className="space-y-3">
              {b.items.map((it, j) => (
                <div key={j}>
                  <dt className="font-semibold"><Inline text={it.term} ctx={ctx} /></dt>
                  <dd className="mt-1 space-y-3 border-l-2 border-border pl-4"><Blocks blocks={it.body} ctx={ctx} /></dd>
                </div>
              ))}
            </dl>
          );
          case 'table': return (
            <div key={i} className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-left">
                <tbody className="divide-y divide-border">
                  {b.rows.map((r, j) => (
                    <tr key={j} className="align-top">
                      <th scope="row" className="w-1/3 bg-muted/50 px-3 py-2 font-semibold"><Inline text={r.key} ctx={ctx} /></th>
                      <td className="space-y-2 px-3 py-2"><BlocksInline blocks={r.value} ctx={ctx} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
          default: return null;
        }
      })}
    </>
  );
}

export function SectionTitle({ s, words = [], flag = true }: { s: Section; words?: string[]; flag?: boolean }) {
  return (
    <>
      {s.part && <span className="mr-2 text-primary">Part {s.part}</span>}
      <span>{marked(dashes(s.title), words)}</span>
      {s.flag && flag && <Badge className="ml-2 align-middle">{s.flag}</Badge>}
    </>
  );
}

export function snippet(text: string, words: string[]) {
  const flat = text.replace(/\s+/g, ' ');
  const hit = words.map((w) => fold(flat).indexOf(w)).filter((i) => i >= 0);
  const start = Math.max(0, (hit.length ? Math.min(...hit) : 0) - 60);
  return `${start ? '... ' : ''}${flat.slice(start, start + 200).trim()}${start + 200 < flat.length ? ' ...' : ''}`;
}

// What a part is about, for the list of parts: the first sentence it says, or
// for a part that's a list of terms (like "The tabs"), the terms.
export function firstSentence(s: Section): string {
  const first = s.blocks[0];
  if (first?.t === 'dl') {
    const terms = first.items.map((it) => it.term.replace(/^"|"$/g, ''));
    const long = terms.some((t) => t.length > 25);
    const n = long ? 2 : 6;
    return `${terms.slice(0, n).join(long ? '; ' : ', ')}${terms.length > n ? (long ? '; and more.' : ', ...') : ''}`;
  }
  const find = (blocks: Block[]): { text: string } | null => {
    for (const b of blocks) {
      const found = b.t === 'p' ? b : b.t === 'ol' || b.t === 'ul' ? find(b.items.flat()) : b.t === 'dl' ? find(b.items.flatMap((it) => it.body)) : null;
      if (found) return found;
    }
    return null;
  };
  const p = find(s.blocks);
  if (!p) return '';
  const text = p.text.replace(/\s+/g, ' ');
  const end = text.search(/[.!?:](\s|$)/);
  return end > 0 && end < 160 ? text.slice(0, end + 1).replace(/:$/, '.') : `${text.slice(0, 140).trim()}${text.length > 140 ? '...' : ''}`;
}

export function search(guides: Guide[], words: string[]) {
  // every word must appear somewhere in the section; words in its title count most
  const hits: { g: Guide; s: Section; i: number; score: number }[] = [];
  for (const g of guides) {
    g.sections.forEach((s, i) => {
      const title = fold(`${s.title} ${g.title}`);
      const body = fold(s.text);
      if (!words.every((w) => title.includes(w) || body.includes(w))) return;
      hits.push({ g, s, i, score: words.reduce((n, w) => n + (fold(s.title).includes(w) ? 10 : 0) + Math.min(body.split(w).length - 1, 5), 0) });
    });
  }
  return hits.sort((a, b) => b.score - a.score);
}

// An example of a whole file (a page, a style file): shown as it is, with a Copy button.
function CodeBlock({ text, words }: { text: string; words: string[] }) {
  const [copied, setCopied] = useState(false);
  const long = text.split('\n').length > 3;
  return (
    <div className="group relative">
      <pre className={`overflow-x-auto rounded-lg border border-border bg-muted/70 p-4 font-mono text-sm leading-relaxed ${long ? 'pt-11 sm:pt-4 sm:pr-24' : 'pr-24'}`}><code>{marked(text, words)}</code></pre>
      <Button type="button" size="sm" variant="outline" className="absolute right-2 top-2 h-7 bg-card px-2.5 text-xs"
        onClick={async () => { await copyText(text, 'Code'); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>
        {copied ? <Check /> : <Copy />}{copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

// "Preview: https://pammy.org/_pammy/examples/garden/login.html" in a guide: the
// example page itself, in a frame (it runs its sign-in script in preview mode, and
// the gate lets only the panel frame it). A worked example (10-forms.txt, PART 12
// to 14) is a whole folder, so its address ends in a slash -- and that one is the
// real page, fetching its own answers, so it keeps its own origin (no sandbox).
const PREVIEW_RE = /^Preview: (https:\/\/pammy\.org\/_pammy\/examples\/[a-z]+\/(?:[a-z-]+\.html)?)$/;
function Preview({ url }: { url: string }) {
  const [open, setOpen] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const parts = url.split('/').filter(Boolean);
  const whole = url.endsWith('/');
  const page = whole ? parts[parts.length - 1]! : parts.slice(-2).join(' / ');
  // the whole frame on screen: its page bar sits at the bottom
  useEffect(() => { if (open) frame.current?.scrollIntoView({ block: 'nearest' }); }, [open]);
  return (
    <div data-testid="example-preview" className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <Eye className="size-4 text-primary" />
        <span className="mr-auto text-sm font-medium">Preview <span className="font-normal text-muted-foreground">{page}</span></span>
        <Button type="button" size="sm" variant={open ? 'outline' : 'light'} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? <EyeOff /> : <Eye />}{open ? 'Hide preview' : 'Show preview'}
        </Button>
        <Button asChild size="sm" variant="ghost">
          <a href={url} target="_blank" rel="noopener" className="no-underline"><ExternalLink />Open in a new tab</a>
        </Button>
      </div>
      {open && (
        <iframe ref={frame} src={url} title={`Preview of ${page}`} {...(whole ? {} : { sandbox: 'allow-scripts allow-forms' })} loading="lazy" referrerPolicy="no-referrer"
          className="block h-[38rem] w-full border-t border-border bg-white" />
      )}
    </div>
  );
}
