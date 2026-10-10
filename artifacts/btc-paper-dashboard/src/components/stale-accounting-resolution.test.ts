import assert from 'node:assert/strict';
import test from 'node:test';
import type { MicroLiveState } from '@workspace/api-client-react';
import { canResolveStaleAccounting } from './stale-accounting-resolution';

const eligibleState = {
  configurationExists: true,
  accountingUnresolved: true,
  accountingUnresolvedReason: 'startup_exchange_reconciliation_failed',
  enabled: false,
  killSwitch: 'ON',
  databaseFlags: { microLiveProductionEnabled: false, liveExecutionEnabled: false },
  environmentFlags: { microLiveProductionEnabled: false, liveExecutionEnabled: false },
} as MicroLiveState;

test('stale accounting control requires the exact flag and every frozen gate', () => {
  assert.equal(canResolveStaleAccounting(eligibleState), true);
  for (const state of [
    { accountingUnresolved: false },
    { accountingUnresolvedReason: 'another_unresolved_reason' },
    { configurationExists: false },
    { enabled: true },
    { killSwitch: 'OFF' },
    { databaseFlags: null },
    { databaseFlags: { microLiveProductionEnabled: true, liveExecutionEnabled: false } },
    { databaseFlags: { microLiveProductionEnabled: false, liveExecutionEnabled: true } },
    { environmentFlags: { microLiveProductionEnabled: true, liveExecutionEnabled: false } },
    { environmentFlags: { microLiveProductionEnabled: false, liveExecutionEnabled: true } },
  ] satisfies Array<Partial<MicroLiveState>>) {
    assert.equal(canResolveStaleAccounting({ ...eligibleState, ...state }), false, JSON.stringify(state));
  }
});