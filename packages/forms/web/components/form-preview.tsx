// The preview: the form exactly as visitors see it, drawn by the same component
// their pages use (public-gate/forms.js). It runs in a frame on pammy.org, which
// only this panel may frame, and the form is handed over by postMessage: nothing
// is saved, and nothing is sent.
import { Monitor, Smartphone } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@panel/core/web/components/ui/button';
import { cn } from '@panel/core/web/lib/utils';
import type { FormItem, FormSettings } from '../lib/types';
import { SITE_ORIGIN } from '@panel/core/web/lib/site';

const SITE = SITE_ORIGIN;
const PREVIEW_URL = `${SITE}/_pammy/form-preview`;

export function FormPreview({ items, settings, title }: { items: FormItem[]; settings: FormSettings; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [width, setWidth] = useState<'desktop' | 'phone'>('desktop');
  const [height, setHeight] = useState(360);
  const [ready, setReady] = useState(false);

  // The form to show, sent again whenever it changes (and as soon as the frame says it is ready).
  useEffect(() => {
    const message = {
      type: 'pammy-form-preview',
      form: { name: 'preview', title, items, submitText: settings.submitText, sentText: settings.sentText, signedInAs: null },
    };
    const onMessage = (e: MessageEvent) => {
      if (new URL(PREVIEW_URL).origin !== e.origin) return;
      if (e.data?.type === 'pammy-form-preview-ready') { setReady(true); frame.current?.contentWindow?.postMessage(message, PREVIEW_URL); }
      if (e.data?.type === 'pammy-form-preview-height' && typeof e.data.height === 'number') setHeight(Math.min(2000, Math.max(200, e.data.height + 64)));
    };
    addEventListener('message', onMessage);
    if (ready) frame.current?.contentWindow?.postMessage(message, PREVIEW_URL);
    return () => removeEventListener('message', onMessage);
  }, [items, settings, title, ready]);

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <h2 className="mr-auto text-sm font-semibold">Preview: what visitors see</h2>
        <div className="flex gap-1 rounded-md border border-border p-0.5">
          <Button size="sm" variant={width === 'desktop' ? 'light' : 'ghost'} aria-pressed={width === 'desktop'} onClick={() => setWidth('desktop')}><Monitor />Computer</Button>
          <Button size="sm" variant={width === 'phone' ? 'light' : 'ghost'} aria-pressed={width === 'phone'} onClick={() => setWidth('phone')}><Smartphone />Phone</Button>
        </div>
      </div>
      <div className="flex justify-center bg-muted/40 p-4">
        <iframe ref={frame} src={PREVIEW_URL} title="Preview of the form" referrerPolicy="no-referrer"
          className={cn('rounded-md border border-border bg-white', width === 'phone' ? 'w-[26rem] max-w-full' : 'w-full')}
          style={{ height }} />
      </div>
      <p className="border-t border-border px-4 py-2.5 text-sm text-muted-foreground">
        Nothing here is sent or saved: the button only shows the thank-you words. The look comes from your own page's style.
      </p>
    </section>
  );
}
