import test from 'node:test';
import assert from 'node:assert/strict';
import {activateOwnerSelfAccount,ownerSelfActivationOutcome,OWNER_SELF_ACTIVATION_CONFIRM} from './ownerSelfAccountActivation';

const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const sha='a'.repeat(40),hash='b'.repeat(64),account='strata-account-exact';
const body={expectedSha:sha,accountId:account,policyHash:hash,
 qualificationId:'33333333-3333-4333-8333-333333333333',
 reviewId:'44444444-4444-4444-8444-444444444444',confirmation:OWNER_SELF_ACTIVATION_CONFIRM};
const originalActivation=process.env.STRATA_OWNER_SELF_ACTIVATION_ENABLED;
const originalExit=process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE;
test.after(()=>{
 if(originalActivation===undefined)delete process.env.STRATA_OWNER_SELF_ACTIVATION_ENABLED;
 else process.env.STRATA_OWNER_SELF_ACTIVATION_ENABLED=originalActivation;
 if(originalExit===undefined)delete process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE;
 else process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE=originalExit;
});
test('invalid owner, forged ownerUserId and malformed consent fail before database access',async()=>{
 const deps={sha:()=>sha,scope:()=>({ownerId:owner,accountId:account}),
  db:{query:async()=>{throw Error('must not query')},connect:async()=>{throw Error('must not connect')}}};
 assert.equal((await activateOwnerSelfAccount('not-a-user',body,deps)).ok,false);
 assert.equal((await activateOwnerSelfAccount(owner,{...body,ownerUserId:other},deps)).reason,'owner_self_explicit_activation_consent_required');
 assert.equal((await activateOwnerSelfAccount(owner,{...body,confirmation:'approve'},deps)).ok,false);
 assert.equal((await activateOwnerSelfAccount(owner,{...body,policyHash:'wrong'},deps)).ok,false);
});
test('enrollment belongs to signed exact owner and account, not to global ADMIN role',async()=>{
 const deps={sha:()=>sha,scope:()=>({ownerId:owner,accountId:account})};
 assert.equal((await activateOwnerSelfAccount(other,body,deps)).reason,'owner_self_account_not_enrolled');
 assert.equal((await activateOwnerSelfAccount(owner,{...body,accountId:'foreign'},deps)).reason,'owner_self_account_not_enrolled');
 assert.equal((await activateOwnerSelfAccount(owner,{...body,expectedSha:'c'.repeat(40)},deps)).reason,'owner_self_deployed_sha_changed');
});
test('missing explicit activation flag and protective capability both fail closed',async()=>{
 process.env.STRATA_OWNER_SELF_ACTIVATION_ENABLED='false';
 process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE='true';
 const deps={sha:()=>sha,scope:()=>({ownerId:owner,accountId:account})};
 assert.equal((await activateOwnerSelfAccount(owner,body,deps)).reason,'owner_self_activation_feature_disabled');
 process.env.STRATA_OWNER_SELF_ACTIVATION_ENABLED='true';
 process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE='false';
 assert.equal((await activateOwnerSelfAccount(owner,body,deps)).reason,'owner_self_signed_protective_exit_feature_disabled');
});
test('activation outcome is scoped to actual owner, source account and recorded SHA',async()=>{
 const rows=[{id:'event',payload:{ownerId:owner},account_id:account,
  execution_enabled:true,kill_switch:false,state:'released',account_kill:false,arm_requested:false}];
 const db={query:async(sql:string,params?:unknown[])=>{
   assert.match(sql,/OWNER_SELF_ACCOUNT_ACTIVATED/);
   assert.deepEqual(params,[owner,sha]);
   return {rows};
 }};
 const r=await ownerSelfActivationOutcome(owner,sha,db);
 assert.equal(r.outcome,'RECORDED');
 assert.equal(r.eligibilityCurrent,true);
 assert.equal(r.tradingAuthorized,false);
 assert.equal((await ownerSelfActivationOutcome(owner,'bad-sha',db)).outcome,'UNKNOWN');
});
test('missing or multiple ambiguous activation receipts never authorize a retry',async()=>{
 const db={query:async()=>({rows:[]})};
 assert.equal((await ownerSelfActivationOutcome(owner,sha,db)).outcome,'UNKNOWN');
 const multi={query:async()=>({rows:[{id:'1'},{id:'2'}]})};
 assert.equal((await ownerSelfActivationOutcome(owner,sha,multi)).outcome,'UNKNOWN');
});
