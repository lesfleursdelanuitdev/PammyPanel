// What the pammy.org components share (login.ts, forms.ts). Built into
// public-gate/login.js and public-gate/forms.js by sites/pammy/widgets/vite.config.ts, each a single
// script with its own copy of Lit, so her pages need nothing but the one tag.
//
// Everything renders into the element itself, never a shadow root: her own CSS
// has to reach every part, by the class names her guides list (09, 10).
import { html, LitElement, nothing, type PropertyDeclarations } from 'lit';

// Every rule of the built-in look is inside :where() and has no weight at all, so
// her own CSS always wins. Put first in <head>, so even equally weak rules of hers
// come later and win.
export function addStyle(id: string, css: string) {
  if (document.getElementById(id)) return;
  const s = document.createElement('style');
  s.id = id;
  s.textContent = css;
  document.head.prepend(s);
}

// Wording attributes, as reactive properties, so each is used as she wrote it
// and a change to one shows at once. Property and attribute have the same name.
export const words = (...names: string[]): PropertyDeclarations =>
  Object.fromEntries(names.map((n) => [n, { type: String }]));

export class PammyElement extends LitElement {
  // pammy-box always; pammy-styled unless styles="off"
  private started = false;

  protected override createRenderRoot() { return this; }

  override connectedCallback() {
    if (!this.started) {
      this.started = true;
      this.classList.add('pammy-box');
      if (this.getAttribute('styles') !== 'off') this.classList.add('pammy-styled');
      this.addStyle();
      this.adopt();
      this.replaceChildren();          // what was written inside goes; Lit renders in its place
      this.start();
    }
    super.connectedCallback();
  }

  protected addStyle() {}
  // before what's inside is cleared: keep any of it that's needed (forms.ts: her thank-you)
  protected adopt() {}
  // once, the first time it's on the page: fetch what it needs
  protected start() {}

  // An attribute's words, or the built-in ones.
  protected text(name: string, fallback: string): string {
    return (this as unknown as Record<string, string | null | undefined>)[name] || fallback;
  }
}

// Robots fill in every field; people never see this one. Inline style, so no
// page style can show it.
export const trap = (name: string) =>
  html`<div style="position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden" aria-hidden="true"><label>Leave this empty<input name=${name} tabindex="-1" autocomplete="off"></label></div>`;

export const maybe = <T>(value: T | null | undefined | false | '', f: (v: T) => unknown) => (value ? f(value) : nothing);
