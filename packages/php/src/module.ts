// The php module (docs/module-contracts-plan.md section 1).
import { defineModule } from '@panel/core/module';

export default defineModule({
  name: 'php',
  kernel: '^1',
  needs: [],
  facts: ['services.phpRun'],
});
