// A database password, the one moment it is ever visible.
//
// Nothing keeps a copy: not the panel's database, not the log, not this page
// once she presses Done. The engine has a hash of it and she has whatever she
// pasted it into. That is why this block shows the whole connection -- server,
// port, login, password -- rather than the password on its own: it is the only
// chance to write down something that will actually work.
import { Copy } from 'lucide-react';
import { ActionButton, Section } from '@panel/core/web/components/page';
import { Button } from '@panel/core/web/components/ui/button';
import { notify } from '@panel/core/web/lib/status';
import { SITE } from '@panel/core/web/lib/site';
import type { DatabaseEngine } from '../lib/types';

// Where the site's engines answer (its profile's studioPorts: pammy.org's are Pamela's, from
// no-sudo/install-pamela-db.sh). Shown so a working line can be pasted into a program, and
// worth saying out loud: these are reachable from this machine only.
const ENDPOINT: Record<DatabaseEngine, { label: string; host: string; port: number | null }> = {
  postgres: { label: 'Postgres', host: '127.0.0.1', port: SITE.studioPorts?.postgres ?? null },
  mariadb: { label: 'MariaDB', host: '127.0.0.1', port: SITE.studioPorts?.mariadb ?? null },
};

export function NewPassword({ title, password, engine, user, onDone }: {
  title: string;
  password: string;
  engine: DatabaseEngine;
  user: string;
  onDone: () => void;
}) {
  const e = ENDPOINT[engine];
  const block = `Server:   ${e.host}\nPort:     ${e.port}\nLogin:    ${user}\nPassword: ${password}`;
  return (
    <Section title={title} className="border-primary/40">
      <p className="mb-2 text-sm">
        Copy this now: the password is never shown again, and nobody &mdash; not even the panel &mdash; can look it up later.
        If it is lost you can set a new one, which stops anything still using the old one.
      </p>
      <pre className="overflow-x-auto rounded-md bg-muted p-3 text-[0.8125rem]" data-testid="new-db-password"><code>{block}</code></pre>
      <p className="mt-2 text-sm text-muted-foreground">
        This login works from {e.label} on this server only &mdash; programs running on your own computer cannot reach it directly.
      </p>
      <div className="mt-2 flex gap-2">
        <ActionButton icon={Copy} onClick={async () => { await navigator.clipboard.writeText(block); notify('Copied.'); }}>Copy</ActionButton>
        <ActionButton icon={Copy} variant="ghost" onClick={async () => { await navigator.clipboard.writeText(password); notify('Password copied.'); }}>Copy just the password</ActionButton>
        <Button variant="ghost" onClick={onDone}>Done</Button>
      </div>
    </Section>
  );
}
