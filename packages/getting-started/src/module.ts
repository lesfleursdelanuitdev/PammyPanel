// The getting-started module (docs/module-contracts-plan.md section 1).
// Getting started's paths are the examples' (docs/phase9-plan.md 9-1)
import { defineModule } from '@panel/core/module';

export default defineModule({
  name: 'getting-started',
  kernel: '^1',
  needs: ['help', 'examples', 'studio'],
  facts: [],
});
