// pammy.org comments component, served at /_pammy/comments.js on every pammy.org
// address (docs/comments-plan.md). On ANY page of the website:
//
//   <script src="/_pammy/comments.js" defer></script>
//   <pammy-comments name="page-comments"></pammy-comments>
//
// name        which comment area (made in the control panel, Comments tab)
// content-id  which thing the comments are about. Leave it out on an ordinary
//             page: the page itself is the thing. An area about a table of
//             one of her apps (blog posts) needs it: content-id="12". It can be
//             set later from a script -- el.setAttribute('content-id', post.id)
//             -- and the comments of that one are shown instead.
// order       newest (the default) or oldest first
// per         how many to show at a time (20)
//
// Every comment waits for her OK before anyone sees it; after sending, the
// visitor is told so.
//
// Wording, with attributes: heading, intro, button, sent-text, empty-text,
//   closed-text, loading-text, more-text, count-text (one), counts-text (many,
//   with {n}), and the comment box's own (as <pammy-form>: optional-text...).
// The look: built-in styles inside :where() (her CSS always wins), styles="off"
// leaves them out. Classes: pammy-comments, pammy-comment-count,
// pammy-comment-list, pammy-comment, pammy-comment-author, pammy-comment-when,
// pammy-comment-body, pammy-comment-form, pammy-more, and the comment box's
// (pammy-form, pammy-field, pammy-input, pammy-button...).
// Settings: --pammy-accent --pammy-accent-text --pammy-radius --pammy-font
//   --pammy-width --pammy-gap
//
// Written with Lit (packages/comments/widgets/comments.ts); public-gate/comments.js is built
// from it, with <pammy-form> inside (packages/forms/widgets/forms.ts).
import { html, nothing } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { addStyle, maybe, PammyElement, words } from '@panel/core/widgets/base.ts';
import '@panel/forms/widgets/forms.ts';

const STYLE = `
:where(pammy-comments) [hidden] { display: none !important; }
:where(pammy-comments.pammy-styled) { display: block; max-width: var(--pammy-width, 40rem); font-family: var(--pammy-font, inherit); }
:where(pammy-comments.pammy-styled .pammy-comments) { display: grid; gap: var(--pammy-gap, 1rem); }
:where(pammy-comments.pammy-styled .pammy-heading) { margin: 0; font-size: 1.4rem; }
:where(pammy-comments.pammy-styled .pammy-comment-count, pammy-comments.pammy-styled .pammy-note) { margin: 0; opacity: 0.8; font-size: 0.95rem; }
:where(pammy-comments.pammy-styled .pammy-comment-list) { display: grid; gap: 0.9rem; list-style: none; margin: 0; padding: 0; }
:where(pammy-comments.pammy-styled .pammy-comment) { display: grid; gap: 0.25rem; padding-bottom: 0.9rem; border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent); }
:where(pammy-comments.pammy-styled .pammy-comment-author) { font-weight: 600; margin-right: 0.5rem; }
:where(pammy-comments.pammy-styled .pammy-comment-when) { font-size: 0.85rem; opacity: 0.7; }
:where(pammy-comments.pammy-styled .pammy-comment-body) { margin: 0; white-space: pre-line; overflow-wrap: anywhere; }
:where(pammy-comments.pammy-styled .pammy-more) {
  justify-self: start; font: inherit; cursor: pointer; padding: 0.5rem 1rem; border-radius: var(--pammy-radius, 8px);
  border: 1px solid color-mix(in srgb, currentColor 30%, transparent); background: transparent; color: inherit;
}
`;

type Comment = { id: number; sentAt: string; author: string; body: string; answers: Record<string, unknown> };
type Page = { area: { name: string; title: string }; content: string; open: boolean; comments: Comment[]; total: number; next: string | null };

class PammyComments extends PammyElement {
  static override properties = {
    ...words('name', 'content-id', 'heading', 'intro', 'button', 'sent-text', 'empty-text', 'closed-text', 'loading-text',
      'more-text', 'count-text', 'counts-text', 'order', 'per', 'optional-text'),
    state: { state: true }, list: { state: true }, total: { state: true }, next: { state: true }, open: { state: true },
    busy: { state: true },
  };
  declare state: { kind: 'loading' } | { kind: 'problem'; text: string } | { kind: 'ready' };
  declare list: Comment[];
  declare total: number;
  declare next: string | null;
  declare open: boolean;
  declare busy: boolean;
  private asked = '';          // the thread last asked for, so a change of content-id loads the other one

  constructor() {
    super();
    this.state = { kind: 'loading' };
    this.list = [];
    this.total = 0;
    this.next = null;
    this.open = true;
    this.busy = false;
  }

  protected override addStyle() { addStyle('pammy-comments-style', STYLE); }

  protected override start() { void this.load(); }

  // content-id is reactive: a page that learns the post's id from a request
  // sets it afterwards, and changing it shows the other thread
  protected override updated(changed: Map<string, unknown>) {
    if (changed.has('content-id') && this.asked !== this.contentId()) void this.load();
  }

  private contentId() { return this.getAttribute('content-id') || ''; }

  private query(after: string | null) {
    const p = new URLSearchParams({ page: location.pathname, content: this.contentId(), order: this.getAttribute('order') === 'oldest' ? 'oldest' : 'newest' });
    const per = Number(this.getAttribute('per'));
    if (per > 0) p.set('per', String(Math.min(100, per)));
    if (after) p.set('after', after);
    return `/_pammy/comments/${encodeURIComponent(this.getAttribute('name') || '')}?${p}`;
  }

  private async load() {
    this.asked = this.contentId();
    this.state = { kind: 'loading' };
    try {
      const res = await fetch(this.query(null), { credentials: 'same-origin' });
      const data = await res.json().catch(() => ({})) as Page & { message?: string };
      if (!res.ok) { this.state = { kind: 'problem', text: data.message || "The comments can't be shown just now." }; return; }
      this.list = data.comments;
      this.total = data.total;
      this.next = data.next;
      this.open = data.open;
      this.state = { kind: 'ready' };
    } catch {
      this.state = { kind: 'problem', text: "The comments couldn't be loaded. Please reload the page." };
    }
  }

  private async more() {
    if (!this.next) return;
    this.busy = true;
    try {
      const res = await fetch(this.query(this.next), { credentials: 'same-origin' });
      const data = await res.json() as Page;
      if (res.ok) { this.list = [...this.list, ...data.comments]; this.next = data.next; }
    } finally {
      this.busy = false;
    }
  }

  private when(iso: string) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  }

  private countText() {
    if (this.total === 1) return this.text('count-text', '1 comment');
    return this.text('counts-text', '{n} comments').replace('{n}', String(this.total));
  }

  override render() {
    const heading = maybe(this.getAttribute('heading') ?? 'Comments', (h) => html`<h2 class="pammy-heading">${h}</h2>`);
    const intro = maybe(this.getAttribute('intro'), (i) => html`<p class="pammy-note">${i}</p>`);
    const s = this.state;
    if (s.kind === 'loading') return html`<div class="pammy-comments">${heading}<p class="pammy-note">${this.text('loading-text', 'Loading the comments...')}</p></div>`;
    if (s.kind === 'problem') return html`<div class="pammy-comments">${heading}<p class="pammy-note">${s.text}</p></div>`;
    const form = this.open
      ? keyed(this.asked, html`<pammy-form class="pammy-comment-form" comments name=${this.getAttribute('name') || ''} content-id=${this.asked}
          button=${this.getAttribute('button') || 'Send'} optional-text=${this.getAttribute('optional-text') ?? nothing}
          sent-text=${this.getAttribute('sent-text') || 'Thank you. Your comment will appear here once it has been approved.'}></pammy-form>`)
      : html`<p class="pammy-note">${this.text('closed-text', 'Comments are closed.')}</p>`;
    return html`<div class="pammy-comments">${heading}${intro}
      <p class="pammy-comment-count">${this.total === 0 ? this.text('empty-text', 'No comments yet.') : this.countText()}</p>
      <ol class="pammy-comment-list" ?hidden=${this.list.length === 0}>${this.list.map((c) => html`<li class="pammy-comment" data-id=${String(c.id)}>
        <div><span class="pammy-comment-author">${c.author || 'Someone'}</span><time class="pammy-comment-when" datetime=${c.sentAt}>${this.when(c.sentAt)}</time></div>
        <p class="pammy-comment-body">${c.body}</p></li>`)}</ol>
      ${maybe(this.next, () => html`<button class="pammy-more" type="button" ?disabled=${this.busy} @click=${() => this.more()}>${this.text('more-text', 'Show more comments')}</button>`)}
      ${form}</div>`;
  }
}

if (!customElements.get('pammy-comments')) customElements.define('pammy-comments', PammyComments);
