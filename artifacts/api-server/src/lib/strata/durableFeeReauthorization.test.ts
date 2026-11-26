import test from 'node:test';
import assert from 'node:assert/strict';
import {validDurableReauthorizationBody,DURABLE_REAUTH_CONFIRM,durableFeeReauthorizationOutcome,durableReauthorizationAdmissionReason} from './durableFeeReauthorization';
import {HISTORICAL_RISK_ACCEPTANCE} from './historicalOwnerFeeBaseline';
const owner='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const body={authorizationId:id,accountId:'account',modelId:id,originalSha:'a'.repeat(40),expectedSha:'b'.repeat(40),policyHash:'c'.repeat(64),sourceDigest:'d'.repeat(64),confirmation:DURABLE_REAUTH_CONFIRM,riskAcceptance:HISTORICAL_RISK_ACCEPTANCE};
test('exact consent body; no unknown fields, missing consent, same build, malformed identifiers',()=>{
 assert.equal(validDurableReauthorizationBody(body),true);
 for(const changed of [{...body,extra:true},{...body,confirmation:''},{...body,riskAcceptance:''},{...body,expectedSha:body.originalSha},{...body,authorizationId:'invalid'},{...body,sourceDigest:'d'.repeat(63)}])assert.equal(validDurableReauthorizationBody(changed),false);
});
test('outcome malformed fails without DB; zero/duplicates/DB errors all UNKNOWN without retry',async()=>{
 let calls=0;const db={query:async()=>{calls++;return {rows:[]};}};
 assert.equal((await durableFeeReauthorizationOutcome(owner,'bad',body.expectedSha,db)).outcome,'UNKNOWN');assert.equal(calls,0);
 for(const query of [async()=>({rows:[]}),async()=>({rows:[{},{}]}),async()=>{throw Error('db secret');}]){
 const result=await durableFeeReauthorizationOutcome(owner,id,body.expectedSha,{query});assert.deepEqual(result,{outcome:'UNKNOWN',tradingAuthorized:false,workerStarted:false,ordersSubmitted:false,retryAuthorized:false});
 }
});

test('exact-build outcome identifies the actual immutable uploaded baseline, not the repository baseline',async()=>{
 const baseline='platform-upload-'+body.sourceDigest;
 const result=await durableFeeReauthorizationOutcome(owner,id,body.expectedSha,{query:async()=>({rows:[{authorization_id:id,owner_user_id:owner,execution_account_id:body.accountId,model_id:body.modelId,original_release_sha:body.originalSha,release_commit_sha:body.expectedSha,policy_hash:body.policyHash,source_digest:body.sourceDigest,confirmation:body.confirmation,risk_acceptance:body.riskAcceptance,historical_baseline_id:baseline,state:'RECORDED'}]})});
 assert.equal(result.outcome,'RECORDED');if(result.outcome==='RECORDED'){assert.equal(result.baselineId,baseline);assert.equal(result.sourceAuthenticityVerified,false);assert.equal(result.tradingAuthorized,false);}
});

import {terminalDisarmedLease} from './terminalWorkerLease';
test('only internally consistent terminal disarmed leases permit fee renewal',()=>{
 for(const state of ['killed','released','owned','expired','disarmed','unknown',null]){
  for(const account_kill of [true,false,null])for(const arm_requested of [true,false,null]){
   assert.equal(terminalDisarmedLease({state,account_kill,arm_requested}),arm_requested===false&&((state==='killed'&&account_kill===true)||(state==='released'&&account_kill===false)));
  }
 }
 assert.equal(terminalDisarmedLease(null),false);assert.equal(terminalDisarmedLease(undefined),false);
});

test('fee preview diagnoses deployment admission and never permits an unqualified public release',()=>{
 const sha='a'.repeat(40),env={NODE_ENV:'production',STRATA_PUBLIC_SELF_SERVICE_ENABLED:'true',RAILWAY_GIT_COMMIT_SHA:sha,STRATA_PUBLIC_SELF_SERVICE_QUALIFIED_SHA:sha};
 assert.equal(durableReauthorizationAdmissionReason(owner,sha,true,env),null);
 assert.equal(durableReauthorizationAdmissionReason(owner,sha,true,{...env,STRATA_PUBLIC_SELF_SERVICE_QUALIFIED_SHA:'b'.repeat(40)}),'durable_reauthorization_platform_release_unqualified');
 assert.equal(durableReauthorizationAdmissionReason(owner,sha,true,{...env,STRATA_PUBLIC_SELF_SERVICE_QUALIFIED_SHA:undefined}),'durable_reauthorization_platform_release_unqualified');
 assert.equal(durableReauthorizationAdmissionReason(owner,sha,true,{...env,RAILWAY_GIT_COMMIT_SHA:'b'.repeat(40)}),'durable_reauthorization_platform_release_unqualified');
 assert.equal(durableReauthorizationAdmissionReason(owner,sha,false,env),'durable_reauthorization_fee_path_disabled');
 assert.equal(durableReauthorizationAdmissionReason(owner,'unknown',true,env),'durable_reauthorization_deployed_build_unavailable');
 assert.equal(durableReauthorizationAdmissionReason('invalid',sha,true,env),'durable_reauthorization_owner_unverified');
});
