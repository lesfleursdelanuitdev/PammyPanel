// CodeMirror 6 for the file editor (docs/editor-plan.md C3): bundled with the
// panel (no CDN), colours from the panel's own light and dark tokens
// (--code-* in index.css), Ctrl/Cmd+S to save. Its styles go in through
// constructed style sheets, or a <style> with the page's nonce where a browser
// can't, so the panel's strict CSP stays as it is.
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { xml } from '@codemirror/lang-xml';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { MergeView } from '@codemirror/merge';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { basicSetup } from 'codemirror';
import { useEffect, useRef } from 'react';
import { extensionOf } from '../../lib/editor';
import { cn } from '@panel/core/web/lib/utils';

const nonce = () => document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')?.nonce ?? '';

function languageFor(name: string): Extension {
  switch (extensionOf(name)) {
    case 'html': case 'htm': return html();
    case 'css': return css();
    case 'js': return javascript();
    case 'json': return json();
    case 'md': return markdown();
    case 'xml': case 'svg': return xml();
    default: return [];
  }
}

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '14px', backgroundColor: 'var(--card)', color: 'var(--foreground)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--primary)', padding: '8px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--primary)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--code-selection) !important' },
  '.cm-gutters': { backgroundColor: 'var(--muted)', color: 'var(--muted-foreground)', borderRight: '1px solid var(--border)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--primary-soft) 55%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--primary-soft)', color: 'var(--foreground)' },
  '.cm-searchMatch': { backgroundColor: 'var(--code-match)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--code-match)' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--code-match)', outline: 'none' },
  '.cm-panels': { backgroundColor: 'var(--popover)', color: 'var(--popover-foreground)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  '.cm-panel.cm-search': { padding: '6px 8px', fontFamily: 'var(--font-sans)' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': { fontSize: '14px', borderRadius: '6px' },
  '.cm-textfield': { backgroundColor: 'var(--card)', border: '1px solid var(--input)', color: 'var(--foreground)' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--secondary)', border: '1px solid var(--input)', color: 'var(--secondary-foreground)' },
  '.cm-tooltip': { backgroundColor: 'var(--popover)', color: 'var(--popover-foreground)', border: '1px solid var(--border)', borderRadius: '6px' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--muted)', border: '1px solid var(--border)', color: 'var(--muted-foreground)' },
});

const colours = HighlightStyle.define([
  { tag: [t.tagName, t.angleBracket], color: 'var(--code-tag)' },
  { tag: [t.attributeName, t.propertyName], color: 'var(--code-attribute)' },
  { tag: [t.string, t.attributeValue, t.special(t.string), t.regexp], color: 'var(--code-string)' },
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword, t.definitionKeyword], color: 'var(--code-keyword)' },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit, t.color], color: 'var(--code-number)' },
  { tag: [t.comment, t.meta, t.documentMeta, t.processingInstruction], color: 'var(--code-comment)', fontStyle: 'italic' },
  { tag: [t.className, t.labelName, t.definition(t.variableName), t.function(t.variableName)], color: 'var(--code-property)' },
  { tag: t.heading, fontWeight: '700', color: 'var(--code-tag)' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.link, color: 'var(--code-property)', textDecoration: 'underline' },
  { tag: t.invalid, color: 'var(--destructive)' },
]);

// Typing over a selection: done here instead of by the browser, which would first
// wrap what it keeps in a styled <span> (refused by the panel's CSP, so noisy,
// though CodeMirror redraws it anyway).
const typeOverSelection = EditorView.domEventHandlers({
  beforeinput(e, view) {
    if (e.inputType !== 'insertText' || !e.data || view.composing || view.state.selection.ranges.every((r) => r.empty)) return false;
    e.preventDefault();
    view.dispatch(view.state.replaceSelection(e.data), { scrollIntoView: true, userEvent: 'input.type' });
    return true;
  },
});

const common = (name: string, label: string): Extension[] => [
  basicSetup, languageFor(name), EditorView.lineWrapping, theme, syntaxHighlighting(colours), typeOverSelection,
  EditorView.cspNonce.of(nonce()), EditorView.contentAttributes.of({ 'aria-label': label }),
];

// Uncontrolled: `initial` is the text when it's made, and again whenever
// `version` changes (a file loaded, "load theirs", a version restored).
// readOnly: shown, not changed (a software root's .php for someone who isn't a panel admin)
export function CodeEditor({ initial, version, name, onChange, onSave, className, readOnly = false }: {
  initial: string; version: number; name: string; onChange: (text: string) => void; onSave: () => void; className?: string; readOnly?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const handlers = useRef({ onChange, onSave });
  handlers.current = { onChange, onSave };

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initial,
        extensions: [
          keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { handlers.current.onSave(); return true; } }]),
          ...common(name, `Text of ${name}`),
          ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
          EditorView.updateListener.of((u) => { if (u.docChanged) handlers.current.onChange(u.state.doc.toString()); }),
        ],
      }),
    });
    view.current = v;
    return () => { v.destroy(); view.current = null; };
  }, [name, readOnly]);                                    // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const v = view.current;
    if (!v || v.state.doc.toString() === initial) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: initial } });
  }, [version]);                                           // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={host} className={cn('h-full min-h-0 overflow-hidden', className)} data-editor />;
}

// An earlier version (left) next to what's in the editor now (right), read-only.
export function CompareView({ before, after, name, className }: { before: string; after: string; name: string; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const ro = [EditorState.readOnly.of(true), EditorView.editable.of(false)];
    const m = new MergeView({
      parent: host.current!,
      a: { doc: before, extensions: [...common(name, 'The earlier version'), ...ro] },
      b: { doc: after, extensions: [...common(name, 'What is in the editor now'), ...ro] },
      collapseUnchanged: { margin: 3, minSize: 6 },
      gutter: true,
    });
    return () => m.destroy();
  }, [before, after, name]);
  return <div ref={host} className={cn('overflow-auto rounded-lg border border-border [&_.cm-mergeView]:h-full', className)} />;
}
