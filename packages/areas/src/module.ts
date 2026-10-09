// The areas module (docs/module-contracts-plan.md section 1).
import { defineModule } from '@panel/core/module';

export default defineModule({
  name: 'areas',
  kernel: '^1',
  needs: [],
  facts: ['services.gate', 'services.sockets.gateAdmin'],
});
