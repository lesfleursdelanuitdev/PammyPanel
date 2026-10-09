// Add a domain: the setup guide (docs/domains-hosts-plan.md step 4, D-5). One question a
// page, phone-first; each answer is checked on the server before the next page (the
// routing helper's check-domain: nothing else in nginx answers for it, its DNS, a
// wildcard record, the certificate and its key, the zone). The summary lists every
// requirement, and Turn on writes the domain: its catch-all in nginx (any <name> under it
// answers "not found" until a host is made there), then a made-up name is asked for real.
// A certificate for named hosts only (step 7, gonsalvesfamily.com's): no catch-all, and
// only hosts whose names it covers.
import { ArrowLeft, ArrowRight, Check, Power } from 'lucide-react';
import { useId, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Field, Page, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { Input } from '@panel/core/web/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@panel/core/web/components/ui/radio-group';
import { useAction } from '@panel/core/web/hooks/useAction';
import { usePageTitle } from '@panel/core/web/hooks/useApi';
import { api } from '@panel/core/web/lib/api';
import { notify } from '@panel/core/web/lib/status';

export type Need = { key: string; label: string; ok: boolean; why: string; required: boolean };
type Answers = {
  name: string; dns: 'dreamhost' | 'cloudflare' | 'manual'; front: 'direct' | 'cloudflare'; wildcardRecord: boolean;
  cert: 'wildcard-dns' | 'cloudflare-origin' | 'files' | 'names'; certPath: string; keyPath: string;
  names: string;      // cert 'names': "@ www admin", as typed
};
// the names typed, as the server takes them ("@": the domain itself)
const namesOf = (a: Answers) => a.names.split(/[\s,]+/).map((n) => n.trim().toLowerCase()).filter(Boolean);
const certBody = (a: Answers) => (a.cert === 'names' ? { names: namesOf(a) } : {});
const shownName = (a: Answers, n: string) => (n === '@' || n === a.name ? a.name : `${n}.${a.name}`);

const STEPS = ['The domain', 'Who keeps its DNS?', "What's in front?", 'New names', 'Certificate', 'Folder hosts', 'Summary'] as const;
// a Let's Encrypt certificate comes with its own TLS settings, as the hosts' have them
const LE = { include: ['/etc/letsencrypt/options-ssl-nginx.conf'], dhparam: '/etc/letsencrypt/ssl-dhparams.pem' };
const tlsOf = (a: Answers) => ({
  cert: a.certPath, key: a.keyPath,
  ...(a.certPath.startsWith('/etc/letsencrypt/') ? LE : {}),
});
const suggested = (a: Answers): Pick<Answers, 'certPath' | 'keyPath'> => a.cert === 'cloudflare-origin'
  ? { certPath: `/etc/ssl/cloudflare/${a.name}.pem`, keyPath: `/etc/ssl/cloudflare/${a.name}.key` }
  : a.cert === 'names'
  ? { certPath: `/etc/letsencrypt/live/${a.name}/fullchain.pem`, keyPath: `/etc/letsencrypt/live/${a.name}/privkey.pem` }
  : { certPath: `/etc/letsencrypt/live/wildcard.${a.name}/fullchain.pem`, keyPath: `/etc/letsencrypt/live/wildcard.${a.name}/privkey.pem` };

export function NeedList({ checks, only }: { checks: Need[]; only?: string[] }) {
  const shown = only ? checks.filter((c) => only.includes(c.key)) : checks;
  return (
    <ul className="space-y-2" aria-label="What it needs">
      {shown.map((c) => (
        <li key={c.key} className="flex flex-wrap items-start gap-2 text-sm">
          <Badge variant={c.ok ? 'ok' : c.required ? 'danger' : 'warn'}>{c.ok ? '✓' : '✗'}{c.required && !c.ok ? ' needed' : ''}</Badge>
          <span className="min-w-0 flex-1"><strong>{c.label}</strong><br /><span className="text-muted-foreground [overflow-wrap:anywhere]">{c.why}</span></span>
        </li>
      ))}
    </ul>
  );
}

function Choice<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; hint: string; disabled?: boolean }[] }) {
  const uid = useId();
  return (
    <RadioGroup value={value} onValueChange={(v) => onChange(v as T)} className="grid gap-3">
      {options.map((o) => (
        <div key={o.value} className="flex items-start gap-2.5">
          <RadioGroupItem value={o.value} id={`${uid}-${o.value}`} disabled={o.disabled} className="mt-1" />
          <label htmlFor={`${uid}-${o.value}`} className={o.disabled ? 'text-muted-foreground' : ''}>
            <span className="font-semibold">{o.label}</span><br /><span className="text-sm text-muted-foreground">{o.hint}</span>
          </label>
        </div>
      ))}
    </RadioGroup>
  );
}

export default function AddDomain() {
  usePageTitle('Add a domain');
  const uid = useId();
  const run = useAction();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [a, setA] = useState<Answers>({ name: '', dns: 'manual', front: 'direct', wildcardRecord: true, cert: 'wildcard-dns', certPath: '', keyPath: '', names: '@ www' });
  const [checks, setChecks] = useState<Need[] | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<Answers>) => { setA((x) => ({ ...x, ...p })); setChecks(null); };

  // the answers so far, checked on the server; the certificate only once it's been given
  const check = async (withCert: boolean) => {
    setBusy(true);
    try {
      const r = await run(() => api<{ checks: Need[] }>('/api/domains/check', {
        name: a.name, dns: a.dns, front: a.front, wildcardRecord: a.wildcardRecord, cert: a.cert, ...(withCert ? { tls: tlsOf(a), ...certBody(a) } : {}),
      }));
      if (r) setChecks(r.checks);
      return r?.checks ?? null;
    } finally { setBusy(false); }
  };
  // Next: check this page's answer; a problem that must be fixed first stops here
  const next = async () => {
    const got = await check(step >= 4);
    if (!got) return;
    const blocking = got.filter((c) => c.required && !c.ok && (c.key === 'name' || c.key === 'nginx' || (step >= 4 && c.key === 'certificate')));
    if (blocking.length) return;
    if (step === 3 && !a.certPath) setA((x) => ({ ...x, ...suggested(x) }));
    setStep((s) => s + 1);
  };
  const back = () => { setChecks(null); setStep((s) => Math.max(0, s - 1)); };
  const shownFor: Record<number, string[]> = { 0: ['name', 'nginx', 'dns'], 1: ['zone'], 2: ['dns'], 3: ['wildcard'], 4: ['certificate'] };

  return (
    <Page title="Add a domain" intro={<>A domain the panel hands out addresses under. Each answer is checked before the next page. <Link to="/hosts" className="font-semibold text-primary underline-offset-2 hover:underline">Back to Hosts</Link></>}>
      <ol className="mb-4 flex flex-wrap gap-1.5 text-xs" aria-label="Steps">
        {STEPS.map((s, i) => <li key={s}><Badge variant={i === step ? 'default' : 'outline'} aria-current={i === step ? 'step' : undefined}>{i + 1}. {s}</Badge></li>)}
      </ol>
      <Section title={STEPS[step]}>
        <div className="grid gap-4">
          {step === 0 && (
            <Field label="Its name" htmlFor={`${uid}-name`} hint="Like example.com: the domain itself, not an address under it.">
              <Input id={`${uid}-name`} autoCapitalize="none" autoComplete="off" spellCheck={false} placeholder="example.com" value={a.name}
                onChange={(e) => set({ name: e.target.value.trim().toLowerCase(), certPath: '', keyPath: '' })} />
            </Field>
          )}
          {step === 1 && (
            <Choice value={a.dns} onChange={(dns) => set({ dns })} options={[
              { value: 'dreamhost', label: 'DreamHost', hint: 'Its records are read with the key already on this server, so a name with a record of its own is never taken as a host.' },
              { value: 'cloudflare', label: 'Cloudflare', hint: 'No Cloudflare key is kept on this server yet: new names can\'t be checked against its records.' },
              { value: 'manual', label: 'Somewhere else', hint: 'New names can\'t be checked against its records: make sure a name has no record of its own before you make it a host.' },
            ]} />
          )}
          {step === 2 && (
            <Choice value={a.front} onChange={(front) => set({ front })} options={[
              { value: 'direct', label: 'Directly', hint: 'Its records point at this server.' },
              { value: 'cloudflare', label: "Behind Cloudflare's proxy", hint: 'Proxied records (orange cloud), and SSL set to "Full (strict)" at Cloudflare.' },
            ]} />
          )}
          {step === 3 && (
            <Choice value={a.wildcardRecord ? 'yes' : 'no'} onChange={(v) => set({ wildcardRecord: v === 'yes' })} options={[
              { value: 'yes', label: 'A * record points every name here', hint: 'A new host needs no change in DNS. Checked by asking for a made-up name.' },
              { value: 'no', label: 'One record per host', hint: 'Each new host needs its own record at the DNS provider before it works.' },
            ]} />
          )}
          {step === 4 && <>
            <Choice value={a.cert} onChange={(cert) => set({ cert, ...suggested({ ...a, cert }) })} options={[
              { value: 'wildcard-dns', label: 'A wildcard certificate (Let\'s Encrypt, DNS-01)', hint: 'Covers the domain and every name under it; renewed through the DNS provider\'s API.' },
              { value: 'cloudflare-origin', label: "Cloudflare's origin certificate", hint: 'Only for a domain behind Cloudflare\'s proxy.' },
              { value: 'files', label: 'Files already on this server', hint: 'Any certificate that covers the domain and *.domain.' },
              { value: 'names', label: 'A certificate for these names only', hint: 'For a domain with no * record (Let\'s Encrypt, one name at a time, renewed through a folder nginx serves). There is no catch-all: only hosts whose names it covers.' },
            ]} />
            {a.cert === 'names' && (
              <Field label="The names it covers" htmlFor={`${uid}-names`} hint={`"@" is ${a.name || 'the domain'} itself; then a name under it each, like www admin.`}>
                <Input id={`${uid}-names`} autoCapitalize="none" autoComplete="off" spellCheck={false} placeholder="@ www admin" value={a.names} onChange={(e) => set({ names: e.target.value })} />
              </Field>
            )}
            <p className="text-sm text-muted-foreground">One certificate per host (each new host waiting for certbot) comes later.</p>
            <Field label="Certificate file" htmlFor={`${uid}-cert`} hint="Under /etc/letsencrypt/ or /etc/ssl/.">
              <Input id={`${uid}-cert`} autoCapitalize="none" spellCheck={false} value={a.certPath} onChange={(e) => set({ certPath: e.target.value.trim() })} />
            </Field>
            <Field label="Its key" htmlFor={`${uid}-key`}>
              <Input id={`${uid}-key`} autoCapitalize="none" spellCheck={false} value={a.keyPath} onChange={(e) => set({ keyPath: e.target.value.trim() })} />
            </Field>
          </>}
          {step === 5 && (
            <Choice<string> value="no" onChange={() => {}} options={[
              { value: 'no', label: 'Hosts only when made', hint: 'A name is served once a host is made for it, on the Hosts page.' },
              { value: 'yes', label: 'Every top-level folder its own host', hint: 'pammy.org\'s way. It comes with pammy.org\'s move to hosts, and needs a * record and a wildcard certificate.', disabled: true },
            ]} />
          )}
          {step === 6 && <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Domain</dt><dd className="font-semibold">{a.name}</dd>
              <dt className="text-muted-foreground">DNS</dt><dd>{{ dreamhost: 'DreamHost', cloudflare: 'Cloudflare', manual: 'somewhere else' }[a.dns]}</dd>
              <dt className="text-muted-foreground">In front</dt><dd>{a.front === 'cloudflare' ? "Cloudflare's proxy" : 'nothing'}</dd>
              <dt className="text-muted-foreground">New names</dt><dd>{a.cert === 'names' ? 'only the certificate\'s' : a.wildcardRecord ? 'a * record' : 'a record each'}</dd>
              <dt className="text-muted-foreground">Certificate</dt><dd className="[overflow-wrap:anywhere]">{a.certPath}</dd>
              {a.cert === 'names' && <><dt className="text-muted-foreground">For</dt><dd className="[overflow-wrap:anywhere]">{namesOf(a).map((n) => shownName(a, n)).join(', ')}</dd></>}
            </dl>
            {a.cert === 'names'
              ? <p className="text-sm">Turn on writes nothing for its names yet: each is served once a host is made for it (or a hand-written file is taken over). Names hand-written files already serve keep being served by them.</p>
              : <p className="text-sm">Turn on writes its catch-all into nginx: any name under {a.name} answers "not found" until a host is made there. Names hand-written files already serve keep being served by them.</p>}
          </>}
          {checks && <NeedList checks={checks} only={step === 6 ? undefined : shownFor[step]} />}
          <div className="flex flex-wrap gap-2">
            {step > 0 && <Button type="button" variant="ghost" onClick={back}><ArrowLeft />Back</Button>}
            {step < 6 && <Button type="button" disabled={busy || !a.name || (step === 4 && (!a.certPath || !a.keyPath || (a.cert === 'names' && !namesOf(a).length)))} onClick={next}>
              {step === 0 && !checks ? <Check /> : <ArrowRight />}Check and go on
            </Button>}
            {step === 6 && <>
              <Button type="button" variant="outline" disabled={busy} onClick={() => check(true)}><Check />Check everything again</Button>
              <Button type="button" disabled={busy || !checks || checks.some((c) => c.required && !c.ok)} onClick={async () => {
                const r = await run(() => api<{ test: { name: string; answers?: { status: number | null } } | null }>('/api/domains', {
                  name: a.name, dns: a.dns, front: a.front, wildcardRecord: a.wildcardRecord, cert: a.cert, tls: tlsOf(a), ...certBody(a), folderHosts: false,
                }));
                // the answer outlives the move back to Hosts (a kept notice)
                if (r) { notify(`${a.name} is on.${r.test?.answers?.status ? ` ${r.test.name} answers ${r.test.answers.status}.` : ''}`, 'ok', true); navigate('/hosts'); }
              }}><Power />Turn on</Button>
            </>}
          </div>
          {step === 6 && !checks && <p className="text-sm text-muted-foreground">Check everything again first: Turn on needs every requirement marked "needed" to pass.</p>}
        </div>
      </Section>
    </Page>
  );
}
