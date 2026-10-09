// A key's media folders on the API keys page (docs/catalog-plan.md step 3c;
// docs/media-api-plan.md M6): none, every one, or the ones ticked.
import type { KeyCover } from '@panel/api-keys/web/lib/covers';
import { Field } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Checkbox } from '@panel/core/web/components/ui/checkbox';
import { NativeSelect } from '@panel/core/web/components/ui/native-select';
import { useApi } from '@panel/core/web/hooks/useApi';
import { siteLabel } from '@panel/core/web/lib/format';

// What GET /api/media sends (the files module's MediaSites), as far as this reads it:
// the folders a key may be given the media of.
type MediaSites = { folders: { folder: string; hasMedia: boolean }[] };
type State = { mode: 'none' | 'all' | 'chosen'; which: string[] };

function Fields({ state, set }: { state: State; set: (s: State) => void }) {
  const sites = useApi<MediaSites>('/api/media');
  const folders = (sites.data?.folders ?? []).filter((f) => f.hasMedia).map((f) => f.folder);
  const { mode, which } = state;
  return (
    <>
      <Field label="Which media folders" htmlFor="key-media"
        hint="A key reads every file in them, by any tag or category (even ones not switched on for everyone), and inside protected folders too.">
        <NativeSelect id="key-media" value={mode} onChange={(e) => set({ ...state, mode: e.target.value as State['mode'] })}>
          <option value="none">No media folders</option>
          <option value="all">Every media folder</option>
          <option value="chosen">Only the media folders I tick</option>
        </NativeSelect>
      </Field>
      {mode === 'chosen' && (
        <ul className="grid gap-1.5" aria-label="Media folders it reads">
          {folders.map((f) => (
            <li key={f || '/'} className="flex items-center gap-2.5">
              <Checkbox id={`key-media-${f || 'main'}`} checked={which.includes(f)}
                onCheckedChange={(v) => set({ ...state, which: v === true ? [...which, f] : which.filter((x) => x !== f) })} />
              <label htmlFor={`key-media-${f || 'main'}`} className="cursor-pointer text-[0.95rem]">{siteLabel(f)}</label>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export const mediaCover: KeyCover<State> = {
  kind: 'media',
  reads: 'the files in media folders',
  help: { topic: 'media-api', label: 'Reading media' },
  start: { mode: 'none', which: [] },
  body: ({ mode, which }) => ({ media: mode === 'chosen' ? which.map((f) => (f ? `/${f}` : '/')) : mode }),
  Fields,
  badges: (k) => k.media && <Badge variant="outline">media</Badge>,
  facts: (k) => [k.media === 'all' ? 'every media folder' : k.media ? `media: ${k.media.map((m) => (m === '/' ? 'main site' : m.slice(1))).join(', ')}` : null],
};
