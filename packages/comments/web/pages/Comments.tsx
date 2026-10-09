// Comments (docs/comments-plan.md, section 4): the conversations on her pages,
// through their own door. The same rows as Responses -- a comment area is a
// form, a comment is a response with a thread -- but the list is "waiting for
// your OK" first, since every comment waits for it (C15), and each one says
// what it is about.
import { useQueryClient } from '@tanstack/react-query';
import { ArchiveRestore, BadgeCheck, MessageSquare, Pencil, Plus, Trash2, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ActionButton, Empty, Facts, Field, GuideLink, InlineLink, List, Loading, Page, Row, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { Input } from '@panel/core/web/components/ui/input';
import { NativeSelect } from '@panel/core/web/components/ui/native-select';
import { Switch } from '@panel/core/web/components/ui/switch';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useMe } from '@panel/core/web/hooks/useMe';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { api, formatTime } from '@panel/core/web/lib/api';
import { isOn, W } from '@panel/core/web/lib/site';
import { answerText } from '@panel/forms/web/lib/form-items';
import type { Form, FormResponse } from '@panel/forms/web/lib/types';
import { CodeBlock } from '@panel/forms/web/pages/Forms';
import { may } from '@panel/core/web/lib/rights';

type Area = Form & { responses: number; unread: number; approved: number };
type Data = { responses: FormResponse[]; more: boolean; trashDays: number; waiting: number; areas: Area[] };

// What a conversation is about, in her words (Q5): a page by its address, a
// record by its table and id.
const aboutOf = (t: FormResponse['thread']) => (!t ? 'somewhere' : t.type === 'page'
  ? (/^[\w.-]+\.html?$|\//.test(t.id) ? `/${t.id.replace(/(^|\/)index\.html$/, '$1')}` : t.id)
  : `${t.type} ${t.id}`);

const componentCode = (name: string, contentType: string) => `<script src="/_pammy/comments.js" defer></script>
<pammy-comments name="${name}"${contentType === 'page' ? '' : ' content-id="THE ID OF THE ' + contentType.toUpperCase() + '"'}></pammy-comments>`;

export default function Comments() {
  usePageTitle('Comments');
  const [params, setParams] = useSearchParams();
  const view = params.get('view') ?? 'waiting';
  const area = params.get('area') ?? '';
  const type = params.get('type') ?? '';
  const content = params.get('content') ?? '';
  const q = new URLSearchParams({ view, ...(area ? { area } : {}), ...(type && content ? { type, content } : {}) });
  const data = useApi<Data>(`/api/comments?${q}`, { placeholderData: (prev) => prev });
  const set = (next: Record<string, string>) => setParams(Object.fromEntries(Object.entries({ view, area, type, content, ...next }).filter(([, v]) => v)), { replace: true });
  const areas = data.data?.areas ?? [];
  const areaOf = (m: FormResponse) => areas.find((a) => a.id === m.formId);

  return (
    <Page title="Comments"
      intro={<>What visitors wrote in the comment areas on your pages. Every comment waits for your OK before anyone sees it. {isOn('mail') ? <>A red number in the menu means some are waiting; you can also be emailed (<InlineLink to="/email">Settings &gt; Email</InlineLink>).</> : 'Nothing is emailed to you: a red number in the menu means some are waiting.'}<GuideLink topic="comments">How comments work</GuideLink></>}>
      <Section flush title={content ? `The comments on ${aboutOf({ type, id: content })}` : 'Comments'}>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-border bg-muted/40 px-4 py-2.5 sm:px-5">
          <div className="flex items-center gap-2">
            <label htmlFor="comments-view" className="text-sm font-semibold">Show</label>
            <NativeSelect id="comments-view" className="w-auto" value={view} onChange={(e) => set({ view: e.target.value })}>
              <option value="waiting">Waiting for your OK{data.data?.waiting ? ` (${data.data.waiting})` : ''}</option>
              <option value="shown">Shown on your pages</option>
              <option value="all">All</option>
              <option value="trash">In the trash</option>
            </NativeSelect>
          </div>
          {areas.length > 1 && (
            <div className="flex items-center gap-2">
              <label htmlFor="comments-area" className="text-sm font-semibold">Area</label>
              <NativeSelect id="comments-area" className="w-auto min-w-40" value={area} onChange={(e) => set({ area: e.target.value, type: '', content: '' })}>
                <option value="">All of them</option>
                {areas.map((a) => <option key={a.id} value={String(a.id)}>{a.title}</option>)}
              </NativeSelect>
            </div>
          )}
          {content && <Button variant="outline" size="sm" className="sm:ml-auto" onClick={() => set({ type: '', content: '' })}>Every conversation</Button>}
        </div>
        {!data.data ? <Loading /> : (
          <List label="Comments">
            {data.data.responses.length === 0 && <Empty>{view === 'waiting' ? 'Nothing is waiting for your OK.' : 'No comments here yet.'}</Empty>}
            {data.data.responses.map((m) => <CommentRow key={m.id} m={m} area={areaOf(m)} trashDays={data.data!.trashDays} inTrash={view === 'trash'}
              onConversation={() => m.thread && set({ view: 'all', area: String(m.formId), type: m.thread.type, content: m.thread.id })} />)}
          </List>
        )}
      </Section>
      <Areas areas={areas} />
    </Page>
  );
}

function CommentRow({ m, area, trashDays, inTrash, onConversation }: { m: FormResponse; area: Area | undefined; trashDays: number; inTrash: boolean; onConversation: () => void }) {
  const run = useAction();
  const qc = useQueryClient();
  const after = () => qc.invalidateQueries();
  // who and what, as the page will show it: the first name-ish answer and the first long one
  const author = m.sender ? (m.sender.name || m.sender.username) : answerText(m.answers.find((a) => a.type === 'name' || a.type === 'short-text')?.value) || 'Someone';
  const body = answerText(m.answers.find((a) => a.type === 'long-text')?.value);
  const others = m.answers.filter((a) => a.type !== 'long-text' && a !== m.answers.find((x) => x.type === 'name' || x.type === 'short-text') && a.value !== null && a.value !== '');
  return (
    <Row highlight={!m.approvedAt && !inTrash} title={<>{author} <span className="font-normal text-muted-foreground">on {aboutOf(m.thread)}</span></>}
      badges={<>{m.approvedAt ? <Badge variant="ok">shown</Badge> : !inTrash && <Badge variant="warn">waiting</Badge>}{area && <Badge variant="outline">{area.title}</Badge>}</>}
      meta={<Facts items={[formatTime(m.createdAt), m.approvedAt ? `approved${m.approvedBy ? ` by ${m.approvedBy}` : ''} ${formatTime(m.approvedAt)}` : null]} />}
      footer={inTrash
        ? <ActionButton icon={ArchiveRestore} onClick={() => run(() => api(`/api/responses/${m.id}/restore`, {}), 'Comment restored.')}>Restore</ActionButton>
        : <>
          <ActionButton variant={m.approvedAt ? 'outline' : 'default'} icon={m.approvedAt ? Undo2 : BadgeCheck} onClick={async () => {
            await run(() => api(`/api/responses/${m.id}/approve`, { approved: !m.approvedAt }), m.approvedAt ? 'Taken off your page.' : 'Approved: it is on your page now.');
            await after();
          }}>{m.approvedAt ? 'Take it off the page' : 'Approve'}</ActionButton>
          {m.thread && <ActionButton variant="outline" icon={MessageSquare} onClick={onConversation}>The whole conversation</ActionButton>}
          <ActionButton variant="danger" icon={Trash2} onClick={async () => {
            await run(() => api(`/api/responses/${m.id}/trash`, {}), `Moved to the trash. You can restore it for ${trashDays} days.`);
            await after();
          }}>Move to trash</ActionButton>
        </>}>
      <p className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{body || <span className="text-muted-foreground">(no words)</span>}</p>
      {others.length > 0 && <p className="mt-1 text-sm text-muted-foreground">{others.map((a) => `${a.label}: ${answerText(a.value)}`).join(' · ')}</p>}
    </Row>
  );
}

// The comment areas: what each asks, where it goes, and a new one (C7: they
// live here, not in Forms; the questions are changed in the same builder).
function Areas({ areas }: { areas: Area[] }) {
  const run = useAction();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [about, setAbout] = useState('page');
  const [table, setTable] = useState('');
  const [code, setCode] = useState<number | null>(null);
  const make = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await run(() => api<{ form: Area }>('/api/forms', { name, title: title || undefined, kind: 'comments', contentType: about === 'page' ? 'page' : table }),
      (x) => `The comment area "${x.form.title}" is ready. Put its two lines on a page.`);
    if (r) { setName(''); setTitle(''); setCode(r.form.id); await qc.invalidateQueries(); }
  };
  return (
    <Section title="Comment areas" intro="A comment area is what a page shows: the comments, and a box to write one. One area can be on as many pages as you like; each page (or each record) is its own conversation.">
      {areas.length === 0 && <p className="text-sm text-muted-foreground">No comment areas yet. Make one below.</p>}
      <ul className="space-y-4">
        {areas.map((a) => (
          <li key={a.id} className="rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{a.title}</span>
              <code className="rounded bg-muted px-1 py-0.5 text-xs">{a.name}</code>
              {a.fixture && <Badge variant="outline" title="The blog example's own: it keeps only its newest 50, and its comments never make a red number.">example</Badge>}
              <span className="text-sm text-muted-foreground">
                {a.contentType === 'page' ? 'about the pages it is on' : `about ${a.contentType} (each needs its content-id)`} · {a.responses} {a.responses === 1 ? 'comment' : 'comments'}
              </span>
              <label className="ml-auto flex items-center gap-2 text-sm">
                <Switch checked={a.enabled} aria-label={`${a.title} takes new comments`}
                  onCheckedChange={(v) => void run(() => api(`/api/forms/${a.id}/switches`, { enabled: v }), v ? 'It takes new comments again.' : 'Closed: the comments stay, and no new ones can be sent.')} />
                Open
              </label>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" asChild><Link to={`/forms/${a.id}`}><Pencil />Change what it asks</Link></Button>
              <Button variant="outline" size="sm" onClick={() => setCode(code === a.id ? null : a.id)} aria-pressed={code === a.id}>Code for a page</Button>
            </div>
            <AreaCopy area={a} />
            {code === a.id && <CodeBlock code={componentCode(a.name, a.contentType ?? 'page')} copied="The two lines are copied. Paste them into your page."
              intro={a.contentType === 'page' ? 'Put these two lines where the comments should appear, on any page. Each page gets its own conversation.' : `Put these where the comments should appear, with the id of the ${a.contentType} in content-id.`} />}
          </li>
        ))}
      </ul>
      <form className="mt-5 grid gap-3 border-t border-border pt-4 sm:grid-cols-2" onSubmit={make}>
        <h3 className="text-sm font-semibold sm:col-span-2">A new comment area</h3>
        <Field label="Name for the page" htmlFor="ca-name" hint="Lowercase words joined with hyphens, like page-comments. It can't be changed later.">
          <Input id="ca-name" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="off" />
        </Field>
        <Field label="Title (for you)" htmlFor="ca-title">
          <Input id="ca-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Comments on my pages" />
        </Field>
        <Field label="What people comment on" htmlFor="ca-about">
          <NativeSelect id="ca-about" value={about} onChange={(e) => setAbout(e.target.value)}>
            <option value="page">The page it is on</option>
            <option value="table">Records of one of my {W.app.many} (blog posts, recipes...)</option>
          </NativeSelect>
        </Field>
        {about === 'table' && (
          <Field label="Which table" htmlFor="ca-table" hint="Its name, like posts. The page gives each record's id.">
            <Input id="ca-table" value={table} onChange={(e) => setTable(e.target.value)} required pattern="[a-z][a-z0-9_]*" autoComplete="off" />
          </Field>
        )}
        <div className="sm:col-span-2"><Button type="submit"><Plus />Make the comment area</Button></div>
      </form>
    </Section>
  );
}


// Which of her apps keeps an area's approved comments (docs/comments-plan.md
// C9, A1): the account manager's choice; apps without comments tables say so.
function AreaCopy({ area }: { area: Area }) {
  const me = useMe();
  const run = useAction();
  const allowed = !!me && may(me, 'databases');
  const st = useApi<{ link: { engine: string; name: string; enabled: boolean } | null; databases: { engine: string; name: string; title: string; active: boolean }[] }>(
    allowed ? `/api/forms/${area.id}/database` : null, { meta: { quiet: true } });
  if (!allowed || !st.data) return null;
  const now = st.data.link ? `${st.data.link.engine}/${st.data.link.name}` : '';
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
      <label htmlFor={`copy-${area.id}`} className="text-muted-foreground">Keep the approved comments in</label>
      <NativeSelect id={`copy-${area.id}`} className="w-auto min-w-44" value={now} onChange={(e) => {
        const [engine, name] = e.target.value ? e.target.value.split('/') : [null, null];
        void run(() => api(`/api/forms/${area.id}/comments-copy`, { engine, name }),
          engine ? `The approved comments are kept in ${name} from now on.` : `Not kept in any ${W.app.one} now.`);
      }}>
        <option value="">no {W.app.one} (Comments only)</option>
        {st.data.databases.filter((d) => d.active).map((d) => <option key={`${d.engine}/${d.name}`} value={`${d.engine}/${d.name}`}>{d.title}</option>)}
      </NativeSelect>
    </div>
  );
}
