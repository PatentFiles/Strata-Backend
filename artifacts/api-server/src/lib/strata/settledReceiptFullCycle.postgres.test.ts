import test from 'node:test';
import {runSettledReceiptFullCycle} from './heldSupervisorDispatch.postgres.fixture';

test('settlement receipt worker: start, simulated entry and protective exit, then restart and reconcile',
 {timeout:120000},runSettledReceiptFullCycle);
