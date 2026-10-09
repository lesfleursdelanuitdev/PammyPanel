// The forms module (docs/module-contracts-plan.md section 1).
import { defineModule } from '@panel/core/module';

export default defineModule({
  name: 'forms',
  kernel: '^1',
  needs: ['areas', 'mail', 'api-keys'],
  facts: ['services.gate', 'services.sockets.gateAdmin'],
});
