// Settings > Backups (docs/lfdln-mariadb-plan.md B1-B4): how long the nightly copies of the
// Studio's databases are kept. Admins only; fewer days asks first, since the older copies go
// straight away.
import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { Facts, Field, Loading, Page, Section } from '@panel/core/web/components/page';
import { Button } from '@panel/core/web/components/ui/button';
import { Input } from '@panel/core/web/components/ui/input';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { api, formatTime } from '@panel/core/web/lib/api';
import { notify } from '@panel/core/web/lib/status';

export type BackupsView = { days: number; min: number; max: number; prunedAt: number | null; prunedNote: string | null; covers: string[] };

export default function Backups() {
  usePageTitle('Backups');
  const data = useApi<BackupsView>('/api/backups');
  const run = useAction();
  const dialogs = useDialogs();
  const [days, setDays] = useState('');
  useEffect(() => { if (data.data) setDays(String(data.data.days)); }, [data.data?.days]);
  const d = data.data;

  const save = async () => {
    if (!d) return;
    const n = Number(days);
    if (!Number.isInteger(n) || n < d.min || n > d.max) return notify(`Type a whole number of days, from ${d.min} to ${d.max}.`, 'error');
    if (n === d.days) return;
    if (n < d.days && !await dialogs.confirm({
      title: `Keep them ${n} days?`,
      body: `Every copy older than ${n} days is deleted now, and can't be brought back. The newest copy of each server always stays.`,
      action: 'Keep them for less',
      danger: true,
    })) return;
    await run(() => api<BackupsView & { pruned: number | null; problem?: string }>('/api/backups', { days: n }),
      (r) => r.problem ?? (r.pruned ? `Saved: ${r.pruned} older ${r.pruned === 1 ? 'copy' : 'copies'} deleted.` : `Saved: kept ${n} days.`));
  };

  return (
    <Page title="Backups" intro="Every night each database server copies all its databases. Here you choose how long the copies are kept; the panel deletes older ones every hour.">
      {!d ? <Loading /> : (
        <Section title="Keep the nightly copies"
          intro={<>Of the databases on Your databases: {d.covers.join(', and ')}. The panel's own database keeps its copies its own way.</>}>
          <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <Field label="Days" htmlFor="keep-days" hint={`From ${d.min} to ${d.max}. Getting a copy back is a job for a programmer.`}>
              <Input id="keep-days" inputMode="numeric" className="max-w-32" value={days} onChange={(e) => setDays(e.target.value)} />
            </Field>
            <div><Button type="submit"><Save />Save</Button></div>
          </form>
          {d.prunedAt !== null && <p className="pt-3 text-sm text-muted-foreground"><Facts items={[`last cleared ${formatTime(d.prunedAt)}`, d.prunedNote]} /></p>}
        </Section>
      )}
    </Page>
  );
}
