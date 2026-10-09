import * as React from 'react';
import { cn } from '../../lib/utils';

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'flex h-9 w-full min-w-0 rounded-md py-1.5 border border-input bg-card px-3 text-[0.9375rem] text-foreground shadow-[0_1px_1px_rgb(0_0_0/0.02)] placeholder:text-muted-foreground/70 transition-colors focus-visible:border-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-primary/15 disabled:cursor-not-allowed disabled:opacity-60',
        'aria-invalid:border-destructive file:border-0 file:bg-transparent file:text-sm file:font-bold',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
