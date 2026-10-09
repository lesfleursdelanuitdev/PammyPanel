// The examples module (docs/module-contracts-plan.md section 1).
import { defineModule } from '@panel/core/module';

export default defineModule({
  name: 'examples',
  kernel: '^1',
  needs: ['areas', 'files', 'forms', 'api-keys', 'studio', 'form-links', 'comments', 'apps'],
  facts: ['services.tutorialExamples'],
});
