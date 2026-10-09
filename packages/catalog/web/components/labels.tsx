// The pieces every tag editor is made of (docs/catalog-plan.md step 4): a label as a chip,
// a box to add one by name, and one thing's labels with Save -- a file's (File Explorer,
// Media) or a record's (the Studio's record page) alike.
import { Plus, Tags, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Button } from '@panel/core/web/components/ui/button';
import { Input } from '@panel/core/web/components/ui/input';
import { cn } from '@panel/core/web/lib/utils';
import { KEY, LABEL_RULE, labelSlug, WORD, type LabelType, type Names } from '../lib/labels';

export function Chip({ name, type, onRemove, struck }: { name: string; type: LabelType; onRemove?: () => void; struck?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full py-0.5 pl-2.5 pr-1 text-sm',
      type === 'category' ? 'bg-primary-soft font-semibold text-primary' : 'border border-border', struck && 'line-through opacity-60')}>
      {type === 'tag' ? `#${name}` : name}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`${struck ? 'Keep' : 'Take off'} ${type} ${name}`}
          className="grid size-5 place-items-center rounded-full hover:bg-foreground/10"><X className="size-3" /></button>
      )}
    </span>
  );
}

// A box to type a name into, suggesting the ones there already.
// What's typed but not added yet is the editor's, so Save doesn't lose it.
export function AddBox({ type, known, onAdd, text, setText }: { type: LabelType; known: string[]; onAdd: (name: string) => void; text: string; setText: (t: string) => void }) {
  const id = useId();
  const slug = labelSlug(text);
  const add = () => { if (slug) { onAdd(slug); setText(''); } };
  return (
    <div>
      <div className="flex gap-2">
        <Input id={id} list={`${id}-known`} value={text} maxLength={60} autoComplete="off" placeholder={`Add a ${WORD[type][1]}`}
          aria-label={`Add a ${WORD[type][1]}`}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <Button type="button" variant="outline" onClick={add} disabled={!slug}><Plus />Add</Button>
      </div>
      <datalist id={`${id}-known`}>{known.map((n) => <option key={n} value={n} />)}</datalist>
      <p className="mt-1 text-xs text-muted-foreground" aria-live="polite">
        {text && slug !== text ? (slug ? `Will be added as "${slug}".` : LABEL_RULE) : LABEL_RULE}
      </p>
    </div>
  );
}

// One thing's labels: chips with × to take one off, a box per kind to add more, and Save
// (anything still typed in a box counts as added).
export function OneThingLabels({ names, known, onSave, busy }: {
  names: Names; known: (type: LabelType) => string[]; onSave: (next: Names) => Promise<unknown>; busy?: boolean;
}) {
  const [have, setHave] = useState<Names>(names);
  const [typed, setTyped] = useState<Record<LabelType, string>>({ tag: '', category: '' });
  useEffect(() => setHave(names), [JSON.stringify(names)]);
  const plus = (n: Names): Names => ({
    tags: [...new Set([...n.tags, labelSlug(typed.tag)].filter(Boolean))],
    categories: [...new Set([...n.categories, labelSlug(typed.category)].filter(Boolean))],
  });
  const dirty = JSON.stringify(plus(have)) !== JSON.stringify(names);
  return (
    <form className="grid gap-5" onSubmit={(e) => {
      e.preventDefault();
      void onSave(plus(have)).then(() => setTyped({ tag: '', category: '' }));
    }}>
      {(['category', 'tag'] as const).map((type) => (
        <section key={type} aria-label={WORD[type][0]} className="grid gap-2">
          <h3 className="text-sm font-semibold">{WORD[type][0]}</h3>
          <div className="flex min-h-7 flex-wrap gap-1.5">
            {have[KEY[type]].length === 0 && <span className="text-sm text-muted-foreground">None yet.</span>}
            {have[KEY[type]].map((n) => <Chip key={n} name={n} type={type}
              onRemove={() => setHave({ ...have, [KEY[type]]: have[KEY[type]].filter((x) => x !== n) })} />)}
          </div>
          <AddBox type={type} known={known(type).filter((n) => !have[KEY[type]].includes(n))} text={typed[type]}
            setText={(t) => setTyped((x) => ({ ...x, [type]: t }))}
            onAdd={(n) => { if (!have[KEY[type]].includes(n)) setHave({ ...have, [KEY[type]]: [...have[KEY[type]], n] }); }} />
        </section>
      ))}
      <div><Button type="submit" disabled={busy || !dirty}><Tags />Save the tags</Button></div>
    </form>
  );
}
