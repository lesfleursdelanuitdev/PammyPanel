import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils';

// A real <select>: works with every keyboard, screen reader and phone picker.
function NativeSelect({ className, ...props }: React.ComponentProps<'select'>) {
  return (
    <div className={cn('relative inline-flex w-full', className)}>
      <select
        data-slot="native-select"
        className="h-9 w-full appearance-none rounded-md py-1.5 pr-9 border border-input bg-card px-3 text-[0.9375rem] text-foreground shadow-[0_1px_1px_rgb(0_0_0/0.02)] placeholder:text-muted-foreground/70 transition-colors focus-visible:border-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-primary/15 disabled:cursor-not-allowed disabled:opacity-60"
        {...props}
      />
      <ChevronDown aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

export { NativeSelect };
