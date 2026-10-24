import test from "node:test";
import assert from "node:assert/strict";
import {boundDynamicFeeEntryV4,DYNAMIC_FEE_POLICY_VERSION_V4,
 type VersionedFeeAuthorityV4,type ExactOrderRiskV4} from "./dynamicFeeOrderRiskV4";
import {computeDynamicFeeModelDigest,type DynamicFeeModel} from "./dynamicOfficialFeeSchedule";

const now=Date.parse("2026-10-23T20:00:00.000Z");
const owner="11111111-1111-4111-8111-111111111111";
const account="index2-subaccount1-owner";
const market="KXBTC15M-26OCT231915";
const sha="a".repeat(40),modelDigest="b".repeat(64),pdf="c".repeat(64);
const grant:VersionedFeeAuthorityV4={
 policyVersion:DYNAMIC_FEE_POLICY_VERSION_V4,ownerId:owner,
 executionAccountId:account,marketTicker:market,modelDigest,
 officialPublicationDigest:pdf,deployedSha:sha,
 approvedAtMs:now-60_000,expiresAtMs:now+300_000,revokedAtMs:null,
 authorizedStages:["STEP_9","STEP_11","ORDER_ENTRY"],
 maxGrossEntryCents:500,maxAllInEntryCents:625,
};
const observed:DynamicFeeModel={
 issuer:"https://kalshi.com/docs/kalshi-fee-schedule.pdf",
 publicationDigest:pdf,effectiveDate:"2026-07-07",
 takerRatePpm:70_000,makerRatePpm:17_500,
 defaultTakerMultiplierPpm:1_000_000,defaultMakerMultiplierPpm:0,
 marketTicker:market,eventTicker:market,metadataDigest:"d".repeat(64),
 feeType:"quadratic",feeMultiplier:"1",
 modelDigest,observedAt:new Date(now-500).toISOString(),
 tradingAuthorized:false,requiresVersionedReview:true,
};
observed.modelDigest=computeDynamicFeeModelDigest(observed);
grant.modelDigest=observed.modelDigest;
const order:ExactOrderRiskV4={
 ownerId:owner,executionAccountId:account,deployedSha:sha,
 marketTicker:market,side:"YES",action:"BUY",reduceOnly:false,
 timeInForce:"IOC",postOnly:false,limitPriceTicks:5000,
 contractsHundredths:1000,availableCashCents:2500,capitalRemainingCents:2500,
 approvedPolicyGrossCents:500,approvedPolicyAllInCents:625,
 reservedExitFeeCents:10,nowMs:now,
};
test("gross $5/fees per 0.01 partial fill/exit fees account for all-in $5.30",()=>{
 const v=boundDynamicFeeEntryV4(grant,observed,order);
 assert.deepEqual(v,{ok:true,grossMicros:5_000_000n,
   maximumEntryFeeMicros:200_000n,allInCents:530,
   modelDigest:observed.modelDigest,tradingAuthorized:false});
});
test("new rate changes computed worst-fill upper bound, never uses 0.07 constant",()=>{
 const revised={...observed,takerRatePpm:90_000};
 revised.modelDigest=computeDynamicFeeModelDigest(revised);
 // Model drift NEVER reuses old owner's consent.
 assert.equal(boundDynamicFeeEntryV4(grant,revised,order).ok,false);
 const high=boundDynamicFeeEntryV4({...grant,modelDigest:revised.modelDigest},revised,order);
 assert.equal(high.ok,true);
 if(high.ok){assert.equal(high.maximumEntryFeeMicros,300_000n);
 assert.equal(high.allInCents,540);}
 const overModel={...observed,takerRatePpm:200_000};
 overModel.modelDigest=computeDynamicFeeModelDigest(overModel);
 const over=boundDynamicFeeEntryV4({...grant,modelDigest:overModel.modelDigest},overModel,
 {...order,reservedExitFeeCents:115});
 assert.equal(over.ok,false);
});
test("changed/revoked/stale/other owner/SHA/market/consent always rejects",()=>{
 const broken=[
 [grant,{...observed,modelDigest:"e".repeat(64)},order],
 [grant,{...observed,publicationDigest:"e".repeat(64)},order],
 [grant,{...observed,metadataDigest:"!"},order],
 [grant,{...observed,takerRatePpm:1},order],
 [grant,{...observed,issuer:"https://attacker.invalid/pdf"},order],
 [grant,{...observed,feeType:"unknown"},order],
 [grant,{...observed,observedAt:new Date(now-11_000).toISOString()},order],
 [{...grant,revokedAtMs:now-1},observed,order],
 [{...grant,expiresAtMs:now+10_000},observed,order],
 [{...grant,approvedAtMs:now+1},observed,order],
 [{...grant,authorizedStages:["STEP_9"]},observed,order],
 [{...grant,ownerId:"other"},observed,order],
 [{...grant,deployedSha:"f".repeat(40)},observed,order],
 [{...grant,marketTicker:"KXBTC15M-other"},observed,order],
 [grant,observed,{...order,ownerId:"other"}],
 [grant,observed,{...order,marketTicker:"KXBTC15M-other"}],
 [grant,observed,{...order,deployedSha:"f".repeat(40)}],
 ] as const;
 for(const [g,m,o] of broken)assert.equal(boundDynamicFeeEntryV4(
   g as VersionedFeeAuthorityV4,m as DynamicFeeModel,o as ExactOrderRiskV4).ok,false);
});
test("execution-side, min $5, all-in cash, gross and fee budgets fail closed",()=>{
 for(const partial of [
   {action:"SELL"},{reduceOnly:true},{timeInForce:"GTC"},{postOnly:true},
   {limitPriceTicks:0},{contractsHundredths:999},
   {availableCashCents:529},{capitalRemainingCents:529},
   {approvedPolicyAllInCents:529},{approvedPolicyGrossCents:499},
   {reservedExitFeeCents:200},{contractsHundredths:0},
 ])assert.equal(boundDynamicFeeEntryV4(grant,observed,{
   ...order,...partial} as ExactOrderRiskV4).ok,false,JSON.stringify(partial));
 assert.equal(boundDynamicFeeEntryV4({...grant,maxAllInEntryCents:529},
   observed,order).ok,false);
 assert.equal(boundDynamicFeeEntryV4(grant,observed,{
   ...order,side:"NO"}).ok,true);
});
test("zero privilege: this calculator never grants execution from an observation",()=>{
 const result=boundDynamicFeeEntryV4(grant,observed,order);
 assert.equal(result.tradingAuthorized,false);
});
