import { FingerprintPattern, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { Centered } from '../components/centered';
import { Field } from '../components/page';
import { Alert } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { usePageTitle } from '../hooks/useApi';
import { api, ApiError, createPasskey, friendlyError, passkeysSupported } from '../lib/api';

type Info = { displayName: string; username: string; passkeys: number };

// A setup link: /invite#<token>. The token is in the #fragment, which browsers never send to the server.
export function Invite() {
  usePageTitle('Set up your passkey');
  const token = useLocation().hash.slice(1);       // (read again if a link is pasted into this same tab)
  const [info, setInfo] = useState<Info | null>(null);
  const [invalid, setInvalid] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    setInfo(null);
    setInvalid('');
    if (!token) { setInvalid('The link is incomplete. Copy the whole link, including everything after the # sign.'); return; }
    if (!passkeysSupported()) { setInvalid("This browser can't create passkeys. Open the link in an up-to-date Chrome, Safari, Edge or Firefox."); return; }
    api<Info>('/api/invite/info', { token }).then(setInfo, (err) => setInvalid(err.message));
  }, [token]);

  const create = async () => {
    setBusy(true);
    setProblem('');
    try {
      await createPasskey('/api/invite/options', '/api/invite/verify', { token, name });
      history.replaceState(null, '', '/invite');   // the link is used up; don't leave it in history
      location.replace('/passkeys');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invite-invalid') setInvalid(err.message);
      else setProblem(friendlyError(err));
      setBusy(false);
    }
  };

  return (
    <Centered>
      {invalid ? (
        <>
          <h1 className="text-3xl font-semibold">This link doesn't work</h1>
          <p className="mt-2">{invalid}</p>
          <p className="mt-4"><a href="/login" className="font-semibold">Go to sign in</a></p>
        </>
      ) : !info ? (
        <p className="text-muted-foreground">Checking your setup link…</p>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <h1 className="text-3xl font-semibold">Hello, {info.displayName}</h1>
          <p className="mt-2">Create a passkey to sign in to the panel. It stays on this device (or in your phone's password manager), and you unlock it with your fingerprint, face or device PIN. There's no password to remember.</p>
          {info.passkeys > 0 && (
            <p className="mt-3 text-sm text-muted-foreground">This adds another passkey to the account <strong>{info.username}</strong>. Its existing passkeys keep working.</p>
          )}
          <Field className="mt-5" label="Name this passkey" htmlFor="pkname" hint="Just a label, so you can tell your devices apart later.">
            <Input id="pkname" maxLength={60} placeholder="e.g. iPhone, work laptop" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Button type="submit" size="lg" className="mt-6 w-full" disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <FingerprintPattern />}Create passkey
          </Button>
          {problem && <Alert variant="error" className="mt-4">{problem}</Alert>}
        </form>
      )}
    </Centered>
  );
}
