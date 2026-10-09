// The apps module (docs/module-contracts-plan.md section 1).
import { defineModule } from '@panel/core/module';

export default defineModule({
  name: 'apps',
  kernel: '^1',
  needs: ['mail', 'studio'],
  facts: ['owner', 'apps', 'services.sockets.apps', 'services.wordpressPlacement'],
});
