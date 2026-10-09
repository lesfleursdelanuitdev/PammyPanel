// The studio module (docs/module-contracts-plan.md section 1).
// her tables' records are a catalog source (docs/catalog-plan.md step 4)
import { defineModule } from '@panel/core/module';

export default defineModule({
  name: 'studio',
  kernel: '^1',
  needs: ['catalog'],
  // the panel's door to the database helper, and the gate's (row ops only, S2)
  facts: ['services.sockets.pammydb', 'services.sockets.pammydbGate'],
});
