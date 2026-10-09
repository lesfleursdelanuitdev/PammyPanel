// The help module (docs/module-contracts-plan.md section 1).
// the guides on their own (docs/phase9-plan.md 9-1)
import { defineModule } from '@panel/core/module';

export default defineModule({
  name: 'help',
  kernel: '^1',
  needs: [],
  facts: ['help'],
});
