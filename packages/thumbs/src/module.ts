// The thumbs module (docs/module-contracts-plan.md section 1).
// pictures for the catalog's items; they go in <mediaPublic>/thumbs, which the gate reads for the media API
import { defineModule } from '@panel/core/module';

export default defineModule({
  name: 'thumbs',
  kernel: '^1',
  needs: ['catalog'],
  facts: ['services.sockets.thumbs', 'services.mediaPublic'],
});
