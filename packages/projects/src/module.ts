// The projects module (docs/module-contracts-plan.md section 1).
// projects are shown through a host's route (docs/phase8b-plan.md 8b-2: its kind of target)
import { defineModule } from '@panel/core/module';

export default defineModule({
  name: 'projects',
  kernel: '^1',
  needs: ['hosts'],
  facts: ['services.sockets.projects'],
});
