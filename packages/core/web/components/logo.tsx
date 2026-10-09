import { cn } from '../lib/utils';
import { SITE } from '../lib/site';

// The panel's mark: a rose (the same drawing is the favicon, public/assets/favicon.svg).
export function RoseMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn('size-8 shrink-0', className)}>
      <rect width="32" height="32" rx="8" className="fill-primary" />
      <g fill="none" className="stroke-primary-foreground" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 6c-3 0-5 2-5 4.6 0 2.4 1.9 4.2 4.6 4.2 2.2 0 3.8-1.5 3.8-3.4 0-1.7-1.2-2.9-3-2.9-1.3 0-2.2.9-2.2 1.9" />
        <path d="M8.5 10.5c-.4 5 2.8 8.5 7.5 8.5s7.9-3.5 7.5-8.5c-1.3 1.9-3 3.3-5.1 3.9" />
        <path d="M8.5 10.5c1.4 1.9 3.2 3.3 5.3 3.9" />
        <path d="M16 19v8" />
        <path d="M16 24.2c-.7-2-2.5-3.2-5-3.1.5 2.1 2.3 3.3 5 3.1Z" />
        <path d="M16 22.6c.6-1.6 2-2.5 3.9-2.5-.4 1.7-1.8 2.6-3.9 2.5Z" />
      </g>
    </svg>
  );
}

export function Brand({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <RoseMark className="size-7" />
      <span className="text-[0.95rem] font-semibold tracking-tight text-foreground">{SITE.name} <span className="font-normal text-muted-foreground">panel</span></span>
    </span>
  );
}
