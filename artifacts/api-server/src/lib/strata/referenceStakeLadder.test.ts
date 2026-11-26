import test from 'node:test';
import assert from 'node:assert/strict';
import { TEST_TWENTY_PERCENT_PRESET as preset } from './sharedPresets';
import { resolveStrictPresetStake } from './strictPresetStake';
test('all nine 20 percent reference tiers match the existing policy exactly and fail one cent under',()=>{
 const ladder=[500,1500,2500,5000,10000,15000,20000,25000,50000];
 const rows=ladder.map(stake=>{
  const capitalBudgetCents=stake*5;
  const selection={presetId:preset.id,presetRevision:preset.revision,capitalBudgetCents};
  const exact=resolveStrictPresetStake(preset,selection,capitalBudgetCents,stake);
  assert.ok(exact.ok);
  const low=resolveStrictPresetStake(preset,selection,capitalBudgetCents-1,stake);
  assert.deepEqual(low,{ok:false,reason:'risk_capital_budget_exceeds_fresh_cash'});
  assert.equal(resolveStrictPresetStake(preset,{...selection,capitalBudgetCents:capitalBudgetCents-1},capitalBudgetCents-1,stake).ok,false);
  const p=exact.limits;
  assert.equal(p.maxEntryAllInCents,stake*1.25);
  return [stake,p.capitalLimitCents,p.maxEntryAllInCents,p.maxDailyLossCents,p.maxTotalLossCents];
 });
 console.log('REFERENCE_LADDER',JSON.stringify(rows));
});
