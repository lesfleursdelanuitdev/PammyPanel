// What the panel shows once, to pass on privately: a setup link, or a password.
import { Check, Copy } from 'lucide-react';
import { Button } from '@panel/core/web/components/ui/button';
import { copyText } from '@panel/core/web/hooks/useAction';
import { formatTime } from '@panel/core/web/lib/api';
import type { SetupLink } from '../lib/types';
import type { Visitor } from '@panel/core/web/lib/types';
import { SITE } from '@panel/core/web/lib/site';

export type Credentials =
  | { kind: 'link'; who: string; username: string; contact: string; link: SetupLink }
  | { kind: 'password'; who: string; username: string; password: string; paths: string[] };

export function CredentialsBox({ c, onDone }: { c: Credentials; onDone: () => void }) {
  return c.kind === 'link' ? <LinkBox c={c} onDone={onDone} /> : <PasswordBox c={c} onDone={onDone} />;
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div data-testid="credentials" className="rounded-lg border border-primary/30 bg-primary-soft/60 p-4 text-sm sm:p-5">
      {children}
    </div>
  );
}

function Secret({ children }: { children: React.ReactNode }) {
  return <div className="mt-2 select-all rounded-md border border-border bg-card px-3 py-2 font-mono text-sm [overflow-wrap:anywhere]">{children}</div>;
}

function LinkBox({ c, onDone }: { c: Extract<Credentials, { kind: 'link' }>; onDone: () => void }) {
  const until = formatTime(c.link.expiresAt);
  const choose = c.link.firstPassword ? 'choose their password' : 'choose a new password';
  const note = `Hi! Here's your link for ${SITE.domain}: ${c.link.url}\nYour username is ${c.username}. The link works once, until ${until}.`;
  return (
    <Frame>
      <p>
        Send this link to {c.who} privately{c.contact ? ` (${c.contact})` : ''}. With it they {choose}.{' '}
        Their username is <strong>{c.username}</strong>. The link works once, until {until}, and this is the only time it's shown.
      </p>
      <Secret>{c.link.url}</Secret>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => copyText(c.link.url, 'Link')}><Copy />Copy link</Button>
        <Button size="sm" variant="outline" onClick={() => copyText(note, 'Message')}><Copy />Copy with a short message</Button>
        <Button size="sm" variant="ghost" onClick={onDone}><Check />Done</Button>
      </div>
    </Frame>
  );
}

function PasswordBox({ c, onDone }: { c: Extract<Credentials, { kind: 'password' }>; onDone: () => void }) {
  const where = c.paths.length ? `https://${SITE.domain}/${c.paths[0]}/` : null;
  const text = `Username: ${c.username}\nPassword: ${c.password}${where ? `\nSign in at: ${where}` : ''}`;
  return (
    <Frame>
      <p>Send these to {c.who} privately. This is the only time the password is shown:</p>
      <Secret>Username: {c.username}</Secret>
      <Secret>Password: {c.password}</Secret>
      {where && <p className="mt-2 text-sm">Sign in at: {where}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => copyText(text, 'Username and password')}><Copy />Copy</Button>
        <Button size="sm" variant="ghost" onClick={onDone}><Check />Done</Button>
      </div>
    </Frame>
  );
}

export const linkCredentials = (v: Pick<Visitor, 'name' | 'username' | 'contact'>, link: SetupLink): Credentials =>
  ({ kind: 'link', who: v.name || v.username, username: v.username, contact: v.contact, link });
