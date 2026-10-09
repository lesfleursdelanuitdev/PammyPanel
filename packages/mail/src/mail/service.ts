// pammy-mail's socket (docs/apps-plan.md phase 3): the panel asks, this sends.
// It sends only to the notice address in its settings -- never to an address a
// request names -- and only a subject, a few lines of text and a link into the
// panel. So the most a request could do is send the notice address a note.
//   status  -> { ready, from, notifyTo, why }
//   test    -> a test email to the notice address
//   notice  -> { subject, lines, link }: one notice
//   visitor -> { kind, to, link }: one of the fixed visitor emails (visitor.ts),
//              to the visitor's own address, in the site's name
//   visitor-samples -> one of each visitor email, to the notice address, to read them
//
// A second door (<unit>-visitor.socket, docs/accounts-plan.md step 4) is the gate's:
// it answers only `visitor`, with the same limits, so the gate can email the person
// who asked and nothing else -- no notices, no tests, no samples.
import type { Server } from 'node:net';
import { createJsonLineServer } from '@panel/core/jsonline';
import { sendViaResend, type Fetch } from './send.ts';
import { MailError, type MailSettings } from './settings.ts';
import { checkVisitorAddress, checkVisitorLink, isVisitorKind, VISITOR_KINDS, visitorMail, VisitorLimits, VISITOR_PER_DAY } from './visitor.ts';

// "pammy.org" and "pammy.org panel" for pammy.org
export type MailNames = { site: string; panel: string };

export type MailDeps = {
  settings: () => MailSettings | null;
  key: () => string | null;
  fetch: Fetch;
  panelOrigin: string;          // https://panel.pammy.org: the only links a notice may carry
  names: MailNames;             // what the emails call the website and the panel (the site's profile)
  domain: string;               // pammy.org: the only site a visitor email may link to (and its subdomains)
  noticesPerDay?: number;       // PER_DAY unless the site says fewer (lfdln shares pammy.org's Resend account)
  visitorsPerDay?: number;      // VISITOR_PER_DAY
  now: () => number;            // unix seconds
  log?: (line: string) => void;
};

// Resend's free plan: 100 a day. These keep a flood of form responses from
// using all of it (and the panel says when a notice was held back).
export const PER_HOUR = 60;
export const PER_DAY = 90;

const FOOTER = (origin: string, n: MailNames) => `\n\n--\nSent by the ${n.site} control panel. To change what it tells you about: ${origin}/email`;

export function createMailServer(d: MailDeps): Server {
  return createMailDoors(d).panel;
}

// Both doors, sharing one count of what was sent today.
export function createMailDoors(d: MailDeps): { panel: Server; visitor: Server } {
  const sent: number[] = [];
  const perDay = d.noticesPerDay ?? PER_DAY;
  const visitors = new VisitorLimits(d.visitorsPerDay ?? VISITOR_PER_DAY);
  const ready = () => {
    const s = d.settings();
    const key = d.key();
    const why = !key ? 'No Resend key has been set.' : !s ? 'The mail settings could not be read.' : null;
    return { s, key, why };
  };
  const send = async (subject: string, text: string, idempotencyKey?: string) => {
    const { s, key, why } = ready();
    if (!s || !key) throw new MailError('not-set-up', why!);
    const t = d.now();
    while (sent.length && sent[0]! < t - 86_400) sent.shift();
    if (sent.filter((x) => x > t - 3600).length >= PER_HOUR || sent.length >= perDay) {
      throw new MailError('full', 'The panel has sent as many emails as it may for now. It carries on later.');
    }
    const r = await sendViaResend(d.fetch, key, { from: s.from, fromName: d.names.panel, to: s.notifyTo, replyTo: s.replyTo, subject, text: `${text}${FOOTER(d.panelOrigin, d.names)}`, idempotencyKey });
    sent.push(t);
    d.log?.(`sent ${r.id} to the notice address: ${subject.slice(0, 80)}`);
    return { sent: true, id: r.id, to: s.notifyTo };
  };

  const handle = async (req: Record<string, unknown> & { op: string }) => {
    switch (req.op) {
      case 'status': {
        const { s, why } = ready();
        return {
          ready: why === null, why, from: s?.from ?? null, notifyTo: s?.notifyTo ?? null, sentToday: sent.filter((x) => x > d.now() - 86_400).length,
          visitorSentToday: visitors.today(d.now()), visitorPerDay: visitors.perDay,
        };
      }
      case 'test':
        return send(`${d.names.site}: a test email`, `This is a test from the ${d.names.site} control panel. If you can read it, the panel can email you.`);
      case 'notice': {
        const subject = req.subject;
        const lines = req.lines;
        const link = req.link;
        if (typeof subject !== 'string' || subject.length < 1 || subject.length > 150 || /[\r\n]/.test(subject)) throw new MailError('invalid', 'A notice needs a one-line subject.');
        if (!Array.isArray(lines) || lines.length > 10 || !lines.every((l) => typeof l === 'string' && l.length <= 300)) throw new MailError('invalid', 'A notice is a few short lines.');
        if (typeof link !== 'string' || !link.startsWith(`${d.panelOrigin}/`) || link.length > 300 || /\s/.test(link)) throw new MailError('invalid', 'A notice links into the panel only.');
        const key = typeof req.key === 'string' && /^[\w:.-]{1,100}$/.test(req.key) ? req.key : undefined;
        return send(`${d.names.site}: ${subject}`, `${(lines as string[]).join('\n')}\n\n${link}`, key);
      }
      case 'visitor': {
        if (!isVisitorKind(req.kind)) throw new MailError('invalid', 'There is no such visitor email.');
        const to = checkVisitorAddress(req.to);
        const link = checkVisitorLink(req.kind, req.link, d.domain);
        const { s, key, why } = ready();
        if (!s || !key) throw new MailError('not-set-up', why!);
        const t = d.now();
        visitors.check(t, to);
        const m = visitorMail(req.kind, d.names.site, link);
        const r = await sendViaResend(d.fetch, key, { from: s.from, fromName: d.names.site, to, replyTo: s.replyTo, subject: m.subject, text: m.text });
        visitors.add(t, to);
        d.log?.(`sent ${r.id}: visitor ${req.kind}`);     // never the address: it's theirs
        return { sent: true, id: r.id };
      }
      case 'visitor-samples': {
        const out: string[] = [];
        for (const kind of VISITOR_KINDS) {
          const m = visitorMail(kind, d.names.site, `https://${d.domain}/_pammy/${kind}#this-is-a-sample-link`);
          await send(`sample visitor email: ${m.subject}`, `(A sample of what a visitor gets. Their copy has no sample line and no panel footer.)\n\n${m.text}`);
          out.push(kind);
        }
        return { sent: out };
      }
      default: throw new MailError('invalid', 'Unknown request.');
    }
  };
  const opts = { describe: (req: Record<string, unknown>) => JSON.stringify(req.subject ?? '').slice(0, 60), timeoutMs: 30_000 };
  return {
    panel: createJsonLineServer(handle, d.log, opts),
    visitor: createJsonLineServer(async (req) => {
      if (req.op !== 'visitor') throw new MailError('invalid', 'Unknown request.');
      return handle(req);
    }, d.log, opts),
  };
}
