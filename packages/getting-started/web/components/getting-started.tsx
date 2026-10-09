// Getting started (docs/getting-started-plan.md): a started path and its steps,
// shared by Home (G4) and the Getting started page. Each step is ticked by the
// panel once the thing it asks for is there; a step it can't see has "I've done
// this", and every step can be skipped.
import { Check, ChevronDown, Circle, CircleHelp, Compass, ExternalLink as ExternalIcon, MinusCircle, Plus } from 'lucide-react';
import { Link } from 'react-router';
import { ActionButton } from '@panel/core/web/components/page';
import { Button } from '@panel/core/web/components/ui/button';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi } from '@panel/core/web/hooks/useApi';
import { api, plural } from '@panel/core/web/lib/api';
import { cn } from '@panel/core/web/lib/utils';

export type Href = { href: string; label: string };
export type StepView = {
  key: string; title: string; why: string; to: Href | null; guide: Href | null;
  state: 'done' | 'todo' | 'unknown' | 'skipped' | 'done-by-hand';
  found?: string; note?: string; canTick: boolean;
};
export type PathView = {
  id: number; path: string; title: string; what: string; startedBy: string; startedAt: number;
  finished: boolean; steps: StepView[]; next: string | null;
  holding: { what: 'db' | 'form' | 'area'; label: string }[];
  guide19: Href;
};
export type GettingStartedData = { open: boolean; paths: PathView[] };

const isDone = (s: StepView) => s.state === 'done' || s.state === 'done-by-hand' || s.state === 'skipped';
export const doneCount = (p: PathView) => p.steps.filter(isDone).length;

// A link that leaves the panel opens in a new tab; one inside it stays.
export function Go({ to, primary = false, className }: { to: Href; primary?: boolean; className?: string }) {
  const outside = /^https?:\/\//.test(to.href);
  return (
    <Button asChild size="sm" variant={primary ? 'default' : 'outline'} className={className}>
      {outside
        ? <a href={to.href} target="_blank" rel="noopener">{to.label}<ExternalIcon /></a>
        : <Link to={to.href}>{to.label}</Link>}
    </Button>
  );
}

function StepIcon({ state }: { state: StepView['state'] }) {
  const common = 'mt-0.5 size-5 shrink-0';
  if (state === 'done' || state === 'done-by-hand') return <Check aria-label="Done" className={cn(common, 'rounded-full bg-primary p-0.5 text-primary-foreground')} />;
  if (state === 'skipped') return <MinusCircle aria-label="Skipped" className={cn(common, 'text-muted-foreground')} />;
  if (state === 'unknown') return <CircleHelp aria-label="Can't tell right now" className={cn(common, 'text-muted-foreground')} />;
  return <Circle aria-label="Not yet" className={cn(common, 'text-muted-foreground')} />;
}

// One path's steps, in order. `compact`: Home -- no explanations, and buttons only on the next step.
export function Steps({ p, compact = false }: { p: PathView; compact?: boolean }) {
  const run = useAction();
  const say = (step: string, state: 'skipped' | 'done-by-hand' | null) => run(() => api(`/api/getting-started/${p.id}/step`, { step, state }));
  return (
    <ol aria-label={`${p.title}: steps`} className="space-y-3">
      {p.steps.map((s, i) => {
        const next = s.key === p.next;
        if (compact && !next) {
          return (
            <li key={s.key} data-state={s.state} className="flex gap-2.5 text-sm">
              <StepIcon state={s.state} />
              <span className={cn(isDone(s) && 'text-muted-foreground', s.state === 'skipped' && 'line-through')}>{s.title}</span>
            </li>
          );
        }
        return (
          <li key={s.key} data-state={s.state} data-testid={`step-${s.key}`}
            className={cn('flex gap-2.5', next && !compact && 'rounded-md bg-primary-soft/50 p-3 shadow-[inset_3px_0_0_var(--primary)]')}>
            <StepIcon state={s.state} />
            <div className="min-w-0 flex-1">
              <p className={cn('text-[0.9375rem] font-medium', s.state === 'skipped' && 'text-muted-foreground line-through')}>
                <span className="sr-only">Step {i + 1}: </span>{s.title}
              </p>
              {s.found && <p className="text-sm text-muted-foreground">{s.state === 'done' ? 'Found: ' : ''}{s.found}</p>}
              {s.note && <p className="text-sm text-muted-foreground">{s.note}</p>}
              {!compact && !isDone(s) && <p className="mt-0.5 max-w-[68ch] text-sm text-muted-foreground">{s.why}</p>}
              {(next || !compact) && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {!isDone(s) && s.to && <Go to={s.to} primary={next} />}
                  {!compact && s.guide && s.guide.href !== s.to?.href && <Go to={s.guide} />}
                  {!compact && s.canTick && s.state === 'todo' && <ActionButton onClick={() => say(s.key, 'done-by-hand')} icon={Check}>I've done this</ActionButton>}
                  {!compact && s.state === 'done-by-hand' && <ActionButton variant="ghost" onClick={() => say(s.key, null)}>Not done after all</ActionButton>}
                  {!compact && !isDone(s) && <ActionButton variant="ghost" onClick={() => say(s.key, 'skipped')}>Skip this</ActionButton>}
                  {!compact && s.state === 'skipped' && <ActionButton variant="ghost" onClick={() => say(s.key, null)}>Don't skip it</ActionButton>}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ------------------------------------------------------------------ on Home (G4)
// Always there for account managers (D2, D4). Closed: one line. Open: what is on
// the go, with the next step's button. The panel remembers which, per account.
export function GettingStartedCard() {
  const q = useApi<GettingStartedData>('/api/getting-started');
  const run = useAction();
  const d = q.data;
  const going = d?.paths.filter((p) => !p.finished) ?? [];
  const finished = d?.paths.filter((p) => p.finished) ?? [];
  const open = d?.open ?? true;
  const line = !d ? 'Checking…'
    : d.paths.length === 0 ? 'What would you like to do? Tell the panel, and it shows you the way.'
      : [...going.map((p) => `${p.title}: ${doneCount(p)} of ${p.steps.length} done`), finished.length ? `${plural(finished.length, 'thing')} done` : ''].filter(Boolean).join(' · ');
  const toggle = () => run(() => api('/api/getting-started/open', { open: !open }));

  return (
    <section aria-labelledby="home-getting-started" data-testid="getting-started-card" className="mb-6 rounded-lg border border-border bg-card shadow-card">
      <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary-soft text-primary"><Compass className="size-[1.125rem]" /></span>
        <div className="min-w-0 flex-1">
          <h2 id="home-getting-started" className="text-[0.975rem] font-semibold">Getting started</h2>
          {!open && <p className="truncate text-sm text-muted-foreground">{line}</p>}
        </div>
        <Button asChild size="sm" variant={d && d.paths.length === 0 ? 'default' : 'outline'} className="hidden sm:inline-flex">
          <Link to="/getting-started"><Plus />Start something new</Link>
        </Button>
        <Button size="icon" variant="ghost" aria-expanded={open} aria-controls="home-getting-started-body" onClick={() => void toggle()}
          aria-label={open ? 'Close Getting started' : 'Open Getting started'}>
          <ChevronDown className={cn('transition-transform', open && 'rotate-180')} />
        </Button>
      </div>
      {open && (
        <div id="home-getting-started-body" className="border-t border-border px-4 py-4 sm:px-5">
          {!d ? <div className="h-10 animate-pulse rounded bg-muted" role="status" aria-label="Loading" />
            : going.length === 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">
                  {finished.length ? `Everything you started is done (${finished.length}). ` : ''}What would you like to do next? A few questions, and the panel shows you the way, step by step.
                </p>
                <Button asChild size="sm"><Link to="/getting-started">What would you like to do?</Link></Button>
              </div>
            ) : (
              <div className="grid gap-5 lg:grid-cols-2">
                {going.map((p) => (
                  <div key={p.id} className="min-w-0">
                    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                      <h3 className="font-semibold">{p.title}</h3>
                      <Link to={`/getting-started#path-${p.id}`} className="text-sm font-medium no-underline hover:underline">
                        {doneCount(p)} of {p.steps.length} done · All steps
                      </Link>
                    </div>
                    <Steps p={p} compact />
                  </div>
                ))}
              </div>
            )}
          {d && d.paths.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-sm sm:hidden">
              <Link to="/getting-started" className="font-medium no-underline hover:underline">Start something new</Link>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
