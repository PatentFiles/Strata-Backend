import test from 'node:test';
import assert from 'node:assert/strict';
import {validDurableReauthorizationBody,DURABLE_REAUTH_CONFIRM,durableFeeReauthorizationOutcome} from './durableFeeReauthorization';
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
