// pammy.org sign-in components, served at /_pammy/login.js on every pammy.org
// address. Each goes on its own page inside a protected folder:
//
//   login.html           <pammy-login></pammy-login>       sign in
//   login-forgot.html    <pammy-forgot></pammy-forgot>     "I forgot my password"
//   login-invite.html    <pammy-invite></pammy-invite>     choose a password with a setup link
//   login-request.html   <pammy-request></pammy-request>   ask for access
//   logout.html          <pammy-signed-out></pammy-signed-out>   signs out on arrival, "you're signed out"
//
// with  <script src="/_pammy/login.js" defer></script>  on the same page.
// On protected pages, a sign-out button:  <pammy-logout></pammy-logout>
// (it signs out and goes to the folder's logout.html). A plain link to
// logout.html signs out too.
//
// Her guide (09-protected-folders.txt, "Changing the words" and "Changing the
// look") is the reference for everything below; keep them in step.
//
// Wording, with attributes:
//   <pammy-login>    heading, button, username-label, password-label, forgot-text, request-text, links="off"
//                    (accounts="open": the gate's page for a route open with accounts; adds register-text)
//   <pammy-forgot>   heading, intro, username-label, message-label, message-hint, button, done, back-text
//   <pammy-invite>   heading, new-heading, password-label, password-hint, again-label, button
//   <pammy-request>  heading, intro, name-label, contact-label, contact-hint, message-label, message-hint,
//                    button, done, back-text, closed-text
//   <pammy-signed-out> heading, intro, signin-text, working-text
//   <pammy-welcome>  heading
//   <pammy-logout>   button
//
// Accounts people make themselves (docs/accounts-plan.md step 4), each shown only
// while the site's owners have switched it on (/_pammy/accounts says which). The
// gate has a built-in page for each (/_pammy/register, confirm, reset, account):
//   <pammy-register> heading, intro, done, signin-text
//   <pammy-confirm>  heading
//   <pammy-reset>    heading
//   <pammy-account>  heading
// and <pammy-login> gains register-text (outside a folder: registering opens no folder).
//
// The look: the built-in styles are as weak as CSS allows (inside :where()), so
// any rule on her page wins. styles="off" leaves them out entirely. Class names
// (the same in forms.js): pammy-box, pammy-form, pammy-heading, pammy-intro,
// pammy-note, pammy-field, pammy-field-<name>, pammy-label, pammy-hint,
// pammy-optional, pammy-input, pammy-button, pammy-link, pammy-message,
// pammy-done, pammy-links, pammy-list.
// Settings: --pammy-accent --pammy-accent-text --pammy-radius --pammy-font
//   --pammy-width --pammy-gap --pammy-field-bg --pammy-field-border --pammy-error --pammy-success
//
// Previews: on the example looks (/_pammy/examples/<look>/<page>, 09-protected-folders.txt
// PART 9 to 11) nothing is sent anywhere. The forms act out what they'd do, and a
// small bar goes between the five pages.
//
// Written with Lit (packages/areas/widgets/login.ts); public-gate/login.js is built from it.
import { html, nothing, render, type PropertyDeclarations, type TemplateResult } from 'lit';
import { addStyle, maybe, PammyElement, trap, words } from '@panel/core/widgets/base.ts';

const PREVIEW = /^\/_pammy\/examples\/[a-z]+\/[a-z-]+\.html$/.test(location.pathname);

// [hidden] stays hidden whatever she sets.
const STYLE = `
:where(.pammy-box) [hidden] { display: none !important; }
:where(.pammy-styled) { display: block; max-width: var(--pammy-width, 24rem); font-family: var(--pammy-font, inherit); }
:where(.pammy-styled .pammy-form) { display: grid; gap: var(--pammy-gap, 0.75rem); }
:where(pammy-logout.pammy-styled) { display: inline-block; }
:where(.pammy-styled .pammy-heading) { margin: 0 0 0.25rem; font-size: 1.5rem; }
:where(.pammy-styled .pammy-field) { display: grid; gap: 0.25rem; font-weight: 600; font-size: 0.95rem; }
:where(.pammy-styled .pammy-input) {
  font: inherit; font-weight: 400; padding: 0.6rem 0.75rem; border-radius: var(--pammy-radius, 8px);
  border: 1px solid var(--pammy-field-border, color-mix(in srgb, currentColor 30%, transparent));
  background: var(--pammy-field-bg, transparent); color: inherit;
}
:where(.pammy-styled textarea.pammy-input) { min-height: 5rem; resize: vertical; }
:where(.pammy-styled .pammy-input:focus) { outline: 2px solid var(--pammy-accent, #7a4b8c); outline-offset: 1px; }
:where(.pammy-styled .pammy-button) {
  font: inherit; font-weight: 600; cursor: pointer; padding: 0.65rem 1rem; border: 0;
  border-radius: var(--pammy-radius, 8px); background: var(--pammy-accent, #7a4b8c); color: var(--pammy-accent-text, #fff);
}
:where(.pammy-styled .pammy-button:disabled) { opacity: 0.6; cursor: default; }
:where(.pammy-styled .pammy-message) { margin: 0; padding: 0.6rem 0.75rem; border-radius: var(--pammy-radius, 8px); font-size: 0.95rem;
  background: color-mix(in srgb, var(--pammy-error, #c0392b) 12%, transparent); color: inherit; }
:where(.pammy-styled .pammy-done) { margin: 0; padding: 0.75rem; border-radius: var(--pammy-radius, 8px);
  background: color-mix(in srgb, var(--pammy-success, #2e7d32) 12%, transparent); }
:where(.pammy-styled .pammy-note, .pammy-styled .pammy-intro, .pammy-styled .pammy-hint) { margin: 0; font-size: 0.9rem; opacity: 0.8; }
:where(.pammy-styled .pammy-hint) { font-weight: 400; }
:where(.pammy-styled .pammy-links) { margin: 0.25rem 0 0; font-size: 0.95rem; display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; }
:where(.pammy-styled a) { color: inherit; }
:where(.pammy-styled .pammy-link) { background: none; border: 0; color: inherit; padding: 0; font: inherit; text-decoration: underline; cursor: pointer; }
`;

class RequestError extends Error {
  status?: number;
}

async function post<T = Record<string, unknown>>(path: string, body: object): Promise<T> {
  if (PREVIEW) return previewPost(path) as Promise<T>;
  const res = await fetch(path, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  let data: { message?: string } = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const err = new RequestError(data.message || 'Something went wrong. Please try again.');
    err.status = res.status;
    throw err;
  }
  return data as T;
}

// What a preview's forms answer: a sign-in "fails" (to show how problems look), the
// setup link belongs to a made-up auntie.jo, requests say thanks.
async function previewPost(path: string): Promise<unknown> {
  await new Promise((resolve) => { setTimeout(resolve, 350); });
  if (path === '/_pammy/login') throw new Error("That username and password don't match. (This is a preview, so nobody can sign in here.)");
  if (path === '/_pammy/invite/check') return { username: 'auntie.jo', firstPassword: true };
  if (path === '/_pammy/invite') throw new Error('This is a preview, so no password was saved.');
  return { ok: true };
}

const PREVIEW_PAGES = [['login.html', 'Sign in'], ['login-forgot.html', 'Forgot password'], ['login-invite.html', 'Choose a password'],
  ['login-request.html', 'Ask for access'], ['logout.html', 'Signed out']] as const;

function previewBar() {
  if (!document.body || document.getElementById('pammy-preview-bar')) return;
  const here = location.pathname.split('/').pop();
  const bar = document.createElement('nav');
  bar.id = 'pammy-preview-bar';
  bar.setAttribute('aria-label', 'The example pages');
  render(html`<strong>Preview:</strong>${PREVIEW_PAGES.map(([file, label]) => (file === here
    ? html`<span aria-current="page">${label}</span>`
    : html`<a href=${file}>${label}</a>`))}`, bar);
  Object.assign(bar.style, {
    position: 'fixed', left: '50%', bottom: '10px', transform: 'translateX(-50%)', zIndex: '2147483647',
    display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '2px 12px', width: 'max-content', maxWidth: 'calc(100vw - 20px)',
    boxSizing: 'border-box', padding: '6px 14px', borderRadius: '16px', background: 'rgba(24, 20, 28, 0.85)', color: '#fff',
    font: '13px/1.5 system-ui, sans-serif', boxShadow: '0 4px 16px rgba(0, 0, 0, 0.25)',
  });
  for (const a of bar.querySelectorAll('a')) Object.assign(a.style, { color: '#fff', opacity: '0.8' });
  for (const s of bar.querySelectorAll('span')) s.style.textDecoration = 'underline';
  document.body.append(bar);
  // room for the bar under the page's last button
  document.body.style.paddingBottom = `calc(${getComputedStyle(document.body).paddingBottom} + ${bar.offsetHeight + 16}px)`;
}

type Me = { signedIn: boolean; username?: string; email?: string | null; emailConfirmed?: boolean; registered?: boolean };
// What the site's owners have switched on (docs/accounts-plan.md A5); null: nothing
// (a site without accounts, or a preview).
type Accounts = { register: boolean; emailedLinks: boolean; changePassword: boolean; deleteAccount: boolean };
let accountsAsked: Promise<Accounts | null> | null = null;
function accounts(): Promise<Accounts | null> {
  if (PREVIEW) return Promise.resolve(null);
  accountsAsked ??= fetch('/_pammy/accounts', { credentials: 'same-origin' })
    .then((res) => (res.ok ? res.json() as Promise<Accounts> : null)).catch(() => null);
  return accountsAsked;
}
type About = { requestsOpen: boolean; pages: { login: string; forgot: string; request: string; logout: string } };

async function whoAmI(): Promise<Me> {
  if (PREVIEW) return { signedIn: false };
  try {
    const res = await fetch('/_pammy/me', { credentials: 'same-origin' });
    return res.ok ? await res.json() : { signedIn: false };
  } catch {
    return { signedIn: false };
  }
}

// Which folder this page belongs to: a built-in page names it (area=...),
// her own pages are found by their address.
function folderOf(host: Element): Record<string, string> {
  const area = host.getAttribute('area') || '';
  return area ? { area } : { page: location.pathname };
}

async function about(host: Element): Promise<About | null> {
  if (PREVIEW) return { requestsOpen: true, pages: { login: 'login.html', forgot: 'login-forgot.html', request: 'login-request.html', logout: 'logout.html' } };
  try {
    const res = await fetch(`/_pammy/about?${new URLSearchParams(folderOf(host))}`, { credentials: 'same-origin' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// Sign out, then on to the folder's signed-out page (logout.html, or the built-in one).
async function signOut(host: Element) {
  const r = await post<{ next?: string }>('/_pammy/logout', folderOf(host)).catch(() => null);
  if (r && r.next) location.assign(r.next);
  else location.reload();
}

// No white space between the parts: none showed before, and without her styles it would.
const field = (name: string, label: string, control: TemplateResult, hint?: string) =>
  html`<label class="pammy-field pammy-field-${name}"><span class="pammy-label">${label}</span>${control}${maybe(hint, (h) => html`<span class="pammy-hint">${h}</span>`)}</label>`;
const linkTo = (href: string, text: string) => html`<a href=${href}>${text}</a>`;
const heading = (text: string) => html`<h2 class="pammy-heading">${text}</h2>`;
const note = (text: unknown) => html`<p class="pammy-note">${text}</p>`;
const alert = (text: string) => html`<p class="pammy-message" role="alert">${text}</p>`;

// A sign-out button that stays pressed while it works.
const signOutButton = (host: PammyElement, text: string, className: string) =>
  html`<button class=${className} type="button" @click=${(e: Event) => { (e.currentTarget as HTMLButtonElement).disabled = true; void signOut(host); }}>${text}</button>`;

class Base extends PammyElement {
  protected override addStyle() { addStyle('pammy-login-style', STYLE); }
}

// The common shape: heading, optional intro, fields, button, error message.
class Box extends Base {
  static override properties: PropertyDeclarations = { message: { state: true }, busy: { state: true } };
  declare message: string;
  declare busy: boolean;

  constructor() {
    super();
    this.message = '';
    this.busy = false;
  }

  protected value(name: string): string {
    return (this.querySelector(`[name="${name}"]`) as HTMLInputElement | null)?.value ?? '';
  }

  protected form(title: string, intro: string | null, fields: unknown, buttonText: string, afterHeading: unknown = nothing) {
    return html`<form class="pammy-form" @submit=${this.submitted}>${heading(title)}${afterHeading}${maybe(intro, (i) => html`<p class="pammy-intro">${i}</p>`)}${fields}<button class="pammy-button" type="submit" ?disabled=${this.busy}>${buttonText}</button><p class="pammy-message" ?hidden=${!this.message} role="alert">${this.message}</p></form>`;
  }

  private submitted = async (e: Event) => {
    e.preventDefault();
    this.message = '';
    this.busy = true;
    try {
      await this.send();
    } catch (err) {
      this.message = (err as Error).message;
    } finally {
      this.busy = false;
    }
  };

  protected async send() {}

  protected finished(text: string, links: unknown) {
    return html`<p class="pammy-done" role="status">${text}</p>${links}`;
  }
}

// ---------------------------------------------------------------- sign in
class PammyLogin extends Box {
  static override properties = {
    ...words('heading', 'button', 'username-label', 'password-label', 'forgot-text', 'request-text', 'links'),
    'register-text': { type: String },
    me: { state: true }, info: { state: true }, acc: { state: true },
  };
  declare me: Me | null;
  declare info: About | null;
  declare acc: Accounts | null;
  private params = new URLSearchParams(location.search);

  protected override start() {
    void whoAmI().then((me) => { if (me.signedIn) this.me = me; });
    void accounts().then((a) => { this.acc = a; });
    if (this.getAttribute('links') !== 'off') void about(this).then((info) => { this.info = info; });
  }

  // Outside a folder (the site's own sign-in, with accounts on): registering and
  // an emailed link, where they're switched on.
  private siteLinks() {
    const a = this.acc;
    if (!a || this.getAttribute('links') === 'off') return nothing;
    const next = this.params.get('next');
    const register = a.register ? linkTo(`/_pammy/register${next ? `?${new URLSearchParams({ next })}` : ''}`, this.text('register-text', 'Make an account')) : nothing;
    // a route open with accounts (the gate's built-in page says accounts="open"):
    // anyone may use it, so anyone may make an account there too
    if (this.getAttribute('accounts') === 'open') return register;
    if (this.getAttribute('area') || this.info) return nothing;
    return html`${a.emailedLinks ? linkTo('/_pammy/forgot', this.text('forgot-text', 'Forgot your password?')) : nothing}${register}`;
  }

  override render() {
    const me = this.me;
    const signedInNote = html`<p class="pammy-note" ?hidden=${!me}>${me ? html`${this.params.get('denied')
      ? `You're signed in as ${me.username}, but that account can't open this folder. Sign in with a different account, or `
      : `You're signed in as ${me.username}. `}${signOutButton(this, 'sign out', 'pammy-link')}.` : nothing}</p>`;
    const info = this.getAttribute('links') !== 'off' ? this.info : null;
    return html`${this.form(this.text('heading', 'Sign in'), null,
      html`${field('username', this.text('username-label', this.acc?.emailedLinks ? 'Username or email' : 'Username'), html`<input class="pammy-input" name="username" autocomplete="username" required autocapitalize="none" spellcheck="false">`)}${field('password', this.text('password-label', 'Password'), html`<input class="pammy-input" name="password" type="password" autocomplete="current-password" required>`)}`,
      this.text('button', 'Sign in'), signedInNote)}<p class="pammy-links">${maybe(info, (i) => html`${linkTo(i.pages.forgot, this.text('forgot-text', 'Forgot your password?'))}${i.requestsOpen ? linkTo(i.pages.request, this.text('request-text', 'Ask for access')) : nothing}`)}${this.siteLinks()}</p>`;
  }

  protected override async send() {
    try {
      const r = await post<{ next?: string }>('/_pammy/login', {
        username: this.value('username'), password: this.value('password'), ...folderOf(this), next: this.params.get('next') || '',
      });
      location.assign(r.next || './');
    } catch (err) {
      (this.querySelector('[name="password"]') as HTMLInputElement | null)?.select();
      throw err;
    }
  }
}

// ---------------------------------------------------------------- forgot password
class PammyForgot extends Box {
  static override properties = {
    ...words('heading', 'intro', 'username-label', 'message-label', 'message-hint', 'button', 'done', 'back-text'),
    sent: { state: true }, info: { state: true }, acc: { state: true },
  };
  declare sent: boolean;
  declare info: About | null;
  declare acc: Accounts | null;

  protected override start() {
    void accounts().then((a) => { this.acc = a; });
  }

  override render() {
    // Emailed links on (docs/accounts-plan.md step 4): a link to the account's
    // own address, straight away. Off: a request the owner passes on by hand.
    const emailed = !!this.acc?.emailedLinks;
    const back = html`<p class="pammy-links">${this.info ? linkTo(this.info.pages.login, this.text('back-text', 'Back to sign in')) : emailed && !this.getAttribute('area') ? linkTo('/_pammy/login', this.text('back-text', 'Back to sign in')) : nothing}</p>`;
    if (this.sent) {
      return this.finished(this.text('done', emailed
        ? "If that account has an email address, a link to choose a new password is on its way to it. The link works for an hour."
        : "Thanks, that's been passed on. You'll be sent a link to choose a new password. It isn't automatic, so it may take a little while."), back);
    }
    if (emailed) {
      return this.form(this.text('heading', 'Forgot your password?'),
        this.text('intro', "Type your username or email address. We'll email the account a link to choose a new password."),
        field('username', this.text('username-label', 'Username or email'), html`<input class="pammy-input" name="username" autocomplete="username" required autocapitalize="none" spellcheck="false">`),
        this.text('button', 'Send me a link'));
    }
    return this.form(this.text('heading', 'Forgot your password?'),
      this.text('intro', "Type your username and we'll pass it on. You'll be sent a link to choose a new password."),
      html`${field('username', this.text('username-label', 'Username'), html`<input class="pammy-input" name="username" autocomplete="username" required autocapitalize="none" spellcheck="false">`)}${field('message', this.text('message-label', 'Anything else? (optional)'), html`<textarea class="pammy-input" name="message" maxlength="1000"></textarea>`, this.text('message-hint', 'For example, the best way to reach you.'))}`,
      this.text('button', 'Send'));
  }

  protected override async send() {
    if (this.acc?.emailedLinks) await post('/_pammy/reset-link', { login: this.value('username'), ...folderOf(this) });
    else await post('/_pammy/forgot', { username: this.value('username'), message: this.value('message'), ...folderOf(this) });
    this.sent = true;
    void about(this).then((info) => { this.info = info; });
  }
}

// ---------------------------------------------------------------- choose a password with a setup link
// The link's secret is after the # (never sent to the server by the browser on
// its own). It's taken out of the address bar straight away, and kept for this
// tab only, so reloading the page still works.
// key: each kind of link its own (setup, confirm, reset), so one tab's never stands in for another's.
function takeLinkToken(key = 'pammy-setup-link'): string {
  if (PREVIEW) return 'preview';
  const fromUrl = location.hash.slice(1);
  let token = /^[A-Za-z0-9_-]{43}$/.test(fromUrl) ? fromUrl : '';
  try {
    if (token) sessionStorage.setItem(key, token);
    else token = sessionStorage.getItem(key) || '';
  } catch { /* storage blocked: the hash is all we have */ }
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  return token;
}
const forgetLinkToken = (key = 'pammy-setup-link') => { try { sessionStorage.removeItem(key); } catch { /* ignore */ } };

type Invite = { username: string; firstPassword: boolean };

class PammyInvite extends Box {
  static override properties = {
    ...words('heading', 'new-heading', 'password-label', 'password-hint', 'again-label', 'button'),
    state: { state: true },
  };
  // checking the link; the link is fine; a problem (no link, a bad one, used up)
  declare state: { kind: 'checking' } | { kind: 'ready'; info: Invite } | { kind: 'problem'; text: string };
  private token = '';

  protected override start() {
    this.token = takeLinkToken();
    if (!this.token) {
      this.state = { kind: 'problem', text: 'This page needs the link you were sent. Open that link again, or ask for a new one.' };
      return;
    }
    this.state = { kind: 'checking' };
    post<Invite>('/_pammy/invite/check', { token: this.token })
      .then((info) => { this.state = { kind: 'ready', info }; })
      .catch((err: Error) => {
        forgetLinkToken();
        this.state = { kind: 'problem', text: err.message };
      });
  }

  override render() {
    const title = this.text('heading', 'Choose your password');
    const s = this.state;
    if (s.kind === 'checking') return html`${heading(title)}${note('Checking your link...')}`;
    if (s.kind === 'problem') return html`${heading(title)}${alert(s.text)}`;
    const { info } = s;
    return this.form(info.firstPassword ? title : this.text('new-heading', 'Choose a new password'), null,
      html`<input name="username" autocomplete="username" .value=${info.username} readonly hidden>${field('password', this.text('password-label', info.firstPassword ? 'Password' : 'New password'), html`<input class="pammy-input" name="password" type="password" autocomplete="new-password" required minlength="10">`, this.text('password-hint', 'At least 10 characters.'))}${field('again', this.text('again-label', 'Type it again'), html`<input class="pammy-input" name="again" type="password" autocomplete="new-password" required>`)}`,
      this.text('button', 'Save password'),
      note(html`Your username is <strong>${info.username}</strong>${info.firstPassword ? ". You'll need it, with the password you choose here, to sign in." : '.'}`));
  }

  protected override async send() {
    if (this.value('password') !== this.value('again')) throw new Error("The two passwords don't match.");
    try {
      const r = await post<{ next?: string }>('/_pammy/invite', { token: this.token, password: this.value('password') });
      forgetLinkToken();
      location.assign(r.next || '/');
    } catch (err) {
      if ((err as RequestError).status === 410) this.state = { kind: 'problem', text: (err as Error).message };
      throw err;
    }
  }
}

// ---------------------------------------------------------------- make an account
// docs/accounts-plan.md step 4: the same answer whether or not the address has an
// account already (that address gets a note instead); a taken username is said.
class PammyRegister extends Box {
  static override properties = { ...words('heading', 'intro', 'done', 'signin-text'), sent: { state: true } };
  declare sent: string;
  private params = new URLSearchParams(location.search);

  private signIn() {
    const next = this.params.get('next');
    return html`<p class="pammy-links">${linkTo(`/_pammy/login${next ? `?${new URLSearchParams({ next })}` : ''}`, this.text('signin-text', 'I have an account: sign in'))}</p>`;
  }

  override render() {
    if (this.sent) {
      return this.finished(this.text('done', `Check your email: a link is on its way to ${this.sent}. Open it within 24 hours to finish making your account.`), this.signIn());
    }
    return html`${this.form(this.text('heading', 'Make an account'), this.text('intro', "We'll email you a link to confirm your address."),
      html`${field('username', 'Username', html`<input class="pammy-input" name="username" autocomplete="username" required autocapitalize="none" spellcheck="false" minlength="2" maxlength="64">`, 'What you sign in with. Others may see it.')}${field('email', 'Email address', html`<input class="pammy-input" name="email" type="email" autocomplete="email" required maxlength="254">`)}${field('password', 'Password', html`<input class="pammy-input" name="password" type="password" autocomplete="new-password" required minlength="10">`, 'At least 10 characters.')}${field('again', 'Type it again', html`<input class="pammy-input" name="again" type="password" autocomplete="new-password" required>`)}${trap('pr-leave-this-empty')}`,
      'Make my account')}${this.signIn()}`;
  }

  protected override async send() {
    if (this.value('password') !== this.value('again')) throw new Error("The two passwords don't match.");
    const email = this.value('email').trim();
    await post('/_pammy/register', { username: this.value('username'), email, password: this.value('password'), website: this.value('pr-leave-this-empty') });
    this.sent = email;
  }
}

// ---------------------------------------------------------------- confirm an address (from the email)
// Opening the page confirms: the link's secret is after the #, and a mail program
// that looks at links first (without running this) confirms nothing.
const CONFIRM_KEY = 'pammy-confirm-link';
class PammyConfirm extends Base {
  static override properties = { ...words('heading'), state: { state: true } };
  declare state: { kind: 'working' } | { kind: 'done'; username: string; changed: boolean; next: string } | { kind: 'problem'; text: string };

  constructor() {
    super();
    this.state = { kind: 'working' };
  }

  protected override start() {
    const token = takeLinkToken(CONFIRM_KEY);
    if (!token) {
      this.state = { kind: 'problem', text: 'This page needs the link you were emailed. Open that link again.' };
      return;
    }
    const next = new URLSearchParams(location.search).get('next') || '';
    post<{ username: string; changed: boolean; next?: string }>('/_pammy/confirm', { token, next })
      .then((r) => { forgetLinkToken(CONFIRM_KEY); this.state = { kind: 'done', username: r.username, changed: r.changed, next: r.next || '/' }; })
      .catch((err: Error) => { forgetLinkToken(CONFIRM_KEY); this.state = { kind: 'problem', text: err.message }; });
  }

  override render() {
    const s = this.state;
    const title = this.text('heading', 'Confirm your email address');
    if (s.kind === 'working') return html`${heading(title)}${note('Confirming...')}`;
    if (s.kind === 'problem') return html`${heading(title)}${alert(s.text)}`;
    return html`${heading(s.changed ? 'Your new address is confirmed' : 'Your address is confirmed')}<p class="pammy-done" role="status">${s.changed
      ? `Your account now uses it. You're signed in as ${s.username}.`
      : `Your account is ready, and you're signed in as ${s.username}.`}</p><p class="pammy-links">${linkTo(s.next, 'Carry on')}</p>`;
  }
}

// ---------------------------------------------------------------- a new password, with an emailed link
const RESET_KEY = 'pammy-reset-link';
class PammyReset extends Box {
  static override properties = { ...words('heading'), state: { state: true } };
  declare state: { kind: 'checking' } | { kind: 'ready'; username: string } | { kind: 'problem'; text: string };
  private token = '';

  protected override start() {
    this.token = takeLinkToken(RESET_KEY);
    if (!this.token) {
      this.state = { kind: 'problem', text: 'This page needs the link you were emailed. Open that link again, or ask for a new one.' };
      return;
    }
    this.state = { kind: 'checking' };
    post<{ username: string }>('/_pammy/reset/check', { token: this.token })
      .then((r) => { this.state = { kind: 'ready', username: r.username }; })
      .catch((err: Error) => { forgetLinkToken(RESET_KEY); this.state = { kind: 'problem', text: err.message }; });
  }

  override render() {
    const title = this.text('heading', 'Choose a new password');
    const s = this.state;
    if (s.kind === 'checking') return html`${heading(title)}${note('Checking your link...')}`;
    if (s.kind === 'problem') return html`${heading(title)}${alert(s.text)}<p class="pammy-links">${linkTo('/_pammy/forgot', 'Ask for a new link')}</p>`;
    return this.form(title, null,
      html`<input name="username" autocomplete="username" .value=${s.username} readonly hidden>${field('password', 'New password', html`<input class="pammy-input" name="password" type="password" autocomplete="new-password" required minlength="10">`, 'At least 10 characters.')}${field('again', 'Type it again', html`<input class="pammy-input" name="again" type="password" autocomplete="new-password" required>`)}`,
      'Save password', note(html`For the account <strong>${s.username}</strong>. You'll be signed out everywhere else.`));
  }

  protected override async send() {
    if (this.value('password') !== this.value('again')) throw new Error("The two passwords don't match.");
    try {
      const r = await post<{ next?: string }>('/_pammy/reset', { token: this.token, password: this.value('password') });
      forgetLinkToken(RESET_KEY);
      location.assign(r.next || '/');
    } catch (err) {
      if ((err as RequestError).status === 410) this.state = { kind: 'problem', text: (err as Error).message };
      throw err;
    }
  }
}

// ---------------------------------------------------------------- your account
// Each part shows only while it's switched on. Every change asks for the password.
type Part = { busy: boolean; message: string; done: string };
class PammyAccount extends Base {
  static override properties = { ...words('heading'), me: { state: true }, acc: { state: true }, parts: { state: true } };
  declare me: Me | null;
  declare acc: Accounts | null;
  declare parts: Record<string, Part>;

  constructor() {
    super();
    this.me = null;
    this.acc = null;
    this.parts = {};
  }

  protected override start() {
    void Promise.all([whoAmI(), accounts()]).then(([me, acc]) => { this.me = me; this.acc = acc; });
  }

  private partOf(name: string): Part { return this.parts[name] ?? { busy: false, message: '', done: '' }; }
  private set(name: string, p: Partial<Part>) { this.parts = { ...this.parts, [name]: { ...this.partOf(name), ...p } }; }

  // One of the page's forms: its own fields, button, message and "done".
  private section(name: string, title: string, fields: unknown, button: string, send: (f: HTMLFormElement) => Promise<string | void>, danger = false) {
    const p = this.partOf(name);
    const submit = async (e: Event) => {
      e.preventDefault();
      const f = e.currentTarget as HTMLFormElement;
      this.set(name, { busy: true, message: '', done: '' });
      try {
        const done = await send(f);
        f.reset();
        this.set(name, { busy: false, done: done || '' });
      } catch (err) {
        this.set(name, { busy: false, message: (err as Error).message });
      }
    };
    return html`<form class="pammy-form pammy-account-${name}" @submit=${submit}><h3 class="pammy-heading">${title}</h3>${fields}<button class="pammy-button${danger ? ' pammy-danger' : ''}" type="submit" ?disabled=${p.busy}>${button}</button><p class="pammy-message" ?hidden=${!p.message} role="alert">${p.message}</p><p class="pammy-done" ?hidden=${!p.done} role="status">${p.done}</p></form>`;
  }

  override render() {
    const title = this.text('heading', 'Your account');
    const me = this.me, a = this.acc;
    if (!me) return html`${heading(title)}${note('Loading...')}`;
    if (!me.signedIn) {
      return html`${heading(title)}${note("You're not signed in.")}<p class="pammy-links">${linkTo(`/_pammy/login?${new URLSearchParams({ next: '/_pammy/account' })}`, 'Sign in')}</p>`;
    }
    const val = (f: HTMLFormElement, n: string) => (f.elements.namedItem(n) as HTMLInputElement | null)?.value ?? '';
    const pw = (name: string, label: string, auto = 'current-password') => field(name, label, html`<input class="pammy-input" name=${name} type="password" autocomplete=${auto} required>`);
    return html`${heading(title)}<p class="pammy-intro">Signed in as <strong>${me.username}</strong>${me.email ? html`, with the email address <strong>${me.email}</strong>${me.emailConfirmed ? '' : ' (not confirmed yet)'}` : ''}.</p>${a?.changePassword ? this.section('password', 'Change your password',
      html`${pw('current', 'Your password now')}${field('password', 'New password', html`<input class="pammy-input" name="password" type="password" autocomplete="new-password" required minlength="10">`, 'At least 10 characters.')}${pw('again', 'Type it again', 'new-password')}`,
      'Change password', async (f) => {
        if (val(f, 'password') !== val(f, 'again')) throw new Error("The two new passwords don't match.");
        await post('/_pammy/account/password', { current: val(f, 'current'), password: val(f, 'password') });
        return "Your password is changed. You're signed out everywhere else.";
      }) : nothing}${a?.emailedLinks ? this.section('email', me.email ? 'Change your email address' : 'Add an email address',
      html`${field('email', 'New email address', html`<input class="pammy-input" name="email" type="email" autocomplete="email" required maxlength="254">`)}${pw('password', 'Your password')}`,
      'Send a confirmation link', async (f) => {
        const email = val(f, 'email').trim();
        await post('/_pammy/account/email', { email, password: val(f, 'password') });
        return `If that address can be used, a link is on its way to ${email}. Your address changes once you open it.`;
      }) : nothing}${this.section('signout', 'Sign out everywhere', note('Every browser signed in to this account, this one too.'), 'Sign out everywhere', async () => {
        const r = await post<{ next?: string }>('/_pammy/account/signout', {});
        location.assign(r.next || '/');
      })}${a?.deleteAccount ? this.section('delete', 'Delete your account',
      html`${note("This can't be undone. Your account goes, and with it what this site keeps about you.")}${pw('password', 'Your password')}`,
      'Delete my account', async (f) => {
        const r = await post<{ next?: string }>('/_pammy/account/delete', { password: val(f, 'password') });
        location.assign(r.next || '/');
      }, true) : nothing}<p class="pammy-links">${signOutButton(this, 'Sign out', 'pammy-link')}</p>`;
  }
}

// ---------------------------------------------------------------- ask for access
class PammyRequest extends Box {
  static override properties = {
    ...words('heading', 'intro', 'name-label', 'contact-label', 'contact-hint', 'message-label', 'message-hint', 'button', 'done', 'back-text', 'closed-text'),
    info: { state: true }, loaded: { state: true }, sent: { state: true },
  };
  declare info: About | null;
  declare loaded: boolean;
  declare sent: boolean;

  protected override start() {
    void about(this).then((info) => { this.info = info; this.loaded = true; });
  }

  private back(info: About) {
    return html`<p class="pammy-links">${linkTo(info.pages.login, this.text('back-text', 'Back to sign in'))}</p>`;
  }

  override render() {
    const title = this.text('heading', 'Ask for access');
    const info = this.info;
    if (!this.loaded) return html`${heading(title)}${note('Loading...')}`;
    if (!info) return html`${heading(title)}${note("This page isn't set up correctly, so requests can't be sent from it.")}`;
    if (!info.requestsOpen) return html`${heading(title)}${note(this.text('closed-text', "This folder isn't taking requests at the moment."))}${this.back(info)}`;
    if (this.sent) return this.finished(this.text('done', "Thanks, your request has been sent. If you're let in, you'll get a link to choose your password."), this.back(info));
    return this.form(title,
      this.text('intro', "Say who you are and how to reach you. If you're let in, you'll be sent a link to choose your password."),
      html`${field('name', this.text('name-label', 'Your name'), html`<input class="pammy-input" name="name" autocomplete="name" required maxlength="60">`)}${field('contact', this.text('contact-label', 'How can we reach you?'), html`<input class="pammy-input" name="contact" autocomplete="on" required maxlength="120">`, this.text('contact-hint', 'A phone number or email address.'))}${field('message', this.text('message-label', 'Message (optional)'), html`<textarea class="pammy-input" name="message" maxlength="1000"></textarea>`, this.text('message-hint', 'For example, how you know us.'))}${trap('pl-leave-this-empty')}`,
      this.text('button', 'Send request'));
  }

  protected override async send() {
    await post('/_pammy/request', {
      name: this.value('name'), contact: this.value('contact'), message: this.value('message'), website: this.value('pl-leave-this-empty'), ...folderOf(this),
    });
    this.sent = true;
  }
}

// ---------------------------------------------------------------- signed in, but the folder has no home page
// Built-in only (/_pammy/welcome): where a signed-in visitor lands instead of
// "403 Forbidden" when a protected folder has no index.html.
type Folder = { username: string; items: { href: string; name: string; folder: boolean }[] };

class PammyWelcome extends Base {
  static override properties = { ...words('heading'), state: { state: true } };
  declare state: { kind: 'loading' | 'missing' | 'failed' } | { kind: 'signed-out'; login?: string } | { kind: 'ok'; folder: Folder };

  constructor() {
    super();
    this.state = { kind: 'loading' };
  }

  protected override start() {
    const path = new URLSearchParams(location.search).get('path') || '';
    fetch(`/_pammy/folder?${new URLSearchParams({ ...folderOf(this), ...(path ? { path } : {}) })}`, { credentials: 'same-origin' })
      .then(async (res) => ({ status: res.status, data: await res.json().catch(() => ({})) }))
      .then(({ status, data }) => {
        if (status === 401) this.state = { kind: 'signed-out', login: data.login };
        else if (status !== 200) this.state = { kind: 'missing' };
        else this.state = { kind: 'ok', folder: data };
      })
      .catch(() => { this.state = { kind: 'failed' }; });
  }

  override render() {
    const s = this.state;
    const title = this.text('heading', "You're signed in");
    switch (s.kind) {
      case 'loading': return html`${heading(title)}${note('Loading...')}`;
      case 'failed': return html`${heading(title)}${note('Something went wrong. Please try again.')}`;
      case 'missing': return html`${heading(title)}${note("This folder can't be found.")}`;
      case 'signed-out': return html`${heading('Please sign in')}${note(html`You're not signed in to this folder. ${maybe(s.login, (l) => linkTo(l, 'Sign in'))}`)}`;
      case 'ok': {
        const f = s.folder;
        return html`${heading(title)}${note(`Signed in as ${f.username}. This folder doesn't have a home page yet.`)}${f.items.length
          ? html`<div><p class="pammy-note">In this folder:</p><ul class="pammy-list">${f.items.map((i) => html`<li>${linkTo(i.href, i.folder ? `${i.name}/` : i.name)}</li>`)}</ul></div>`
          : note('There are no pages in it to show yet.')}<p class="pammy-links">${signOutButton(this, 'Sign out', 'pammy-link')}</p>`;
      }
    }
  }
}

// ---------------------------------------------------------------- the signed-out page (logout.html)
// Opening it signs you out, so a plain link to logout.html is a sign-out link.
class PammySignedOut extends Base {
  static override properties = { ...words('heading', 'intro', 'signin-text', 'working-text'), state: { state: true }, info: { state: true } };
  declare state: 'working' | 'done' | 'failed';
  declare info: About | null;

  constructor() {
    super();
    this.state = 'working';
  }

  protected override start() {
    post('/_pammy/logout', folderOf(this))
      .then(() => {
        this.state = 'done';
        return about(this);
      })
      .then((info) => { this.info = info; })
      .catch(() => { this.state = 'failed'; });
  }

  override render() {
    const links = html`<p class="pammy-links">${maybe(this.state === 'done' && this.info, (i) => linkTo(i.pages.login, this.text('signin-text', 'Sign in again')))}</p>`;
    if (this.state === 'failed') {
      return html`${heading('Not signed out yet')}<p class="pammy-message" role="alert">Something went wrong, so you may still be signed in. Please reload this page to try again.</p>${links}`;
    }
    return html`${heading(this.text('heading', "You're signed out"))}${this.state === 'done'
      ? html`<p class="pammy-intro" role="status">${this.text('intro', 'You can close this page, or sign in again.')}</p>`
      : html`<p class="pammy-note" role="status">${this.text('working-text', 'Signing you out...')}</p>`}${links}`;
  }
}

// ---------------------------------------------------------------- sign out
class PammyLogout extends Base {
  static override properties = words('button');

  override render() {
    return signOutButton(this, this.text('button', 'Sign out'), 'pammy-button');
  }
}

if (!customElements.get('pammy-login')) {
  if (PREVIEW) previewBar();
  customElements.define('pammy-login', PammyLogin);
  customElements.define('pammy-forgot', PammyForgot);
  customElements.define('pammy-invite', PammyInvite);
  customElements.define('pammy-request', PammyRequest);
  customElements.define('pammy-welcome', PammyWelcome);
  customElements.define('pammy-signed-out', PammySignedOut);
  customElements.define('pammy-logout', PammyLogout);
  customElements.define('pammy-register', PammyRegister);
  customElements.define('pammy-confirm', PammyConfirm);
  customElements.define('pammy-reset', PammyReset);
  customElements.define('pammy-account', PammyAccount);
}
