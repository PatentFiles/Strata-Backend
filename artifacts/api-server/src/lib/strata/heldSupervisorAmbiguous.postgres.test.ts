import test from 'node:test';
import {runHeldSupervisorDispatchScenario} from './heldSupervisorDispatch.postgres.fixture';

// Run alone through run-v13-disposable-postgres.mjs: one process/database per scenario.
test('actual supervisor: ambiguous_post', {timeout:120000}, async()=>{
 await runHeldSupervisorDispatchScenario('ambiguous_post');
});
