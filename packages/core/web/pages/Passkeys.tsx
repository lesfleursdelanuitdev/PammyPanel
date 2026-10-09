import { FingerprintPattern, Loader2, LogOut, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useDialogs } from '../components/dialogs';
import { ActionButton, Facts, Field, List, Loading, Page, Row, Section } from '../components/page';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { useAction } from '../hooks/useAction';
import { useApi, usePageTitle } from '../hooks/useApi';
import { api, createPasskey, formatTime } from '../lib/api';
import type { Passkey, SessionRow } from '../lib/types';

export function Passkeys() {
  usePageTitle('Passkeys & devices');
  const passkeys = useApi<{ passkeys: Passkey[] }>('/api/me/passkeys');
  const sessions = useApi<{ sessions: SessionRow[] }>('/api/me/sessions');
  const run = useAction();
  const dialogs = useDialogs();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <Page title="Passkeys & devices" intro="How you sign in to this panel, and where you're signed in now.">
      <Section title="Your passkeys" intro="Keep at least two, for example your phone and your computer, so losing one device doesn't lock you out.">
        {!passkeys.data ? <Loading /> : (
          <List label="Your passkeys">
            {passkeys.data.passkeys.map((pk) => (
              <Row key={pk.id} title={pk.name} badges={pk.thisSession && <Badge variant="ok">signed in with this</Badge>}
                meta={<Facts items={[`Added ${formatTime(pk.createdAt)}`, `last used ${formatTime(pk.lastUsedAt)}`, pk.synced && 'synced across your devices']} />}
                actions={<>
                  <ActionButton icon={Pencil} onClick={async () => {
                    const n = await dialogs.prompt({ title: 'Rename this passkey', label: 'New name', value: pk.name, action: 'Rename' });
                    if (n !== null) await run(() => api(`/api/me/passkeys/${pk.id}/rename`, { name: n }), 'Renamed.');
                  }}>Rename</ActionButton>
                  <ActionButton variant="danger" icon={Trash2} onClick={async () => {
                    const ok = await dialogs.confirm({
                      title: `Remove the passkey "${pk.name}"?`, action: 'Remove', danger: true,
                      body: <><p>It will stop working for this panel.</p>{pk.thisSession && <p>You signed in with this passkey, so this will also sign you out here.</p>}</>,
                    });
                    if (!ok) return;
                    const r = await run(() => api<{ signedOut?: boolean }>(`/api/me/passkeys/${pk.id}/delete`, {}), 'Passkey removed.');
                    if (r?.signedOut) location.replace('/login');
                  }}>Remove</ActionButton>
                </>} />
            ))}
          </List>
        )}
        <form className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const ok = await run(() => createPasskey('/api/me/passkeys/options', '/api/me/passkeys/verify', { name }), 'Passkey added.');
          if (ok) setName('');
          setBusy(false);
        }}>
          <Field label="Add a passkey on this device" htmlFor="new-passkey-name" className="flex-1">
            <Input id="new-passkey-name" maxLength={60} placeholder="e.g. iPhone, work laptop" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Button type="submit" disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <FingerprintPattern />}Add passkey</Button>
        </form>
      </Section>

      <Section flush title="Where you're signed in" intro="Sign out anywhere you don't recognise. Sessions end on their own after 8 hours unused, or 7 days at most.">
        {!sessions.data ? <Loading /> : (
          <List label="Where you're signed in">
            {sessions.data.sessions.map((s) => (
              <Row key={s.id} title={s.device} badges={s.current && <Badge variant="ok">this browser</Badge>}
                meta={<Facts items={[`Signed in ${formatTime(s.createdAt)}`, `last active ${formatTime(s.lastSeenAt)}`, s.ip]} />}
                actions={!s.current && <ActionButton icon={LogOut} onClick={() => run(() => api(`/api/me/sessions/${s.id}/revoke`, {}), 'Signed out.')}>Sign out</ActionButton>} />
            ))}
          </List>
        )}
      </Section>
    </Page>
  );
}
