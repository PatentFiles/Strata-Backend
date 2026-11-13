import test from 'node:test';
import {runHeldSupervisorDispatchScenario} from './heldSupervisorDispatch.postgres.fixture';

// One canonical disposable cluster/process per real restricted-role scenario.
test('restricted nonowner supervisor: ambiguous_post',{timeout:120000},async()=>{
 await runHeldSupervisorDispatchScenario('ambiguous_post',true);
});
