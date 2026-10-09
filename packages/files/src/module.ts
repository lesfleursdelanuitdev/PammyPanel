// The files module (docs/module-contracts-plan.md section 1).
import { defineModule } from '@panel/core/module';

export default defineModule({
  name: 'files',
  kernel: '^1',
  needs: ['catalog', 'thumbs'],
  facts: [],
});
