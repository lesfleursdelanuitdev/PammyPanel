// The comments module (docs/module-contracts-plan.md section 1).
import { defineModule } from '@panel/core/module';

export default defineModule({
  name: 'comments',
  kernel: '^1',
  needs: ['areas', 'forms', 'form-links', 'studio'],
  facts: [],
});
