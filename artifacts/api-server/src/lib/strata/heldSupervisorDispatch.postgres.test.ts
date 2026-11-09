import test from 'node:test';
import {runHeldSupervisorDispatchScenario} from './heldSupervisorDispatch.postgres.fixture';

// Run alone through run-v13-disposable-postgres.mjs: one process/database per scenario.
test('actual supervisor: partial_then_flat', {timeout:120000}, async()=>{
 await runHeldSupervisorDispatchScenario('partial_then_flat');
});
