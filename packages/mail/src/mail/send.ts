// One email through Resend's API (https://resend.com/docs/api-reference/emails/send-email).
// fetch is handed in, so the tests never reach Resend.
import { MailError } from './settings.ts';

export type Message = { from: string; fromName: string; to: string; replyTo: string; subject: string; text: string; idempotencyKey?: string };
export type Fetch = typeof fetch;

export async function sendViaResend(f: Fetch, key: string, m: Message): Promise<{ id: string }> {
  let res: Response;
  try {
    res = await f('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        ...(m.idempotencyKey ? { 'idempotency-key': m.idempotencyKey } : {}),
      },
      body: JSON.stringify({ from: `${m.fromName} <${m.from}>`, to: [m.to], reply_to: m.replyTo, subject: m.subject, text: m.text }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new MailError('unavailable', 'Resend could not be reached. Try again in a minute.');
  }
  let body: { id?: unknown; message?: unknown; name?: unknown } = {};
  try { body = await res.json() as typeof body; } catch { /* no body */ }
  if (res.ok && typeof body.id === 'string') return { id: body.id };
  // Resend's own words, shortened: they name the actual problem ("The
  // mail.example.com domain is not verified") better than anything said here
  const said = typeof body.message === 'string' ? ` Resend said: ${body.message.slice(0, 200)}` : '';
  if (res.status === 401 || res.status === 403) throw new MailError('refused', `Resend did not accept the key.${said}`);
  if (res.status === 422 || res.status === 400) throw new MailError('refused', `Resend would not send it.${said}`);
  if (res.status === 429) throw new MailError('full', `Resend says too many emails were sent. Try again later.${said}`);
  throw new MailError('unavailable', `Resend had a problem (${res.status}).${said}`);
}
