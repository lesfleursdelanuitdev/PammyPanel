// Tags & categories (docs/media-plan.md D21): the tags and categories of the whole
// website or of one folder at its top, with how many files have each, and
// rename, delete and "show its files" (in File Explorer). Any file can have them,
// not only media; only listing them for pages is limited to media folders.
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router';
import { LabelsManager } from '../components/media/labels-manager';
import { Field, InlineLink, Loading, Page } from '@panel/core/web/components/page';
import { NativeSelect } from '@panel/core/web/components/ui/native-select';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { FILES_DEFAULTS, filesHref, pref, setPref } from '../lib/media';
import { isOn, W } from '@panel/core/web/lib/site';
import { EverywhereLabels } from '@panel/catalog/web/components/everywhere';
import { useMe } from '@panel/core/web/hooks/useMe';
import { may } from '@panel/core/web/lib/rights';

type FilesRoot = { dirs: string[]; limitedTo: string[] | null };

// The old address (under Media) still works.
export function OldTagsAddress() {
  const { search } = useLocation();
  return <Navigate to={`/tags${search}`} replace />;
}

export default function TagsPage() {
  usePageTitle('Tags & categories');
  const root = useApi<FilesRoot>('/api/files');
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const limitedTo = root.data?.limitedTo ?? null;
  const tops = (root.data?.dirs ?? []).filter((d) => d && !d.includes('/'));
  // ?folder=* everything, / the top of the website, recipes one folder; else the last one looked at.
  // A person kept to places (D22) chooses only among theirs.
  // 'everywhere/': labels that go on anything, files and records (docs/catalog-plan.md step 4;
  // with a slash, so no folder can be called that)
  // (lfdln: Everywhere's labels are the services' too, so they need that part as well)
  const me = useMe();
  const everywhere = limitedTo === null && isOn('catalog') && (!isOn('services') || (!!me && may(me, 'services')));
  const choices = limitedTo ?? [...(everywhere ? ['everywhere/'] : []), '*', '/', ...tops];
  const asked = params.get('folder') ?? pref<string>('tags-folder', limitedTo ? choices[0] ?? '*' : '*');
  const choice = choices.includes(asked) ? asked : choices[0] ?? '*';
  const scope = choice === '*' || choice === '/' ? choice : `/${choice}`;

  return (
    <Page title="Tags & categories" intro={<>Words for finding files again, on any file in {W.website.your}: pages, pictures, documents. Each folder at {W.website.top} has its own, and so does any folder you mark as a tag scope; a file can use labels from its folder and from folders above it. Put them on files in <InlineLink to="/files">File Explorer</InlineLink> or the <InlineLink to="/media">Media</InlineLink> tab (a file's "..." menu, or several files at once).</>}>
      {!root.data ? <Loading /> : (
        <div className="space-y-5">
          {(limitedTo === null || limitedTo.length > 1) && (
            <Field label="Show" htmlFor="tags-folder" className="max-w-sm">
              <NativeSelect id="tags-folder" value={choice} onChange={(e) => {
                setPref('tags-folder', e.target.value);
                navigate(`/tags?folder=${encodeURIComponent(e.target.value)}`, { replace: true });
              }}>
                {everywhere && <option value="everywhere/">Everywhere (files, and records with tags on)</option>}
                {limitedTo === null && <option value="*">Every folder</option>}
                {limitedTo === null && <option value="/">{isOn('hosts') ? 'All the site folders' : 'The top of the website (your main site)'}</option>}
                {(limitedTo ?? tops).map((f) => <option key={f} value={f}>{f}</option>)}
              </NativeSelect>
            </Field>
          )}
          {choice === 'everywhere/' ? (
            <EverywhereLabels onShowFiles={(l) => navigate(filesHref({ ...FILES_DEFAULTS, path: '', tags: l.type === 'tag' ? [l.id] : [], categories: l.type === 'category' ? [l.id] : [] }))} />
          ) : <LabelsManager key={scope} scope={scope}
            onShow={(l) => {
              const tags = l.type === 'tag' ? [l.id] : [];
              const categories = l.type === 'category' ? [l.id] : [];
              navigate(filesHref({ ...FILES_DEFAULTS, path: l.scope === '/' ? '' : l.scope.slice(1), tags, categories }));
            }} />}
        </div>
      )}
    </Page>
  );
}
