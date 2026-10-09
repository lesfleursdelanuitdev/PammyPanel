import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

// Light badges, like Mantine's: a tint of the colour, the colour's text.
const badgeVariants = cva('inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-full px-2 text-xs font-semibold leading-none [&_svg]:size-3', {
  variants: {
    variant: {
      default: 'bg-primary-soft text-primary',
      ok: 'bg-success-soft text-success',
      warn: 'bg-warning-soft text-warning',
      solid: 'bg-destructive text-destructive-foreground',
      outline: 'border border-border text-muted-foreground',
      danger: 'bg-danger-soft text-destructive',
    },
  },
  defaultVariants: { variant: 'default' },
});

function Badge({ className, variant, ...props }: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
