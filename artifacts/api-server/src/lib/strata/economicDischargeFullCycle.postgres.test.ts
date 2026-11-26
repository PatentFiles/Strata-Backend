import test from 'node:test';
import {runEconomicDischargeFullCycle} from './heldSupervisorDispatch.postgres.fixture';
// No production credentials or network: canonical disposable runner is required.
test('canonical economic discharge: real worker entry, protective exit, STOP, restart, no replay and cash conservation',
 {timeout:120000},runEconomicDischargeFullCycle);
