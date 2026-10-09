// The Media page's files (docs/media-plan.md D20-D21), as a grid of cards or as a
// table, with the same "⋯" menu on each and checkboxes for choosing several.
import { ArrowDown, ArrowUp, Code, Copy, CopyPlus, Ellipsis, Eye, FilePenLine, Folder, FolderInput, Info, Pencil, Tags, Trash2, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { Checkbox } from '@panel/core/web/components/ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@panel/core/web/components/ui/dropdown-menu';
import { copyText } from '@panel/core/web/hooks/useAction';
import { formatTime } from '@panel/core/web/lib/api';
import { isEditable } from '../../lib/editor';
import { fileUrl, htmlFor, kindLabel, publicAddresses, useShown, type Browse } from '../../lib/media';
import { formatSize, siteLabel } from '@panel/core/web/lib/format';
import type { MediaItem } from '../../lib/types';
import { cn } from '@panel/core/web/lib/utils';
import { KIND_ICONS, LabelChips, Thumb } from './thumb';

// What the page does when a menu item is chosen (it owns the dialogs).
// edit/details: where clicking a text file opens the editor (the File Explorer),
// the menu offers both.
export type ItemActions = {
  open: (it: MediaItem) => void;
  edit?: (it: MediaItem) => void;
  details?: (it: MediaItem) => void;
  rename: (it: MediaItem) => void;
  move: (items: MediaItem[], mode: 'move' | 'copy') => void;
  labels: (items: MediaItem[]) => void;
  trash: (items: MediaItem[]) => void;
};

export const whereOf = (it: MediaItem, showSite: boolean) =>
  [showSite ? siteLabel(it.site) : null, kindLabel(it.kind), ...(it.folder ? it.folder.split('/') : [])].filter(Boolean).join(' › ');

export function ItemMenu({ it, actions, reserved, className }: { it: MediaItem; actions: ItemActions; reserved: string[]; className?: string }) {
  const address = publicAddresses(it.path, reserved, useShown())[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" className={cn('size-9', className)} aria-label={`More for ${it.name}`}><Ellipsis /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {actions.edit && isEditable(it.name) ? <>
          <DropdownMenuItem onSelect={() => actions.edit!(it)}><FilePenLine />Edit</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => (actions.details ?? actions.open)(it)}><Info />Details</DropdownMenuItem>
        </> : <DropdownMenuItem onSelect={() => actions.open(it)}><Eye />Open and details</DropdownMenuItem>}
        {address && <DropdownMenuItem onSelect={() => void copyText(address, 'Address')}><Copy />Copy address</DropdownMenuItem>}
        <DropdownMenuItem onSelect={() => void copyText(htmlFor(it.path, it.kind), 'HTML')}><Code />Copy HTML</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => actions.rename(it)}><Pencil />Rename</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => actions.move([it], 'move')}><FolderInput />Move to…</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => actions.move([it], 'copy')}><CopyPlus />Make a copy…</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => actions.labels([it])}><Tags />Tags and categories…</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => actions.trash([it])}><Trash2 />Move to trash</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type ListProps = {
  items: MediaItem[]; actions: ItemActions; reserved: string[]; selected: Set<number>; onSelect: (id: number, on: boolean) => void;
  showSite: boolean; showWhere: boolean;
};

const Doesnt = ({ it }: { it: MediaItem }) => (it.fits ? null : <Badge variant="warn">doesn't belong here</Badge>);

// Cards: 2 across on a phone, more as the screen widens.
export function MediaGrid({ items, actions, reserved, selected, onSelect, showSite, showWhere }: ListProps) {
  return (
    <ul aria-label="Files" className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]">
      {items.map((it) => {
        const KindIcon = KIND_ICONS[it.kind] ?? KIND_ICONS.files!;
        const on = selected.has(it.id);
        return (
          <li key={it.id} data-selected={on || undefined}
            className={cn('relative flex min-w-0 flex-col overflow-hidden rounded-lg border bg-background', on ? 'border-primary ring-2 ring-primary/30' : 'border-border hover:border-primary/50')}>
            <button type="button" onClick={() => actions.open(it)} aria-label={`Open ${it.name}`}
              className="group grid aspect-square place-items-center overflow-hidden bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
              <Thumb thumb={it.thumb} kind={it.kind} alt="" original={it.kind === 'images' && it.fits ? fileUrl(it.path) : undefined}
                className="size-full object-cover transition-transform group-hover:scale-[1.03]" />
            </button>
            <span className="absolute left-2 top-2 grid size-8 place-items-center rounded-md bg-card/90 shadow-sm">
              <Checkbox checked={on} onCheckedChange={(v) => onSelect(it.id, v === true)} aria-label={`Select ${it.name}`} />
            </span>
            <ItemMenu it={it} actions={actions} reserved={reserved} className="absolute right-1.5 top-1.5 size-8 bg-card/90 shadow-sm hover:bg-card" />
            <div className="flex min-w-0 flex-1 flex-col gap-1 px-2.5 py-2">
              <span className="flex min-w-0 items-center gap-1.5">
                <KindIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate text-sm font-semibold" title={it.name}>{it.name}</span>
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {formatSize(it.size)} · {formatTime(it.addedAt)}
              </span>
              {showWhere && <span className="truncate text-xs text-muted-foreground" title={whereOf(it, showSite)}>{whereOf(it, showSite)}</span>}
              <Doesnt it={it} />
              <LabelChips tags={it.tags} categories={it.categories} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function SortHeader({ label, col, browse, onSort, className }:
  { label: string; col: Browse['sort']; browse: Browse; onSort: (col: Browse['sort'], desc: boolean) => void; className?: string }) {
  const active = browse.sort === col;
  return (
    <th scope="col" className={className} aria-sort={active ? (browse.desc ? 'descending' : 'ascending') : 'none'}>
      <button type="button" className="inline-flex items-center gap-1 font-semibold hover:text-foreground" onClick={() => onSort(col, active ? !browse.desc : col !== 'name')}>
        {label}{active && (browse.desc ? <ArrowDown className="size-3.5" /> : <ArrowUp className="size-3.5" />)}
      </button>
    </th>
  );
}

// A table; on phones each row folds into picture, name, one line of details and ⋯.
export function MediaTable({ items, actions, reserved, selected, onSelect, showSite, showWhere, browse, onSort, allOn, onAll }:
  ListProps & { browse: Browse; onSort: (col: Browse['sort'], desc: boolean) => void; allOn: boolean; onAll: (on: boolean) => void }) {
  const th = 'px-2 py-2 text-left text-xs font-semibold text-muted-foreground';
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="w-full table-fixed border-collapse text-sm" aria-label="Files">
        <thead className="bg-muted/60">
          <tr>
            <th scope="col" className={cn(th, 'w-10')}><Checkbox checked={allOn} onCheckedChange={(v) => onAll(v === true)} aria-label="Select every file on this page" /></th>
            <th scope="col" className={cn(th, 'w-14')}><span className="sr-only">Picture</span></th>
            <SortHeader label="Name" col="name" browse={browse} onSort={onSort} className={th} />
            <th scope="col" className={cn(th, 'hidden w-24 lg:table-cell')}>Kind</th>
            {showWhere && <th scope="col" className={cn(th, 'hidden w-48 xl:table-cell')}>Folder</th>}
            <SortHeader label="Size" col="size" browse={browse} onSort={onSort} className={cn(th, 'hidden w-24 md:table-cell')} />
            <SortHeader label="Added" col="added" browse={browse} onSort={onSort} className={cn(th, 'hidden w-40 md:table-cell')} />
            <th scope="col" className={cn(th, 'hidden w-56 lg:table-cell')}>Tags and categories</th>
            <th scope="col" className={cn(th, 'w-12')}><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => {
            const on = selected.has(it.id);
            return (
              <tr key={it.id} data-selected={on || undefined} className={cn('border-t border-border align-middle', on && 'bg-accent/50')}>
                <td className="px-2 py-1.5"><Checkbox checked={on} onCheckedChange={(v) => onSelect(it.id, v === true)} aria-label={`Select ${it.name}`} /></td>
                <td className="px-2 py-1.5">
                  <span className="grid size-10 place-items-center overflow-hidden rounded-md border border-border bg-muted">
                    <Thumb thumb={it.thumb} kind={it.kind} alt="" iconClass="size-5" className="size-full object-cover" />
                  </span>
                </td>
                <td className="min-w-0 px-2 py-1.5">
                  <button type="button" className="block max-w-full truncate text-left font-semibold text-primary hover:underline" onClick={() => actions.open(it)} title={it.name}>{it.name}</button>
                  <span className="block truncate text-xs text-muted-foreground md:hidden">{formatSize(it.size)} · {formatTime(it.addedAt)}{showWhere ? ` · ${whereOf(it, showSite)}` : ''}</span>
                  <span className="lg:hidden"><Doesnt it={it} /></span>
                </td>
                <td className="hidden px-2 py-1.5 text-muted-foreground lg:table-cell">{kindLabel(it.kind)}<span className="block"><Doesnt it={it} /></span></td>
                {showWhere && <td className="hidden truncate px-2 py-1.5 text-muted-foreground xl:table-cell" title={whereOf(it, showSite)}>{whereOf(it, showSite)}</td>}
                <td className="hidden px-2 py-1.5 text-muted-foreground md:table-cell">{formatSize(it.size)}</td>
                <td className="hidden px-2 py-1.5 text-muted-foreground md:table-cell">{formatTime(it.addedAt)}</td>
                <td className="hidden px-2 py-1.5 lg:table-cell"><LabelChips tags={it.tags} categories={it.categories} /></td>
                <td className="px-1 py-1.5 text-right"><ItemMenu it={it} actions={actions} reserved={reserved} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Folders inside the one being browsed: cards in the grid, rows in the table, always first.
export function FolderTiles({ folders, href, menu }: { folders: { name: string; items: number }[]; href: (name: string) => string; menu: (name: string) => ReactNode }) {
  if (!folders.length) return null;
  return (
    <ul aria-label="Folders here" className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]">
      {folders.map((f) => (
        <li key={f.name} className="relative flex items-center rounded-lg border border-border bg-background hover:border-primary/50">
          <Link to={href(f.name)} className="flex min-w-0 flex-1 items-center gap-3 p-3 no-underline">
            <Folder className="size-8 shrink-0 fill-secondary text-primary" />
            <span className="min-w-0">
              <span className="block truncate font-semibold text-foreground">{f.name}</span>
              <span className="block text-sm text-muted-foreground">{f.items} item{f.items === 1 ? '' : 's'}</span>
            </span>
          </Link>
          {menu(f.name)}
        </li>
      ))}
    </ul>
  );
}

// Shown while files are chosen: how many, and what can be done to all of them at once.
export function SelectionBar({ count, onClear, onPage, allOnPage, children }:
  { count: number; onClear: () => void; onPage: () => void; allOnPage: boolean; children: ReactNode }) {
  if (count === 0) return null;
  return (
    <div role="region" aria-label="Chosen files"
      className="sticky top-2 z-30 flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-card/95 px-3 py-2 shadow-pop backdrop-blur">
      <span className="text-sm font-semibold">{count} chosen</span>
      <Button size="sm" variant="ghost" onClick={onPage}>{allOnPage ? 'Unchoose this page' : 'Choose this page'}</Button>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {children}
        <Button size="sm" variant="ghost" onClick={onClear} aria-label="Unchoose all"><X />Done</Button>
      </div>
    </div>
  );
}
