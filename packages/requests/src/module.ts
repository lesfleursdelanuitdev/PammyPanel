// The requests module (docs/module-contracts-plan.md section 1).
import { defineModule } from '@panel/core/module';

export default defineModule({
  name: 'requests',
  kernel: '^1',
  needs: ['areas'],
  facts: ['services.gate', 'services.sockets.gateAdmin'],
});
