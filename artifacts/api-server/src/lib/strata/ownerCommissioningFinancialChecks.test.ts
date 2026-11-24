import test from "node:test";
import assert from "node:assert/strict";
import {verifyCommissioningFinancialChecks,VERIFY_FINANCIAL_CHECKS} from "./ownerCommissioningFinancialChecks";
const owner="11111111-1111-4111-8111-111111111111";
const consent={expectedOwnerId:owner,confirmation:VERIFY_FINANCIAL_CHECKS};
function fixture(){
 const status={ok:true,emailVerified:true,ownedAccountUnique:true,keyInventory:{connection:"saved",storedRoles:["provisioning","verification","account_setup_execution","restricted_execution"],primaryMaskedId:null},
 credentials:{allFourRecorded:true},account:{commissioned:true,killSwitchOn:true,provisionalHold:false,otherFreeze:false},
 funding:{historicalOrCompletedTransferRecorded:true},policy:{approvedRecord:true,configuredStakeCents:500},
 openingBasis:{cashMicros:"25000000",initialCashMicros:"25000000",cashMovementMicros:"0",differenceMicros:"0",repairCandidate:false}};
 const signed={ok:true,authenticatedExchangeFlat:true,exchangeCashMatchesLedger:true,apiMarketFeeMetadataVerified:true};
 const fee={ok:true,feeArtifactDigest:"a".repeat(64),reason:"approved_fee_verified"};
 const audit={ok:true,cash:{persistedReconciliationFresh:true,localExposureFlat:true},exit:{protectiveRelease:{recordPresent:true}},owner:{exactShaApproval:{recordPresent:true}}};
 const calls:string[]=[];
 const ports={status:async(id:string)=>{assert.equal(id,owner);calls.push("status");return structuredClone(status);},
 signed:async(id:string)=>{assert.equal(id,owner);calls.push("signed");return signed;},
 fee:async(id:string)=>{assert.equal(id,owner);calls.push("fee");return fee;},
 release:async(id:string)=>{assert.equal(id,owner);calls.push("release");return audit;}};
 const run=(body:unknown=consent,id=owner)=>verifyCommissioningFinancialChecks(id,body,ports as never);
 return {status,signed,fee,audit,calls,ports,run};
}
test("exact owner and versioned evidence consent required before any provider call",async()=>{
 const f=fixture();
 for(const b of [{...consent,expectedOwnerId:"22222222-2222-4222-8222-222222222222"},{...consent,allowTrading:true},{...consent,confirmation:"VERIFY_AND_COMMISSION_TECHNICAL_SETUP_V1"}]){
  assert.equal((await f.run(b)).ok,false);
 }
 assert.deepEqual(f.calls,[]);
});
test("registered opening discrepancy is an owner recovery decision, not an automatic write",async()=>{
 const f=fixture();f.status.openingBasis.initialCashMicros="0";f.status.openingBasis.differenceMicros="25000000";
 const out=await f.run();assert.equal(out.stage,"OPENING_CAPITAL_RECOVERY_REQUIRED");assert.deepEqual(f.calls,["status"]);
 assert.equal(out.tradingAuthorized,false);
});
test("missing funding or policy is identified without financial mutation",async()=>{
 for(const stage of ["FUNDING_REQUIRED","POLICY_REQUIRED"]){
  const f=fixture();if(stage==="FUNDING_REQUIRED")f.status.funding.historicalOrCompletedTransferRecorded=false;else f.status.policy.approvedRecord=false;
  assert.equal((await f.run()).stage,stage);assert.deepEqual(f.calls,["status"]);
 }
});
test("signed history and cash must both match before actual fee-source checks",async()=>{
 const f=fixture();f.signed.exchangeCashMatchesLedger=false;
 const out=await f.run();assert.equal(out.stage,"CASH_RECONCILIATION_REQUIRED");assert.deepEqual(f.calls,["status","signed"]);
});
test("API market metadata is never complete issuer monetary authorization",async()=>{
 const f=fixture();f.fee.ok=false;
 const out=await f.run();assert.equal(out.stage,"FEE_AUTHORITY_REQUIRED");assert.equal(out.checks.marketFeeMetadataVerified,true);
 assert.equal(out.checks.approvedFeeSourceVerified,false);assert.equal(out.tradingAuthorized,false);
});
test("complete current evidence remains distinct from actual activation",async()=>{
 const f=fixture();const out=await f.run();assert.equal(out.stage,"CHECKS_COMPLETE");
 assert.deepEqual(f.calls,["status","signed","fee","release","status"]);
 assert.equal(out.readOnly,true);assert.equal(out.ordersSubmitted,false);assert.equal(out.transferAttempted,false);
 assert.equal(out.workerStarted,false);assert.equal(out.tradingAuthorized,false);
});
test("stale reconciliation, provisional hold and release gaps retain their real next action",async()=>{
 for(const stage of ["CASH_RECONCILIATION_REQUIRED","COMMISSIONING_REQUIRED","RELEASE_REQUIRED"]){
  const f=fixture();
  if(stage==="CASH_RECONCILIATION_REQUIRED")f.audit.cash.persistedReconciliationFresh=false;
  else if(stage==="COMMISSIONING_REQUIRED")f.status.account.provisionalHold=true;
  else f.audit.exit.protectiveRelease.recordPresent=false;
  assert.equal((await f.run()).stage,stage);
 }
});
test("a concurrent change in the owner policy refuses the composite report",async()=>{
 const f=fixture();
 f.ports.fee=async id=>{assert.equal(id,owner);f.status.policy.configuredStakeCents=600;return f.fee;};
 assert.equal((await f.run()).stage,"BLOCKED");
});
