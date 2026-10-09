// Media › Make media folders (D3): which of her sites have a media folder, and
// making one (media/images, files, audio and video) at the top of the main site
// or in a folder directly inside it.
import { FolderOpen, FolderPlus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { FolderPicker } from '@panel/core/web/components/folder-picker';
import { ActionButton, Facts, InlineLink, List, Loading, Page, Row, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { api } from '@panel/core/web/lib/api';
import { BROWSE_DEFAULTS, browseHref, MEDIA_WHERE, NO_MAIN_MEDIA } from '@panel/files/web/lib/media';
import { siteLabel } from '@panel/core/web/lib/format';
import { notify } from '@panel/core/web/lib/status';
import type { MediaSites } from '@panel/files/web/lib/types';

export default function MediaFolders() {
  usePageTitle('Make media folders');
  const sites = useApi<MediaSites>('/api/media');
  const run = useAction();
  const navigate = useNavigate();
  const [makeIn, setMakeIn] = useState('');
  const all = sites.data?.folders ?? [];
  const hasMedia = new Set(all.filter((f) => f.hasMedia).map((f) => f.folder));

  const make = async (f: string) => {
    const r = await run(() => api<{ created: string[]; folder: string }>('/api/media/folder', { folder: f }));
    if (!r) return;
    setMakeIn('');
    notify(r.created.length ? `Made a media folder in ${siteLabel(r.folder)}, with images, files, audio and video in it.` : `${siteLabel(r.folder)} already has a media folder.`);
  };
  const open = (f: string) => navigate(browseHref({ ...BROWSE_DEFAULTS, folder: f }));

  return (
    <Page title="Make media folders" intro={MEDIA_WHERE}>
      {!sites.data ? <Loading /> : <>
        <Section title="Make a media folder">
          <form onSubmit={(e) => {
            e.preventDefault();
            const f = makeIn.trim().replace(/^\/+|\/+$/g, '');
            if (f === '' && NO_MAIN_MEDIA) { notify('Choose a site folder first.'); return; }
            void make(f);
          }}>
            <FolderPicker id="media-make-folder" label="Make a media folder in" mainSite={!NO_MAIN_MEDIA}
              placeholder={NO_MAIN_MEDIA ? 'Type to find a site folder' : 'Type to find a folder (empty: the main site)'}
              folders={all.filter((f) => f.folder !== '').map((f) => f.folder)} value={makeIn} onChange={setMakeIn}
              status={(f) => (hasMedia.has(f) ? { note: 'has a media folder', disabled: true } : null)}
              hint="Makes media/images, media/files, media/audio and media/video inside it. Anything already there stays as it is."
              action={<Button type="submit"><FolderPlus />Make</Button>} />
          </form>
        </Section>
        <Section flush title="Your sites" intro={<>Then put things in it on the <InlineLink to="/media">Media</InlineLink> tab.</>}>
          <List label="Sites and their media folders">
            {all.map((f) => (
              <Row key={f.folder} title={siteLabel(f.folder)}
                badges={f.hasMedia ? <Badge variant="ok">has a media folder</Badge> : <Badge variant="outline">no media folder</Badge>}
                meta={<Facts items={[f.hasMedia ? `${f.folder ? `${f.folder}/` : ''}media/` : null]} />}
                actions={f.hasMedia
                  ? <ActionButton icon={FolderOpen} onClick={() => open(f.folder)}>Open in Media</ActionButton>
                  : <ActionButton icon={FolderPlus} onClick={() => make(f.folder)}>Make one</ActionButton>} />
            ))}
          </List>
        </Section>
      </>}
    </Page>
  );
}
