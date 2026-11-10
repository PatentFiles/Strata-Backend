import test from 'node:test';
import {runHeldSupervisorDispatchScenario} from './heldSupervisorDispatch.postgres.fixture';

// One canonical disposable cluster/process per real restricted-role scenario.
test('restricted nonowner supervisor: partial_then_flat',{timeout:120000},async()=>{
 await runHeldSupervisorDispatchScenario('partial_then_flat',true);
});
