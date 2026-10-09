// The hosts module (docs/module-contracts-plan.md section 1).
// site folders are the files module's records; a route shows one (docs/phase8b-plan.md 8b-9)
import { defineModule } from '@panel/core/module';

export default defineModule({
  name: 'hosts',
  kernel: '^1',
  needs: ['files'],
  facts: ['hosts', 'services.sockets.routes'],
});
