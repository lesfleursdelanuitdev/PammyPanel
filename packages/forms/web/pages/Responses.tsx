import { useQueryClient } from '@tanstack/react-query';
import { ArchiveRestore, BadgeCheck, CheckCheck, ChevronsDown, Mail, MailOpen, Reply, RotateCw, Trash2, Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ActionButton, Collapsible, Empty, Facts, InlineLink, List, Loading, Page, Row, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { NativeSelect } from '@panel/core/web/components/ui/native-select';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { api, formatTime } from '@panel/core/web/lib/api';
import { answerText } from '../lib/form-items';
import { notify } from '@panel/core/web/lib/status';
import type { Answer, FormResponse, FormsData, ResponsesData } from '../lib/types';
import { isOn, SITE, W } from '@panel/core/web/lib/site';

export function Responses() {
  usePageTitle('Responses');
  const [params, setParams] = useSearchParams();
  const form = params.get('form') ?? '';
  const [read, setRead] = useState('');          // '' | 'unread' | 'read'
  const [approval, setApproval] = useState('');
  const [pages, setPages] = useState(1);            // "Show older" asks for one more page
  const [trashOpen, setTrashOpen] = useState(false);
  const forms = useApi<FormsData>('/api/forms');
  const run = useAction();
  const qc = useQueryClient();

  const filter = `${form ? `&form=${encodeURIComponent(form)}` : ''}${read ? `&read=${read}` : ''}${approval ? `&approval=${approval}` : ''}`;
  useEffect(() => { setPages(1); }, [filter]);
  const inbox = useApi<ResponsesData>(`/api/responses?view=inbox${filter}&pages=${pages}`, {
    queryFn: async () => {
      // one request per page of 100, each older than the last
      let before: number | null = null;
      const all: FormResponse[] = [];
      let last: ResponsesData | null = null;
      for (let i = 0; i < pages; i++) {
        last = await api<ResponsesData>(`/api/responses?view=inbox${filter}${before ? `&before=${before}` : ''}`);
        all.push(...last.responses);
        if (!last.responses.length || !last.more) break;
        before = last.responses[last.responses.length - 1]!.id;
      }
      return { ...last!, responses: all };
    },
    placeholderData: (prev) => prev,
  });
  const trash = useApi<ResponsesData>(trashOpen ? '/api/responses?view=trash' : null);

  useEffect(() => {
    if (inbox.data) qc.setQueryData(['/api/responses/unread'], { unread: inbox.data.unread });
  }, [inbox.data, qc]);

  const chosenForm = forms.data?.forms.find((f) => String(f.id) === form);
  const waiting = inbox.data?.unread ?? 0;
  // the form's title as it is now, falling back to the name it was sent with
  const titleOf = (m: FormResponse) => forms.data?.forms.find((f) => f.id === m.formId)?.title ?? m.formName;
  // Entries on one of the worked examples: in the list like everything else, but
  // marked, and never part of the red number (docs/examples-plan.md, D9).
  const isExample = (m: FormResponse) => !!forms.data?.forms.find((f) => f.id === m.formId)?.fixture;
  return (
    <Page title="Responses" intro={isOn('mail')
      // email notices (Settings > Email) are off until ticked, so the page says where they are
      ? <>What people sent through the forms on {W.website.your}, newest first. A red number in the menu means some are unread; you can also be emailed about new ones (<InlineLink to="/email">Settings &gt; Email</InlineLink>).</>
      : 'What people sent through the forms on your website, newest first. Nothing is emailed to you, so check here now and then. A red number in the menu means some are unread.'}>
      <Section flush title="Inbox">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-border bg-muted/40 px-4 py-2.5 sm:px-5">
          <div className="flex items-center gap-2">
            <label htmlFor="response-form-filter" className="text-sm font-semibold">Form</label>
            <NativeSelect id="response-form-filter" className="w-auto min-w-44" value={form} onChange={(e) => setParams(e.target.value ? { form: e.target.value } : {}, { replace: true })}>
              <option value="">All forms</option>
              {forms.data?.forms.filter((f) => f.kind !== 'comments').map((f) => <option key={f.id} value={String(f.id)}>{f.title}</option>)}
            </NativeSelect>
          </div>
          {(chosenForm?.approvable || approval) && (
            <div className="flex items-center gap-2">
              <label htmlFor="response-approval-filter" className="text-sm font-semibold">Approved</label>
              <NativeSelect id="response-approval-filter" className="w-auto" value={approval} onChange={(e) => setApproval(e.target.value)}>
                <option value="">All</option>
                <option value="approved">Approved</option>
                <option value="waiting">Not approved</option>
              </NativeSelect>
            </div>
          )}
          <div className="flex items-center gap-2">
            <label htmlFor="response-read-filter" className="text-sm font-semibold">Show</label>
            <NativeSelect id="response-read-filter" className="w-auto" value={read} onChange={(e) => setRead(e.target.value)}>
              <option value="">All</option>
              <option value="unread">Unread{waiting > 0 ? ` (${waiting})` : ''}</option>
              <option value="read">Read</option>
            </NativeSelect>
          </div>
          <ActionButton className="sm:ml-auto" icon={CheckCheck} onClick={async () => {
            const r = await run(() => api<{ marked: number }>('/api/responses/read-all', form ? { formId: Number(form) } : {}));
            if (r) notify(r.marked ? `${r.marked} response${r.marked === 1 ? '' : 's'} marked as read.` : 'Nothing was unread.');
          }}>Mark all as read</ActionButton>
        </div>
        {!inbox.data ? <Loading /> : (
          <List label="Responses">
            {inbox.data.responses.length === 0 && <Empty>{read === 'unread' ? 'Nothing unread.' : read === 'read' ? 'Nothing read yet.' : 'No responses yet.'}</Empty>}
            {inbox.data.responses.map((m) => <ResponseRow key={m.id} m={m} title={titleOf(m)} example={isExample(m)} trashDays={inbox.data!.trashDays} />)}
          </List>
        )}
        {inbox.data?.more && (
          <div className="border-t border-border p-3 text-center"><Button variant="ghost" disabled={inbox.isFetching} onClick={() => setPages((p) => p + 1)}><ChevronsDown />Show older</Button></div>
        )}
      </Section>
      <Collapsible summary={<><Trash2 className="size-4" />Trash</>} onToggle={setTrashOpen}>
        <p className="mb-3 text-muted-foreground">Responses you moved to the trash. Restore them within 30 days; after that they're deleted for good.</p>
        {!trash.data ? <Loading rows={1} /> : (
          <List label="Trashed responses">
            {trash.data.responses.length === 0 && <Empty>The trash is empty.</Empty>}
            {trash.data.responses.map((m) => <ResponseRow key={m.id} m={m} title={titleOf(m)} example={isExample(m)} trashDays={trash.data!.trashDays} inTrash />)}
          </List>
        )}
      </Collapsible>
    </Page>
  );
}

function AnswerValue({ a }: { a: Answer }) {
  const text = answerText(a.value);
  if (text === '') return <span className="text-muted-foreground">(left empty)</span>;
  if (a.type === 'email') return <a href={`mailto:${text}`}>{text}</a>;
  if (a.type === 'phone') return <a href={`tel:${text.replace(/[^+0-9]/g, '')}`}>{text}</a>;
  if (a.type === 'website') return <a href={text} target="_blank" rel="noopener">{text}</a>;
  if (a.type === 'rating') return <>{text} star{text === '1' ? '' : 's'}</>;
  return <>{text}</>;
}

function Answers({ m }: { m: FormResponse }) {
  return (
    <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-[minmax(8rem,max-content)_1fr]">
      {m.answers.map((a, i) => (
        <div key={i} className="contents">
          <dt className="text-[0.8125rem] font-medium text-muted-foreground sm:pt-0.5">{a.label}</dt>
          <dd className="whitespace-pre-wrap [overflow-wrap:anywhere]"><AnswerValue a={a} /></dd>
        </div>
      ))}
    </dl>
  );
}

function ResponseRow({ m, title, trashDays, example = false, inTrash = false }:
  { m: FormResponse; title: string; trashDays: number; example?: boolean; inTrash?: boolean }) {
  const run = useAction();
  const qc = useQueryClient();
  const unread = !m.readAt && !inTrash;
  const email = m.answers.find((a) => a.type === 'email' && a.value);
  const after = () => qc.invalidateQueries({ queryKey: ['/api/responses?view=inbox'], exact: false });
  return (
    <Row highlight={unread} title={title}
      badges={<>
        {unread && <Badge variant="solid">unread</Badge>}
        {m.approvedAt && <Badge variant="ok">approved</Badge>}
        {example && <Badge>example</Badge>}
      </>}
      meta={<Facts items={[
        formatTime(m.createdAt), m.page ? `from ${m.page}` : null,
        m.sender && `sent by ${m.sender.name ? `${m.sender.name} (${m.sender.username})` : m.sender.username}, signed in`,
        m.approvedAt ? `approved${m.approvedAuto ? ' automatically' : m.approvedBy ? ` by ${m.approvedBy}` : ''} ${formatTime(m.approvedAt)}` : null,
        inTrash ? `moved to the trash${m.trashedBy ? ` by ${m.trashedBy}` : ''} ${formatTime(m.trashedAt)}, deleted for good after ${formatTime((m.trashedAt ?? 0) + trashDays * 86400)}`
          : m.readAt ? `read${m.readBy ? ` by ${m.readBy}` : ''} ${formatTime(m.readAt)}` : null,
      ]} />}
      footer={inTrash
        ? <ActionButton icon={ArchiveRestore} onClick={() => run(() => api(`/api/responses/${m.id}/restore`, {}), 'Response restored.')}>Restore</ActionButton>
        : <>
          {m.approvable && (
            <ActionButton variant={m.approvedAt ? 'outline' : 'default'} icon={m.approvedAt ? Undo2 : BadgeCheck}
              onClick={async () => {
                // a form that saves answers on approval says where it went, or why not
                await run(() => api<{ saved?: { saved: boolean | null; table?: string; label?: string; problem?: string } | null }>(`/api/responses/${m.id}/approve`, { approved: !m.approvedAt }),
                  (r) => (m.approvedAt ? 'No longer approved.'
                    : r.saved?.saved === true ? `Approved, and saved in ${r.saved.table} as ${r.saved.label}.`
                      : r.saved?.saved === false ? `Approved. It could not be saved in the database: ${r.saved.problem}` : 'Approved.'));
                await after();
              }}>{m.approvedAt ? 'Unapprove' : 'Approve'}</ActionButton>
          )}
          <ActionButton variant={unread ? 'default' : 'outline'} icon={unread ? MailOpen : Mail}
            onClick={() => run(() => api(`/api/responses/${m.id}/read`, { read: unread }))}>{unread ? 'Mark as read' : 'Mark as unread'}</ActionButton>
          {email && (
            <Button asChild size="sm" variant="outline">
              <a href={`mailto:${answerText(email.value)}?subject=${encodeURIComponent(`Re: your message to ${SITE.domain}`)}`} className="no-underline"><Reply />Reply by email</a>
            </Button>
          )}
          <ActionButton variant="danger" icon={Trash2} onClick={() => run(() => api(`/api/responses/${m.id}/trash`, {}), `Moved to the trash. You can restore it for ${trashDays} days.`)}>Move to trash</ActionButton>
        </>}>
      {!inTrash && m.savedTo && (
        <p className="mt-2 text-sm">
          Saved in {m.savedTo.plural} as{' '}
          <Link to={`/app/${m.savedTo.engine}/${m.savedTo.name}/${m.savedTo.table}/edit?${new URLSearchParams(Object.entries(m.savedTo.key).map(([k, v]) => [k, String(v)])).toString()}`}
            className="font-medium text-primary underline-offset-4 hover:underline">{m.savedTo.label}</Link>
        </p>
      )}
      {!inTrash && !m.savedTo && m.saveProblem && (
        <div role="status" className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm">
          <span className="mr-auto">
            {/* unsure: the database took the answers and then went quiet, so it
                may be there already -- pressing Try again could make a second one */}
            {m.saveState === 'unsure' ? 'Not sure whether this was saved: ' : 'Not saved in the database yet: '}
            {m.saveProblem}{m.saveRetry ? ' It will be tried again on its own.' : ''}
          </span>
          <ActionButton variant="outline" icon={RotateCw} onClick={async () => {
            const r = await run(() => api<{ result: { saved: boolean | null; problem?: string; why?: string; table?: string; label?: string } }>(`/api/responses/${m.id}/save-again`, {}));
            if (r?.result.saved === true) notify(`Saved in ${r.result.table} as ${r.result.label}.`);
            else if (r) notify(r.result.problem ?? r.result.why ?? 'It could not be saved.', 'error');
            await after();
          }}>Try again</ActionButton>
        </div>
      )}
      {inTrash
        ? <details className="mt-2"><summary className="cursor-pointer text-sm font-semibold text-primary">Show the answers</summary><Answers m={m} /></details>
        : <Answers m={m} />}
    </Row>
  );
}
