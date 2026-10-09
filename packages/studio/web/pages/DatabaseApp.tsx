// The Application tab: what her tables MEAN, as opposed to how they are stored
// (docs/databases-plan.md 11).
//
// The habit this page is built around is the opposite of the schema pages'. On
// the Tables page nothing is real until she presses Apply. Here everything is
// real at once and **nothing touches her database** -- a Resource is the
// panel's own opinion about her tables, so there is no draft, no Review and no
// Apply. Changing a label changes a label.
//
// The other thing it must get right: a table she has never looked at is
// **proposed**, not managed. Adopting a database with forty tables must not
// fill her menu with forty pages.
import { ArrowRight, Boxes, Database, Eye, EyeOff, KeyRound, Link2, MessageSquare, Power, PowerOff, Table2, Wrench } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { Empty, Facts, InlineLink, List, Loading, Page, Row, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { api, plural } from '@panel/core/web/lib/api';
import { cap, W } from '@panel/core/web/lib/site';
import { type AppData, type DatabaseEngine, type Resource } from '../lib/schema';

const KIND_ICON = { thing: Boxes, connection: Link2, machinery: Wrench } as const;

export default function DatabaseApp() {
  const { engine, name } = useParams<{ engine: DatabaseEngine; name: string }>();
  usePageTitle(name ? `${name} ${W.app.one}` : cap(W.app.one));
  const base = `/api/databases/${engine}/${name}`;
  const data = useApi<AppData>(`${base}/app`);
  const run = useAction();
  const navigate = useNavigate();
  // docs/comments-plan.md C8, C9: comments tables drawn into the draft, then Review
  const takeComments = async () => {
    const ok = await dialogs.confirm({
      title: `Let ${d?.title ?? name} keep comments?`, action: 'Draw the tables',
      body: `Two tables are drawn into your changes: Conversations and Comments. Nothing happens to your database until you look at them on Review and press Apply. A comment area for this ${W.app.one} is made too, on the Comments tab; every comment waits for your OK, and only approved ones are kept here.`,
    });
    if (!ok) return;
    const r = await run(() => api<{ review: string; area: string }>(`${base}/comments`, {}), (x) => `Drawn. Apply them on Review; the comment area "${x.area}" is on the Comments tab.`);
    if (r) navigate(r.review);
  };
  const dialogs = useDialogs();

  const d = data.data;
  const resources = d?.resources ?? [];
  const managed = resources.filter((r) => r.enabled);
  const rest = resources.filter((r) => !r.enabled);

  const manage = (r: Resource, enabled: boolean) =>
    run(() => api(`${base}/app/${r.table}/settings`, { enabled }),
      enabled ? `${r.plural} are part of your ${W.app.one} now.` : `${r.plural} are not part of your ${W.app.one}.`);

  const card = (r: Resource) => {
    const Icon = KIND_ICON[r.kind];
    const shown = r.fields.filter((f) => f.exposed && !f.primaryKey);
    return (
      <Row key={r.table} title={r.enabled ? r.plural : r.table}
        badges={<>
          {!r.decided && <Badge variant="outline">the panel's guess</Badge>}
          {r.kind === 'connection' && <Badge variant="outline">connecting table</Badge>}
          {r.kind === 'machinery' && <Badge variant="outline">looks like plumbing</Badge>}
          {r.publicRead && <Badge variant="outline">anyone can read{r.publicOnly ? ` (only where ${r.publicOnly} is yes)` : ''}</Badge>}
          {r.visitorArea && <Badge variant="outline">signed-in people can change{r.visitorOwner ? ' (each their own)' : ''}</Badge>}
        </>}
        meta={<>
          <Facts items={[
            <span key="t"><Icon className="mr-1 inline size-3.5 align-[-0.15em]" aria-hidden />{r.table}</span>,
            r.enabled ? `one is a ${r.singular}` : null,
            r.titleField ? `named by ${r.titleField}` : 'nothing to name them by yet',
            `${plural(shown.length, 'field')} shown of ${r.fields.length}`,
            r.related.length ? plural(r.related.length, 'connection') : null,
          ]} />
          {r.note && !r.enabled && <p className="mt-1 text-sm text-muted-foreground">{r.note}</p>}
        </>}
        actions={<div className="flex flex-wrap gap-2">
          {r.enabled && d?.status === 'active' && (
            <Button variant="outline" size="sm" asChild>
              <Link to={`/app/${engine}/${name}/${r.table}`}><ArrowRight />Open</Link>
            </Button>
          )}
          {r.enabled && (
            <Button variant="outline" size="sm" asChild>
              <Link to={`/databases/${engine}/${name}/app/${r.table}`}><Table2 />Settings</Link>
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => void manage(r, !r.enabled)}>
            {r.enabled ? <><EyeOff />Leave it out</> : <><Eye />Manage this</>}
          </Button>
        </div>} />
    );
  };

  // Activate publishes the ticked things as pages. It is deliberately plain
  // about what it does NOT do (docs/databases-plan.md D9): no data is copied,
  // and nothing goes on the internet -- the API switches are separate and off.
  const activate = async () => {
    await run(() => api(`${base}/activate`, {}), `${d?.title ?? name} is switched on.`);
  };
  const deactivate = async () => {
    const ok = await dialogs.confirm({
      title: `Switch ${d?.title ?? name} off?`,
      body: 'The pages go away and the menu group disappears. Your data, your tables and everything you have set here all stay exactly as they are — switching it on again brings the pages back.',
      action: 'Switch it off',
    });
    if (ok) await run(() => api(`${base}/deactivate`, {}), `${d?.title ?? name} is switched off.`);
  };

  return (
    <Page title={name ? `${name}: the ${W.app.one}` : ''} wide
      intro={<>
        <InlineLink to="/databases">Your databases</InlineLink>{' · '}
        <InlineLink to={`/databases/${engine}/${name}`}>{name}</InlineLink>{' · '}
        {W.explain ? <>A table is how something is kept. This is what it <em>means</em> — and nothing here changes your database.</> : 'Nothing here changes your database.'}
      </>}
      actions={<Button variant="outline" asChild>
        <Link to={`/databases/${engine}/${name}`}><Table2 />Tables<ArrowRight /></Link>
      </Button>}>

      {!d ? <Loading /> : <>
        {d.status === 'active' ? (
          <Section title={`This ${W.app.one} is switched on`}
            intro={`${d.title} is in your menu, with a page for each table it manages.${d.apiRead ? ' Programs can reach it too — see "Letting programs in".' : ' Nothing is on the internet: that is a separate switch, and it is off.'}`}
            action={<div className="flex flex-wrap gap-2">
              <Button variant="outline" asChild>
                <Link to={`/databases/${engine}/${name}/programs`}><KeyRound />Letting programs in</Link>
              </Button>
              <Button variant="outline" onClick={() => void deactivate()}><PowerOff />Switch the {W.app.one} off</Button>
            </div>} />
        ) : (
          <Section title={`This ${W.app.one} is not switched on yet`}
            intro={managed.length
              ? `Switching it on gives ${d.title} a group in your menu, with a page for each table below. It does not copy anything and it does not put anything on the internet.`
              : `Tick at least one table below first, then you can switch the ${W.app.one} on.`}
            action={<Button onClick={() => void activate()} disabled={managed.length === 0}><Power />Switch the {W.app.one} on</Button>} />
        )}

        {(() => {
          const has = d.resources.some((r) => r.table === 'comments') && d.resources.some((r) => r.table === 'comment_threads');
          return (
            <Section title="Comments"
              intro={has
                ? `This ${W.app.one} keeps the comments people leave on your pages once you approve them: Conversations and Comments below. To let people comment on the records of one table (blog posts), open it and switch on "People can comment on these".`
                : `Keep the comments people leave on your website in this ${W.app.one}, so you can find, count and sort them like anything else here.`}
              action={has ? <Button variant="outline" asChild><Link to="/comments"><MessageSquare />Comments</Link></Button>
                : <Button variant="outline" onClick={() => void takeComments()}><MessageSquare />This {W.app.one} takes comments</Button>} />
          );
        })()}

        <Section flush title={`Tables your ${W.app.one} manages`}
          intro={managed.length
            ? `Each of these becomes a page in your ${W.app.one}: a list, and a form for one record.`
            : undefined}>
          <List label="Managed">
            {managed.length === 0 && (
              <Empty>
                Nothing yet. Pick a table below and the panel gives it pages for listing, adding and changing its records.
              </Empty>
            )}
            {managed.map(card)}
          </List>
        </Section>

        {rest.length > 0 && (
          <Section flush title="Also in this database"
            intro="These are here, and left alone. Tick one if it is something you want to manage.">
            <List label="Left out">{rest.map(card)}</List>
          </Section>
        )}

        <Section title="What this is for" plain>
          <p className="text-sm text-muted-foreground">
            <Database className="mr-1.5 inline size-4 align-[-0.2em]" aria-hidden />
            A field that is not shown here is not on any form, not in any list, and not in the API —
            being in the database is not the same as being something people may read or change.
          </p>
        </Section>
      </>}
    </Page>
  );
}
