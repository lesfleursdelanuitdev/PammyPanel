import { CircleAlert, CircleCheck, X } from 'lucide-react';
import { useEffect } from 'react';
import { clearNotice, useNotice } from '../lib/status';
import { cn } from '../lib/utils';

// News about what just happened, at the bottom of the screen where it's seen
// wherever you've scrolled. Good news goes away by itself; problems stay until closed.
export function NoticeBar() {
  const notice = useNotice();
  useEffect(() => {
    if (notice?.kind !== 'ok') return;
    const t = setTimeout(() => { clearNotice(); }, 7000);
    return () => clearTimeout(t);
  }, [notice]);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex justify-center p-3 sm:justify-end sm:p-5">
      <div aria-live="polite" className="w-full max-w-xl sm:max-w-sm">
        {notice && (
          <div key={notice.id} role={notice.kind === 'error' ? 'alert' : 'status'} data-kind={notice.kind}
            className={cn('pointer-events-auto flex items-start gap-3 rounded-lg border bg-card px-4 py-3 text-sm shadow-pop animate-[pop-in_160ms_ease-out]',
              notice.kind === 'error' ? 'border-destructive/30 text-foreground [&>svg]:text-destructive' : 'border-border text-foreground [&>svg]:text-success')}>
            {notice.kind === 'error' ? <CircleAlert className="mt-0.5 size-5 shrink-0" /> : <CircleCheck className="mt-0.5 size-5 shrink-0" />}
            <p className="flex-1 [overflow-wrap:anywhere]">{notice.text}</p>
            <button type="button" onClick={clearNotice} aria-label="Close" className="-m-1 grid size-8 shrink-0 place-items-center rounded-full opacity-80 hover:opacity-100 focus-visible:outline-2 focus-visible:outline-ring">
              <X className="size-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
