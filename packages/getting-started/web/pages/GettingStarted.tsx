// Getting started (docs/getting-started-plan.md G2-G4): "What would you like to
// do?", one question at a time, ending in a recommendation that also points to
// guide 19; and every path she started, with its steps, which the panel ticks
// by itself once each thing is there. From Home and from Help (D3).
import { ArrowLeft, BookOpen, Check, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { doneCount, Steps, type GettingStartedData, type Href, type PathView } from '../components/getting-started';
import { ActionButton, Collapsible, InlineLink, Loading, Page, Section } from '@panel/core/web/components/page';
import { Button } from '@panel/core/web/components/ui/button';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { api, formatTime, friendlyError } from '@panel/core/web/lib/api';
import { notify } from '@panel/core/web/lib/status';
import { cn } from '@panel/core/web/lib/utils';

type Question = { key: string; text: string; hint?: string; options: { value: string; label: string; hint?: string }[] };
type Recommendation = { path: string; title: string; what: string; why: string; steps: string[]; guide19: Href };
type Asked = { answers: Record<string, string>; question?: Question; recommendation?: Recommendation };

export function GettingStarted() {
  usePageTitle('Getting started');
  const q = useApi<GettingStartedData>('/api/getting-started?deep=1');
  const going = q.data?.paths.filter((p) => !p.finished) ?? [];
  const finished = q.data?.paths.filter((p) => p.finished) ?? [];
  const { hash } = useLocation();

  // Home's "All steps" goes straight to that path
  useEffect(() => {
    if (q.data && hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [q.data, hash]);

  return (
    <Page title="Getting started"
      intro={<>Tell the panel what you would like to make, and it shows you the way, step by step. It ticks each step off by itself once it is done. <InlineLink to="/help/forms-or-a-database">Forms or a database?</InlineLink></>}>
      {q.isLoading ? <Loading rows={2} /> : going.map((p) => <PathCard key={p.id} p={p} />)}
      <Questions first={!q.isLoading && !going.length} />
      {finished.length > 0 && (
        <Collapsible summary={`Done (${finished.length})`}>
          <div className="space-y-6">{finished.map((p) => <PathCard key={p.id} p={p} plain />)}</div>
        </Collapsible>
      )}
    </Page>
  );
}

function PathCard({ p, plain = false }: { p: PathView; plain?: boolean }) {
  const run = useAction();
  const body = (
    <>
      {p.holding.length > 0 && (
        <p className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          {p.holding.map((h) => (
            <span key={h.what} className="inline-flex items-center gap-1.5">
              {h.what === 'db' ? 'Its database' : h.what === 'form' ? 'Its form' : 'Its folder'}: <strong className="font-medium text-foreground">{h.label}</strong>
              <ActionButton variant="link" className="h-auto px-0" onClick={() => run(() => api(`/api/getting-started/${p.id}/not-the-one`, { what: h.what }), 'The panel will look for another one.')}>
                That's not the one
              </ActionButton>
            </span>
          ))}
        </p>
      )}
      <Steps p={p} />
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4 text-sm">
        <span className="text-muted-foreground">Started by {p.startedBy}, {formatTime(p.startedAt)}. <InlineLink to={p.guide19.href}>{p.guide19.label}</InlineLink></span>
        <ActionButton variant="ghost" onClick={() => run(() => api(`/api/getting-started/${p.id}/put-away`, {}), `${p.title} is put away.`)}>Put away</ActionButton>
      </div>
    </>
  );
  if (plain) return <div id={`path-${p.id}`}><h3 className="mb-3 font-semibold">{p.title}</h3>{body}</div>;
  return (
    <Section id={`path-${p.id}`} title={p.title} intro={`${p.what} · ${doneCount(p)} of ${p.steps.length} done`}>
      {body}
    </Section>
  );
}

// ------------------------------------------------------------------ the questions (G2)
function Questions({ first }: { first: boolean }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [asked, setAsked] = useState<Asked | null>(null);
  const [order, setOrder] = useState<string[]>([]);   // which questions she answered, for Back
  const run = useAction();

  const ask = async (next: Record<string, string>) => {
    try {
      const r = await api<Asked>('/api/getting-started/ask', { answers: next });
      setAnswers(r.answers);
      setAsked(r);
    } catch (e) {
      notify(friendlyError(e), 'error');
    }
  };
  useEffect(() => { void ask({}); }, []);

  const choose = (key: string, value: string) => {
    setOrder((o) => [...o.filter((k) => k !== key), key]);
    void ask({ ...answers, [key]: value });
  };
  const back = () => {
    const last = order[order.length - 1];
    if (!last) return;
    const rest = { ...answers };
    delete rest[last];
    setOrder(order.slice(0, -1));
    void ask(rest);
  };
  const again = () => { setOrder([]); void ask({}); };
  const start = async () => {
    const r = await run(() => api<{ id: number; title: string }>('/api/getting-started/start', { answers }), (x) => `Started: ${x.title}. The steps are at the top of this page.`);
    if (r) { again(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  };

  const question = asked?.question;
  const rec = asked?.recommendation;
  return (
    <Section title={first ? undefined : 'Start something new'}>
      {!asked ? <div className="h-24 animate-pulse rounded bg-muted" role="status" aria-label="Loading" />
        : question ? (
          <fieldset>
            <legend className={cn('font-semibold', question.key === 'goal' && first ? 'text-xl' : 'text-lg')}>{question.text}</legend>
            {question.hint && <p className="mt-1 text-sm text-muted-foreground">{question.hint}</p>}
            <ul className="mt-4 grid gap-2 sm:grid-cols-2">
              {question.options.map((o) => (
                <li key={o.value}>
                  <button type="button" onClick={() => choose(question.key, o.value)} data-value={o.value}
                    className="flex h-full w-full flex-col items-start rounded-lg border border-border bg-card px-4 py-3 text-left shadow-card transition-colors hover:border-primary/60 hover:bg-primary-soft/40 focus-visible:outline-2 focus-visible:outline-primary">
                    <span className="font-medium">{o.label}</span>
                    {o.hint && <span className="mt-0.5 text-sm text-muted-foreground">{o.hint}</span>}
                  </button>
                </li>
              ))}
            </ul>
            {order.length > 0 && <Button variant="ghost" size="sm" className="mt-3" onClick={back}><ArrowLeft />Back</Button>}
          </fieldset>
        ) : rec ? (
          <div data-testid="recommendation">
            <p className="text-sm font-medium text-primary">What we suggest</p>
            <h3 className="mt-0.5 text-xl font-semibold">{rec.what}</h3>
            <p className="mt-2 max-w-[68ch] text-[0.9375rem]">{rec.why}</p>
            <p className="mt-4 text-sm font-medium">The steps</p>
            <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-[0.9375rem]">
              {rec.steps.map((s) => <li key={s}>{s}</li>)}
            </ol>
            <div className="mt-5 flex flex-wrap gap-2">
              <ActionButton size="default" variant="default" icon={Check} onClick={start}>Start this</ActionButton>
              <Button variant="outline" onClick={back}><ArrowLeft />Back</Button>
              <Button variant="ghost" onClick={again}><RotateCcw />Start again</Button>
            </div>
            <p className="mt-5 flex flex-wrap items-center gap-2 rounded-md bg-muted/50 px-3 py-2.5 text-sm">
              <BookOpen className="size-4 shrink-0 text-muted-foreground" />
              Want the longer explanation first? See <InlineLink to={rec.guide19.href}>{rec.guide19.label}</InlineLink>
            </p>
          </div>
        ) : null}
    </Section>
  );
}

