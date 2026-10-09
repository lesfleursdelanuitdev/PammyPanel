// What a key can cover, on the page (docs/catalog-plan.md step 3c, K1): each module
// that owns something a key reads (forms, media folders) gives its part of the
// "New key" form and how a key's cover of it is shown. The site hands the page the
// covers of the modules it has on.
import type { ReactNode } from 'react';
import type { ApiKey } from './types';
import { type GuideTopic } from '@panel/core/web/lib/site';

// S: the part's own state while a key is being made
export type KeyCover<S = unknown> = {
  kind: 'forms' | 'media';
  // what a key lets a program read ("forms' responses"), and the guide about it
  reads: string;
  help: { topic: GuideTopic; label: string };
  start: S;
  // its part of what POST /api/api-keys is sent
  body: (s: S) => Record<string, unknown>;
  Fields: (p: { state: S; set: (s: S) => void }) => ReactNode;
  // its badges and facts in the list of keys
  badges: (k: ApiKey) => ReactNode;
  facts: (k: ApiKey) => (string | null)[];
};

// a cover of any state, as the page holds them side by side
export type AnyKeyCover = KeyCover<any>;
