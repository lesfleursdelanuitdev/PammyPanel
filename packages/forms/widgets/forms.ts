// pammy.org form component, served at /_pammy/forms.js on every pammy.org
// address. On ANY page of the website:
//
//   <script src="/_pammy/forms.js" defer></script>
//   <pammy-form name="olivias-form" thanks="thank-you.html"></pammy-form>
//
// name     which form to show (made in the control panel, Forms tab)
// thanks   where to go after sending: like a link, and on this website only.
//          Without it, the form is replaced by a thank-you message on the page.
//
// The thank-you on the page is hers to write and style. Either sent-text="..."
// (or the words set in the panel), which lands in <p class="pammy-sent">, or her
// own markup, which is used exactly as written:
//
//   <pammy-form name="olivias-form">
//     <template class="pammy-thanks">
//       <h2>Thank you!</h2>
//       <p>See you on the 3rd. <a href="/">Back to the website</a></p>
//     </template>
//   </pammy-form>
//
// Her guide (10-forms.txt, "Changing the words" and "Changing the look") is the
// reference for everything below; keep them in step.
//
// Wording, with attributes: heading, intro, sent-text, unavailable-text,
//   button, optional-text, choose-text, other-text, loading-text, sending-as-text
// The look: built-in styles inside :where() (her CSS always wins), styles="off"
// leaves them out. Classes: pammy-box, pammy-form, pammy-heading, pammy-intro,
// pammy-note, pammy-help, pammy-field (+ pammy-field-<kind>), pammy-label,
// pammy-optional, pammy-input, pammy-choices, pammy-choice, pammy-check,
// pammy-parts, pammy-part, pammy-stars, pammy-star, pammy-scale, pammy-button,
// pammy-message, pammy-sent, pammy-heading-item, pammy-paragraph, pammy-divider,
// pammy-image. Every field also has data-key="<its key>" and data-type="<kind>",
// and its label has data-question="<its words>". A field that's wrong gets
// aria-invalid="true".
// Settings: --pammy-accent --pammy-accent-text --pammy-radius --pammy-font
//   --pammy-width --pammy-gap --pammy-field-bg --pammy-field-border --pammy-error
//
// Written with Lit (packages/forms/widgets/forms.ts); public-gate/forms.js is built from it.
import { html, nothing, type TemplateResult } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { addStyle, maybe, PammyElement, trap, words } from '@panel/core/widgets/base.ts';

const STYLE = `
:where(pammy-form) [hidden] { display: none !important; }
:where(pammy-form.pammy-styled) { display: block; max-width: var(--pammy-width, 36rem); font-family: var(--pammy-font, inherit); }
:where(pammy-form.pammy-styled .pammy-form) { display: grid; gap: var(--pammy-gap, 0.9rem); }
:where(pammy-form.pammy-styled .pammy-heading) { margin: 0 0 0.25rem; font-size: 1.5rem; }
:where(pammy-form.pammy-styled .pammy-heading-item) { margin: 0.5rem 0 0; }
:where(pammy-form.pammy-styled .pammy-paragraph) { margin: 0; }
:where(pammy-form.pammy-styled .pammy-divider) { border: 0; border-top: 1px solid var(--pammy-field-border, color-mix(in srgb, currentColor 25%, transparent)); margin: 0.4rem 0; width: 100%; }
:where(pammy-form.pammy-styled .pammy-image) { max-width: 100%; height: auto; border-radius: var(--pammy-radius, 8px); }
:where(pammy-form.pammy-styled .pammy-field) { display: grid; gap: 0.3rem; font-weight: 600; font-size: 0.95rem; }
:where(pammy-form.pammy-styled .pammy-optional) { font-weight: 400; opacity: 0.7; }
:where(pammy-form.pammy-styled .pammy-help) { font-weight: 400; font-size: 0.85rem; opacity: 0.8; margin: 0; }
:where(pammy-form.pammy-styled .pammy-input) {
  font: inherit; font-weight: 400; padding: 0.6rem 0.75rem; border-radius: var(--pammy-radius, 8px);
  border: 1px solid var(--pammy-field-border, color-mix(in srgb, currentColor 30%, transparent));
  background: var(--pammy-field-bg, transparent); color: inherit; max-width: 100%;
}
:where(pammy-form.pammy-styled select.pammy-input option) { color: #2a2622; background: #fff; }
:where(pammy-form.pammy-styled textarea.pammy-input) { resize: vertical; }
:where(pammy-form.pammy-styled .pammy-choices) { display: grid; gap: 0.35rem; font-weight: 400; }
:where(pammy-form.pammy-styled .pammy-choices[data-columns="2"]) { grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); }
:where(pammy-form.pammy-styled .pammy-choice, pammy-form.pammy-styled .pammy-check) { display: flex; align-items: flex-start; gap: 0.6rem; font-weight: 400; }
:where(pammy-form.pammy-styled .pammy-choice input, pammy-form.pammy-styled .pammy-check .pammy-input) {
  width: 1.15rem; height: 1.15rem; margin: 0.15rem 0 0; padding: 0; accent-color: var(--pammy-accent, #7a4b8c);
}
:where(pammy-form.pammy-styled .pammy-parts) { display: grid; gap: 0.4rem; font-weight: 400; }
:where(pammy-form.pammy-styled .pammy-parts[data-columns="2"]) { grid-template-columns: 1fr 1fr; }
:where(pammy-form.pammy-styled .pammy-part) { display: grid; gap: 0.2rem; font-size: 0.85rem; }
:where(pammy-form.pammy-styled .pammy-stars, pammy-form.pammy-styled .pammy-scale) { display: flex; flex-wrap: wrap; gap: 0.35rem; font-weight: 400; }
:where(pammy-form.pammy-styled .pammy-star, pammy-form.pammy-styled .pammy-step) {
  cursor: pointer; border: 1px solid var(--pammy-field-border, color-mix(in srgb, currentColor 30%, transparent));
  border-radius: var(--pammy-radius, 8px); padding: 0.3rem 0.7rem; background: var(--pammy-field-bg, transparent); font: inherit; color: inherit;
}
:where(pammy-form.pammy-styled .pammy-star[aria-checked="true"], pammy-form.pammy-styled .pammy-step[aria-checked="true"]) {
  background: var(--pammy-accent, #7a4b8c); color: var(--pammy-accent-text, #fff); border-color: transparent;
}
:where(pammy-form.pammy-styled .pammy-ends) { display: flex; justify-content: space-between; font-weight: 400; font-size: 0.85rem; opacity: 0.8; }
:where(pammy-form.pammy-styled .pammy-input:focus, pammy-form.pammy-styled .pammy-star:focus, pammy-form.pammy-styled .pammy-step:focus) {
  outline: 2px solid var(--pammy-accent, #7a4b8c); outline-offset: 1px;
}
:where(pammy-form.pammy-styled [aria-invalid="true"]) { border-color: var(--pammy-error, #c0392b); }
:where(pammy-form.pammy-styled .pammy-button) {
  justify-self: start; font: inherit; font-weight: 600; cursor: pointer; padding: 0.65rem 1.25rem; border: 0;
  border-radius: var(--pammy-radius, 8px); background: var(--pammy-accent, #7a4b8c); color: var(--pammy-accent-text, #fff);
}
:where(pammy-form.pammy-styled .pammy-button:disabled) { opacity: 0.6; cursor: default; }
:where(pammy-form.pammy-styled .pammy-message) { margin: 0; padding: 0.6rem 0.75rem; border-radius: var(--pammy-radius, 8px); font-size: 0.95rem;
  background: color-mix(in srgb, var(--pammy-error, #c0392b) 12%, transparent); }
:where(pammy-form.pammy-styled .pammy-note, pammy-form.pammy-styled .pammy-intro) { margin: 0; }
:where(pammy-form.pammy-styled p.pammy-sent) { margin: 0; }
:where(pammy-form.pammy-styled .pammy-note, pammy-form.pammy-styled .pammy-intro) { font-size: 0.9rem; opacity: 0.8; }
:where(pammy-form.pammy-styled .pammy-half) { max-width: 16rem; }
`;
const NAME_PARTS = [['title', 'Title'], ['first', 'First name'], ['middle', 'Middle name'], ['last', 'Last name']] as const;
const ADDRESS_PARTS = [['line1', 'Address'], ['line2', 'Address line 2'], ['town', 'Town or city'], ['region', 'County or state'], ['postcode', 'Postcode'], ['country', 'Country']] as const;
const AUTOCOMPLETE: Record<string, string> = {
  first: 'given-name', last: 'family-name', line1: 'address-line1', line2: 'address-line2', town: 'address-level2', region: 'address-level1', postcode: 'postal-code', country: 'country-name',
};
const LAYOUT = ['heading', 'paragraph', 'divider', 'image'];
// A question in one control of its own sits in a <label>; the rest in a <div role="group">.
const ONE_CONTROL = ['short-text', 'email', 'phone', 'website', 'date', 'time', 'long-text', 'number', 'dropdown'];
const KINDS = [...ONE_CONTROL, 'single-choice', 'multiple-choice', 'checkbox', 'name', 'address', 'rating', 'scale', 'hidden'];

// A form item as the gate sends it (src/gate/forms/items.ts has the whole of it).
type Item = {
  type: string; key: string; label: string; required?: boolean; help?: string; width?: string;
  placeholder?: string; default?: unknown; maxLength?: number; minLength?: number; rows?: number;
  earliest?: string; latest?: string; step?: number; min?: number | null; max?: number | null; decimals?: number;
  options?: string[]; other?: boolean; columns?: number; minPicks?: number; maxPicks?: number;
  parts?: Record<string, boolean>; defaultCountry?: string;
  stars?: number; from?: number; to?: number; lowLabel?: string; highLabel?: string; param?: string;
  text?: string; size?: string; src?: string; alt?: string;
};
type Form = { name: string; items?: Item[]; submitText?: string; sentText?: string; signedInAs?: string };
type Answer = string | boolean | number | null | string[] | Record<string, string>;
type Words = { choose: string; other: string; optional: string };

const isBlank = (v: Answer) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)
  || (typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((s) => !s));

const dayOf = (v: unknown) => (v === 'today' ? new Date().toISOString().slice(0, 10) : (v as string) || '');
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

function layoutNode(item: Item) {
  switch (item.type) {
    case 'heading':
      if (item.size === 'large') return html`<h2 class="pammy-heading-item">${item.text}</h2>`;
      if (item.size === 'small') return html`<h4 class="pammy-heading-item">${item.text}</h4>`;
      return html`<h3 class="pammy-heading-item">${item.text}</h3>`;
    case 'paragraph': return html`<p class="pammy-paragraph">${item.text}</p>`;
    case 'divider': return html`<hr class="pammy-divider">`;
    case 'image': return html`<img class="pammy-image${item.width === 'half' ? ' pammy-half' : ''}" src=${str(item.src)} alt=${str(item.alt)} loading="lazy">`;
    default: return nothing;
  }
}

// The parts a name or address question asks for: the two it always needs, and those she switched on.
const partsOf = (item: Item) => (item.type === 'name' ? NAME_PARTS : ADDRESS_PARTS)
  .filter(([p]) => (item.type === 'name' ? p === 'first' || p === 'last' : p === 'line1' || p === 'town') || (item.parts || {})[p]);

// The first number on a rating or scale, and the last.
const rangeOf = (item: Item) => (item.type === 'rating' ? [1, item.stars || 5] : [item.from === 0 ? 0 : 1, item.to || 10]) as [number, number];

class PammyForm extends PammyElement {
  static override properties = {
    ...words('name', 'thanks', 'heading', 'intro', 'sent-text', 'unavailable-text', 'button', 'optional-text', 'choose-text',
      'other-text', 'loading-text', 'sending-as-text', 'panel'),
    preview: { type: Boolean },
    // inside <pammy-comments> (packages/comments/widgets/comments.ts): the comment box of that
    // area, for the thread its content-id names
    comments: { type: Boolean }, 'content-id': { type: String },
    state: { state: true }, message: { state: true }, invalid: { state: true }, busy: { state: true }, picks: { state: true },
  };
  declare preview: boolean;
  // loading; a problem loading it (its words); the form; sent (the thank-you shown)
  declare state: { kind: 'loading' } | { kind: 'problem'; text: string } | { kind: 'form'; data: Form } | { kind: 'sent'; data: Form; text: string };
  declare message: string;
  declare invalid: string | null;           // the key of the question that's wrong
  declare busy: boolean;
  declare picks: Map<string, number | null>; // ratings and scales: what's chosen
  private thanksMarkup: DocumentFragment | null = null;
  private generation = 0;                   // each form loaded is built afresh
  private groupNames = new Map<string, string>();
  private watching = false;
  private previewing = false;

  constructor() {
    super();
    this.state = { kind: 'loading' };
    this.message = '';
    this.invalid = null;
    this.busy = false;
    this.picks = new Map();
  }

  protected override addStyle() { addStyle('pammy-form-style', STYLE); }

  // her own thank-you markup, kept before the form replaces what's inside
  protected override adopt() {
    const template = this.querySelector<HTMLTemplateElement>('template.pammy-thanks');
    this.thanksMarkup = template ? template.content.cloneNode(true) as DocumentFragment : null;
  }

  protected override start() {
    // In the panel's preview the form comes from the panel itself, never the network.
    if (this.hasAttribute('preview')) {
      const from = this.getAttribute('panel') || '';
      addEventListener('message', (e) => {
        if (e.origin !== from || !e.data || e.data.type !== 'pammy-form-preview') return;
        this.previewing = true;
        this.load(e.data.form);
      });
      if (parent !== window) parent.postMessage({ type: 'pammy-form-preview-ready' }, from || '*');
      return;
    }
    const name = this.getAttribute('name') || '';
    const where = this.hasAttribute('comments')
      ? `/_pammy/comments/${encodeURIComponent(name)}/form?${new URLSearchParams({ page: location.pathname, content: this.getAttribute('content-id') || '' })}`
      : `/_pammy/forms/${encodeURIComponent(name)}?${new URLSearchParams({ page: location.pathname })}`;
    fetch(where, { credentials: 'same-origin' })
      .then(async (res) => ({ ok: res.ok, data: await res.json().catch(() => ({})) }))
      .then(({ ok, data }) => {
        if (!ok) { this.state = { kind: 'problem', text: this.getAttribute('unavailable-text') || data.message || "This form isn't available right now." }; return; }
        this.load(data);
      })
      .catch(() => { this.state = { kind: 'problem', text: "The form couldn't be loaded. Please reload the page." }; });
  }

  private load(data: Form) {
    this.generation++;
    this.groupNames.clear();
    this.picks = new Map();
    this.message = '';
    this.invalid = null;
    this.state = { kind: 'form', data };
  }

  // The preview frame is as tall as the form, so the panel is told its height.
  protected override updated() {
    if (!this.previewing) return;
    const to = this.getAttribute('panel') || '*';
    const send = () => parent.postMessage({ type: 'pammy-form-preview-height', height: Math.ceil(this.getBoundingClientRect().height) }, to);
    send();
    if (!this.watching) {
      this.watching = true;
      new ResizeObserver(send).observe(this);
    }
  }

  private words(): Words {
    const optional = (this as unknown as Record<string, string | null | undefined>)['optional-text'];
    return {
      choose: this.text('choose-text', 'Choose...'),
      other: this.text('other-text', 'Something else'),
      optional: optional === null || optional === undefined ? '(optional)' : optional,
    };
  }

  override render() {
    const heading = this.getAttribute('heading');
    const title = maybe(heading, (h) => html`<h2 class="pammy-heading">${h}</h2>`);
    const s = this.state;
    switch (s.kind) {
      case 'loading': return html`${title}<p class="pammy-note">${this.hasAttribute('preview') ? 'Preview' : this.text('loading-text', 'Loading the form...')}</p>`;
      case 'problem': return html`${title}<p class="pammy-note">${s.text}</p>`;
      case 'sent': return this.thanksMarkup
        ? html`<div class="pammy-sent" role="status">${this.thanksMarkup.cloneNode(true)}</div>`
        : html`<p class="pammy-sent" role="status">${s.text}</p>`;
      case 'form': return keyed(this.generation, this.formTemplate(s.data, title));
    }
  }

  private formTemplate(data: Form, title: unknown) {
    const words = this.words();
    const intro = this.getAttribute('intro');
    return html`<form class="pammy-form" novalidate @submit=${(e: Event) => this.submitted(e, data)}>${title}${maybe(intro, (i) => html`<p class="pammy-intro">${i}</p>`)}${maybe(data.signedInAs, (who) => html`<p class="pammy-note">${this.text('sending-as-text', 'Sending as')} ${who}.</p>`)}${(data.items || []).map((item) => this.itemTemplate(item, words))}${trap('pf-leave-this-empty')}<button class="pammy-button" type="submit" ?disabled=${this.busy}>${this.text('button', data.submitText || 'Send')}</button><p class="pammy-message" ?hidden=${!this.message} role="alert">${this.message}</p></form>`;
  }

  private itemTemplate(item: Item, words: Words) {
    if (LAYOUT.includes(item.type)) return layoutNode(item);
    if (!KINDS.includes(item.type) || item.type === 'hidden') return nothing;
    const invalid = this.invalid === item.key ? 'true' : nothing;
    const label = html`<span class="pammy-label" data-question=${item.label}>${item.label}${item.required || !words.optional ? nothing : html`<span class="pammy-optional">${` ${words.optional}`}</span>`}</span>`;
    const help = maybe(item.help, (h) => html`<p class="pammy-help">${h}</p>`);
    if (item.type === 'checkbox') {
      return html`<label class="pammy-field pammy-check pammy-field-checkbox" data-key=${item.key} data-type=${item.type}><input class="pammy-input" type="checkbox" ?checked=${item.default === true} aria-invalid=${invalid}><span>${label}${help}</span></label>`;
    }
    const cls = `pammy-field pammy-field-${item.type}${item.width === 'half' ? ' pammy-half' : ''}`;
    const control = this.control(item, words, invalid);
    return ONE_CONTROL.includes(item.type)
      ? html`<label class=${cls} data-key=${item.key} data-type=${item.type}>${label}${help}${control}</label>`
      : html`<div class=${cls} data-key=${item.key} data-type=${item.type} role="group">${label}${help}${control}</div>`;
  }

  // Each kind of question: its inputs. What's answered is read back from them by answerOf.
  private control(item: Item, words: Words, invalid: 'true' | typeof nothing): TemplateResult {
    const text = (type: string, maxLength: number, autocomplete?: string, inputMode?: string) =>
      html`<input class="pammy-input" type=${type} maxlength=${maxLength} autocomplete=${autocomplete ?? nothing} inputmode=${inputMode ?? nothing} placeholder=${item.placeholder || ''} value=${str(item.default)} aria-invalid=${invalid}>`;
    switch (item.type) {
      case 'short-text': return text('text', item.maxLength || 500);
      case 'email': return text('email', 254, 'email');
      case 'phone': return text('tel', 40, 'tel');
      case 'website': return text('text', 2000, undefined, 'url');
      case 'date': return html`<input class="pammy-input" type="date" min=${dayOf(item.earliest)} max=${dayOf(item.latest)} value=${dayOf(item.default)} aria-invalid=${invalid}>`;
      case 'time': return html`<input class="pammy-input" type="time" min=${item.earliest || ''} max=${item.latest || ''} step=${String((item.step || 1) * 60)} value=${str(item.default)} aria-invalid=${invalid}>`;
      case 'long-text': return html`<textarea class="pammy-input" rows=${item.rows || 5} maxlength=${item.maxLength || 5000} placeholder=${item.placeholder || ''} .value=${str(item.default)} aria-invalid=${invalid}></textarea>`;
      case 'number': {
        const has = (v: unknown) => v !== null && v !== undefined && v !== '';
        return html`<input class="pammy-input" type="number" inputmode=${item.decimals ? 'decimal' : 'numeric'} placeholder=${item.placeholder || ''} min=${has(item.min) ? String(item.min) : nothing} max=${has(item.max) ? String(item.max) : nothing} step=${item.decimals ? String(Number(`1e-${item.decimals}`)) : '1'} value=${has(item.default) ? String(item.default) : nothing} aria-invalid=${invalid}>`;
      }
      case 'dropdown': return html`<select class="pammy-input" aria-invalid=${invalid}><option value="">${item.placeholder || words.choose}</option>${(item.options || []).map((o) => html`<option value=${o} ?selected=${o === item.default}>${o}</option>`)}</select>`;
      case 'single-choice':
      case 'multiple-choice': {
        const many = item.type === 'multiple-choice';
        const type = many ? 'checkbox' : 'radio';
        let name = this.groupNames.get(item.key);
        if (!name) this.groupNames.set(item.key, name = `${item.key}-${Math.random().toString(36).slice(2, 8)}`);
        const picked = (o: string) => (many ? ((item.default as string[]) || []).includes(o) : item.default === o);
        // "Something else": ticking it goes to its words, typing there ticks it
        const other = item.other
          ? html`<label class="pammy-choice"><input type=${type} name=${name} value="" @change=${(e: Event) => { const t = e.currentTarget as HTMLInputElement; if (t.checked) (t.nextElementSibling as HTMLInputElement).focus(); }}><input class="pammy-input" type="text" maxlength="200" placeholder=${words.other} aria-label=${`${item.label}: ${words.other}`} @input=${(e: Event) => { const t = e.currentTarget as HTMLInputElement; if (t.value) (t.previousElementSibling as HTMLInputElement).checked = true; }}></label>`
          : nothing;
        return html`<div class="pammy-choices" data-columns=${String(item.columns || 1)} aria-invalid=${invalid}>${(item.options || []).map((o) => html`<label class="pammy-choice"><input type=${type} name=${name} value=${o} ?checked=${picked(o)}><span>${o}</span></label>`)}${other}</div>`;
      }
      case 'name':
      case 'address':
        return html`<div class="pammy-parts" data-columns=${item.type === 'name' ? '2' : '1'} aria-invalid=${invalid}>${partsOf(item).map(([p, label]) => html`<label class="pammy-part"><span>${label}</span><input class="pammy-input" type="text" maxlength=${p === 'postcode' ? 20 : 200} autocomplete=${AUTOCOMPLETE[p] || 'on'} value=${p === 'country' && item.defaultCountry ? item.defaultCountry : nothing}></label>`)}</div>`;
      case 'rating':
      case 'scale': {
        const stars = item.type === 'rating';
        const [from, to] = rangeOf(item);
        const value = this.picks.get(item.key) ?? null;
        const steps = Array.from({ length: to - from + 1 }, (_, i) => from + i);
        const choose = (n: number) => { this.picks = new Map(this.picks).set(item.key, value === n ? null : n); };
        const box = html`<div class=${stars ? 'pammy-stars' : 'pammy-scale'} role="radiogroup" aria-label=${item.label} aria-invalid=${item.lowLabel || item.highLabel ? nothing : invalid}>${steps.map((n) => html`<button type="button" class=${stars ? 'pammy-star' : 'pammy-step'} role="radio" aria-checked=${String(value !== null && (stars ? n <= value : n === value))} aria-label=${stars ? `${n} of ${to}` : String(n)} @click=${() => choose(n)}>${stars ? '★' : String(n)}</button>`)}</div>`;
        return item.lowLabel || item.highLabel
          ? html`<div aria-invalid=${invalid}>${box}<div class="pammy-ends"><span>${item.lowLabel || ''}</span><span>${item.highLabel || ''}</span></div></div>`
          : box;
      }
      default: return html``;
    }
  }

  // What's answered to one question, read from its inputs.
  private answerOf(item: Item, row: Element | undefined): Answer {
    if (item.type === 'hidden') return item.param ? new URLSearchParams(location.search).get(item.param) || '' : '';
    if (item.type === 'rating' || item.type === 'scale') return this.picks.get(item.key) ?? null;
    if (!row) return null;
    if (item.type === 'checkbox') return (row.querySelector('input') as HTMLInputElement).checked;
    if (item.type === 'single-choice' || item.type === 'multiple-choice') {
      const labels = [...row.querySelectorAll('.pammy-choice')];
      const ticks = labels.map((l) => l.firstElementChild as HTMLInputElement);
      const picked = ticks.filter((i) => i.checked).map((i) => i.value).filter((v) => v !== '');
      if (item.other) {
        const words = labels[labels.length - 1]!.querySelector('.pammy-input') as HTMLInputElement;
        if (ticks[ticks.length - 1]!.checked && words.value.trim()) picked.push(words.value.trim());
      }
      return item.type === 'multiple-choice' ? picked : picked[0] || '';
    }
    if (item.type === 'name' || item.type === 'address') {
      const inputs = [...row.querySelectorAll<HTMLInputElement>('.pammy-part input')];
      return Object.fromEntries(partsOf(item).map(([p], i) => [p, inputs[i]!.value.trim()]));
    }
    if (item.type === 'dropdown') return (row.querySelector('select') as HTMLSelectElement).value;
    return (row.querySelector('input, textarea') as HTMLInputElement).value.trim();
  }

  private async show(text: string, key: string | null = null) {
    this.message = text;
    this.invalid = key;
    if (!key) return;
    await this.updateComplete;
    const row = [...this.querySelectorAll<HTMLElement>('[data-key]')].find((r) => r.dataset.key === key);
    row?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
  }

  private sent(data: Form, text: string) {
    this.state = { kind: 'sent', data, text };
  }

  private async submitted(e: Event, data: Form) {
    e.preventDefault();
    void this.show('');
    const items = (data.items || []).filter((i) => !LAYOUT.includes(i.type) && KINDS.includes(i.type));
    const rows = new Map([...this.querySelectorAll<HTMLElement>('[data-key]')].map((r) => [r.dataset.key!, r]));
    const answers: Record<string, Answer> = {};
    for (const item of items) answers[item.key] = this.answerOf(item, rows.get(item.key));
    // the browser's own check first, one field at a time, in the server's words
    for (const item of items) {
      const problem = checkAnswer(item, answers[item.key]!);
      if (problem) return void this.show(problem, item.key);
    }
    if (this.previewing) return this.sent(data, data.sentText || 'Thank you.');
    this.busy = true;
    try {
      const comments = this.hasAttribute('comments');
      const res = await fetch(`/_pammy/${comments ? 'comments' : 'forms'}/${encodeURIComponent(data.name)}`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page: location.pathname, answers, website: (this.querySelector('[name="pf-leave-this-empty"]') as HTMLInputElement).value,
          ...(comments ? { content: this.getAttribute('content-id') || '' } : {}),
        }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) return void this.show(r.message || 'Something went wrong. Please try again.', r.field ?? null);
      this.dispatchEvent(new CustomEvent('pammy-sent', { bubbles: true, detail: { waiting: r.waiting === true } }));
      const go = this.thanksUrl();
      if (go) location.assign(go);
      else this.sent(data, this.getAttribute('sent-text') || data.sentText || 'Thank you. Your answers have been sent.');
    } catch {
      void this.show("That couldn't be sent. Check your connection and try again.");
    } finally {
      this.busy = false;
    }
  }

  // thanks="thank-you.html" works like a link on the page. Another website is ignored.
  private thanksUrl(): string | null {
    const thanks = this.getAttribute('thanks');
    if (!thanks) return null;
    try {
      const url = new URL(thanks, location.href);
      return url.origin === location.origin ? url.href : null;
    } catch {
      return null;
    }
  }
}

// The same checks the gate makes, so people are told before anything is sent.
function checkAnswer(item: Item, value: Answer): string | null {
  const label = item.label;
  if (item.type === 'checkbox') return item.required && value !== true ? `Please tick "${label}".` : null;
  if (isBlank(value)) {
    if (!item.required) return null;
    if (item.type === 'dropdown' || item.type === 'single-choice' || item.type === 'rating' || item.type === 'scale') return `Please choose an answer for "${label}".`;
    if (item.type === 'multiple-choice') return `Please choose at least one answer for "${label}".`;
    if (item.type === 'date') return `Please choose a date for "${label}".`;
    if (item.type === 'time') return `Please choose a time for "${label}".`;
    return `Please fill in "${label}".`;
  }
  const s = typeof value === 'string' ? value : '';
  if (item.type === 'email' && !/^[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[^\s@<>"'(),;:]+$/.test(s)) return `"${label}" doesn't look like an email address.`;
  if (item.type === 'phone' && (s.replace(/[^0-9]/g, '').length < 5)) return `"${label}" doesn't look like a phone number.`;
  if ((item.type === 'short-text' || item.type === 'long-text') && item.minLength && [...s].length < item.minLength) {
    return `"${label}" needs at least ${item.minLength} characters.`;
  }
  if (item.type === 'multiple-choice' && Array.isArray(value)) {
    if (item.minPicks && value.length < item.minPicks) return `Please choose at least ${item.minPicks} answers for "${label}".`;
    if (item.maxPicks && value.length > item.maxPicks) return `Please choose at most ${item.maxPicks} answers for "${label}".`;
  }
  if ((item.type === 'name' || item.type === 'address') && item.required) {
    const parts = value as Record<string, string>;
    const must = item.type === 'name' ? ['first', 'last'] : ['line1', 'town'];
    if (must.some((p) => !parts[p])) {
      return item.type === 'name' ? `Please fill in both first and last name for "${label}".`
        : `Please fill in at least the first line and town for "${label}".`;
    }
  }
  return null;
}

if (!customElements.get('pammy-form')) customElements.define('pammy-form', PammyForm);
