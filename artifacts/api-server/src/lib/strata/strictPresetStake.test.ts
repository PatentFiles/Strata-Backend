import test from "node:test";
import assert from "node:assert/strict";
import {STANDARD_PROPORTIONAL_PRESET} from "./sharedPresets";
import {resolveStrictPresetStake} from "./strictPresetStake";

const standard=STANDARD_PROPORTIONAL_PRESET;
function select(capitalBudgetCents:number, stakeCents:number, preset=standard){
  return resolveStrictPresetStake(preset,{
    presetId:preset.id,presetRevision:preset.revision,capitalBudgetCents,
  },capitalBudgetCents,stakeCents);
}

test("6% C52/C53 keeps exact stake, all-in, daily and total risk ratios",()=>{
  const samples=[
    {capital:2500,stake:150,allIn:200,daily:500,total:1500},
    {capital:50_000,stake:3000,allIn:4000,daily:10_000,total:30_000},
    {capital:2_500_000,stake:150_000,allIn:200_000,daily:500_000,total:1_500_000},
    {capital:41_666_667,stake:2_500_000,allIn:3_333_333,daily:8_333_333,total:25_000_000},
  ];
  for(const t of samples){
    const d=select(t.capital,t.stake);
    assert.equal(d.ok,true,JSON.stringify(t));
    if(!d.ok)continue;
    assert.deepEqual([
      d.limits.maxEntryStakeCents,d.limits.maxEntryAllInCents,
      d.limits.maxDailyLossCents,d.limits.maxTotalLossCents,
    ],[t.stake,t.allIn,t.daily,t.total]);
  }
});

test("separate 12% and 80% named presets require their own version",()=>{
  const twelve={...standard,id:"twelve-percent",revision:2,maxEntryStakeCents:300,
    maxEntryAllInCents:400,maxDailyLossCents:500,maxTotalLossCents:1500};
  const eighty={...standard,id:"eighty-percent",revision:5,maxEntryStakeCents:2000,
    maxEntryAllInCents:2250,maxDailyLossCents:2250,maxTotalLossCents:2500};
  assert.equal(select(2500,300,twelve).ok,true);
  assert.equal(select(2500,2000,eighty).ok,true);
  assert.equal(select(2500,2000,standard).ok,false);
  const wrong=resolveStrictPresetStake(twelve,{
    presetId:twelve.id,presetRevision:1,capitalBudgetCents:2500,
  },2500,300);
  assert.deepEqual(wrong,{ok:false,reason:"selected_risk_preset_revision_changed"});
});

test("stale cash, unapproved budget, mismatch, and hard $25k ceiling fail closed",()=>{
  const overCash=resolveStrictPresetStake(standard,{
    presetId:standard.id,presetRevision:standard.revision,capitalBudgetCents:2501,
  },2500,150);
  assert.equal(overCash.ok,false);
  const mismatch=select(2500,2000);
  assert.deepEqual(mismatch,{ok:false,reason:"stake_must_match_selected_proportional_preset"});
  const tiny=select(2000,120);
  assert.equal(tiny.ok,false);
  const cap=select(50_000_000,3_000_000);
  assert.equal(cap.ok,false);
  assert.equal(select(2500,150).ok,true);
});
