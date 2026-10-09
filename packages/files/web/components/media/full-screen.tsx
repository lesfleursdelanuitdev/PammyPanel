// Full screen for the Media tab and File Explorer: the list fills the whole
// window, over the panel's header and menu, until it's switched off again (the
// same button, or Escape). Inside the page rather than the browser's own full
// screen: that one doesn't exist on iPhones, and hides the panel's dialogs.
import { Maximize2, Minimize2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@panel/core/web/components/ui/button';
import { cn } from '@panel/core/web/lib/utils';

export function useFullScreen(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!on) return;
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';            // the page behind doesn't scroll too
    const onKey = (e: KeyboardEvent) => {
      // Escape first closes whatever is open on top (a dialog, a menu); only then
      // this. Heard first (window, capturing), while that is still open.
      if (e.key !== 'Escape') return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return;
      setOn(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => { document.body.style.overflow = before; window.removeEventListener('keydown', onKey, true); };
  }, [on]);
  return [on, setOn];
}

export function FullScreenButton({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <Button type="button" variant="outline" size="sm" className="h-9" aria-pressed={on} onClick={() => onChange(!on)}
      title={on ? 'Back to the normal page (Esc)' : 'Fill the whole window'}>
      {on ? <Minimize2 /> : <Maximize2 />}
      <span className="sr-only sm:not-sr-only">{on ? 'Exit full screen' : 'Full screen'}</span>
    </Button>
  );
}

// What fills the window when on; as it was when off.
export function FullScreenArea({ on, label, className, children }: { on: boolean; label: string; className?: string; children: ReactNode }) {
  return (
    <section aria-label={label} data-full-screen={on || undefined}
      className={cn(className, on && 'fixed inset-0 z-40 !m-0 overflow-auto bg-background p-3 sm:p-5')}>
      {children}
    </section>
  );
}
