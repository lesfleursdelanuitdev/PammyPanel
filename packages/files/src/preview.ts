// The editor's preview (docs/editor-plan.md, section 4): an HTML page shown in a
// sandboxed frame, as /api/files/view/<token>/<path in the website>, so her
// relative links (style.css, images/x.jpg, ../) find the real files next to it.
//
// The frame has no allow-same-origin, so the page runs in an opaque origin: its
// scripts can't read the panel or use the signed-in session. Browsers don't send
// the panel's cookie from such a frame either, which is why the address carries
// a token instead: made for one signed-in session and one open editor, good only
// inside `root` (the folder the page is in at the top of the website, or the
// account's own folder), forgotten after two idle hours or when the session ends.
//
// The editor also parks its unsaved text here (one draft per token), so the
// preview shows what's being typed, not only what's saved.
import { randomBytes } from 'node:crypto';

export const PREVIEW_IDLE = 2 * 3600;
export const PREVIEW_MAX_AGE = 12 * 3600;
const MAX_TOKENS = 200;
const DRAFT_BUDGET = 64 * 1024 * 1024;

export type PreviewToken = { userId: number; sessionId: number; root: string; createdAt: number; usedAt: number; draft: { path: string; text: string } | null };

export class Previews {
  private tokens = new Map<string, PreviewToken>();
  private now: () => number;
  constructor(now: () => number) { this.now = now; }

  create(userId: number, sessionId: number, root: string): string {
    this.sweep();
    if (this.tokens.size >= MAX_TOKENS) {
      const oldest = [...this.tokens.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
      if (oldest) this.tokens.delete(oldest[0]);
    }
    const token = randomBytes(24).toString('base64url');
    const t = this.now();
    this.tokens.set(token, { userId, sessionId, root, createdAt: t, usedAt: t, draft: null });
    return token;
  }

  // The token's details if it's still good; using it keeps it alive.
  use(token: string): PreviewToken | null {
    const p = this.tokens.get(token);
    if (!p) return null;
    const t = this.now();
    if (t - p.usedAt > PREVIEW_IDLE || t - p.createdAt > PREVIEW_MAX_AGE) { this.tokens.delete(token); return null; }
    p.usedAt = t;
    return p;
  }

  // Only its own account may park a draft under a token.
  setDraft(token: string, userId: number, path: string, text: string): boolean {
    const p = this.use(token);
    if (!p || p.userId !== userId || !inside(p.root, path)) return false;
    p.draft = { path, text };
    this.trimDrafts();
    return true;
  }

  drop(token: string, userId: number) {
    const p = this.tokens.get(token);
    if (p && p.userId === userId) this.tokens.delete(token);
  }

  private sweep() {
    const t = this.now();
    for (const [k, p] of this.tokens) if (t - p.usedAt > PREVIEW_IDLE || t - p.createdAt > PREVIEW_MAX_AGE) this.tokens.delete(k);
  }

  // Drafts are at most 2 MB each; if they add up to too much, the least recently
  // used ones go (their previews fall back to the saved file).
  private trimDrafts() {
    let total = 0;
    const withDrafts = [...this.tokens.values()].filter((p) => p.draft).sort((a, b) => b.usedAt - a.usedAt);
    for (const p of withDrafts) {
      total += p.draft!.text.length * 2;
      if (total > DRAFT_BUDGET) p.draft = null;
    }
  }
}

export const inside = (root: string, path: string) => root === '' || path === root || path.startsWith(`${root}/`);

// Where a token may read: for a person kept to places, the place the page is in;
// else the folder at the top of the website that the page is in (the whole
// website for a page at the top).
export function previewRoot(path: string, limitedTo: string | null): string {
  if (limitedTo !== null) return limitedTo;
  const parts = path.split('/').filter(Boolean);
  return parts.length > 1 ? parts[0]! : '';
}

// Her gate's own tags don't work in the panel (they talk to the gate on
// pammy.org), so the preview shows a labelled box where each one goes. And
// addresses starting with "/" mean the top of her site (or of the subdomain
// folder), which in the preview is `rootBase`.
const PLACEHOLDERS = `<style data-pammy-preview>
pammy-form, pammy-login, pammy-forgot, pammy-invite, pammy-request, pammy-welcome, pammy-signed-out, pammy-logout {
  display: block; margin: 1em 0; padding: 1.25em; border: 2px dashed #b4637a; border-radius: 10px;
  background: #fbf2f4; color: #6d2a3d; font: 15px/1.4 system-ui, sans-serif; text-align: center;
}
pammy-form::before { content: "Your form “" attr(name) "” shows here on the real page."; }
pammy-login::before, pammy-forgot::before, pammy-invite::before, pammy-request::before { content: "The sign-in box shows here on the real page."; }
pammy-welcome::before { content: "The list of pages in this folder shows here on the real page."; }
pammy-signed-out::before, pammy-logout::before { content: "The sign-out message shows here on the real page."; }
pammy-form > *, pammy-login > *, pammy-forgot > *, pammy-invite > *, pammy-request > *, pammy-welcome > *, pammy-signed-out > *, pammy-logout > * { display: none !important; }
</style>`;

export function previewHtml(html: string, rootBase: string): string {
  const rewritten = html.replace(/(\s(?:src|href|action|poster)\s*=\s*["'])\/(?![/\\])/gi, `$1${rootBase}`);
  const head = /<head\b[^>]*>/i.exec(rewritten);
  if (head) return rewritten.slice(0, head.index + head[0].length) + PLACEHOLDERS + rewritten.slice(head.index + head[0].length);
  return PLACEHOLDERS + rewritten;
}
