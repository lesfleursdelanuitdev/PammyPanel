// The services module (docs/module-contracts-plan.md section 1).
// a service is shown through a host's route (docs/domains-hosts-plan.md step 2: its kind of target)
import { defineModule } from '@panel/core/module';

export default defineModule({
  name: 'services',
  kernel: '^1',
  needs: ['hosts'],
  facts: ['services.sockets.services'],
});
