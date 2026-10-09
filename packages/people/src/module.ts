// The people module (docs/module-contracts-plan.md section 1).
// signing in (to a protected folder, or with accounts anywhere: docs/accounts-plan.md step 4)
import { defineModule } from '@panel/core/module';

export default defineModule({
  name: 'people',
  kernel: '^1',
  needs: ['areas'],
  facts: ['services.gate', 'services.sockets.gateAdmin'],
});
