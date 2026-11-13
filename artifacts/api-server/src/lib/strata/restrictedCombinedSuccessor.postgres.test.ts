import test from 'node:test';
import {runHeldSupervisorDispatchScenario} from './heldSupervisorDispatch.postgres.fixture';
test('combined restricted worker renews while flat, then uses standing successor through held partial-to-flat exits',
 {timeout:120000},async()=>runHeldSupervisorDispatchScenario('partial_then_flat',true,'success'));
