import test from 'node:test';
import {runHeldSupervisorDispatchScenario} from './heldSupervisorDispatch.postgres.fixture';
test('combined restricted worker refuses final standing-review revocation without a POST or accounting continuation',
 {timeout:120000},async()=>runHeldSupervisorDispatchScenario('ambiguous_post',true,'revocation'));
