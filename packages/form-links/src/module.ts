// The form-links module (docs/module-contracts-plan.md section 1).
import { defineModule } from '@panel/core/module';

export default defineModule({
  name: 'form-links',
  kernel: '^1',
  needs: ['forms', 'studio'],
  facts: [],
});
