// The settings of one thing on a form, and of the whole form. Every rule here
// is checked again by the gate (src/gate/forms/items.ts).
import { X } from 'lucide-react';
import { useId } from 'react';
import { Field } from '@panel/core/web/components/page';
import { Button } from '@panel/core/web/components/ui/button';
import { Checkbox } from '@panel/core/web/components/ui/checkbox';
import { Input } from '@panel/core/web/components/ui/input';
import { NativeSelect } from '@panel/core/web/components/ui/native-select';
import { Textarea } from '@panel/core/web/components/ui/textarea';
import { isOn } from '@panel/core/web/lib/site';
import { kindOf } from '../lib/form-items';
import { isAnswerType, type FormItem, type FormSettings } from '../lib/types';

const PRIVATE_BY_DEFAULT = new Set(['email', 'phone', 'address', 'hidden']);

// pictures: images a picture item can show (from the form's own folder, D22), offered as you type
export function ItemSettings({ item, onChange, onClose, phone = false, pictures = [], scope = '/' }: {
  item: FormItem; onChange: (patch: Partial<FormItem>) => void; onClose: () => void; phone?: boolean; pictures?: string[]; scope?: string;
}) {
  const uid = useId();
  const kind = kindOf(item.type);
  const id = (s: string) => `${uid}-${s}`;
  const num = (v: string): number | null => (v.trim() === '' ? null : Number(v));
  const answer = isAnswerType(item.type);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-sm font-semibold">{kind.label}</h2>
        <Button size="icon" variant="ghost" aria-label="Close the settings" onClick={onClose}><X /></Button>
      </div>

      {answer && (
        <>
          <Field label="Label (the question)" htmlFor={id('label')}>
            <Input id={id('label')} value={item.label ?? ''} maxLength={200} onChange={(e) => onChange({ label: e.target.value })} />
          </Field>
          <Field label="Help text" htmlFor={id('help')} hint="Small words under the question. Leave empty for none.">
            <Textarea id={id('help')} rows={2} value={item.help ?? ''} maxLength={500} onChange={(e) => onChange({ help: e.target.value })} />
          </Field>
          {item.key && <p className="text-xs text-muted-foreground">Its name in the API: <code className="rounded bg-muted px-1 py-0.5">{item.key}</code> (fixed once saved)</p>}
        </>
      )}

      {item.type === 'heading' && (
        <>
          <Field label="Words" htmlFor={id('text')}>
            <Input id={id('text')} value={item.text ?? ''} maxLength={200} onChange={(e) => onChange({ text: e.target.value })} />
          </Field>
          <Field label="Size" htmlFor={id('size')}>
            <NativeSelect id={id('size')} value={item.size ?? 'medium'} onChange={(e) => onChange({ size: e.target.value as FormItem['size'] })}>
              <option value="large">Large</option><option value="medium">Medium</option><option value="small">Small</option>
            </NativeSelect>
          </Field>
        </>
      )}
      {item.type === 'paragraph' && (
        <Field label="Words" htmlFor={id('text')}>
          <Textarea id={id('text')} rows={4} value={item.text ?? ''} maxLength={5000} onChange={(e) => onChange({ text: e.target.value })} />
        </Field>
      )}
      {item.type === 'image' && (
        <>
          <Field label="Picture" htmlFor={id('src')}
            hint={scope === '/' ? 'Its address in your website, from the Media tab: e.g. recipes/media/images/cake.jpg. Start typing to see your images.'
              : `An image from ${scope.slice(1)}, like ${scope.slice(1)}/media/images/cake.jpg (this form only works on the pages in ${scope.slice(1)}). Start typing to see them.`}>
            <Input id={id('src')} list={id('pictures')} value={item.src ?? ''} placeholder={`${scope === '/' ? 'folder' : scope.slice(1)}/media/images/picture.jpg`}
              autoComplete="off" onChange={(e) => onChange({ src: e.target.value.trim() })} />
            <datalist id={id('pictures')}>{pictures.map((p) => <option key={p} value={p} />)}</datalist>
          </Field>
          <Field label="What it shows" htmlFor={id('alt')} hint="A few words, for people who can't see it.">
            <Input id={id('alt')} value={item.alt ?? ''} maxLength={200} onChange={(e) => onChange({ alt: e.target.value })} />
          </Field>
        </>
      )}

      {(item.type === 'short-text' || item.type === 'long-text' || item.type === 'email' || item.type === 'phone' || item.type === 'website' || item.type === 'number' || item.type === 'dropdown') && (
        <Field label="Faint example text" htmlFor={id('placeholder')} hint="Shown in the empty box.">
          <Input id={id('placeholder')} value={item.placeholder ?? ''} maxLength={120} onChange={(e) => onChange({ placeholder: e.target.value })} />
        </Field>
      )}

      {(item.type === 'short-text' || item.type === 'long-text') && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Fewest characters" htmlFor={id('min')}>
            <Input id={id('min')} type="number" min={0} value={item.minLength ?? ''} onChange={(e) => onChange({ minLength: num(e.target.value) })} />
          </Field>
          <Field label="Most characters" htmlFor={id('max')}>
            <Input id={id('max')} type="number" min={1} value={item.maxLength ?? ''} onChange={(e) => onChange({ maxLength: num(e.target.value) })} />
          </Field>
        </div>
      )}
      {item.type === 'long-text' && (
        <Field label="Height (lines)" htmlFor={id('rows')}>
          <Input id={id('rows')} type="number" min={2} max={20} value={item.rows ?? 5} onChange={(e) => onChange({ rows: Number(e.target.value) || 5 })} />
        </Field>
      )}
      {item.type === 'number' && (
        <div className="grid grid-cols-3 gap-3">
          <Field label="Smallest" htmlFor={id('nmin')}>
            <Input id={id('nmin')} type="number" value={item.min ?? ''} onChange={(e) => onChange({ min: num(e.target.value) })} />
          </Field>
          <Field label="Largest" htmlFor={id('nmax')}>
            <Input id={id('nmax')} type="number" value={item.max ?? ''} onChange={(e) => onChange({ max: num(e.target.value) })} />
          </Field>
          <Field label="Decimals" htmlFor={id('dec')}>
            <Input id={id('dec')} type="number" min={0} max={6} value={item.decimals ?? 0} onChange={(e) => onChange({ decimals: Number(e.target.value) || 0 })} />
          </Field>
        </div>
      )}
      {item.type === 'date' && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Earliest" htmlFor={id('early')} hint='A date, or "today"'>
            <Input id={id('early')} value={item.earliest ?? ''} placeholder="2026-01-01" onChange={(e) => onChange({ earliest: e.target.value.trim() })} />
          </Field>
          <Field label="Latest" htmlFor={id('late')}>
            <Input id={id('late')} value={item.latest ?? ''} placeholder="today" onChange={(e) => onChange({ latest: e.target.value.trim() })} />
          </Field>
        </div>
      )}
      {item.type === 'time' && (
        <div className="grid grid-cols-3 gap-3">
          <Field label="Earliest" htmlFor={id('tearly')}>
            <Input id={id('tearly')} value={item.earliest ?? ''} placeholder="09:00" onChange={(e) => onChange({ earliest: e.target.value.trim() })} />
          </Field>
          <Field label="Latest" htmlFor={id('tlate')}>
            <Input id={id('tlate')} value={item.latest ?? ''} placeholder="17:00" onChange={(e) => onChange({ latest: e.target.value.trim() })} />
          </Field>
          <Field label="Minutes apart" htmlFor={id('step')}>
            <Input id={id('step')} type="number" min={1} max={60} value={item.step ?? 1} onChange={(e) => onChange({ step: Number(e.target.value) || 1 })} />
          </Field>
        </div>
      )}

      {(item.type === 'dropdown' || item.type === 'single-choice' || item.type === 'multiple-choice') && (
        <>
          <Field label="Choices" htmlFor={id('options')} hint="One per line.">
            <Textarea id={id('options')} rows={5} value={(item.options ?? []).join('\n')}
              onChange={(e) => onChange({ options: e.target.value.split('\n').map((o) => o.trim()).filter(Boolean) })} />
          </Field>
          {item.type !== 'dropdown' && (
            <>
              <Tick id={id('other')} checked={item.other === true} onChange={(v) => onChange({ other: v })}>Let them write something else</Tick>
              <Tick id={id('cols')} checked={item.columns === 2} onChange={(v) => onChange({ columns: v ? 2 : 1 })}>Show the choices in two columns</Tick>
            </>
          )}
          {item.type === 'multiple-choice' && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Fewest to pick" htmlFor={id('minp')}>
                <Input id={id('minp')} type="number" min={0} value={item.minPicks ?? ''} onChange={(e) => onChange({ minPicks: num(e.target.value) })} />
              </Field>
              <Field label="Most to pick" htmlFor={id('maxp')}>
                <Input id={id('maxp')} type="number" min={1} value={item.maxPicks ?? ''} onChange={(e) => onChange({ maxPicks: num(e.target.value) })} />
              </Field>
            </div>
          )}
        </>
      )}

      {item.type === 'name' && (
        <>
          <Tick id={id('title')} checked={item.parts?.title === true} onChange={(v) => onChange({ parts: { ...item.parts, title: v } })}>Ask for a title (Mr, Ms...)</Tick>
          <Tick id={id('middle')} checked={item.parts?.middle === true} onChange={(v) => onChange({ parts: { ...item.parts, middle: v } })}>Ask for a middle name</Tick>
        </>
      )}
      {item.type === 'address' && (
        <>
          {([['line2', 'Second address line'], ['region', 'County or state'], ['postcode', 'Postcode'], ['country', 'Country']] as const).map(([p, label]) => (
            <Tick key={p} id={id(p)} checked={item.parts?.[p] !== false} onChange={(v) => onChange({ parts: { ...item.parts, [p]: v } })}>Ask for a {label.toLowerCase()}</Tick>
          ))}
          <Field label="Country to start with" htmlFor={id('country')}>
            <Input id={id('country')} value={item.defaultCountry ?? ''} maxLength={80} onChange={(e) => onChange({ defaultCountry: e.target.value })} />
          </Field>
        </>
      )}
      {item.type === 'rating' && (
        <Field label="How many stars" htmlFor={id('stars')}>
          <Input id={id('stars')} type="number" min={3} max={10} value={item.stars ?? 5} onChange={(e) => onChange({ stars: Number(e.target.value) || 5 })} />
        </Field>
      )}
      {item.type === 'scale' && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Starts at" htmlFor={id('from')}>
              <NativeSelect id={id('from')} value={String(item.from ?? 1)} onChange={(e) => onChange({ from: Number(e.target.value) })}>
                <option value="0">0</option><option value="1">1</option>
              </NativeSelect>
            </Field>
            <Field label="Up to" htmlFor={id('to')}>
              <Input id={id('to')} type="number" min={5} max={10} value={item.to ?? 10} onChange={(e) => onChange({ to: Number(e.target.value) || 10 })} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Words at the low end" htmlFor={id('low')}>
              <Input id={id('low')} value={item.lowLabel ?? ''} maxLength={60} onChange={(e) => onChange({ lowLabel: e.target.value })} />
            </Field>
            <Field label="Words at the high end" htmlFor={id('high')}>
              <Input id={id('high')} value={item.highLabel ?? ''} maxLength={60} onChange={(e) => onChange({ highLabel: e.target.value })} />
            </Field>
          </div>
        </>
      )}
      {item.type === 'hidden' && (
        <>
          <Field label="Value" htmlFor={id('value')} hint="Saved with every response.">
            <Input id={id('value')} value={item.value ?? ''} maxLength={500} onChange={(e) => onChange({ value: e.target.value })} />
          </Field>
          <Field label="Or take it from the page address" htmlFor={id('param')} hint="For example source, for pages ending ?source=facebook.">
            <Input id={id('param')} value={item.param ?? ''} maxLength={40} onChange={(e) => onChange({ param: e.target.value.trim() })} />
          </Field>
        </>
      )}

      {answer && item.type !== 'hidden' && (
        <>
          <Tick id={id('required')} checked={item.required === true} onChange={(v) => onChange({ required: v })}>
            {item.type === 'checkbox' ? 'Must be ticked' : 'Must be answered'}
          </Tick>
          <Field label="Width" htmlFor={id('width')}>
            <NativeSelect id={id('width')} value={item.width ?? 'full'} onChange={(e) => onChange({ width: e.target.value as 'full' | 'half' })}>
              <option value="full">Full width</option><option value="half">Half width</option>
            </NativeSelect>
          </Field>
        </>
      )}
      {answer && (
        <Tick id={id('public')} checked={item.public ?? !PRIVATE_BY_DEFAULT.has(item.type)} onChange={(v) => onChange({ public: v })}>
          Show publicly (only matters if anyone may read this form's approved responses)
        </Tick>
      )}

      {phone && <Button className="w-full" onClick={onClose}>Done</Button>}
    </div>
  );
}

export function FormSettingsPanel({ settings, onChange }: { settings: FormSettings; onChange: (patch: Partial<FormSettings>) => void }) {
  const uid = useId();
  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold">Form settings</h2>
      <p className="text-xs text-muted-foreground">Pick something on the form to change that instead.</p>
      <Field label="Words on the button" htmlFor={`${uid}-submit`}>
        <Input id={`${uid}-submit`} value={settings.submitText} maxLength={60} onChange={(e) => onChange({ submitText: e.target.value })} />
      </Field>
      <Field label="Thank-you words" htmlFor={`${uid}-sent`} hint='Shown in place of the form, unless the page has thanks="..."'>
        <Textarea id={`${uid}-sent`} rows={3} value={settings.sentText} maxLength={500} onChange={(e) => onChange({ sentText: e.target.value })} />
      </Field>
      <Tick id={`${uid}-signed`} checked={settings.signedInOnly} onChange={(v) => onChange({ signedInOnly: v })}>
        {/* on a site with hosts, visitors' accounts are on routes (lfdln) */}
        {isOn('hosts') ? 'Only people signed in behind a route with accounts may use it' : 'Only people signed in to a protected folder may use it'}
      </Tick>
      <Tick id={`${uid}-sender`} checked={settings.showSender} onChange={(v) => onChange({ showSender: v })}>
        If anyone may read the approved responses, tell them who sent each one
      </Tick>
    </div>
  );
}

function Tick({ id, checked, onChange, children }: { id: string; checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} className="mt-0.5" />
      <label htmlFor={id} className="cursor-pointer text-sm">{children}</label>
    </div>
  );
}
