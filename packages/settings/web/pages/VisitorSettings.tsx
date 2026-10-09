import { useId } from 'react';
import { Facts, List, Loading, Page, Row, Section } from '@panel/core/web/components/page';
import { Switch } from '@panel/core/web/components/ui/switch';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { api, formatTime } from '@panel/core/web/lib/api';
import type { VisitorSettingsData, VisitorSwitch } from '../lib/types';

// What each switch does, and what happens while it's off (docs/accounts-plan.md A5).
const ABOUT: Record<string, { on: string; off: string }> = {
  emailedLinks: { on: 'The panel emails people the links to confirm their address, reset a forgotten password, or change their address.', off: 'A forgotten password goes to Requests, and you pass a link on yourself.' },
  selfRegister: { on: 'People make their own account, and it works once they confirm their email address. It opens no protected folder until you let them in.', off: 'You add people, or say yes to "ask for access".' },
  changePassword: { on: 'Signed-in people can change their own password.', off: 'Only you can, or they choose one with a setup link.' },
  deleteAccount: { on: 'Signed-in people can delete their own account.', off: 'Only you can remove someone.' },
  openAreas: { on: 'Folders and routes can be "Open with accounts": anyone can see them, and the pages know who is signed in.', off: 'Only protected folders have a sign-in.' },
  roles: { on: 'Each protected folder has an Access page: people get roles there, and a role is a set of privileges a program in the folder can check. A folder can even be opened to everyone.', off: 'Everyone who can open a folder can do the same there. It can be turned off again once every folder is back on the built-in roles.' },
};

export function VisitorSettings() {
  usePageTitle('Visitor settings');
  const data = useApi<VisitorSettingsData>('/api/visitor-settings');
  return (
    <Page title="Visitor settings" intro="What visitors can do for themselves. Everything here starts off; protected folders, Requests and setup links keep working as they do whatever you turn on.">
      <Section flush title="Switches" intro={data.data?.changedAt ? <Facts items={[`last changed ${formatTime(data.data.changedAt)}`, data.data.changedBy && `by ${data.data.changedBy}`]} /> : undefined}>
        {!data.data ? <Loading /> : (
          <List label="Visitor settings">
            {data.data.switches.map((s) => <SwitchRow key={s.key} s={s} />)}
          </List>
        )}
      </Section>
    </Page>
  );
}

function SwitchRow({ s }: { s: VisitorSwitch }) {
  const run = useAction();
  const id = useId();
  const about = ABOUT[s.key];
  return (
    <Row title={<label htmlFor={id} className="cursor-pointer">{s.label}</label>}
      meta={<>
        {about && <span>{s.on ? about.on : `Off: ${about.off}`}</span>}
        {s.blocked && <span className="mt-1 block text-amber-800 dark:text-amber-300" data-blocked>{s.blocked}</span>}
      </>}
      actions={(
        <Switch id={id} data-key={s.key} checked={s.on} disabled={!s.on && s.blocked !== null} onCheckedChange={(on) => run(
          () => api<VisitorSettingsData>('/api/visitor-settings', { key: s.key, on }),
          (r) => `${s.label}: ${on ? 'on' : 'off'}.${r.alsoOff?.length ? ` Also turned off: ${r.alsoOff.map((k) => r.switches.find((x) => x.key === k)?.label ?? k).join(', ')}.` : ''}`,
        )} />
      )} />
  );
}
