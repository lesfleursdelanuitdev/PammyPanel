// The monitoring module (docs/module-contracts-plan.md section 1).
// every host's and service's checks, and mail when one goes down (docs/monitoring-plan.md):
// the site hands it what to ask (lfdln's app: with hosts on, and mail if on)
import { defineModule } from '@panel/core/module';

export default defineModule({
  name: 'monitoring',
  kernel: '^1',
  needs: [],
  facts: [],
});
