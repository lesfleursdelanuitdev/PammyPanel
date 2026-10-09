import { FingerprintPattern, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Centered } from '../components/centered';
import { Button } from '../components/ui/button';
import { Alert } from '../components/ui/alert';
import { usePageTitle } from '../hooks/useApi';
import { friendlyError, passkeysSupported, signInWithPasskey } from '../lib/api';

// Where to go after signing in: the panel page that sent you here (?next=/messages),
// never another site. Same rule as nextPage() in src/app.ts.
export function nextPage(search: string): string {
  const next = new URLSearchParams(search).get('next') || '/';
  return /^\/(?![/\\])[^\s\\]*$/.test(next) && !/^\/(login|invite|api|assets)\b/.test(next) ? next : '/';
}

export function Login() {
  usePageTitle('Sign in');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const supported = passkeysSupported();

  const signIn = async () => {
    setBusy(true);
    setProblem('');
    try {
      await signInWithPasskey();
      location.replace(nextPage(location.search));
    } catch (err) {
      setProblem(friendlyError(err));
      setBusy(false);
    }
  };

  return (
    <Centered>
      <h1 className="text-3xl font-semibold">Sign in</h1>
      <p className="mt-2 text-muted-foreground">Use the passkey on your phone or computer. You'll be asked for your fingerprint, face or device PIN.</p>
      <Button size="lg" className="mt-6 w-full" disabled={busy || !supported} onClick={signIn}>
        {busy ? <Loader2 className="animate-spin" /> : <FingerprintPattern />}Sign in with passkey
      </Button>
      {problem && <Alert variant="error" className="mt-4">{problem}</Alert>}
      {!supported && <p className="mt-4 text-sm text-muted-foreground">This browser can't use passkeys. Try an up-to-date Chrome, Safari, Edge or Firefox.</p>}
    </Centered>
  );
}
