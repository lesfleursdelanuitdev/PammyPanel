// Shared by Protected folders and People: who can open what, and adding someone.
import { Dices, UserPlus } from 'lucide-react';
import { useId, useState } from 'react';
import { Field } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { Checkbox } from '@panel/core/web/components/ui/checkbox';
import { Input } from '@panel/core/web/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@panel/core/web/components/ui/radio-group';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useMe } from '@panel/core/web/hooks/useMe';
import { isKept } from '@panel/core/web/lib/rights';
import { api } from '@panel/core/web/lib/api';
import { makePassword } from '@panel/core/web/lib/names';
import type { SetupLink } from '../lib/types';
import type { Area, Visitor } from '@panel/core/web/lib/types';
import { Loader2 } from 'lucide-react';

export function AccessCheckbox({ area, visitor, label }: { area: Area; visitor: Visitor; label: string }) {
  const run = useAction();
  const me = useMe();
  const dialogs = useDialogs();
  const allowed = area.visitors.includes(visitor.id);
  const [pending, setPending] = useState<boolean | null>(null);
  const id = useId();
  const checked = pending ?? allowed;
  return (
    <div className="flex items-center gap-2.5 py-1">
      <Checkbox id={id} checked={checked} disabled={pending !== null} onCheckedChange={async (v) => {
        const allow = v === true;
        // kept to places, their last folder of yours: they leave your list (docs/permissions-plan.md R5)
        if (!allow && me && isKept(me) && visitor.areas.length === 1 && !await dialogs.confirm({
          title: `Take ${visitor.username} out of "${area.path}"?`, action: 'Take them out',
          body: "It's the only one of your folders they can open, so they leave your People list. To let them back in later, ask whoever looks after the whole site.",
        })) return;
        setPending(allow);
        await run(() => api(`/api/protected/${area.id}/access`, { visitorId: visitor.id, allow }),
          allow ? `${visitor.username} can now open "${area.path}".` : `${visitor.username} can no longer open "${area.path}".`);
        setPending(null);
      }} />
      <label htmlFor={id} className="cursor-pointer [overflow-wrap:anywhere]">{label}</label>
      {!visitor.active && <Badge variant="warn">switched off</Badge>}
    </div>
  );
}

export type NewPerson = { id: number; username: string; link?: SetupLink; password?: string };

// Username, name, how to reach them, and their password: a setup link, or set now.
export function AddPersonForm({ areaIds, chooseAreas, onAdded, submitLabel = 'Add person' }:
  { areaIds?: number[]; chooseAreas?: Area[]; onAdded: (p: NewPerson) => void | Promise<void>; submitLabel?: string }) {
  const run = useAction();
  const uid = useId();
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [mode, setMode] = useState<'link' | 'set'>('link');
  const [password, setPassword] = useState('');
  const [chosen, setChosen] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    const pw = mode === 'set' ? password : undefined;
    const r = await run(() => api<{ id: number; username: string; link?: SetupLink }>('/api/visitors',
      { username, name, contact, password: pw, areaIds: areaIds ?? chosen }));
    setBusy(false);
    if (!r) return;
    setUsername(''); setName(''); setContact(''); setPassword(''); setMode('link'); setChosen([]);
    await onAdded({ ...r, password: pw });
  };

  return (
    <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Username" htmlFor={`${uid}-u`}>
          <Input id={`${uid}-u`} maxLength={64} placeholder="e.g. auntie.jo" autoComplete="off" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} />
        </Field>
        <Field label="Name (only you see it)" htmlFor={`${uid}-n`}>
          <Input id={`${uid}-n`} maxLength={60} placeholder="e.g. Auntie Jo" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="How to reach them (only you see it)" htmlFor={`${uid}-c`} className="sm:col-span-2">
          <Input id={`${uid}-c`} maxLength={120} placeholder="e.g. phone number or email" autoComplete="off" value={contact} onChange={(e) => setContact(e.target.value)} />
        </Field>
      </div>
      <fieldset>
        <legend className="mb-2 text-sm font-bold">Their password</legend>
        <RadioGroup value={mode} onValueChange={(v) => setMode(v as 'link' | 'set')}>
          <div className="flex items-center gap-2.5">
            <RadioGroupItem value="link" id={`${uid}-link`} />
            <label htmlFor={`${uid}-link`}>They choose it: I'll send them a setup link</label>
          </div>
          <div className="flex items-center gap-2.5">
            <RadioGroupItem value="set" id={`${uid}-set`} />
            <label htmlFor={`${uid}-set`}>I'll set it now</label>
          </div>
        </RadioGroup>
      </fieldset>
      {mode === 'set' && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <Field label="Password" htmlFor={`${uid}-p`} className="flex-1">
            <Input id={`${uid}-p`} maxLength={200} autoComplete="off" spellCheck={false} className="font-mono" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Button type="button" variant="outline" onClick={() => setPassword(makePassword())}><Dices />Make one up</Button>
        </div>
      )}
      {chooseAreas && (
        <fieldset>
          <legend className="mb-1 text-sm font-bold">Can open</legend>
          {chooseAreas.length === 0 ? <p className="text-muted-foreground">No protected folders yet. You can choose folders later.</p>
            : chooseAreas.map((a) => (
              <div key={a.id} className="flex items-center gap-2.5 py-1">
                <Checkbox id={`${uid}-a${a.id}`} checked={chosen.includes(a.id)}
                  onCheckedChange={(v) => setChosen((c) => (v === true ? [...c, a.id] : c.filter((x) => x !== a.id)))} />
                <label htmlFor={`${uid}-a${a.id}`} className="cursor-pointer">{a.path}</label>
              </div>
            ))}
        </fieldset>
      )}
      <div><Button type="submit" disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <UserPlus />}{submitLabel}</Button></div>
    </form>
  );
}
