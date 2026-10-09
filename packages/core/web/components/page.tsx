// The building blocks every page is made of.
import { ChevronRight, Loader2 } from 'lucide-react';
import { createContext, useContext, useState, type ComponentProps, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Button } from './ui/button';
import { cn } from '../lib/utils';
import { guideTo, type GuideTopic } from '../lib/site';

export function Page({ title, intro, children, wide = false, actions }: { title: ReactNode; intro?: ReactNode; children: ReactNode; wide?: boolean; actions?: ReactNode }) {
  return (
    <div className={cn('mx-auto w-full px-4 pb-24 pt-6 sm:px-6 sm:pt-8 lg:px-8', wide ? 'max-w-6xl' : 'max-w-4xl')}>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight sm:text-[1.75rem]">{title}</h1>
          {intro && <p className="mt-1.5 max-w-[68ch] text-[0.9375rem] text-muted-foreground">{intro}</p>}
        </div>
        {actions}
      </header>
      <div className="space-y-6">{children}</div>
    </div>
  );
}

// Inside a flush section, lists run edge to edge in the card instead of framing themselves.
const Flush = createContext(false);

// A card with a title bar. plain: no card, for content that's cards already.
// flush: the content (a List) touches the card's edges.
export function Section({ title, intro, action, children, id, className, plain = false, flush = false }:
  { title?: ReactNode; intro?: ReactNode; action?: ReactNode; children?: ReactNode; id?: string; className?: string; plain?: boolean; flush?: boolean }) {
  const head = (title || action || intro) && (
    <div className={cn('flex flex-wrap items-start justify-between gap-3', plain ? 'mb-3' : 'border-b border-border px-4 py-3.5 sm:px-5')}>
      <div className="min-w-0">
        {title && <h2 className="text-[0.975rem] font-semibold leading-snug">{title}</h2>}
        {intro && <p className="mt-0.5 max-w-[72ch] text-sm text-muted-foreground">{intro}</p>}
      </div>
      {action}
    </div>
  );
  if (plain) return <section id={id} className={cn('scroll-mt-20', className)}>{head}{children}</section>;
  return (
    <section id={id} className={cn('scroll-mt-20 rounded-lg border border-border bg-card shadow-card', className)}>
      {head}
      {children !== undefined && children !== null && children !== false && (
        flush ? <Flush.Provider value><div className="overflow-hidden rounded-b-lg">{children}</div></Flush.Provider> : <div className="p-4 sm:p-5">{children}</div>
      )}
    </section>
  );
}

// A framed list of real things: folders, people, messages.
export function List({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  const flush = useContext(Flush);
  return <ul aria-label={label} className={cn('divide-y divide-border', !flush && 'overflow-hidden rounded-lg border border-border bg-card', className)}>{children}</ul>;
}

export function Row({ title, badges, meta, children, actions, footer, className, highlight = false }:
  { title: ReactNode; badges?: ReactNode; meta?: ReactNode; children?: ReactNode; actions?: ReactNode; footer?: ReactNode; className?: string; highlight?: boolean }) {
  return (
    // wide screens: what it is and its buttons side by side, the details below at full width;
    // phones: what it is, the details, then the buttons.
    // footer: buttons along the bottom of the row instead, under a line of their own,
    // for rows whose details are worth reading before deciding anything (Responses).
    <li className={cn('grid gap-y-2 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-4', highlight && 'bg-primary-soft/50 shadow-[inset_3px_0_0_var(--primary)]', className)}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[0.9375rem] font-semibold [overflow-wrap:anywhere]">{title}</span>
          {badges}
        </div>
        {meta && <div className="mt-0.5 text-[0.8125rem] text-muted-foreground [overflow-wrap:anywhere]">{meta}</div>}
      </div>
      {children && <div className="min-w-0 sm:col-span-2">{children}</div>}
      {actions && <div className="mt-1 flex flex-wrap gap-2 sm:col-start-2 sm:row-start-1 sm:mt-0 sm:max-w-[28rem] sm:justify-end">{actions}</div>}
      {footer && (
        <div className="-mx-4 -mb-3.5 mt-2.5 flex flex-wrap items-center gap-2 border-t border-border bg-muted/30 px-4 py-2.5 sm:col-span-2">
          {footer}
        </div>
      )}
    </li>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <li className="px-4 py-8 text-center text-sm text-muted-foreground">{children}</li>;
}

export function Loading({ rows = 3 }: { rows?: number }) {
  const flush = useContext(Flush);
  return (
    <div role="status" aria-label="Loading" className={cn('divide-y divide-border', !flush && 'rounded-lg border border-border bg-card')}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="space-y-2 px-5 py-4">
          <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

// A button whose job takes a moment: it can't be pressed twice meanwhile.
export function ActionButton({ onClick, icon: Icon, children, ...props }:
  Omit<ComponentProps<typeof Button>, 'onClick'> & { onClick: () => Promise<unknown> | unknown; icon?: React.ComponentType<{ className?: string }> }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button type="button" size="sm" variant="outline" {...props} disabled={busy || props.disabled}
      onClick={async () => { setBusy(true); try { await onClick(); } finally { setBusy(false); } }}>
      {busy ? <Loader2 className="animate-spin" /> : Icon ? <Icon /> : null}
      {children}
    </Button>
  );
}

export function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return <a href={href} target="_blank" rel="noopener" className={cn('text-primary underline-offset-4 hover:underline [overflow-wrap:anywhere]', className)}>{children}</a>;
}

export function Addresses({ links }: { links: { href: string; text: string }[] }) {
  return (
    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
      {links.map((l) => <ExternalLink key={l.href} href={l.href}>{l.text}</ExternalLink>)}
    </div>
  );
}

export function Facts({ items }: { items: (ReactNode | null | false | undefined)[] }) {
  const shown = items.filter((x) => x !== null && x !== false && x !== undefined && x !== '');
  return <>{shown.map((x, i) => <span key={i}>{i > 0 && <span aria-hidden className="mx-1.5 opacity-50">·</span>}{x}</span>)}</>;
}

export function Field({ label, htmlFor, hint, children, className }: { label: ReactNode; htmlFor?: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('grid min-w-0 gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium">{label}</label>
      {children}
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function Collapsible({ summary, children, onToggle, defaultOpen = false, className }:
  { summary: ReactNode; children: ReactNode; onToggle?: (open: boolean) => void; defaultOpen?: boolean; className?: string }) {
  return (
    <details open={defaultOpen} className={cn('group rounded-lg border border-border bg-card shadow-card', className)} onToggle={(e) => onToggle?.((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-4 py-3 text-[0.9375rem] font-semibold hover:bg-muted/60 sm:px-5 [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="size-4 text-muted-foreground transition-transform group-open:rotate-90" />
        {summary}
      </summary>
      <div className="border-t border-border px-4 py-4 sm:px-5">{children}</div>
    </details>
  );
}

export function InlineLink({ to, children }: { to: string; children: ReactNode }) {
  return <Link to={to} className="font-medium text-primary no-underline hover:underline">{children}</Link>;
}

// A link to the site's guide about a topic, with a space before it; nothing where the site has
// no such guide (docs/phase9-plan.md 9-1)
export function GuideLink({ topic, children }: { topic: GuideTopic; children: ReactNode }) {
  const to = guideTo(topic);
  return to && <> <InlineLink to={to}>{children}</InlineLink></>;
}
