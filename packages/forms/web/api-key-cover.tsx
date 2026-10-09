// A key's forms on the API keys page (docs/catalog-plan.md step 3c): which forms,
// and which of their responses.
import type { KeyCover } from '@panel/api-keys/web/lib/covers';
import { Field } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Checkbox } from '@panel/core/web/components/ui/checkbox';
import { NativeSelect } from '@panel/core/web/components/ui/native-select';
import { useApi } from '@panel/core/web/hooks/useApi';
import type { FormsData } from './lib/types';

type State = { mode: 'all' | 'chosen' | 'none'; which: number[]; level: 'approved' | 'all' };

function Fields({ state, set }: { state: State; set: (s: State) => void }) {
  const forms = useApi<FormsData>('/api/forms');
  const { mode, which, level } = state;
  return (
    <>
      <Field label="Which forms" htmlFor="key-forms">
        <NativeSelect id="key-forms" value={mode} onChange={(e) => set({ ...state, mode: e.target.value as State['mode'] })}>
          <option value="all">Every form, including ones you make later</option>
          <option value="chosen">Only the forms I tick</option>
          <option value="none">No forms</option>
        </NativeSelect>
      </Field>
      {mode === 'chosen' && (
        <ul className="grid gap-1.5" aria-label="Forms it reads">
          {forms.data?.forms.filter((f) => !f.trashedAt).map((f) => (
            <li key={f.id} className="flex items-center gap-2.5">
              <Checkbox id={`key-form-${f.id}`} checked={which.includes(f.id)}
                onCheckedChange={(v) => set({ ...state, which: v === true ? [...which, f.id] : which.filter((x) => x !== f.id) })} />
              <label htmlFor={`key-form-${f.id}`} className="cursor-pointer text-[0.95rem]">{f.title} <code className="text-xs text-muted-foreground">{f.name}</code></label>
            </li>
          ))}
        </ul>
      )}
      {mode !== 'none' && (
        <Field label="Which responses" htmlFor="key-level">
          <NativeSelect id="key-level" value={level} onChange={(e) => set({ ...state, level: e.target.value as State['level'] })}>
            <option value="approved">Approved responses only</option>
            <option value="all">All responses</option>
          </NativeSelect>
        </Field>
      )}
    </>
  );
}

export const formsCover: KeyCover<State> = {
  kind: 'forms',
  reads: "forms' responses",
  help: { topic: 'forms', label: 'Reading responses' },
  start: { mode: 'all', which: [], level: 'approved' },
  body: ({ mode, which, level }) => ({ level, forms: mode === 'chosen' ? which : mode }),
  Fields,
  badges: (k) => k.forms?.length !== 0 && <Badge>{k.level === 'all' ? 'all responses' : 'approved only'}</Badge>,
  facts: (k) => [k.forms === null ? 'every form' : k.forms.length === 0 ? 'no forms' : `${k.forms.length} form${k.forms.length === 1 ? '' : 's'}`],
};
