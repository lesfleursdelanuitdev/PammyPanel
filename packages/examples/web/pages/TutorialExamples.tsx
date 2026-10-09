// Databases › Tutorial examples (docs/tutorial-examples-plan.md): the finished
// pages of guides 15-18, working, here on panel.pammy.org and nowhere on her
// website. Two databases the panel owns (example_journal, example_todo) and the
// four pages: the guides' own files, with only the database's name changed. She
// builds her own copy on pammy.org by following the guide.
import { BookOpen, Boxes, ExternalLink as ExternalLinkIcon, GraduationCap, Monitor, RotateCcw, Shapes, Smartphone } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { ActionButton, Loading, Page, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { api } from '@panel/core/web/lib/api';
import { cn } from '@panel/core/web/lib/utils';
import { SITE, W } from '@panel/core/web/lib/site';

type Demo = { folder: string; guide: number; heading: string; href: string };
type TutorialExample = { kind: string; heading: string; about: string; database: string; setUp: boolean; demos: Demo[] };

// the Help tab's address for each guide: its file name without the number
const GUIDES: Record<number, string> = {
  15: '/help/a-blog-with-javascript',
  16: '/help/a-blog-with-php',
  17: '/help/a-to-do-list-with-javascript',
  18: '/help/a-to-do-list-with-php',
};
const ABOUT: Record<string, string> = {
  journal: 'The list of published posts, newest first, and a page for each. The JavaScript asks for them when the page opens.',
  'journal-php': 'The same journal, made on the server by PHP: the page arrives finished. Look at its source: the posts are already in it.',
  todo: 'Your own list: add, tick off and delete. Each account in the control panel has its own, as each person signed in to your folder will.',
  'todo-php': 'The same tasks, with plain forms and PHP. A task added here is on the JavaScript one too: it is the same database.',
};

export default function TutorialExamples() {
  usePageTitle('Tutorial examples');
  const data = useApi<{ examples: TutorialExample[]; ready: boolean }>('/api/tutorial-examples');
  const run = useAction();
  const dialogs = useDialogs();
  // bumped after setting up, so the frames are read again
  const [shown, setShown] = useState(0);

  const setUp = async () => {
    const r = await run(() => api('/api/tutorial-examples/setup', {}), 'The tutorial examples are ready.');
    if (r) {
      setShown((n) => n + 1);
      void data.refetch();
    }
  };
  const reset = async () => {
    const ok = await dialogs.confirm({
      title: 'Put the tutorial examples back as they were?',
      body: <>Both example databases are made again from the start, with their sample posts. <strong>Anything added to them goes, and so does every to-do list in the example.</strong> Your own journal and to-do list, if you have made them, are not touched.</>,
      action: 'Put them back', danger: true,
    });
    if (ok) await setUp();
  };

  return (
    <Page wide title="Tutorial examples"
      intro={`What the four tutorials on the Help tab build, finished and working: a journal and a to-do list, each once in HTML and JavaScript and once in PHP. They are here in the control panel, not on your website. Follow a tutorial to make your own copy on ${SITE.domain}.`}>
      {!data.data ? <Loading /> : !data.data.ready ? (
        <Section title="Set them up"
          intro={`The panel makes two example databases on your Postgres — example_journal, with some sample posts, and example_todo — switches their ${W.app.many} on, and puts the four pages here. It asks for your passkey.`}>
          <Button onClick={() => void setUp()}><GraduationCap />Set up the tutorial examples</Button>
        </Section>
      ) : <>
        {data.data.examples.flatMap((e) => e.demos.map((d) => <DemoFrame key={`${d.folder}-${shown}`} example={e} demo={d} />))}

        <Section title="Look inside"
          intro={`The examples' databases, in the Database Manager like any other. Add a post in the journal's ${W.app.one} and it is on both journal pages.`}>
          <ul className="divide-y divide-border text-sm">
            {data.data.examples.map((e) => (
              <li key={e.kind} className="flex flex-wrap items-center gap-2 py-2.5">
                <span className="mr-auto"><strong>{e.heading}</strong> <code className="text-muted-foreground">{e.database}</code> — <span className="text-muted-foreground">{e.about}</span></span>
                <Button variant="outline" size="sm" asChild><Link to={`/databases/postgres/${e.database}/canvas`}><Shapes />The canvas</Link></Button>
                <Button variant="outline" size="sm" asChild><Link to={`/databases/postgres/${e.database}/app`}><Boxes />Its {W.app.one} settings</Link></Button>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Put them back as they were" intro="Changed an example until it no longer makes sense? This makes both example databases again, exactly as they were shipped.">
          <ActionButton icon={RotateCcw} onClick={() => void reset()}>Put them back as they were</ActionButton>
        </Section>
      </>}
    </Page>
  );
}

function DemoFrame({ example, demo }: { example: TutorialExample; demo: Demo }) {
  const [width, setWidth] = useState<'desktop' | 'phone'>('desktop');
  return (
    <Section title={demo.heading} intro={ABOUT[demo.folder]}
      action={<div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">Guide {demo.guide}</Badge>
        <Button variant="outline" size="sm" asChild><Link to={GUIDES[demo.guide] ?? '/help'}><BookOpen />The tutorial</Link></Button>
      </div>}>
      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-3 py-2">
          <code className="mr-auto truncate rounded bg-background px-2 py-1 text-xs text-muted-foreground">{demo.href}</code>
          <div className="flex gap-1 rounded-md border border-border p-0.5">
            <Button size="sm" variant={width === 'desktop' ? 'light' : 'ghost'} aria-pressed={width === 'desktop'} onClick={() => setWidth('desktop')}><Monitor />Computer</Button>
            <Button size="sm" variant={width === 'phone' ? 'light' : 'ghost'} aria-pressed={width === 'phone'} onClick={() => setWidth('phone')}><Smartphone />Phone</Button>
          </div>
          <Button size="sm" variant="ghost" asChild>
            <a href={demo.href} target="_blank" rel="noreferrer noopener"><ExternalLinkIcon />Open it in a tab</a>
          </Button>
        </div>
        <div className="flex justify-center bg-muted/30 p-3">
          <iframe src={demo.href} title={`${demo.heading} (example)`}
            className={cn('h-[36rem] max-h-[75vh] rounded-md border border-border bg-white', width === 'phone' ? 'w-[24rem] max-w-full' : 'w-full')} />
        </div>
        <p className="border-t border-border px-4 py-2.5 text-sm text-muted-foreground">
          The tutorial's own files, reading {example.database} instead of the database you will make.
        </p>
      </div>
    </Section>
  );
}
