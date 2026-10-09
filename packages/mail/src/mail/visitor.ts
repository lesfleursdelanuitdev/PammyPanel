// Mail to visitors (docs/accounts-plan.md step 2): the few fixed emails the
// accounts need -- confirm an address, reset a password, and the notes that go
// with them. Plain text in the site's own name (Q9).
//
// Nothing anyone typed goes into one: no username, no name, no message. Only
// the kind's own words, the site's name, and a link into the site's /_pammy/
// pages. So an address someone else typed can get at most one of these few
// notes (and at most 5 a day: Q5), never a message of the sender's choosing.
import { ADDRESS_RE, MailError } from './settings.ts';

export const VISITOR_KINDS = ['confirm', 'reset', 'email-change', 'email-changed', 'already-registered', 'deleted'] as const;
export type VisitorKind = (typeof VISITOR_KINDS)[number];
export const isVisitorKind = (v: unknown): v is VisitorKind => typeof v === 'string' && (VISITOR_KINDS as readonly string[]).includes(v);

// Q5, as revised: 5 a day to one address; 40 a day for the site (the two sites
// share one Resend account's 100 a day)
export const PER_ADDRESS_DAY = 5;
export const VISITOR_PER_DAY = 40;

// the kinds that carry a link, and those that don't (a note after the fact)
const NEEDS_LINK: Readonly<Record<VisitorKind, boolean>> = {
  confirm: true, reset: true, 'email-change': true, 'already-registered': true, 'email-changed': false, deleted: false,
};

export function visitorMail(kind: VisitorKind, site: string, link: string | null): { subject: string; text: string } {
  const ignore = 'If this wasn\'t you, you can ignore this email.';
  switch (kind) {
    case 'confirm': return {
      subject: `Confirm your email address for ${site}`,
      text: `Someone, hopefully you, made an account on ${site} with this email address.\n\nTo confirm it, open this link within 24 hours:\n${link}\n\n${ignore} Without the link, the account is removed in two days.`,
    };
    case 'reset': return {
      subject: `Choose a new password for ${site}`,
      text: `Someone asked to reset the password of the ${site} account that uses this email address.\n\nTo choose a new password, open this link within an hour. It works once:\n${link}\n\n${ignore} Your password stays as it is.`,
    };
    case 'email-change': return {
      subject: `Confirm your new email address for ${site}`,
      text: `Someone asked to use this email address for an account on ${site}.\n\nTo confirm it, open this link within 24 hours:\n${link}\n\n${ignore} Nothing changes.`,
    };
    case 'already-registered': return {
      subject: `You already have an account on ${site}`,
      text: `Someone tried to make a new account on ${site} with this email address, which already has one.\n\nIf that was you and you've forgotten your password, choose a new one here:\n${link}\n\n${ignore}`,
    };
    case 'email-changed': return {
      subject: `Your email address for ${site} was changed`,
      text: `The ${site} account that used this email address now uses another one.\n\nIf you didn't do this, reply to this email.`,
    };
    case 'deleted': return {
      subject: `Your account on ${site} was deleted`,
      text: `The ${site} account that used this email address has been deleted, with everything the site kept about you.\n\nIf you didn't do this, reply to this email.`,
    };
  }
}

// A link into the site's own sign-in pages, on its domain or one of its
// subdomains: https://examprep.lesfleursdelanuit.com/_pammy/reset#<token>
export function checkVisitorLink(kind: VisitorKind, link: unknown, domain: string): string | null {
  if (!NEEDS_LINK[kind]) {
    if (link !== undefined && link !== null) throw new MailError('invalid', 'That email carries no link.');
    return null;
  }
  if (typeof link !== 'string' || link.length > 300 || /\s/.test(link)) throw new MailError('invalid', 'That email needs a link to the site.');
  let u: URL;
  try { u = new URL(link); } catch { throw new MailError('invalid', 'That email needs a link to the site.'); }
  const d = domain.toLowerCase();
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || u.port !== '' || u.username || u.password || (host !== d && !host.endsWith(`.${d}`)) || !u.pathname.startsWith('/_pammy/')) {
    throw new MailError('invalid', `A visitor email links only to the site's own pages (https://…${d}/_pammy/…).`);
  }
  return link;
}

export function checkVisitorAddress(to: unknown): string {
  if (typeof to !== 'string' || !ADDRESS_RE.test(to)) throw new MailError('invalid', "That isn't an email address.");
  return to.toLowerCase();
}

// Who was sent what today, to keep to the limits. In memory: a restart forgets,
// and the gate's own limits (per address and per IP) stand in front of it.
export class VisitorLimits {
  #sent: { at: number; to: string }[] = [];
  readonly perDay: number;
  readonly perAddress: number;
  constructor(perDay = VISITOR_PER_DAY, perAddress = PER_ADDRESS_DAY) { this.perDay = perDay; this.perAddress = perAddress; }
  #trim(now: number) { while (this.#sent.length && this.#sent[0]!.at <= now - 86_400) this.#sent.shift(); }
  today(now: number) { this.#trim(now); return this.#sent.length; }
  check(now: number, to: string) {
    this.#trim(now);
    if (this.#sent.length >= this.perDay) throw new MailError('full', 'The site has sent as many emails as it may today. Please try again tomorrow.');
    if (this.#sent.filter((s) => s.to === to).length >= this.perAddress) throw new MailError('full', 'That address has been sent as many emails as it may today. Please try again tomorrow.');
  }
  add(now: number, to: string) { this.#sent.push({ at: now, to }); }
}
