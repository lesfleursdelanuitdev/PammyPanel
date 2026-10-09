// Review changes, then Apply (docs/databases-plan.md 8). The moment of truth in
// the whole workspace: everything before this is a drawing.
//
// Three things this page must not soften:
//
//  * **What a step costs.** A removed field takes the writing in it with it, and
//    the line says so next to the step rather than in a paragraph at the top.
//  * **That MariaDB cannot undo.** Postgres applies a patch in one transaction:
//    all of it or none. MariaDB does them one at a time, and a failure half way
//    through means half of it happened. The page says which engine she is on
//    BEFORE she presses, not after it goes wrong.
//  * **What the engine will actually run.** Under Advanced, and it comes back
//    from the helper -- the same printer that does the work, not a second
//    rendering of the same idea.
import { AlertTriangle, ArrowLeft, PlayCircle, RotateCcw } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { Collapsible, InlineLink, List, Loading, Page, Row, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { api, plural } from '@panel/core/web/lib/api';
import { W } from '@panel/core/web/lib/site';
import { notify } from '@panel/core/web/lib/status';
import type { AppImpact, ApplyData, DatabaseEngine, ReviewData } from '../lib/schema';

export default function DatabaseReview() {
  const { engine, name } = useParams<{ engine: DatabaseEngine; name: string }>();
  usePageTitle(`Review ${name ?? ''}`);
  const base = `/api/databases/${engine}/${name}`;
  const data = useApi<ReviewData>(`${base}/schema/review`);
  const run = useAction();
  const dialogs = useDialogs();
  const navigate = useNavigate();

  const d = data.data;
  const changes = d?.plan.changes ?? [];
  const sql = d?.sql ?? [];
  const sequential = engine === 'mariadb';

  const apply = async () => {
    if (!d) return;
    const ok = await dialogs.confirm({
      title: `Apply ${plural(changes.length, 'change')} to ${name}?`,
      body: <>
        {d.plan.destructive
          ? <p><strong>Some of these delete information that cannot be brought back here.</strong> Last night's backup is still there, but getting anything out of it is a job for momolig.</p>
          : <p>None of these delete anything that is already stored.</p>}
        {sequential
          ? <p className="mt-2">MariaDB does these one at a time. If a later one fails, the earlier ones have already happened — there is no undo.</p>
          : <p className="mt-2">Postgres does these all together. If one fails, none of them happen.</p>}
      </>,
      action: 'Apply them',
    });
    if (!ok) return;
    const r = await run(() => api<ApplyData>(`${base}/schema/apply`, {}));
    if (!r) return;
    if (r.failed) {
      notify(r.rolledBack
        ? `Nothing was changed: the database refused step ${r.failed.at + 1}.`
        : `${r.applied} of ${r.total} changes went in, then step ${r.failed.at + 1} was refused. The rest are still waiting.`, 'error');
      return;
    }
    // kept through the move back to the tables: this is the answer to what she
    // just pressed, not old news the new page should clear
    notify(`${plural(r.applied, 'change')} applied to ${name}.`, 'ok', true);
    void navigate(`/databases/${engine}/${name}`);
  };

  const discard = async () => {
    const ok = await dialogs.confirm({
      title: 'Throw these changes away?',
      body: 'The drawing goes back to being exactly what the database has. Nothing in the database itself is touched.',
      action: 'Throw them away',
    });
    if (!ok) return;
    const gone = await run(() => api(`${base}/schema/discard`, {}));
    if (gone) {
      notify('Back to what the database really has.', 'ok', true);
      void navigate(`/databases/${engine}/${name}`);
    }
  };

  return (
    <Page title="Review changes" wide
      intro={<>
        <InlineLink to="/databases">Your databases</InlineLink>{' · '}
        <InlineLink to={`/databases/${engine}/${name}`}>{name}</InlineLink>
      </>}>

      {!d ? <Loading /> : changes.length === 0 ? (
        <Section title="Nothing to apply">
          <p className="text-sm">Your drawing and the database say the same thing.</p>
          <p className="mt-3">
            <Button variant="outline" asChild><Link to={`/databases/${engine}/${name}`}><ArrowLeft />Back to the tables</Link></Button>
          </p>
        </Section>
      ) : <>
        {d.drift && (
          <Section title="This database changed somewhere else" className="border-destructive/40">
            <p className="text-sm">
              {name} changed after you started drawing, so these changes were worked out from how it used to be.
              They cannot be applied until you have had another look.
            </p>
            <p className="mt-3"><Button variant="outline" onClick={discard}><RotateCcw />Start again from the database</Button></p>
          </Section>
        )}

        <Section flush title={`${plural(changes.length, 'change')} waiting`}>
          <List label="Changes">
            {changes.map((c, i) => (
              <Row key={i} title={c.line}
                badges={c.destructive ? <Badge variant="danger">deletes something</Badge> : undefined}
                meta={c.warning ? (
                  <p className="flex gap-2 text-sm text-muted-foreground">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />{c.warning}
                  </p>
                ) : undefined} />
            ))}
          </List>
        </Section>

        {d.app && <AppAffected app={d.app} />}
        {(d.tagsLost ?? []).length > 0 && (
          <Section title="Tags that go">
            <ul className="list-disc space-y-1 pl-5 text-sm" aria-label="Tags that go">
              {d.tagsLost!.map((t) => <li key={t.table}>{t.plural} goes, and with it the tags and categories on {t.labelled === 1 ? '1 record' : `${t.labelled} records`} (and the table's own tags and categories). Tags that go everywhere stay.</li>)}
            </ul>
          </Section>
        )}

        <Section title={sequential ? 'These are applied one at a time' : 'These are applied all together'}>
          <p className="text-sm">
            {sequential
              ? <>This is a MariaDB database. It does each change in turn, and it cannot undo one. If a later change is refused, the earlier ones have already happened — the panel will tell you exactly how far it got, and what is left stays on your list.</>
              : <>This is a Postgres database. It does all the changes as one. If any of them is refused, none of them happen and nothing is left half done.</>}
          </p>
        </Section>

        <Collapsible summary="Advanced: what the database will be asked to do">
          <p className="mb-2 text-sm text-muted-foreground">
            {plural(sql.length, 'statement')}, in the order they run. This is what the panel will send, not a description of it.
          </p>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs"><code>{sql.map((s) => `${s};`).join('\n')}</code></pre>
        </Collapsible>

        <Section title="Apply">
          {d.plan.destructive ? (
            <p className="mb-3 flex gap-2 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
              Some of these delete information for good. You will be asked for your passkey.
            </p>
          ) : d.app && (
            // the server asks for it on a switched-on app too (src/app.ts, apply),
            // and a passkey prompt nobody mentioned looks like something went wrong
            <p className="mb-3 text-sm">{d.app.title} is switched on, so you will be asked for your passkey.</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={apply} disabled={d.drift}><PlayCircle />Apply {plural(changes.length, 'change')}</Button>
            <Button variant="outline" onClick={discard}><RotateCcw />Throw them away</Button>
          </div>
        </Section>
      </>}
    </Page>
  );
}

// What these changes do to an app that is switched on (src/studio/impact.ts):
// its pages change the moment they are applied, and so does what programs can
// reach, if she has let them in. Said before Apply, not discovered after.
const HOW: Record<AppImpact['touched'][number]['how'], (plural: string, programs: boolean) => string> = {
  goes: (p, programs) => `${p} goes, with its pages${programs ? ', and programs asking for it get nothing' : ''}.`,
  renamed: (p, programs) => `${p}: the table gets a new name. Its pages follow it${programs ? '; a program using the old name has to change to the new one' : ''}.`,
  // a new field is shown unless she hides it (src/studio/resources.ts), so it
  // reaches programs too -- worth saying when a program is reading
  changed: (p, programs) => `${p}: its fields change, and its pages change with them. A new field is shown unless you hide it${programs ? ' — to programs as well — and a renamed field reaches programs under its new name' : ''}.`,
};

function AppAffected({ app }: { app: AppImpact }) {
  return (
    <Section title={`${app.title} is switched on`}
      intro={app.touched.length
        ? `These changes reach it the moment you apply them${app.programs ? ' — its pages, and what programs can read' : ''}.`
        : `None of these change anything ${app.title} already manages.`}>
      {app.touched.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-sm" aria-label={`What changes in ${app.title}`}>
          {app.touched.map((t) => <li key={t.table}>{HOW[t.how](t.plural, app.programs)}</li>)}
        </ul>
      )}
      {app.added.length > 0 && (
        <p className="mt-3 text-sm">
          {app.added.length === 1 ? `The new table ${app.added[0]} is` : `The new tables ${app.added.join(', ')} are`} not
          added to {app.title} by {app.added.length === 1 ? 'itself' : 'themselves'}. Press “Manage this” on the {W.app.one}'s page if you want {app.title} to manage {app.added.length === 1 ? 'it' : 'them'}{app.programs ? ' — until then programs cannot see ' + (app.added.length === 1 ? 'it' : 'them') + ' either' : ''}.
        </p>
      )}
    </Section>
  );
}
