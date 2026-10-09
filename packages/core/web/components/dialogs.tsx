// Questions in a small window, instead of the browser's own confirm() and prompt():
//   const dialogs = useDialogs();
//   if (!await dialogs.confirm({ title: 'Move "recipes" to the trash?', body: '...', action: 'Move to trash', danger: true })) return;
//   const name = await dialogs.prompt({ title: 'Rename', label: 'New name', value: 'old' });   // null: cancelled
import { AlertDialog as AlertDialogPrimitive } from 'radix-ui';
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { cn } from '../lib/utils';

type ConfirmOpts = { title: string; body?: ReactNode; action: string; danger?: boolean; cancel?: string };
type PromptOpts = { title: string; body?: ReactNode; label: string; value?: string; action?: string; placeholder?: string; hint?: ReactNode };
type Asking =
  | ({ kind: 'confirm'; resolve: (v: boolean) => void } & ConfirmOpts)
  | ({ kind: 'prompt'; resolve: (v: string | null) => void } & PromptOpts);

const Ctx = createContext<{ confirm: (o: ConfirmOpts) => Promise<boolean>; prompt: (o: PromptOpts) => Promise<string | null> } | null>(null);

export function useDialogs() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useDialogs outside DialogsProvider');
  return c;
}

export function DialogsProvider({ children }: { children: ReactNode }) {
  const [asking, setAsking] = useState<Asking | null>(null);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setAsking({ kind: 'confirm', resolve, ...o })), []);
  const prompt = useCallback((o: PromptOpts) => new Promise<string | null>((resolve) => {
    setValue(o.value ?? '');
    setAsking({ kind: 'prompt', resolve, ...o });
  }), []);

  const finish = (answer: boolean) => {
    if (!asking) return;
    if (asking.kind === 'confirm') asking.resolve(answer);
    else asking.resolve(answer ? value : null);
    setAsking(null);
  };

  return (
    <Ctx.Provider value={{ confirm, prompt }}>
      {children}
      <AlertDialogPrimitive.Root open={asking !== null} onOpenChange={(open) => { if (!open) finish(false); }}>
        <AlertDialogPrimitive.Portal>
          <AlertDialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[rgb(20_12_26/0.45)] backdrop-blur-[2px] data-[state=open]:animate-[fade-in_150ms_ease-out]" />
          <AlertDialogPrimitive.Content
            className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-pop data-[state=open]:animate-[zoom-in_160ms_ease-out]"
            onOpenAutoFocus={(e) => { if (asking?.kind === 'prompt') { e.preventDefault(); inputRef.current?.select(); inputRef.current?.focus(); } }}
          >
            {asking && (
              <form onSubmit={(e) => { e.preventDefault(); finish(true); }}>
                <AlertDialogPrimitive.Title className="text-base font-semibold leading-snug [overflow-wrap:anywhere]">{asking.title}</AlertDialogPrimitive.Title>
                <AlertDialogPrimitive.Description asChild>
                  <div className={cn('mt-2 space-y-2 text-sm text-muted-foreground', !asking.body && 'sr-only')}>{asking.body ?? asking.title}</div>
                </AlertDialogPrimitive.Description>
                {asking.kind === 'prompt' && (
                  <div className="mt-4 grid gap-1.5">
                    <Label htmlFor="dialog-prompt">{asking.label}</Label>
                    <Input id="dialog-prompt" ref={inputRef} value={value} placeholder={asking.placeholder} autoComplete="off" spellCheck={false}
                      onChange={(e) => setValue(e.target.value)} />
                    {asking.hint && <p className="text-sm text-muted-foreground">{asking.hint}</p>}
                  </div>
                )}
                <div className="mt-6 flex flex-wrap justify-end gap-2">
                  <AlertDialogPrimitive.Cancel asChild>
                    <Button type="button" variant="outline">{asking.kind === 'confirm' ? asking.cancel ?? 'Cancel' : 'Cancel'}</Button>
                  </AlertDialogPrimitive.Cancel>
                  <Button type="submit" variant={asking.kind === 'confirm' && asking.danger ? 'destructive' : 'default'}
                    disabled={asking.kind === 'prompt' && !value.trim()}>
                    {asking.kind === 'confirm' ? asking.action : asking.action ?? 'OK'}
                  </Button>
                </div>
              </form>
            )}
          </AlertDialogPrimitive.Content>
        </AlertDialogPrimitive.Portal>
      </AlertDialogPrimitive.Root>
    </Ctx.Provider>
  );
}
