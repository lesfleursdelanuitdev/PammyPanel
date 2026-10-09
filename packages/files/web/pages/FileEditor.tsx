// The file editor (docs/editor-plan.md): one text file at /files/edit?path=...,
// with Code | Preview (and Side by side on wide screens) for web pages, Save and
// Ctrl/Cmd+S, a refusal when the file changed since it was opened, earlier
// versions, and the unsaved text kept in this browser in case the tab closes.
import { useQueryClient } from '@tanstack/react-query';
import {
  ChevronLeft, Code, Columns2, Copy, Download, ExternalLink, Eye, History, Info, RefreshCw, RotateCcw, Save, TriangleAlert, Undo2,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { CodeEditor, CompareView } from '../components/editor/code-editor';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { FullScreenArea, FullScreenButton, useFullScreen } from '../components/media/full-screen';
import { Loading } from '@panel/core/web/components/page';
import { Button } from '@panel/core/web/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@panel/core/web/components/ui/dialog';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { useMe } from '@panel/core/web/hooks/useMe';
import { api, ApiError, formatTime, friendlyError, signedOut, timeAgo } from '@panel/core/web/lib/api';
import { clearDraft, editorHref, isCached, isCode, isEditable, isPage, readDraft, specialName, writeDraft, type Draft } from '../lib/editor';
import { FILES_DEFAULTS, filesHref, parentOf, pref, publicAddresses, rootFileUrl, setPref, useShown } from '../lib/media';
import { clearNotice, notify } from '@panel/core/web/lib/status';
import { cn } from '@panel/core/web/lib/utils';
import { SITE, W } from '@panel/core/web/lib/site';

type Opened = { path: string; name: string; text: string; hash: string; size: number; modifiedAt: number; readOnly?: boolean };
type Saved = { path: string; name: string; hash: string; unchanged: boolean; created: boolean };
type Version = { id: string; path: string; name: string; hash: string; size: number; modifiedAt: number; savedAt: number; by: string };
type View = 'code' | 'preview' | 'split';

const WIDE = '(min-width: 1100px)';
function useWide(): boolean {
  const [wide, setWide] = useState(() => typeof matchMedia === 'function' && matchMedia(WIDE).matches);
  useEffect(() => {
    const mq = matchMedia(WIDE);
    const onChange = () => setWide(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return wide;
}

const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
// what Cloudflare in front does to a changed file (nothing to say without it)
const CACHE_NOTE = SITE.front === 'cloudflare' ? 'Cloudflare may keep showing visitors the old copy for up to 4 hours. To see the new one at once, change the link on your pages, for example style.css?v=2.' : null;

export default function FileEditor() {
  const [params] = useSearchParams();
  const path = (params.get('path') ?? '').split('/').filter((x) => x && x !== '.' && x !== '..').join('/');
  const name = path.split('/').pop() ?? '';
  // a software root's file (docs/catalog-plan.md step 3): no preview, no records; its
  // .php open for everyone and are saved by panel admins only (readOnly otherwise)
  const root = params.get('root') ?? '';
  const soft = root !== '' && root !== 'website';
  const rq = soft ? `&root=${encodeURIComponent(root)}` : '';
  const rb = soft ? { root } : {};
  const dkey = soft ? `${root}:${path}` : path;
  const [readOnly, setReadOnly] = useState(false);
  usePageTitle(name ? `Edit ${name}` : 'Editor');
  const me = useMe();
  const navigate = useNavigate();
  const dialogs = useDialogs();
  const qc = useQueryClient();
  const wide = useWide();
  const [full, setFull] = useFullScreen();

  const [problem, setProblem] = useState<{ message: string; status: number } | null>(null);
  const [saved, setSaved] = useState<{ text: string; hash: string } | null>(null);
  const [text, setText] = useState('');
  const [version, setVersion] = useState(0);         // bumped when the text is replaced (not typed)
  const [offer, setOffer] = useState<Draft | null>(null);
  const [conflict, setConflict] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [viewPref, setViewPref] = useState<View>(() => pref('editor-view', 'split', ['code', 'preview', 'split'] as const));
  const page = isPage(name) && !soft;
  const view: View = !page ? 'code' : !wide && viewPref === 'split' ? 'code' : viewPref;
  const chooseView = (v: View) => { setViewPref(v); setPref('editor-view', v); };
  const dirty = saved !== null && text !== saved.text;
  const leaving = useRef(false);
  // this open editor: its quick saves share one earlier version (src/sitefs/edit.ts)
  const session = useRef('');
  if (!session.current) session.current = [...crypto.getRandomValues(new Uint8Array(12))].map((x) => x.toString(16).padStart(2, '0')).join('');
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty && !leaving.current;

  const put = (t: string) => { setText(t); setVersion((v) => v + 1); };

  const load = useCallback(async (offerDraft: boolean): Promise<Opened | null> => {
    try {
      const f = await api<Opened>(`/api/files/text?path=${encodeURIComponent(path)}${rq}`);
      setReadOnly(f.readOnly === true);
      setSaved({ text: f.text, hash: f.hash });
      put(f.text);
      setProblem(null);
      if (offerDraft && me) {
        const d = readDraft(me.username, dkey);
        if (d && d.text !== f.text) setOffer(d);
        else if (d) clearDraft(me.username, dkey);
      }
      return f;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) { signedOut(); return null; }
      setProblem({ message: friendlyError(err), status: err instanceof ApiError ? err.status : 500 });
      return null;
    }
  }, [path, me, rq, dkey]);

  useEffect(() => {
    if (!me) return;
    leaving.current = false;
    setSaved(null);
    setOffer(null);
    void load(true);
  }, [path, me?.username]);                                // eslint-disable-line react-hooks/exhaustive-deps

  // The unsaved text, kept in this browser a moment after each change (Q2). Not
  // while a kept one is being offered back: that one isn't thrown away unasked.
  useEffect(() => {
    if (!me || !saved || offer) return;
    if (!dirty) { clearDraft(me.username, dkey); return; }
    const t = setTimeout(() => writeDraft(me.username, dkey, { text, base: saved.hash, at: Date.now() }), 800);
    return () => clearTimeout(t);
  }, [text, saved, offer, dirty, me, path]);

  const save = async () => {
    if (!saved || saving) return;
    if (readOnly) { notify('Only panel admins can change this file.', 'error'); return; }
    if (!dirty) { notify('Nothing new to save.'); return; }
    setSaving(true);
    clearNotice();
    const sending = text;
    try {
      const r = await api<Saved>('/api/files/save', { ...rb, path, text: sending, expect: saved.hash, session: session.current });
      setSaved({ text: sending, hash: r.hash });
      if (me) clearDraft(me.username, dkey);
      notify(isCached(name) && CACHE_NOTE ? `Saved. ${CACHE_NOTE}` : 'Saved.');
      void qc.invalidateQueries();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'conflict') setConflict(true);
      else if (err instanceof ApiError && err.status === 401) signedOut();
      else notify(friendlyError(err), 'error');
    } finally {
      setSaving(false);
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  // Leaving with unsaved changes: the browser asks on closing or reloading the
  // tab; links in the panel ask here. (What was typed is kept in this browser either way.)
  useEffect(() => {
    const onBefore = (e: BeforeUnloadEvent) => { if (dirtyRef.current) { e.preventDefault(); e.returnValue = ''; } };
    const onClick = (e: MouseEvent) => {
      if (!dirtyRef.current || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin || (url.pathname === location.pathname && url.search === location.search)) return;
      e.preventDefault();
      e.stopPropagation();
      void dialogs.confirm({
        title: 'Leave without saving?', action: 'Leave', cancel: 'Stay',
        body: `What you changed isn't in ${W.website.your} yet. This browser keeps it, and offers it back the next time you open this file.`,
      }).then((ok) => { if (ok) { leaving.current = true; navigate(url.pathname + url.search + url.hash); } });
    };
    // Ctrl/Cmd+S anywhere on the page (the editor handles its own first)
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.key.toLowerCase() !== 's' || !(mac ? e.metaKey : e.ctrlKey) || e.altKey || e.shiftKey) return;
      e.preventDefault();
      void saveRef.current();
    };
    window.addEventListener('beforeunload', onBefore);
    document.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('beforeunload', onBefore);
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [dialogs, navigate]);

  const folder = parentOf(path);
  const back = filesHref({ ...FILES_DEFAULTS, path: folder, root });
  const special = specialName(name);

  if (!path || !(isEditable(name) || (soft && isCode(name)))) {
    return (
      <Shell>
        <Problem title="The editor can't open this" back={back}>
          <p>The editor opens web pages, style sheets, scripts and text: files ending in .html, .css, .js, .txt, .md, .json, .xml or .svg.</p>
        </Problem>
      </Shell>
    );
  }
  if (problem) {
    return (
      <Shell>
        <Problem title={problem.status === 404 ? "This file isn't there any more" : "The editor can't open this file"} back={back}>
          <p>{problem.message}</p>
          {problem.status !== 404 && (
            <Button asChild variant="outline" size="sm"><a href={rootFileUrl(root, path, true)} className="no-underline"><Download />Download it instead</a></Button>
          )}
        </Problem>
      </Shell>
    );
  }
  if (!saved) return <Shell><Loading rows={4} /></Shell>;

  const editor = <CodeEditor initial={text} version={version} name={name} onChange={setText} onSave={() => void saveRef.current()} readOnly={readOnly} />;
  const preview = page ? <Preview path={path} text={text} dirty={dirty} /> : null;

  return (
    <Shell>
      <FullScreenArea on={full} label={`Editing ${name}`} className={cn('flex flex-col gap-3', full && '!p-2 sm:!p-3')}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button asChild variant="ghost" size="sm" className="-ml-2">
            <Link to={back} className="no-underline"><ChevronLeft />{folder ? folder.split('/').pop() : soft ? 'wp-content' : W.website.title}</Link>
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
              <span className="truncate">{name}</span>
              {dirty && <span className="inline-flex items-center gap-1.5 rounded-full bg-primary-soft px-2 py-0.5 text-xs font-semibold text-primary"><span aria-hidden className="size-2 rounded-full bg-primary" />Not saved</span>}
            </h1>
            <p className="truncate font-mono text-xs text-muted-foreground" title={path}>{path}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {page && <ViewSwitch view={view} wide={wide} onChange={chooseView} />}
            <Button variant="outline" size="sm" className="h-9" onClick={() => setVersionsOpen(true)}><History /><span className="sr-only sm:not-sr-only">Earlier versions</span></Button>
            <FullScreenButton on={full} onChange={setFull} />
            {!readOnly && (
              <Button size="sm" className="h-9" onClick={() => void save()} disabled={saving || !dirty} title={`Save (${mac ? '⌘' : 'Ctrl+'}S)`}>
                <Save />{saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
              </Button>
            )}
          </div>
        </div>

        {offer && (
          <div role="status" className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-sm">
            <Undo2 className="size-4 shrink-0 text-warning" />
            <div className="min-w-0 flex-1 space-y-1">
              <p className="font-semibold">You have changes from {formatTime(Math.floor(offer.at / 1000))} that were never saved to {W.website.your}.</p>
              {offer.base !== saved.hash && <p>This file has been changed since then. If you bring them back and save, they replace those changes (which are kept as an earlier version).</p>}
            </div>
            <Button size="sm" onClick={() => { put(offer.text); setOffer(null); }}>Bring them back</Button>
            <Button size="sm" variant="ghost" onClick={() => { if (me) clearDraft(me.username, dkey); setOffer(null); }}>Throw them away</Button>
          </div>
        )}
        {readOnly && (
          <p role="status" className="flex items-start gap-2 rounded-lg border border-border bg-muted px-4 py-3 text-sm">
            <Info className="mt-0.5 size-4 shrink-0" />
            <span>You can read this file, not change it: only panel admins can change .php files, because they run as part of the site.</span>
          </p>
        )}
        {(special || isCached(name)) && (
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0" />
            <span>{special ?? (CACHE_NOTE && `After saving: ${CACHE_NOTE}`)}</span>
          </p>
        )}

        <div className={cn('overflow-hidden rounded-lg border border-border bg-card shadow-card', full ? 'min-h-0 flex-1' : 'h-[calc(100dvh-14rem)] min-h-[22rem]')}>
          <Panes view={view} editor={editor} preview={preview} />
        </div>
        <p className="text-xs text-muted-foreground">
          {mac ? '⌘S' : 'Ctrl+S'} saves. {mac ? '⌘F' : 'Ctrl+F'} finds and replaces. Every save keeps what was there before, for 30 days (Earlier versions).
        </p>
      </FullScreenArea>

      <ConflictDialog open={conflict} name={name}
        onClose={() => setConflict(false)}
        keepMine={async () => {
          try {
            const cur = await api<Opened>(`/api/files/text?path=${encodeURIComponent(path)}${rq}`).catch((err: unknown) => {
              if (err instanceof ApiError && err.status === 404) return null;
              throw err;
            });
            const r = await api<Saved>('/api/files/save', cur ? { ...rb, path, text, expect: cur.hash, session: session.current } : { ...rb, path, text, create: 'exact' });
            setSaved({ text, hash: r.hash });
            if (me) clearDraft(me.username, dkey);
            setConflict(false);
            notify('Saved. What was there is kept as an earlier version.');
            void qc.invalidateQueries();
          } catch (err) { notify(friendlyError(err), 'error'); }
        }}
        loadTheirs={async () => {
          if (me) clearDraft(me.username, dkey);
          await load(false);
          setConflict(false);
          notify('The latest copy is open. Your changes were left out.');
        }}
        saveCopy={async () => {
          try {
            const r = await api<Saved>('/api/files/save', { ...rb, path, text, create: 'free' });
            if (me) clearDraft(me.username, dkey);
            leaving.current = true;
            setConflict(false);
            notify(`Your changes are saved as "${r.name}". "${name}" was left as it is.`);
            navigate(editorHref(r.path, root));
          } catch (err) { notify(friendlyError(err), 'error'); }
        }} />

      {versionsOpen && (
        <Versions path={path} root={root} name={name} current={text} dirty={dirty} savedHash={saved.hash} onClose={() => setVersionsOpen(false)}
          onRestored={async () => {
            if (me) clearDraft(me.username, dkey);
            await load(false);
            setVersionsOpen(false);
            void qc.invalidateQueries();
            notify('The earlier version is back. What was there before is kept as an earlier version too.');
          }} />
      )}
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-[110rem] px-3 pb-8 pt-4 sm:px-6 sm:pt-6">{children}</div>;
}

function Problem({ title, back, children }: { title: string; back: string; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-xl space-y-4 rounded-lg border border-border bg-card p-6 shadow-card">
      <h1 className="flex items-center gap-2 text-xl font-bold"><TriangleAlert className="size-5 text-warning" />{title}</h1>
      <div className="space-y-3 text-muted-foreground">{children}</div>
      <Button asChild variant="outline" size="sm"><Link to={back} className="no-underline"><ChevronLeft />Back to the File Explorer</Link></Button>
    </div>
  );
}

function ViewSwitch({ view, wide, onChange }: { view: View; wide: boolean; onChange: (v: View) => void }) {
  const options = ([['code', 'Code', Code], ['preview', 'Preview', Eye], ['split', 'Side by side', Columns2]] as const).filter(([v]) => v !== 'split' || wide);
  return (
    <div role="radiogroup" aria-label="Show" className="inline-flex rounded-md border border-border bg-muted/50 p-0.5">
      {options.map(([v, label, Icon]) => (
        <button key={v} type="button" role="radio" aria-checked={view === v} onClick={() => onChange(v)}
          className={cn('inline-flex h-8 items-center gap-1.5 rounded px-3 text-sm font-medium',
            view === v ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
          <Icon className="size-4" />{label}
        </button>
      ))}
    </div>
  );
}

// The code, the page, or both side by side with a divider to drag (or move with
// the arrow keys; where it was left is remembered in this browser). The editor
// stays in place whichever is shown, so its undo history and cursor survive.
function Panes({ view, editor, preview }: { view: View; editor: ReactNode; preview: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [pct, setPct] = useState(() => Number(pref('editor-split', '50')) || 50);
  const [dragging, setDragging] = useState(false);
  const keep = (p: number) => { const v = Math.round(Math.min(80, Math.max(20, p))); setPct(v); setPref('editor-split', String(v)); };
  const move = (e: ReactPointerEvent) => {
    if (!dragging || !box.current) return;
    const r = box.current.getBoundingClientRect();
    keep(((e.clientX - r.left) / r.width) * 100);
  };
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); keep(pct - 5); }
    if (e.key === 'ArrowRight') { e.preventDefault(); keep(pct + 5); }
  };
  return (
    <div ref={box} className="flex h-full min-h-0">
      <div className={cn('h-full min-w-0', view === 'preview' && 'hidden', view === 'code' && 'flex-1')} style={view === 'split' ? { width: `${pct}%` } : undefined}>{editor}</div>
      {view === 'split' && (
        <div role="separator" aria-orientation="vertical" aria-label="Make the code or the preview wider" aria-valuemin={20} aria-valuemax={80} aria-valuenow={pct}
          tabIndex={0} onKeyDown={onKey}
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDragging(true); }}
          onPointerMove={move} onPointerUp={() => setDragging(false)} onPointerCancel={() => setDragging(false)}
          className={cn('w-1.5 shrink-0 cursor-col-resize touch-none bg-border outline-none transition-colors hover:bg-primary/50 focus-visible:bg-primary', dragging && 'bg-primary')} />
      )}
      {view !== 'code' && <div className={cn('h-full min-w-0 flex-1', dragging && 'pointer-events-none select-none')}>{preview}</div>}
    </div>
  );
}

// The page in a sandboxed frame (no allow-same-origin: its scripts can't reach
// the panel), loaded through a preview token so its own links work. What's in
// the editor is sent a moment after typing stops, then the frame reloads.
function Preview({ path, text, dirty }: { path: string; text: string; dirty: boolean }) {
  const [base, setBase] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const tokenOf = (b: string) => b.split('/')[4]!;
  const baseRef = useRef<string | null>(null);

  const start = useCallback(async () => {
    const r = await api<{ token: string; base: string }>('/api/files/preview', { path });
    baseRef.current = r.base;
    setBase(r.base);
    return r.base;
  }, [path]);

  useEffect(() => {
    start().catch((err: unknown) => setProblem(friendlyError(err)));
    return () => {
      const b = baseRef.current;
      if (b) void api('/api/files/preview/close', { token: tokenOf(b) }).catch(() => undefined);
      baseRef.current = null;
    };
  }, [start]);

  useEffect(() => {
    if (!base) return;
    const t = setTimeout(async () => {
      try {
        try { await api('/api/files/draft', { token: tokenOf(base), path, text }); } catch (err) {
          if (!(err instanceof ApiError) || err.status !== 410) throw err;
          await start();                       // expired: a new token, and this effect runs again
          return;
        }
        setProblem(null);
        setN((x) => x + 1);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) { signedOut(); return; }
        setProblem(friendlyError(err));
      }
    }, n === 0 ? 0 : 600);
    return () => clearTimeout(t);
  }, [base, text]);                                        // eslint-disable-line react-hooks/exhaustive-deps

  // (on lfdln: through a route that shows its folder; none, no link)
  const live = publicAddresses(path, [], useShown())[0];
  const src = base && n > 0 ? `${base}${path.split('/').map(encodeURIComponent).join('/')}?preview=${n}` : null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/60 px-3 py-1.5 text-sm">
        <span className="font-semibold">Preview</span>
        <span className="text-muted-foreground">{dirty ? 'with your unsaved changes' : 'as saved'}</span>
        <span className="ml-auto flex gap-1">
          <Button variant="ghost" size="sm" className="h-7" onClick={() => setN((x) => x + 1)} title="Reload the preview"><RefreshCw /><span className="sr-only">Reload</span></Button>
          {live && <Button asChild variant="ghost" size="sm" className="h-7">
            <a href={live} target="_blank" rel="noopener" className="no-underline" title={`Open the saved page on ${W.website.your}, in a new tab`}><ExternalLink />Real page</a>
          </Button>}
        </span>
      </div>
      {problem ? <p className="p-4 text-sm text-destructive">{problem}</p>
        : !src ? <div className="p-4"><Loading rows={3} /></div>
        : <iframe key={base} src={src} title="Preview of the page" sandbox="allow-scripts" referrerPolicy="no-referrer" className="min-h-0 w-full flex-1 bg-white" />}
    </div>
  );
}

function ConflictDialog({ open, name, onClose, keepMine, loadTheirs, saveCopy }: {
  open: boolean; name: string; onClose: () => void; keepMine: () => Promise<void>; loadTheirs: () => Promise<void>; saveCopy: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const run = (fn: () => Promise<void>) => async () => { setBusy(true); try { await fn(); } finally { setBusy(false); } };
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>"{name}" was changed since you opened it</DialogTitle>
          <DialogDescription>Someone else saved it, or it was changed in another window or with WinSCP. Nothing was saved yet. What would you like to do?</DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-3">
          <ChoiceButton disabled={busy} onClick={run(keepMine)} title="Keep mine" text="Save your text over theirs. Theirs is kept as an earlier version, so it can be put back." />
          <ChoiceButton disabled={busy} onClick={run(loadTheirs)} title="Load theirs" text="Open the latest copy and leave your changes out." />
          <ChoiceButton disabled={busy} onClick={run(saveCopy)} title="Save mine as a copy" text={`Save your text as a new file next to "${name}", and leave theirs as it is.`} />
        </DialogBody>
        <DialogFooter><Button variant="ghost" onClick={onClose} disabled={busy}>Not now</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChoiceButton({ title, text, onClick, disabled }: { title: string; text: string; onClick: () => void; disabled: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className="rounded-lg border border-border bg-card px-4 py-3 text-left shadow-card transition-colors hover:border-primary hover:bg-primary-soft disabled:opacity-60">
      <span className="block font-semibold">{title}</span>
      <span className="block text-sm text-muted-foreground">{text}</span>
    </button>
  );
}

// Every save keeps what it replaced for 30 days (D1): see one next to what's in
// the editor now, or put it back.
function Versions({ path, root, name, current, dirty, savedHash, onClose, onRestored }: {
  path: string; root: string; name: string; current: string; dirty: boolean; savedHash: string; onClose: () => void; onRestored: () => Promise<void>;
}) {
  const dialogs = useDialogs();
  const soft = root !== '' && root !== 'website';
  const list = useApi<{ versions: Version[]; keepDays: number }>(`/api/files/versions?path=${encodeURIComponent(path)}${soft ? `&root=${encodeURIComponent(root)}` : ''}`);
  const [comparing, setComparing] = useState<{ v: Version; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const restore = async (v: Version) => {
    const ok = await dialogs.confirm({
      title: `Put back "${name}" as it was on ${formatTime(v.modifiedAt)}?`, action: 'Put it back',
      body: dirty ? "Your changes that aren't saved yet are lost. What's saved now is kept as an earlier version, so you can change your mind."
        : "What's there now is kept as an earlier version, so you can change your mind.",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api('/api/files/versions/restore', { ...(soft ? { root } : {}), id: v.id, expect: savedHash });
      await onRestored();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'conflict') notify('The file was changed since you opened it. Close this, save or reload, then try again.', 'error');
      else notify(friendlyError(err), 'error');
    } finally { setBusy(false); }
  };
  const compare = async (v: Version) => {
    try { setComparing({ v, text: (await api<{ text: string }>(`/api/files/version?id=${encodeURIComponent(v.id)}${soft ? `&root=${encodeURIComponent(root)}` : ''}`)).text }); } catch (err) { notify(friendlyError(err), 'error'); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent wide className={cn(comparing && 'max-w-6xl')}>
        <DialogHeader>
          <DialogTitle>{comparing ? `As it was on ${formatTime(comparing.v.modifiedAt)}` : `Earlier versions of "${name}"`}</DialogTitle>
          <DialogDescription>
            {comparing ? 'Left: the earlier version. Right: what is in the editor now. Changed lines are marked.'
              : `Each save keeps what it replaced, for ${list.data?.keepDays ?? 30} days. Quick saves from one open editor, a few minutes apart, share one.`}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {comparing ? <CompareView before={comparing.text} after={current} name={name} className="h-[60vh]" />
            : !list.data ? <Loading rows={3} />
            : list.data.versions.length === 0 ? <p className="text-muted-foreground">None yet. Once you save, what was there before shows here.</p>
            : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {list.data.versions.map((v) => (
                  <li key={v.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold">As it was on {formatTime(v.modifiedAt)}</p>
                      <p className="text-sm text-muted-foreground">Replaced when {v.by} saved, {timeAgo(v.savedAt)} · {v.hash === savedHash ? 'the same as now' : `${v.size.toLocaleString()} bytes`}</p>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => void compare(v)}><Copy />Compare</Button>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void restore(v)}><RotateCcw />Put back</Button>
                  </li>
                ))}
              </ul>
            )}
        </DialogBody>
        <DialogFooter>
          {comparing ? <>
            <Button variant="ghost" onClick={() => setComparing(null)}><ChevronLeft />All versions</Button>
            <Button disabled={busy} onClick={() => void restore(comparing.v)}><RotateCcw />Put this one back</Button>
          </> : <Button variant="ghost" onClick={onClose}>Close</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
