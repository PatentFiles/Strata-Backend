import test from 'node:test';
import {runEconomicDischargeFullCycle} from './heldSupervisorDispatch.postgres.fixture';
test('real worker: 50c source/52c ask refuses before order; distinct fresh crossing enters once, fills, exits, reconciles and restarts without replay',{timeout:120000},()=>runEconomicDischargeFullCycle(true));
