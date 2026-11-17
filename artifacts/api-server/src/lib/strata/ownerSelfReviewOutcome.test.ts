import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerSelfReviewOutcome} from './ownerSelfReviewOutcome';
import {OWNER_SELF_REVIEW_CONFIRM} from './ownerSelfReviewMode';
const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const body={expectedSha:'a'.repeat(40),accountId:'acct',policyHash:'b'.repeat(64),qualificationId:other};
const row={release_id:owner,owner_user_id:owner,owner_authorizer_id:owner,execution_account_id:'acct',release_commit_sha:body.expectedSha,policy_hash:body.policyHash,qualification_id:other,review_authority:'OWNER_SELF_V1',independent_reviewer_id:null,confirmation:OWNER_SELF_REVIEW_CONFIRM,state:'approved',revoked_at:null};
const db=(rows:Record<string,unknown>[])=>({query:async()=>({rows})});
test('historical exact receipt has no current eligibility or retry authority',async()=>{
 const r=await ownerSelfReviewOutcome(owner,body,db([row]));
 assert.equal(r.outcome,'RECORDED');assert.ok('ownerAuthorizerId' in r&&r.ownerAuthorizerId===owner);assert.equal(r.tradingAuthorized,false);assert.equal(r.retryAuthorized,false);assert.equal(r.workerStarted,false);assert.equal(r.ordersSubmitted,false);
});
test('revocation does not erase historical receipt or grant current permission',async()=>{
 const r=await ownerSelfReviewOutcome(owner,body,db([{...row,revoked_at:new Date()}]));
 assert.equal(r.outcome,'RECORDED');assert.ok('revoked' in r&&r.revoked);assert.equal(r.tradingAuthorized,false);
});
test('query binds authenticated owner and historical scope without current SHA or qualification freshness',async()=>{
 let count=0;
 await ownerSelfReviewOutcome(owner,body,{query:async(sql,args)=>{count++;assert.deepEqual(args,[owner,'acct',body.expectedSha,body.policyHash,other,OWNER_SELF_REVIEW_CONFIRM]);
 assert.match(sql,/r\.owner_authorizer_id=\$1::uuid/);assert.match(sql,/a\.owner_user_id=r\.owner_user_id/);assert.match(sql,/q\.release_commit_sha=r\.release_commit_sha/);assert.match(sql,/LIMIT 2/);assert.doesNotMatch(sql,/expires_at|UPDATE|INSERT|DELETE|FOR UPDATE/);return {rows:[row]};}});
 assert.equal(count,1);
});
test('missing, duplicate and inaccessible receipts remain unknown with no retry',async()=>{
 for(const rows of [[],[row,row]]){const r=await ownerSelfReviewOutcome(owner,body,db(rows));assert.equal(r.outcome,'UNKNOWN');assert.equal(r.retryAuthorized,false);}
 assert.equal((await ownerSelfReviewOutcome(owner,body,{query:async()=>{throw Error('private error');}})).outcome,'UNKNOWN');
});
test('all tuple and authority mismatches remain unknown',async()=>{
 for(const patch of [{owner_user_id:other},{owner_authorizer_id:other},{execution_account_id:'other'},{release_commit_sha:'c'.repeat(40)},{policy_hash:'d'.repeat(64)},{qualification_id:owner},{review_authority:'INDEPENDENT_V1'},{independent_reviewer_id:other},{confirmation:'wrong'},{state:'pending'},{release_id:'invalid'}])assert.equal((await ownerSelfReviewOutcome(owner,body,db([{...row,...patch}]))).outcome,'UNKNOWN');
});
test('malformed scope and forged owner inputs fail before queries',async()=>{
 let calls=0;const noDb={query:async()=>{calls++;throw Error('must not query');}};
 for(const raw of [null,[],{}, {...body,ownerUserId:other},{...body,accountId:''},{...body,expectedSha:'invalid'},{...body,policyHash:[]},{...body,qualificationId:'bad'}])assert.equal((await ownerSelfReviewOutcome(owner,raw,noDb)).outcome,'UNKNOWN');
 assert.equal(calls,0);
});
