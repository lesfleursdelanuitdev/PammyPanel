import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const alertVariants = cva('relative flex w-full items-start gap-3 rounded-md px-4 py-3 text-sm [&>svg]:mt-0.5 [&>svg]:size-5 [&>svg]:shrink-0', {
  variants: {
    variant: {
      default: 'bg-secondary text-secondary-foreground',
      ok: 'bg-success-soft text-success',
      error: 'bg-danger-soft text-destructive',
    },
  },
  defaultVariants: { variant: 'default' },
});

function Alert({ className, variant, ...props }: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return <div data-slot="alert" role={variant === 'error' ? 'alert' : 'status'} className={cn(alertVariants({ variant }), className)} {...props} />;
}

export { Alert };
