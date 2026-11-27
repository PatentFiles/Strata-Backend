import test from 'node:test';
import assert from 'node:assert/strict';
import {runEconomicDischargeFullCycle} from './heldSupervisorDispatch.postgres.fixture';

// The disposable runner starts a fresh database and fences every external connection.
const [source, lane, adverse] = (process.env.V13_DIRECT_TIMING_CASE ?? '').split('/');
assert.ok(source === 'reviewed' || source === 'durable');
assert.ok(lane === 'serial' || lane === 'overlap' || lane === 'candidate' || lane === 'final_only');
assert.ok(adverse === undefined || adverse === 'duplicate_latency' || adverse === 'wire_expiry' || adverse === 'protective_cycle' || adverse === 'yes_1523' || adverse === 'yes_1523_db' || adverse === 'yes_1523_plan' || adverse === 'yes_1523_work' || adverse === 'yes_1523_lock' || adverse === 'mismatch' || adverse === 'revoked' || adverse === 'wire_fee_deadline');
test('native direct worker timing and outcome', {timeout:120_000},
  () => runEconomicDischargeFullCycle(false, lane, source === 'durable', adverse));
