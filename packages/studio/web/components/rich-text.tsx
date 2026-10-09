// The rich-text editor (docs/rich-text-plan.md): a field she writes in with
// headings, lists, links and tables, stored as HTML.
//
// It can only MAKE what the cleaner keeps (src/studio/rich-text.ts, T4): the
// extensions below are that list, so pasting from Word or Google Docs keeps
// the headings, lists, links and tables and drops fonts, colours and pictures
// as it arrives. That is a convenience -- the panel cleans whatever it is sent
// all over again, because anyone can send anything.
//
// On a phone (T21-T25): 16px text (smaller and iPhone Safari zooms the page
// when she taps in), a toolbar that sticks under the panel's header while she
// scrolls a long post, one row of buttons at least 44px square with the rest
// under More, and choices in a sheet from the bottom of the screen instead of
// small menus. Toolbar buttons do not take the focus, so the on-screen
// keyboard stays up while she makes something bold.
//
// Loaded only on a form that has a rich-text field (AppRecord.tsx, lazy), so
// the rest of the panel does not download it.
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { Dialog as DialogPrimitive } from 'radix-ui';
import {
  Bold, Heading, Italic, Link2, List, ListOrdered, Minus, MoreHorizontal, Quote, Redo2, Strikethrough,
  Table as TableIcon, Underline, Undo2, X,
} from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from '@panel/core/web/components/ui/button';
import { Input } from '@panel/core/web/components/ui/input';
import { useNarrow } from '@panel/core/web/hooks/useNarrow';
import { cn } from '@panel/core/web/lib/utils';

// ------------------------------------------------------------------ what it can hold

// A table cell holds writing and lists -- not headings, quotes or another
// table (T18). The cleaner flattens those if they arrive some other way.
const CELL = '(paragraph | bulletList | orderedList)+';

// T5, the same rule as the cleaner's: a web address, an email, a phone number,
// or somewhere on her own site. Checked here so she is told at once, rather
// than finding the link quietly gone after saving.
const SCHEMES = ['https', 'http', 'mailto', 'tel'];
export function linkProblem(href: string): string | null {
  const bare = href.replace(/[\u0000-\u0020\u007f-\u009f]/g, '');
  if (!bare) return 'Type an address first.';
  if (/^[\\/]{2}/.test(bare)) return 'Start a web address with https://';
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(bare)?.[1]?.toLowerCase();
  if (scheme && !SCHEMES.includes(scheme)) {
    return 'A link can go to a web address (https://…), an email (mailto:…), a phone number (tel:…) or a page on your own site (/…).';
  }
  return null;
}
// `example.org/page` is a web address she forgot the start of
const withScheme = (href: string): string =>
  (/^[a-z0-9-]+(\.[a-z0-9-]+)+([/?#]|$)/i.test(href) && !href.includes('@') ? `https://${href}` : href);

// ------------------------------------------------------------------ the editor

export function RichTextEditor({ id, label, value, onChange, disabled = false }: {
  id: string;
  label: string;
  // clean HTML from the panel ('' for nothing)
  value: string;
  onChange: (html: string) => void;
  disabled?: boolean;
}) {
  // what this editor last said, so a value coming back from the form is not
  // put back in (which would move the cursor to the end while she types)
  const said = useRef(value);
  const [linking, setLinking] = useState(false);

  const editor = useEditor({
    // the panel's security policy refuses a <style> the page did not bring,
    // so Tiptap's own is in index.css instead (".ProseMirror")
    injectCSS: false,
    editable: !disabled,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    extensions: [
      StarterKit.configure({
        code: false,
        codeBlock: false,
        heading: { levels: [2, 3, 4] },
        link: {
          openOnClick: false,
          autolink: true,
          linkOnPaste: true,
          defaultProtocol: 'https',
          protocols: ['mailto', 'tel'],
          isAllowedUri: (url) => linkProblem(url) === null,
          // the panel decides rel when it saves; no target, ever
          HTMLAttributes: { rel: 'noopener noreferrer', target: null },
        },
      }),
      // no dragging column edges: it cannot be done with a finger, and the
      // widths would be thrown away when it is saved anyway (T19)
      Table.configure({ resizable: false, allowTableNodeSelection: false }),
      TableRow,
      TableHeader.extend({ content: CELL }),
      TableCell.extend({ content: CELL }),
    ],
    content: value || '',
    editorProps: {
      attributes: {
        id,
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': label,
        class: 'rich-text-content',
      },
      // Ctrl/Cmd+K: add a link, as in every word processor
      handleKeyDown: (_view, e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { setLinking(true); return true; }
        return false;
      },
    },
    onUpdate: ({ editor: ed }) => {
      const html = ed.isEmpty ? '' : ed.getHTML();
      said.current = html;
      onChange(html);
    },
  });

  // a value from outside -- the record arriving after the page drew
  useEffect(() => {
    if (!editor || value === said.current) return;
    said.current = value;
    editor.commands.setContent(value || '', { emitUpdate: false });
  }, [editor, value]);

  useEffect(() => { editor?.setEditable(!disabled); }, [editor, disabled]);

  if (!editor) return null;
  return (
    // min-w-0: without it the toolbar's width becomes the form's, and on a
    // phone the whole page scrolls sideways (found by the phone tests)
    <div className={cn('rich-text min-w-0 max-w-full rounded-md border border-input bg-card focus-within:border-primary focus-within:ring-3 focus-within:ring-primary/15', disabled && 'opacity-60')}>
      <Toolbar editor={editor} onLink={() => setLinking(true)} disabled={disabled} />
      <EditorContent editor={editor} />
      <LinkSheet editor={editor} open={linking} onClose={() => { setLinking(false); editor.commands.focus(); }} />
    </div>
  );
}

// ------------------------------------------------------------------ the toolbar

type Choice = { label: string; icon: ReactNode; run: () => void; active?: boolean; disabled?: boolean; danger?: boolean };

function Toolbar({ editor, onLink, disabled }: { editor: Editor; onLink: () => void; disabled: boolean }) {
  const narrow = useNarrow();
  const styleId = useId();
  const [menu, setMenu] = useState<'more' | 'table' | 'style' | null>(null);
  // what is on where the cursor is, re-read as she moves
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      style: e.isActive('heading', { level: 2 }) ? 'h2' : e.isActive('heading', { level: 3 }) ? 'h3' : e.isActive('heading', { level: 4 }) ? 'h4' : 'p',
      bold: e.isActive('bold'), italic: e.isActive('italic'), underline: e.isActive('underline'), strike: e.isActive('strike'),
      bullets: e.isActive('bulletList'), numbers: e.isActive('orderedList'), quote: e.isActive('blockquote'),
      link: e.isActive('link'), table: e.isActive('table'),
      undo: e.can().undo(), redo: e.can().redo(),
      merge: e.can().mergeCells(), split: e.can().splitCell(),
    }),
  });
  const chain = () => editor.chain().focus();

  const setStyle = (v: string) => {
    if (v === 'p') chain().setParagraph().run();
    else chain().setHeading({ level: Number(v.slice(1)) as 2 | 3 | 4 }).run();
  };
  const table = () => {
    if (s.table) setMenu('table');
    else chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
  };

  // on a phone the paragraph style is a button and a sheet: a menu showing
  // "Small heading" is too wide for one row of buttons (T23)
  const styles: Choice[] = [
    { label: 'Paragraph', icon: null, run: () => setStyle('p'), active: s.style === 'p' },
    { label: 'Heading', icon: null, run: () => setStyle('h2'), active: s.style === 'h2' },
    { label: 'Subheading', icon: null, run: () => setStyle('h3'), active: s.style === 'h3' },
    { label: 'Small heading', icon: null, run: () => setStyle('h4'), active: s.style === 'h4' },
  ];
  const more: Choice[] = [
    { label: 'Numbered list', icon: <ListOrdered />, run: () => chain().toggleOrderedList().run(), active: s.numbers },
    { label: 'Quote', icon: <Quote />, run: () => chain().toggleBlockquote().run(), active: s.quote, disabled: s.table },
    { label: 'Underline', icon: <Underline />, run: () => chain().toggleUnderline().run(), active: s.underline },
    { label: 'Strikethrough', icon: <Strikethrough />, run: () => chain().toggleStrike().run(), active: s.strike },
    { label: 'Dividing line', icon: <Minus />, run: () => chain().setHorizontalRule().run(), disabled: s.table },
    { label: 'Undo', icon: <Undo2 />, run: () => chain().undo().run(), disabled: !s.undo },
    { label: 'Redo', icon: <Redo2 />, run: () => chain().redo().run(), disabled: !s.redo },
  ];
  // words in a menu, not small handles on the table's edges (T17)
  const tableChoices: Choice[] = [
    { label: 'Add a row above', icon: null, run: () => chain().addRowBefore().run() },
    { label: 'Add a row below', icon: null, run: () => chain().addRowAfter().run() },
    { label: 'Add a column on the left', icon: null, run: () => chain().addColumnBefore().run() },
    { label: 'Add a column on the right', icon: null, run: () => chain().addColumnAfter().run() },
    { label: 'Header row on or off', icon: null, run: () => chain().toggleHeaderRow().run() },
    { label: 'Merge the selected cells', icon: null, run: () => chain().mergeCells().run(), disabled: !s.merge },
    { label: 'Split this cell', icon: null, run: () => chain().splitCell().run(), disabled: !s.split },
    { label: 'Delete this row', icon: null, run: () => chain().deleteRow().run(), danger: true },
    { label: 'Delete this column', icon: null, run: () => chain().deleteColumn().run(), danger: true },
    { label: 'Delete the table', icon: null, run: () => chain().deleteTable().run(), danger: true },
  ];

  return (
    <div role="toolbar" aria-label="Formatting" aria-disabled={disabled || undefined}
      // under the panel's own header (h-14), so it is in reach all the way
      // down a long post (T22)
      className="sticky top-14 z-20 flex items-center gap-0.5 overflow-x-auto rounded-t-md border-b border-border bg-card/95 p-1 backdrop-blur lg:gap-1">
      {narrow ? (
        <Tool label="Paragraph style" active={s.style !== 'p'} onClick={() => setMenu('style')} disabled={disabled || s.table} popup><Heading /></Tool>
      ) : (
        <>
          <label className="sr-only" htmlFor={styleId}>Paragraph style</label>
          <select id={styleId} value={s.style} disabled={disabled || s.table}
            onChange={(e) => setStyle(e.target.value)}
            className="h-9 shrink-0 rounded-md border border-input bg-card px-2 text-sm">
            <option value="p">Paragraph</option>
            <option value="h2">Heading</option>
            <option value="h3">Subheading</option>
            <option value="h4">Small heading</option>
          </select>
        </>
      )}
      <Tool label="Bold" active={s.bold} onClick={() => chain().toggleBold().run()} disabled={disabled}><Bold /></Tool>
      <Tool label="Italic" active={s.italic} onClick={() => chain().toggleItalic().run()} disabled={disabled}><Italic /></Tool>
      {!narrow && <Tool label="Underline" active={s.underline} onClick={() => chain().toggleUnderline().run()} disabled={disabled}><Underline /></Tool>}
      {!narrow && <Tool label="Strikethrough" active={s.strike} onClick={() => chain().toggleStrike().run()} disabled={disabled}><Strikethrough /></Tool>}
      <Tool label="Bulleted list" active={s.bullets} onClick={() => chain().toggleBulletList().run()} disabled={disabled}><List /></Tool>
      {!narrow && <Tool label="Numbered list" active={s.numbers} onClick={() => chain().toggleOrderedList().run()} disabled={disabled}><ListOrdered /></Tool>}
      {!narrow && <Tool label="Quote" active={s.quote} onClick={() => chain().toggleBlockquote().run()} disabled={disabled || s.table}><Quote /></Tool>}
      <Tool label={s.link ? 'Change the link' : 'Add a link'} active={s.link} onClick={onLink} disabled={disabled}><Link2 /></Tool>
      <Tool label={s.table ? 'Table choices' : 'Add a table'} active={s.table} onClick={table} disabled={disabled}
        popup={s.table}><TableIcon /></Tool>
      {!narrow && <Tool label="Dividing line" onClick={() => chain().setHorizontalRule().run()} disabled={disabled || s.table}><Minus /></Tool>}
      {!narrow && <Tool label="Undo" onClick={() => chain().undo().run()} disabled={disabled || !s.undo}><Undo2 /></Tool>}
      {!narrow && <Tool label="Redo" onClick={() => chain().redo().run()} disabled={disabled || !s.redo}><Redo2 /></Tool>}
      {narrow && <Tool label="More" onClick={() => setMenu('more')} disabled={disabled} popup><MoreHorizontal /></Tool>}

      <ChoiceSheet title="Paragraph style" open={menu === 'style'} onClose={() => setMenu(null)} choices={styles} />
      <ChoiceSheet title="More" open={menu === 'more'} onClose={() => setMenu(null)} choices={more} />
      <ChoiceSheet title="Table" open={menu === 'table'} onClose={() => setMenu(null)} choices={tableChoices} />
    </div>
  );
}

// One button. It does not take the focus from the writing (mousedown is not
// allowed to), so the cursor stays where it was and a phone keeps its
// keyboard up.
function Tool({ label, active, onClick, disabled, popup, children }: {
  label: string; active?: boolean; onClick: () => void; disabled?: boolean; popup?: boolean; children: ReactNode;
}) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled}
      aria-pressed={popup ? undefined : !!active} aria-haspopup={popup ? 'dialog' : undefined}
      onMouseDown={(e) => e.preventDefault()} onClick={onClick}
      className={cn(
        // at least 44px square on a phone (T23)
        'grid size-11 shrink-0 place-items-center rounded-md text-foreground transition-colors lg:size-9',
        'hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40 [&_svg]:size-5 lg:[&_svg]:size-4',
        active && 'bg-primary-soft text-primary',
      )}>
      {children}
    </button>
  );
}

// ------------------------------------------------------------------ choices and the link

// A sheet from the bottom of the screen on a phone, a small window on a
// computer (T24): big rows either way, each one word or a few.
function Sheet({ title, open, onClose, children }: { title: string; open: boolean; onClose: () => void; children: ReactNode }) {
  const narrow = useNarrow();
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[rgb(20_12_26/0.45)] data-[state=open]:animate-[fade-in_150ms_ease-out]" />
        <DialogPrimitive.Content
          // back to the writing, not to the button, so she can go on typing
          onCloseAutoFocus={(e) => e.preventDefault()}
          aria-describedby={undefined}
          className={cn(
            'fixed z-50 flex max-h-[85dvh] flex-col overflow-hidden border border-border bg-popover text-popover-foreground shadow-pop',
            narrow
              ? 'inset-x-0 bottom-0 rounded-t-xl pb-[env(safe-area-inset-bottom)] data-[state=open]:animate-[slide-in-bottom_200ms_ease-out]'
              : 'left-1/2 top-1/2 w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-lg data-[state=open]:animate-[zoom-in_160ms_ease-out]',
          )}>
          <div className="flex items-center justify-between border-b border-border py-2 pl-4 pr-2">
            <DialogPrimitive.Title className="text-base font-semibold">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close className="grid size-11 place-items-center rounded-md text-muted-foreground hover:bg-accent lg:size-9">
              <X className="size-5" /><span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          </div>
          <div className="overflow-y-auto">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function ChoiceSheet({ title, open, onClose, choices }: { title: string; open: boolean; onClose: () => void; choices: Choice[] }) {
  return (
    <Sheet title={title} open={open} onClose={onClose}>
      <ul className="py-1">
        {choices.map((c) => (
          <li key={c.label}>
            <button type="button" disabled={c.disabled} aria-pressed={c.active === undefined ? undefined : c.active}
              onClick={() => { onClose(); c.run(); }}
              className={cn(
                'flex min-h-12 w-full items-center gap-3 px-4 text-left text-base hover:bg-accent disabled:opacity-40 [&_svg]:size-5',
                c.danger && 'text-destructive',
                c.active && 'font-semibold text-primary',
              )}>
              {c.icon}{c.label}
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

function LinkSheet({ editor, open, onClose }: { editor: Editor; open: boolean; onClose: () => void }) {
  const hrefId = useId();
  const wordsId = useId();
  const [href, setHref] = useState('');
  const [words, setWords] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  // nothing selected and not on a link: she types the words to show as well
  const [needWords, setNeedWords] = useState(false);

  useEffect(() => {
    if (!open) return;
    const current = editor.getAttributes('link').href as string | undefined;
    if (current) editor.chain().extendMarkRange('link').run();
    setHref(current ?? '');
    setWords('');
    setProblem(null);
    setNeedWords(!current && editor.state.selection.empty);
  }, [open]);

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    // the sheet is drawn elsewhere on the page (a portal), but React still
    // hands its submit on to the record's own form around the editor --
    // which would save the whole record and leave the page (found by test)
    e.stopPropagation();
    const to = withScheme(href.trim());
    const why = linkProblem(to);
    if (why) { setProblem(why); return; }
    if (needWords) {
      const text = words.trim() || to;
      // the space after it is not part of the link, so she can type on
      editor.chain().focus().insertContent([
        { type: 'text', text, marks: [{ type: 'link', attrs: { href: to } }] },
        { type: 'text', text: ' ' },
      ]).run();
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href: to }).run();
    }
    onClose();
  };
  const remove = () => { editor.chain().focus().extendMarkRange('link').unsetLink().run(); onClose(); };
  const had = !!editor.getAttributes('link').href;

  return (
    <Sheet title={had ? 'Change the link' : 'Add a link'} open={open} onClose={onClose}>
      <form className="grid gap-4 p-4" onSubmit={save}>
        <div className="grid gap-1.5">
          <label htmlFor={hrefId} className="text-sm font-medium">Where it goes</label>
          {/* a keyboard with / and .com, without the browser refusing /recipes.html (T24) */}
          <Input id={hrefId} inputMode="url" autoComplete="off" autoCapitalize="off" spellCheck={false} autoFocus
            className="h-11 text-[16px]" placeholder="https://… or /page.html"
            value={href} onChange={(e) => { setHref(e.target.value); setProblem(null); }}
            aria-invalid={problem ? true : undefined} aria-describedby={problem ? `${hrefId}-problem` : undefined} />
          {problem && <p id={`${hrefId}-problem`} className="text-sm text-destructive">{problem}</p>}
        </div>
        {needWords && (
          <div className="grid gap-1.5">
            <label htmlFor={wordsId} className="text-sm font-medium">Words to show</label>
            <Input id={wordsId} className="h-11 text-[16px]" value={words} onChange={(e) => setWords(e.target.value)}
              placeholder="Leave empty to show the address" />
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {had && <Button type="button" variant="outline" className="h-11" onClick={remove}>Remove the link</Button>}
          <Button type="submit" className="h-11">{had ? 'Change it' : 'Add the link'}</Button>
        </div>
      </form>
    </Sheet>
  );
}
