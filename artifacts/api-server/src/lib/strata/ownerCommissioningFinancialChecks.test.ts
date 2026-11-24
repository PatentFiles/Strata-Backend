import test from "node:test";
import assert from "node:assert/strict";
import {verifyCommissioningFinancialChecks,VERIFY_FINANCIAL_CHECKS,advanceOwnerFinancialCommissioning,ADVANCE_FINANCIAL_COMMISSIONING,CONFIRM_INITIAL_COMMISSIONING,PREPARE_RELEASE_QUALIFICATION} from "./ownerCommissioningFinancialChecks";
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

const advanceConsent={expectedOwnerId:owner,confirmation:ADVANCE_FINANCIAL_COMMISSIONING};
const scopeDigest="b".repeat(64);
const observedAt="2026-11-23T12:00:00.123Z";
function transitionFixture(){
 const f=fixture();f.status.account.commissioned=false;
 f.status.funding.historicalOrCompletedTransferRecorded=false;
 f.audit.cash.persistedReconciliationFresh=false;
 const ports={...f.ports,
 funding:async(id:string)=>{assert.equal(id,owner);f.calls.push("funding");f.status.funding.historicalOrCompletedTransferRecorded=true;return {ok:true,historicalVerified:true};},
 refreshCash:async(id:string)=>{assert.equal(id,owner);f.calls.push("cash");f.audit.cash.persistedReconciliationFresh=true;return {ok:true,observedAt};},
 review:async(id:string,fee:unknown)=>{assert.equal(id,owner);assert.equal(fee,f.fee);f.calls.push("review");return {scopeDigest,existingExitFloorMicros:1000};},
 commission:async(id:string,r:{scopeDigest:string},floor:number,at:string)=>{assert.equal(id,owner);assert.equal(r.scopeDigest,scopeDigest);assert.equal(floor,1000);assert.equal(at,observedAt);f.calls.push("commission");f.status.account.commissioned=true;return {ok:true};},
 };
 const run=(body:unknown=advanceConsent)=>advanceOwnerFinancialCommissioning(owner,body,ports as never);
 return {...f,ports,run};
}
const confirmConsent={expectedOwnerId:owner,confirmation:CONFIRM_INITIAL_COMMISSIONING,scopeDigest,minimumExitMicros:1000};
test("financial V1 and malformed V2 cannot invoke writes",async()=>{
 const f=transitionFixture();
 assert.equal((await f.run(consent)).readOnly,true);
 assert.deepEqual(f.calls,["status"]);f.calls.length=0;
 for(const body of [{...advanceConsent,expectedOwnerId:"22222222-2222-4222-8222-222222222222"},{...advanceConsent,start:true},{...confirmConsent,minimumExitMicros:0}]){
  assert.equal((await f.run(body)).ok,false);
 }
 assert.deepEqual(f.calls,[]);
});
test("V2 records funding and cash, then requires exact owner commission; replay only reads",async()=>{
 const f=transitionFixture();
 const review=await f.run();
 assert.equal(review.stage,"COMMISSIONING_REQUIRED");
 assert.ok("commissioningReview" in review&&review.commissioningReview?.scopeDigest===scopeDigest);
 assert.deepEqual(f.calls.filter(x=>["funding","cash","review","commission"].includes(x)),["funding","cash","review"]);
 f.calls.length=0;
 const out=await f.run(confirmConsent);
 assert.equal(out.stage,"CHECKS_COMPLETE");assert.ok("commissioningPerformed" in out&&out.commissioningPerformed);
 assert.equal(out.tradingAuthorized,false);assert.equal(out.workerStarted,false);
 assert.deepEqual(f.calls.filter(x=>["funding","cash","review","commission"].includes(x)),["cash","review","commission"]);
 f.calls.length=0;await f.run(confirmConsent);
 assert.ok(!f.calls.some(x=>["funding","cash","review","commission"].includes(x)));
});
test("V2 does not commission changed scope, changed floor, missing policy or unreconciled cash",async()=>{
 const f=transitionFixture();f.status.funding.historicalOrCompletedTransferRecorded=true;
 for(const body of [{...confirmConsent,scopeDigest:"c".repeat(64)},{...confirmConsent,minimumExitMicros:1001}]){
  assert.equal((await f.run(body)).stage,"BLOCKED");assert.ok(!f.calls.includes("commission"));
 }
 f.calls.length=0;f.status.policy.approvedRecord=false;
 assert.equal((await f.run()).stage,"POLICY_REQUIRED");assert.ok(!f.calls.includes("cash"));
 f.status.policy.approvedRecord=true;
 f.ports.refreshCash=async()=>({ok:false,observedAt});
 assert.equal((await f.run()).stage,"CASH_RECONCILIATION_REQUIRED");assert.ok(!f.calls.includes("commission"));
});
test("commissioned opening-capital discrepancy and provisional hold remain separately authorized",async()=>{
 const f=transitionFixture();f.status.account.commissioned=true;f.status.funding.historicalOrCompletedTransferRecorded=true;
 f.status.openingBasis.differenceMicros="25000000";
 assert.equal((await f.run()).stage,"OPENING_CAPITAL_RECOVERY_REQUIRED");assert.ok(!f.calls.includes("cash"));
 f.status.openingBasis.differenceMicros="0";f.status.account.provisionalHold=true;f.calls.length=0;
 assert.equal((await f.run()).stage,"COMMISSIONING_REQUIRED");assert.ok(!f.calls.includes("commission"));
});

test("V2 can renew already-authorized runtime fee evidence without making V1 write or renew",async()=>{
 const f=transitionFixture();
 f.status.account.commissioned=true;f.status.funding.historicalOrCompletedTransferRecorded=true;
 f.audit.cash.persistedReconciliationFresh=true;f.fee.ok=false;
 const ports={...f.ports,runtimeFee:async(id:string)=>{assert.equal(id,owner);f.calls.push("runtime-fee");return {...f.fee,ok:true};}};
 const v1=await advanceOwnerFinancialCommissioning(owner,consent,ports as never);
 assert.equal(v1.stage,"FEE_AUTHORITY_REQUIRED");assert.equal(v1.readOnly,true);assert.ok(!f.calls.includes("runtime-fee"));assert.ok(!f.calls.includes("cash"));
 f.calls.length=0;
 const v2=await advanceOwnerFinancialCommissioning(owner,advanceConsent,ports as never);
 assert.equal(v2.stage,"CHECKS_COMPLETE");assert.equal(v2.checks.approvedFeeSourceVerified,true);
 assert.equal(f.calls.filter(c=>c==="runtime-fee").length,1);assert.ok(!f.calls.includes("fee"));
 assert.equal(v2.tradingAuthorized,false);assert.equal(v2.workerStarted,false);assert.equal(v2.ordersSubmitted,false);
});

test("explicit preparation records the activation request and technical qualification without granting live authority",async()=>{
 const f=transitionFixture();f.status.account.commissioned=true;f.status.funding.historicalOrCompletedTransferRecorded=true;
 f.audit.cash.persistedReconciliationFresh=true;f.audit.exit.protectiveRelease.recordPresent=false;
 const ports={...f.ports,prepareActivation:async(id:string)=>{assert.equal(id,owner);f.calls.push("prepare-activation");return {ok:true,reason:"activation_requested"};},
 qualify:async(id:string)=>{assert.equal(id,owner);f.calls.push("qualify");return {ok:true,qualificationId:owner,expiresAt:new Date(Date.now()+60000).toISOString()};}};
 for(const body of [consent,advanceConsent,{...advanceConsent,confirmation:PREPARE_RELEASE_QUALIFICATION,expectedOwnerId:"22222222-2222-4222-8222-222222222222"},{...advanceConsent,confirmation:PREPARE_RELEASE_QUALIFICATION,start:true}]){
  f.calls.length=0;await advanceOwnerFinancialCommissioning(owner,body,ports as never);
  assert.ok(!f.calls.includes("prepare-activation"));assert.ok(!f.calls.includes("qualify"));
 }
 f.calls.length=0;
 const out=await advanceOwnerFinancialCommissioning(owner,{expectedOwnerId:owner,confirmation:PREPARE_RELEASE_QUALIFICATION},ports as never);
 assert.equal(out.stage,"RELEASE_REQUIRED");assert.ok("qualificationPrepared" in out&&out.qualificationPrepared);assert.ok("activationRequestRecorded" in out&&out.activationRequestRecorded);
 assert.deepEqual(f.calls.slice(-2),["prepare-activation","qualify"]);
 assert.ok(!f.calls.includes("cash"));assert.ok(!f.calls.includes("commission"));
 assert.equal(out.tradingAuthorized,false);assert.equal(out.workerStarted,false);assert.equal(out.ordersSubmitted,false);
 f.calls.length=0;f.signed.exchangeCashMatchesLedger=false;
 const blocked=await advanceOwnerFinancialCommissioning(owner,{expectedOwnerId:owner,confirmation:PREPARE_RELEASE_QUALIFICATION},ports as never);
 assert.equal(blocked.stage,"CASH_RECONCILIATION_REQUIRED");assert.ok(!f.calls.includes("prepare-activation"));assert.ok(!f.calls.includes("qualify"));
});
