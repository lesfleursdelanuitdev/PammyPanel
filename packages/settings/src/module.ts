// The settings module (docs/module-contracts-plan.md section 1).
import { defineModule } from '@panel/core/module';

export default defineModule({
  name: 'settings',
  kernel: '^1',
  // Settings > Visitors shows people's switch words and rules (docs/k-a-plan.md KA-Q4)
  needs: ['people'],
  facts: [],
});
