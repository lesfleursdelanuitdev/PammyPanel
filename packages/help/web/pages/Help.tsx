import { ArrowLeft, ArrowRight, Compass, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { Loading } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { Input } from '@panel/core/web/components/ui/input';
import { NativeSelect } from '@panel/core/web/components/ui/native-select';
import { useApi } from '@panel/core/web/hooks/useApi';
import { useMe } from '@panel/core/web/hooks/useMe';
import {
  Blocks, dashes, firstSentence, fold, guideHref, guideNumber, guideSlug, helpWords, isIntro, marked, search,
  SectionTitle, sectionSlug, snippet, type Ctx,
} from '../lib/help';
import type { Guide } from '../lib/types';
import { FirstStepsBack } from '../components/first-steps';
import { isOn, SITE } from '@panel/core/web/lib/site';
import { may } from '@panel/core/web/lib/rights';

// /help                              every guide, and a search box (?q=words: results)
// /help/control-panel                one guide (a long one: its introduction and parts)
// /help/control-panel/part-9         one part of a long guide
// /help/wordpress#part-2             a place in a shorter guide
export function Help() {
  const help = useApi<{ guides: Guide[] }>('/api/help', { staleTime: Infinity });
  const { guide: guideParam, section: sectionParam } = useParams();
  const [params] = useSearchParams();
  const location = useLocation();
  const q = params.get('q') || '';

  if (!help.data) return <Wrap><Loading rows={4} /></Wrap>;
  const guides = help.data.guides;
  if (!guideParam) return <HelpHome guides={guides} q={q} />;
  const guide = guides.find((g) => guideSlug(g.file) === guideParam);
  if (!guide) return <Navigate to="/help" replace />;      // a guide that isn't there (any more)
  const want = sectionParam ?? (location.hash.slice(1) || null);
  const i = want ? guide.sections.findIndex((s) => sectionSlug(s) === want) : -1;
  const section = i >= 0 ? i : null;
  if (guide.parts && section !== null && section > 0) return <GuidePart key={`${guide.file}/${section}`} guides={guides} g={guide} i={section} q={q} />;
  return <GuidePage key={guide.file} guides={guides} g={guide} section={section} q={q} />;
}

function Wrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-3xl px-4 pb-24 pt-6 sm:px-6 sm:pt-8 lg:px-8">{children}</div>;
}

function useTitle(title: string) {
  useEffect(() => { document.title = title; }, [title]);
}

function SearchForm({ initial, live }: { initial: string; live: boolean }) {
  const [value, setValue] = useState(initial);
  const navigate = useNavigate();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const to = (v: string) => (v.trim() ? `/help?q=${encodeURIComponent(v.trim())}` : '/help');
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <form role="search" className="flex gap-2" onSubmit={(e) => { e.preventDefault(); clearTimeout(timer.current); navigate(to(value), { replace: live }); }}>
      <Input id="help-q" type="search" value={value} autoFocus={live && !!initial} aria-label="Search the guides" autoComplete="off"
        placeholder={`e.g. ${SITE.help?.searchExample ?? 'passkey'}`}
        onChange={(e) => {
          const v = e.target.value;
          setValue(v);
          if (!live) return;
          clearTimeout(timer.current);
          timer.current = setTimeout(() => navigate(to(v), { replace: true }), 150);
        }} />
      <Button type="submit"><Search />Search</Button>
    </form>
  );
}

function HelpHome({ guides, q }: { guides: Guide[]; q: string }) {
  useTitle(`Help · ${SITE.panelName}`);
  const words = helpWords(q);
  const hits = words.length ? search(guides, words) : [];
  const byPart = guides.filter((g) => g.listed);
  const me = useMe();

  return (
    <Wrap>
      <h1 className="text-2xl font-bold tracking-tight sm:text-[1.75rem]">Help</h1>
      <p className="mt-1.5 text-[0.9375rem] text-muted-foreground">{SITE.help?.intro ?? 'The guides. Search them all, or open one.'}</p>
      <div className="mt-6"><SearchForm initial={q} live /></div>
      {/* the first-steps card, put away on Home (docs/phase9-plan.md 9-3) */}
      {SITE.help?.firstSteps && !words.length && <FirstStepsBack />}
      {isOn('getting-started') && me && may(me, 'databases') && !words.length && (
        <Link to="/getting-started" className="mt-6 flex items-center gap-3 rounded-lg border border-border bg-card p-4 no-underline shadow-card hover:border-primary/40">
          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary-soft text-primary"><Compass className="size-[1.125rem]" /></span>
          <span>
            <span className="block font-semibold text-foreground">Getting started: what would you like to do?</span>
            <span className="block text-sm text-muted-foreground">A few questions, then the steps, ticked off as you go.</span>
          </span>
        </Link>
      )}

      {!guides.length ? <p className="mt-6 text-muted-foreground">The guides are not installed with this version of the panel.</p>
        : words.length ? (
          <>
            <p id="help-summary" aria-live="polite" className="mt-6 text-muted-foreground">{hits.length ? `${hits.length} place${hits.length === 1 ? '' : 's'} in your guides.` : 'Nothing found. Try fewer or different words.'}</p>
            <ul aria-label="Search results" className="mt-3 divide-y divide-border rounded-lg border border-border bg-card shadow-card">
              {hits.slice(0, 50).map(({ g, s, i }) => (
                <li key={`${g.file}/${i}`}>
                  <Link to={guideHref(guides, g.file, i, q)} className="block px-5 py-4 no-underline hover:bg-accent/50">
                    <span className="font-semibold text-foreground"><SectionTitle s={s} words={words} /></span>
                    <span className="text-sm text-muted-foreground"> in {dashes(g.title)}</span>
                    <span className="mt-1 block text-[0.95rem] text-muted-foreground">{marked(dashes(snippet(s.text, words)), words)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            {byPart.map((g) => (
              <section key={g.file} className="mt-12">
                <h2 className="text-base font-semibold">{dashes(g.title)} <span className="text-base font-normal text-muted-foreground">guide {guideNumber(g)}</span></h2>
                <ul className="mt-4 grid gap-3 sm:grid-cols-2">
                  {g.sections.map((s, i) => (
                    <li key={i}>
                      <Link to={guideHref(guides, g.file, i)} className="flex h-full flex-col rounded-lg border border-border bg-card p-4 no-underline shadow-card hover:border-primary/40">
                        <span className="text-sm font-semibold text-primary">{isIntro(g, i) ? 'Start here' : s.part ? `Part ${s.part}` : ' '}</span>
                        <span className="mt-0.5 text-[0.9375rem] font-semibold leading-snug text-foreground">
                          {isIntro(g, i) ? 'About the control panel' : dashes(s.title)}{s.flag && <Badge className="ml-2 align-middle">{s.flag}</Badge>}
                        </span>
                        <span className="mt-1 text-[0.95rem] text-muted-foreground">{dashes(firstSentence(s))}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            <section className="mt-12">
              {byPart.length > 0 && <h2 className="text-base font-semibold">More guides</h2>}
              <ul className="mt-4 divide-y divide-border rounded-lg border border-border bg-card shadow-card">
                {guides.filter((g) => !g.listed).map((g) => {
                  const intro = isIntro(g, 0) ? g.sections[0]!.blocks.find((b) => b.t === 'p') : undefined;
                  return (
                    <li key={g.file}>
                      <Link to={guideHref(guides, g.file)} className="flex gap-4 px-5 py-4 no-underline hover:bg-accent/40">
                        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary-soft text-sm font-semibold text-primary tabular-nums">{guideNumber(g)}</span>
                        <span className="min-w-0">
                          <span className="block text-[0.9375rem] font-semibold leading-snug text-foreground">{dashes(g.title)}</span>
                          <span className="mt-0.5 block text-[0.95rem] text-muted-foreground">{dashes(g.subtitle || snippet(intro && 'text' in intro ? intro.text : '', []))}</span>
                          <span className="mt-1 block text-sm text-muted-foreground">{g.sections.length} section{g.sections.length === 1 ? '' : 's'}</span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          </>
        )}
    </Wrap>
  );
}

function Crumbs({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <nav aria-label="Where you are" className="flex flex-wrap items-center gap-1.5 text-[0.95rem]">
        <ArrowLeft className="size-4 text-muted-foreground" />{children}
      </nav>
      <div className="sm:w-80"><SearchForm initial="" live={false} /></div>
    </div>
  );
}

function Marking({ q, href }: { q: string; href: string }) {
  if (!q) return null;
  return <p className="mt-3 text-sm text-muted-foreground">Search words marked: "{q}". <Link to={href} className="font-semibold">Clear</Link></p>;
}

const prose = 'space-y-4 text-[0.975rem] leading-relaxed';

function GuidePage({ guides, g, section, q }: { guides: Guide[]; g: Guide; section: number | null; q: string }) {
  useTitle(`${dashes(g.title)} · Help · ${SITE.panelName}`);
  const words = helpWords(q);
  const ctx: Ctx = { guides, guide: g, words };
  const byPart = g.parts;
  const intro = isIntro(g, 0) ? g.sections[0]! : null;
  const shown = byPart ? (intro ? [intro] : []) : g.sections;
  const location = useLocation();

  useEffect(() => {
    const target = !byPart && section !== null ? document.getElementById(sectionSlug(g.sections[section]!)) : null;
    if (target) target.scrollIntoView({ block: 'start' }); else window.scrollTo(0, 0);
  }, [byPart, section, g, location.key]);

  return (
    <Wrap>
      <Crumbs><Link to="/help">All guides</Link></Crumbs>
      <article>
        <p className="text-sm font-semibold text-primary">Guide {guideNumber(g)} <span className="font-normal text-muted-foreground">{g.file}</span></p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-[1.75rem]">{dashes(g.title)}</h1>
        {g.subtitle && <p className="mt-1.5 text-[0.9375rem] text-muted-foreground">{dashes(g.subtitle)}</p>}
        <Marking q={q} href={guideHref(guides, g.file, section)} />
        {!byPart && g.sections.length > 2 && (
          <nav aria-label="In this guide" className="mt-8 rounded-lg border border-border bg-card p-5 shadow-card">
            <h2 className="text-base font-semibold">In this guide</h2>
            <ol className="mt-2 space-y-1">
              {g.sections.map((s, k) => <li key={k}><Link to={guideHref(guides, g.file, k, q)} className="no-underline hover:underline"><SectionTitle s={s} flag={false} /></Link></li>)}
            </ol>
          </nav>
        )}
        {shown.map((s) => {
          const k = g.sections.indexOf(s);
          return (
            <section key={k} id={isIntro(g, k) ? undefined : sectionSlug(s)} className={`mt-10 scroll-mt-20 ${prose}`}>
              {!isIntro(g, k) && <h2 className="border-b border-border pb-2 text-lg font-semibold"><SectionTitle s={s} words={words} /></h2>}
              <Blocks blocks={s.blocks} ctx={ctx} />
            </section>
          );
        })}
        {byPart && (
          <nav aria-label="Parts of this guide" className="mt-12">
            <h2 className="text-base font-semibold">Parts of this guide</h2>
            <ul className="mt-4 divide-y divide-border rounded-lg border border-border bg-card shadow-card">
              {g.sections.map((s, k) => (s === intro ? null : (
                <li key={k}>
                  <Link to={guideHref(guides, g.file, k, q)} className="block px-5 py-4 no-underline hover:bg-accent/40">
                    <span className="block font-semibold text-foreground"><SectionTitle s={s} /></span>
                    <span className="mt-0.5 block text-[0.95rem] text-muted-foreground">{dashes(firstSentence(s))}</span>
                  </Link>
                </li>
              )))}
            </ul>
          </nav>
        )}
      </article>
    </Wrap>
  );
}

// One part of a long guide, with the way back and on.
function GuidePart({ guides, g, i, q }: { guides: Guide[]; g: Guide; i: number; q: string }) {
  const s = g.sections[i]!;
  useTitle(`${s.part ? `Part ${s.part}: ` : ''}${dashes(s.title)} · Help · ${SITE.panelName}`);
  const words = helpWords(q);
  const navigate = useNavigate();
  const first = isIntro(g, 0) ? 1 : 0;
  const prev = i > first ? i - 1 : null;
  const next = i < g.sections.length - 1 ? i + 1 : null;
  useEffect(() => { window.scrollTo(0, 0); }, []);   // (braces: scrollTo returns a promise in newer browsers, which React would call on the way out)

  return (
    <Wrap>
      <Crumbs><Link to="/help">All guides</Link><span aria-hidden className="text-muted-foreground">›</span><Link to={guideHref(guides, g.file)}>{dashes(g.title)}</Link></Crumbs>
      <article>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-semibold text-primary">{s.part ? `Part ${s.part} of ${g.sections.filter((x) => x.part).length}` : dashes(g.title)}</p>
          <div className="flex items-center gap-2 text-sm">
            <label htmlFor="guide-jump" className="font-semibold">Go to</label>
            <NativeSelect id="guide-jump" className="w-auto max-w-64" value={String(i)} onChange={(e) => navigate(guideHref(guides, g.file, Number(e.target.value) || null))}>
              {g.sections.map((x, k) => <option key={k} value={String(k)}>{k === 0 && first ? 'Introduction' : `${x.part ? `Part ${x.part}: ` : ''}${dashes(x.title)}`}</option>)}
            </NativeSelect>
          </div>
        </div>
        <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-[1.75rem]">{marked(dashes(s.title), words)}{s.flag && <Badge className="ml-3 align-middle">{s.flag}</Badge>}</h1>
        <Marking q={q} href={guideHref(guides, g.file, i)} />
        <section id={sectionSlug(s)} className={`mt-8 ${prose}`}><Blocks blocks={s.blocks} ctx={{ guides, guide: g, words }} /></section>
        <nav aria-label="Previous and next part" className="mt-14 grid gap-3 border-t border-border pt-6 sm:grid-cols-2">
          {prev !== null ? (
            <Link to={guideHref(guides, g.file, prev)} className="flex flex-col rounded-lg border border-border bg-card p-4 no-underline shadow-card hover:border-primary/40">
              <span className="flex items-center gap-1 text-sm text-muted-foreground"><ArrowLeft className="size-4" />Previous</span>
              <span className="mt-1 font-semibold text-foreground"><SectionTitle s={g.sections[prev]!} flag={false} /></span>
            </Link>
          ) : <span />}
          <Link to={next !== null ? guideHref(guides, g.file, next) : guideHref(guides, g.file)} className="flex flex-col rounded-lg border border-border bg-card p-4 text-right no-underline shadow-card hover:border-primary/40">
            <span className="flex items-center justify-end gap-1 text-sm text-muted-foreground">{next !== null ? 'Next' : 'Back to'}<ArrowRight className="size-4" /></span>
            <span className="mt-1 font-semibold text-foreground">{next !== null ? <SectionTitle s={g.sections[next]!} flag={false} /> : dashes(g.title)}</span>
          </Link>
        </nav>
      </article>
    </Wrap>
  );
}
