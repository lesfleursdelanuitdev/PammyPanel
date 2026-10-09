import * as React from 'react';
import { Slot } from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

// Mantine-like: filled, light (tinted), default (white with a border), subtle, and danger.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-semibold transition-colors select-none active:translate-y-px disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-card hover:bg-primary/90',
        light: 'bg-primary-soft text-primary hover:bg-primary/15',
        destructive: 'bg-destructive text-destructive-foreground shadow-card hover:bg-destructive/90',
        outline: 'border border-input bg-card text-foreground shadow-card hover:bg-muted',
        danger: 'bg-danger-soft text-destructive hover:bg-destructive/15',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'text-foreground hover:bg-muted',
        link: 'text-primary underline-offset-4 hover:underline px-0',
      },
      size: {
        default: 'h-9 px-4',
        sm: 'h-8 px-3 text-[0.8125rem] [&_svg:not([class*=size-])]:size-3.5',
        lg: 'h-11 px-6 text-[0.95rem]',
        icon: 'size-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

function Button({ className, variant, size, asChild = false, ...props }:
  React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'button';
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
