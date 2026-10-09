// Every signed-in page: the bar at the top, the menu that slides in from the
// left (on every screen size), and the page itself.
import { LogOut, Menu as MenuIcon, X, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { Brand } from './logo';
import { NoticeBar } from './notice';
import { Button } from './ui/button';
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from './ui/sheet';
import { api, passkeysSupported } from '../lib/api';
import { clearNotice, keepNoticeThroughNavigation, notify } from '../lib/status';
import { may, type PageNeeds } from '../lib/rights';
import type { Me } from '../lib/types';
import { cn } from '../lib/utils';
import { SITE } from '../lib/site';

// needs and wholeSite: who it is shown to, as for a page (lib/routes.tsx).
// count: which of the site's waiting numbers (Menu.useCounts) goes beside it.
export type NavItem = { to: string; label: string; icon: LucideIcon; count?: string; needs: PageNeeds; wholeSite?: true };
export type NavGroup = { label: string | null; items: NavItem[] };
// What the site puts in the menu (sites/pammy/web/src/menu.ts): its groups, what is
// waiting (checked by the site, which knows which modules it has), and groups that
// come and go (the apps she has switched on). Both hooks are called on every render.
export type Menu = {
  groups: NavGroup[];
  useCounts: (me: Me) => Record<string, number>;
  useMore: (me: Me) => NavGroup[];
};

async function signOut() {
  await api('/api/logout', {}).catch(() => {});
  location.replace('/login');
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  return <span aria-hidden className={cn('grid size-8 shrink-0 place-items-center rounded-full bg-primary-soft text-xs font-semibold text-primary', className)}>{initials(name)}</span>;
}

export function Shell({ me, menu }: { me: Me; menu: Menu }) {
  const [open, setOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const counts = menu.useCounts(me);
  const more = menu.useMore(me);
  const location = useLocation();
  const anyWaiting = Object.values(counts).some((n) => n > 0);

  // a new page: close the menu, clear old news, start at the top (unless going to a place on the page)
  const lastPath = useRef(location.pathname);
  useEffect(() => {
    setOpen(false);
    if (lastPath.current !== location.pathname) {
      if (!keepNoticeThroughNavigation()) clearNotice();
      if (!location.hash) window.scrollTo(0, 0);
    }
    lastPath.current = location.pathname;
  }, [location.pathname, location.search, location.hash]);

  useEffect(() => {
    if (!passkeysSupported()) notify("This browser can't use passkeys, so adding passkeys and confirming changes won't work here.", 'error');
  }, []);

  return (
    <div className="min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-md focus:bg-card focus:px-3 focus:py-2">Skip to the page</a>
      <header className="sticky top-0 z-30 border-b border-border bg-card/90 backdrop-blur supports-[backdrop-filter]:bg-card/80">
        <div className="flex h-14 items-center gap-2 px-2 sm:px-4">
          <Button ref={menuButton} variant="ghost" size="icon" className="relative" aria-label="Open the menu" aria-expanded={open} onClick={() => setOpen(true)}>
            <MenuIcon className="size-5" />
            {anyWaiting && <span data-testid="menu-dot" className="absolute right-1.5 top-1.5 size-2 rounded-full bg-destructive ring-2 ring-card" />}
          </Button>
          <NavLink to="/" className="no-underline" aria-label={`${SITE.panelName}, home`}><Brand /></NavLink>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden items-center gap-2.5 pr-2 md:flex">
              <Avatar name={me.displayName} />
              <span className="leading-tight">
                <span className="block text-sm font-medium">{me.displayName}</span>
                <span className="block text-xs text-muted-foreground">{me.username}</span>
              </span>
            </span>
            <Button variant="ghost" size="sm" onClick={signOut}><LogOut />Sign out</Button>
          </div>
        </div>
      </header>

      <Sheet open={open} onOpenChange={setOpen}>
        <Drawer me={me} groups={menu.groups} counts={counts} more={more} onClose={() => setOpen(false)} returnFocus={() => menuButton.current?.focus()} />
      </Sheet>

      <main id="main" tabIndex={-1} className="outline-none">
        <Outlet />
      </main>
      <NoticeBar />
    </div>
  );
}

function Drawer({ me, groups, counts, more, onClose, returnFocus }: { me: Me; groups: NavGroup[]; counts: Record<string, number>; more: NavGroup[]; onClose: () => void; returnFocus: () => void }) {
  // items another item lives under (/ and /media): only lit up on their own page
  const under = useMemo(() => new Set(groups.flatMap((g) => g.items.map((i) => i.to))
    .filter((to, _, all) => to === '/' || all.some((o) => o !== to && o.startsWith(`${to}/`)))), [groups]);
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; t: number; dx: number; horizontal: boolean | null } | null>(null);
  const swiped = useRef(false);

  // Swipe left to close: the menu follows the finger, and closes if dragged far
  // enough or flicked; otherwise it springs back.
  const start = (e: ReactPointerEvent) => {
    if (e.pointerType === 'mouse') return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), dx: 0, horizontal: null };
  };
  const move = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id || !ref.current) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (d.horizontal === null && Math.hypot(dx, dy) > 8) d.horizontal = Math.abs(dx) > Math.abs(dy);
    if (!d.horizontal) return;
    d.dx = Math.min(0, dx);
    ref.current.style.transition = 'none';
    ref.current.style.transform = `translateX(${d.dx}px)`;
  };
  const end = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id || !ref.current) return;
    drag.current = null;
    ref.current.style.transition = '';
    ref.current.style.transform = '';
    if (!d.horizontal) return;
    swiped.current = true;
    setTimeout(() => { swiped.current = false; }, 400);
    const speed = -d.dx / Math.max(1, performance.now() - d.t);
    if (-d.dx > ref.current.offsetWidth * 0.3 || (-d.dx > 30 && speed > 0.5)) onClose();
  };
  // a sideways swipe isn't a scroll: otherwise a quick flick keeps "gliding" and eats the next tap
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const tm = (e: TouchEvent) => { if (drag.current?.horizontal) e.preventDefault(); };
    el.addEventListener('touchmove', tm, { passive: false });
    return () => el.removeEventListener('touchmove', tm);
  });

  const count = (item: NavItem) => (item.count ? counts[item.count] ?? 0 : 0);

  return (
    <SheetContent ref={ref} aria-describedby={undefined} onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
      onClickCapture={(e) => { if (swiped.current) { e.preventDefault(); e.stopPropagation(); swiped.current = false; } }}
      onOpenAutoFocus={(e) => { e.preventDefault(); ref.current?.querySelector<HTMLElement>('[aria-current=page]')?.focus(); }}
      onCloseAutoFocus={(e) => { e.preventDefault(); returnFocus(); }}>
      <div className="flex h-14 items-center justify-between border-b border-border pl-4 pr-2">
        <SheetTitle asChild><div><Brand /></div></SheetTitle>
        <SheetDescription className="sr-only">The pages of the panel</SheetDescription>
        <SheetClose asChild>
          <Button variant="ghost" size="icon" aria-label="Close the menu"><X className="size-5" /></Button>
        </SheetClose>
      </div>
      <nav aria-label="Sections" className="flex-1 overflow-y-auto px-3 py-3">
        {[...groups, ...more].map((group, gi) => {
          const items = group.items.filter((n) => may(me, n.needs, n.wholeSite));
          return (
            <div key={gi} className={cn(gi > 0 && 'mt-4')}>
              {group.label && <p className="mb-1 px-3 text-xs font-medium text-muted-foreground">{group.label}</p>}
              <ul className="space-y-0.5">
                {items.map((item) => (
                  <li key={item.to}>
                    <NavLink to={item.to} end={under.has(item.to)} onClick={onClose}
                      className={({ isActive }) => cn(
                        'flex h-9 items-center gap-3 rounded-md px-3 text-sm font-medium text-foreground no-underline transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring',
                        isActive && 'bg-primary-soft text-primary hover:bg-primary-soft',
                      )}>
                      {({ isActive }) => (
                        <>
                          <item.icon className={cn('size-[1.125rem] shrink-0', isActive ? 'text-primary' : 'text-muted-foreground')} />
                          <span className="flex-1">{item.label}</span>
                          {count(item) > 0 && (
                            <span className="min-w-5 rounded-full bg-destructive px-1.5 text-center text-[0.6875rem] font-semibold leading-5 text-destructive-foreground tabular-nums"
                              aria-label={`${count(item)} waiting`}>{count(item)}</span>
                          )}
                        </>
                      )}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>
      <div className="flex items-center gap-3 border-t border-border px-4 py-3">
        <Avatar name={me.displayName} />
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-sm font-medium">{me.displayName}</p>
          <p className="truncate text-xs text-muted-foreground">Signed in as {me.username}</p>
        </div>
        <Button variant="ghost" size="icon" aria-label="Sign out" onClick={signOut}><LogOut /></Button>
      </div>
    </SheetContent>
  );
}
