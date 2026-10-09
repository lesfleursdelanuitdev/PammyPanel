// Can software be the whole website now? The software helper says, with its list
// (packages/apps/src/apps/host.ts wholeSiteServed): not while pammy.org is served from its
// hosts (docs/phase8-plan.md 8-7d). Until the list has come, it isn't offered.
import { useApi } from '@panel/core/web/hooks/useApi';
import type { SoftwareSummary } from './types';

export const useWholeSite = () =>
  useApi<{ apps: SoftwareSummary[]; wholeSite?: boolean }>('/api/software', { meta: { quiet: true } }).data?.wholeSite === true;
