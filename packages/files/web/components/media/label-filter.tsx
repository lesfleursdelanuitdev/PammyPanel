// Multi-select for tags or categories on the Media toolbar: a file must have every one chosen.
import { ChevronDown } from 'lucide-react';
import { Button } from '@panel/core/web/components/ui/button';
import { Checkbox } from '@panel/core/web/components/ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@panel/core/web/components/ui/dropdown-menu';
import type { MediaLabel } from '../../lib/types';
import { cn } from '@panel/core/web/lib/utils';

export function LabelFilter({
  label, labels, selected, onChange, nameOf,
}: {
  label: string; labels: MediaLabel[]; selected: number[]; onChange: (ids: number[]) => void;
  nameOf: (l: MediaLabel) => string;
}) {
  const chosen = labels.filter((l) => selected.includes(l.id));
  const summary = !chosen.length ? `Any ${label.toLowerCase()}`
    : chosen.length === 1 ? nameOf(chosen[0]!)
      : `${chosen.length} ${label.toLowerCase()}s`;
  const toggle = (id: number) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className={cn('h-9 min-w-36 justify-between font-normal', chosen.length && 'border-primary/50')}
          aria-label={label}>
          <span className="truncate">{summary}</span>
          <ChevronDown className="size-4 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 min-w-52 overflow-auto p-1" onCloseAutoFocus={(e) => e.preventDefault()}>
        {labels.length === 0 && <p className="px-2.5 py-2 text-sm text-muted-foreground">None yet</p>}
        {labels.map((l) => {
          const on = selected.includes(l.id);
          return (
            <label key={l.id} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent">
              <Checkbox checked={on} onCheckedChange={() => toggle(l.id)} aria-label={nameOf(l)} />
              <span className="min-w-0 truncate">{nameOf(l)} <span className="text-muted-foreground">({l.count})</span></span>
            </label>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
