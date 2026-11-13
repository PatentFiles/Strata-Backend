import test from 'node:test';
import {runHeldSupervisorDispatchScenario} from './heldSupervisorDispatch.postgres.fixture';

// Run alone through run-v13-disposable-postgres.mjs: one process/database per scenario.
test('actual supervisor: durable_no_send', {timeout:120000}, async()=>{
 await runHeldSupervisorDispatchScenario('durable_no_send');
});
