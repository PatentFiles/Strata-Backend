import test from 'node:test';
import {runHeldSupervisorDispatchScenario} from './heldSupervisorDispatch.postgres.fixture';

// One canonical disposable cluster/process per real restricted-role scenario.
test('restricted nonowner supervisor: durable_no_send',{timeout:120000},async()=>{
 await runHeldSupervisorDispatchScenario('durable_no_send',true);
});
