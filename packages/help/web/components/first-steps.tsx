// First steps (docs/phase9-plan.md 9-3): a card on Home for each person. A second passkey
// (ticked when the account has two), the guide to read first (ticked by hand), and one
// line per part they can change, with its page and its guide: short for someone with one
// part, long for an admin. "I'm done with this" puts it away; Help brings it back.
import { BookOpen, Check, Circle, Footprints, X } from 'lucide-react';
import { Link } from 'react-router';
import { ActionButton } from '@panel/core/web/components/page';
import { Button } from '@panel/core/web/components/ui/button';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi } from '@panel/core/web/hooks/useApi';
import { api } from '@panel/core/web/lib/api';
import { partOn, RIGHT_WORDS, RIGHTS, type Right } from '@panel/core/web/lib/rights';
import { W, cap } from '@panel/core/web/lib/site';
import type { Me } from '@panel/core/web/lib/types';
import { cn } from '@panel/core/web/lib/utils';

type GuideRef = { slug: string; title: string };
export type FirstStepsData = {
  hidden: boolean; passkeys: number;
  read: (GuideRef & { done: boolean }) | null;
  guides: Partial<Record<Right, GuideRef>>;
};
// the page each part opens on (the site's menu knows: sites/lfdln/web/src/pages/Home.tsx)
export type PartPages = Partial<Record<Right, { to: string; label: string }>>;

export const useFirstSteps = () => useApi<FirstStepsData>('/api/first-steps');

export function FirstStepsCard({ me, pages }: { me: Me; pages: PartPages }) {
  const q = useFirstSteps();
  const run = useAction();
  const d = q.data;
  if (!d || d.hidden) return null;
  const parts = RIGHTS.filter((r) => me.rights.includes(r) && partOn(r));
  const admin = me.role === 'manager';
  const ticks = [d.passkeys >= 2, ...(d.read ? [d.read.done] : [])];

  return (
    <section aria-labelledby="home-first-steps" data-testid="first-steps" className="mb-6 rounded-lg border border-border bg-card shadow-card">
      <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary-soft text-primary"><Footprints className="size-[1.125rem]" /></span>
        <div className="min-w-0 flex-1">
          <h2 id="home-first-steps" className="text-[0.975rem] font-semibold">First steps</h2>
          <p className="text-sm text-muted-foreground">{ticks.filter(Boolean).length} of {ticks.length} done</p>
        </div>
        <ActionButton variant="ghost" icon={X} onClick={() => run(() => api('/api/first-steps', { hidden: true }), 'Put away. Help brings it back.')}>
          I'm done with this
        </ActionButton>
      </div>
      <div className="grid gap-6 border-t border-border px-4 py-4 sm:px-5 lg:grid-cols-2">
        <ol aria-label="First steps" className="space-y-3">
          <Step done={d.passkeys >= 2} testId="step-passkey" title="Add a second passkey"
            why={d.passkeys >= 2 ? `You have ${d.passkeys}.` : 'On another phone or computer, so losing one device doesn’t lock you out.'}>
            <Button asChild size="sm" variant={d.passkeys >= 2 ? 'outline' : 'default'}><Link to="/passkeys">Passkeys &amp; devices</Link></Button>
          </Step>
          {d.read && (
            <Step done={d.read.done} testId="step-read" title={`Read “${d.read.title}”`} why="What this panel is for, and the words it uses.">
              <Button asChild size="sm" variant={d.read.done ? 'outline' : 'default'}><Link to={`/help/${d.read.slug}`}><BookOpen />Open it</Link></Button>
              {d.read.done
                ? <ActionButton variant="ghost" onClick={() => run(() => api('/api/first-steps', { read: false }))}>Not read after all</ActionButton>
                : <ActionButton icon={Check} onClick={() => run(() => api('/api/first-steps', { read: true }))}>I've read it</ActionButton>}
            </Step>
          )}
        </ol>
        <div className="min-w-0">
          <h3 className="mb-2 text-sm font-semibold">What you can change</h3>
          {parts.length === 0 && !admin ? <p className="text-sm text-muted-foreground">Nothing yet: {W.admin.a} gives you parts on Accounts.</p> : (
            <ul aria-label="What you can change" className="divide-y divide-border rounded-md border border-border">
              {admin && <Part label="Accounts" about={`Who can use this panel, and what they can change (${W.admin.many} only)`} page={{ to: '/accounts', label: 'Accounts' }} />}
              {parts.map((r) => <Part key={r} label={RIGHT_WORDS[r].label} about={RIGHT_WORDS[r].about} page={pages[r]} guide={d.guides[r]} />)}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function Step({ done, title, why, testId, children }: { done: boolean; title: string; why: string; testId: string; children: React.ReactNode }) {
  return (
    <li data-testid={testId} data-state={done ? 'done' : 'todo'} className="flex gap-2.5">
      {done
        ? <Check aria-label="Done" className="mt-0.5 size-5 shrink-0 rounded-full bg-primary p-0.5 text-primary-foreground" />
        : <Circle aria-label="Not yet" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />}
      <div className="min-w-0 flex-1">
        <p className={cn('text-[0.9375rem] font-medium', done && 'text-muted-foreground')}>{title}</p>
        <p className="text-sm text-muted-foreground">{why}</p>
        <div className="mt-2 flex flex-wrap gap-2">{children}</div>
      </div>
    </li>
  );
}

function Part({ label, about, page, guide }: { label: string; about: string; page?: { to: string; label: string }; guide?: GuideRef }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2.5">
      <span className="min-w-0 flex-1 text-sm">
        <strong className="font-semibold">{cap(label)}</strong>
        <span className="text-muted-foreground"> · {about}</span>
      </span>
      <span className="flex shrink-0 gap-3 text-sm">
        {page && <Link to={page.to} className="font-medium no-underline hover:underline">{page.label}</Link>}
        {guide && <Link to={`/help/${guide.slug}`} className="font-medium no-underline hover:underline">Guide: {guide.title}</Link>}
      </span>
    </li>
  );
}

// On Help: the card brought back, once it has been put away.
export function FirstStepsBack() {
  const q = useFirstSteps();
  const run = useAction();
  if (!q.data?.hidden) return null;
  return (
    <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-4 shadow-card">
      <span className="flex items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary-soft text-primary"><Footprints className="size-[1.125rem]" /></span>
        <span className="text-sm text-muted-foreground">The first-steps card is put away.</span>
      </span>
      <ActionButton onClick={() => run(() => api('/api/first-steps', { hidden: false }), 'Back on Home.')}>Show first steps on Home</ActionButton>
    </div>
  );
}
