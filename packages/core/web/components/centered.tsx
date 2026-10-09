import type { ReactNode } from 'react';
import { RoseMark } from './logo';
import { NoticeBar } from './notice';
import { SITE } from '../lib/site';

// Sign in and the setup link: one small card in the middle of the page.
export function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh place-items-center px-4 py-10">
      <main className="w-full max-w-[26rem]">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <RoseMark className="size-12" />
          <p className="text-sm font-medium text-muted-foreground">{SITE.panelName}</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-6 shadow-card sm:p-8">{children}</div>
      </main>
      <NoticeBar />
    </div>
  );
}
