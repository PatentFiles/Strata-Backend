import test from 'node:test';
import {runDischargeReceiptFullCycle} from './heldSupervisorDispatch.postgres.fixture';

test('economic discharge: real worker enters, exits, and restarts in the fenced simulator',
 {timeout:120000},runDischargeReceiptFullCycle);
