// The media module (docs/module-contracts-plan.md section 1).
import { defineModule } from '@panel/core/module';

export default defineModule({
  name: 'media',
  kernel: '^1',
  needs: ['areas', 'api-keys', 'catalog', 'files', 'thumbs'],
  facts: ['services.mediaPublic', 'services.gate'],
});
