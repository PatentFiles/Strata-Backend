import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './entryBudgetChoice.fixture';
import {describeApprovedEntryBudgetFunding} from './entryBudgetChoice';
test('displayed loss-limit floors include losses already realized and never modify approvals',()=>{
 const x=fixture(1500,1875,50000,62500);
 x.preflight.realizedDailyLossCents=799000;x.preflight.realizedTotalLossCents=898500;
 const before=JSON.stringify(x),v=describeApprovedEntryBudgetFunding(x);assert.ok(v);
 assert.equal(v.policyDailyLossLimitCents,800000);assert.equal(v.policyTotalLossLimitCents,900000);
 assert.equal(v.policyDailyLossForFullReservationCents,800875);
 assert.equal(v.policyTotalLossForFullReservationCents,900375);
 assert.equal(v.shortfalls.dailyLossCents,875);assert.equal(v.shortfalls.totalLossCents,375);
 assert.equal(JSON.stringify(x),before);
});
test('unsafe sums are unavailable, never rounded into apparently funded limits',()=>{
 const x=fixture(500,625,50000,62500);x.preflight.realizedDailyLossCents=Number.MAX_SAFE_INTEGER;
 assert.equal(describeApprovedEntryBudgetFunding(x),null);
});
