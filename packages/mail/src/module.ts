// The mail module (docs/module-contracts-plan.md section 1).
import { defineModule } from '@panel/core/module';

export default defineModule({
  name: 'mail',
  kernel: '^1',
  needs: [],
  facts: ['mail', 'services.sockets.mail', 'services.mailSettings'],
});
