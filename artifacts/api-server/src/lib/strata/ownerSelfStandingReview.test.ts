import test from 'node:test';import assert from 'node:assert/strict';
import {recordOwnerSelfStandingReview} from './ownerSelfStandingReview';
import {OWNER_SELF_REVIEW_CONFIRM,standingAuthorityMatches} from './ownerSelfReviewMode';
const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',sha='a'.repeat(40),hash='b'.repeat(64);
const body={expectedSha:sha,accountId:'acct',policyHash:hash,qualificationId:owner,confirmation:OWNER_SELF_REVIEW_CONFIRM};
test('authority modes never relabel owner as independent or accept unknown modes',()=>{
 assert.equal(standingAuthorityMatches({independent_reviewer_id:other},owner),true);
 assert.equal(standingAuthorityMatches({independent_reviewer_id:owner},owner),false);
 assert.equal(standingAuthorityMatches({review_authority:'OWNER_SELF_V1',independent_reviewer_id:null,owner_authorizer_id:owner},owner),true);
 for(const r of [{review_authority:'unknown',independent_reviewer_id:other},{review_authority:'OWNER_SELF_V1',independent_reviewer_id:owner,owner_authorizer_id:owner},{review_authority:'OWNER_SELF_V1',independent_reviewer_id:null,owner_authorizer_id:other}])assert.equal(standingAuthorityMatches(r,owner),false);
});
test('owner identity supplied in body is rejected before database activity',async()=>{
 const deps={sha:()=>sha,db:{connect:async()=>{throw Error('must not connect')}}};
 assert.equal((await recordOwnerSelfStandingReview(owner,{...body,ownerId:other},deps)).reason,'explicit_owner_self_review_required');
});
test('unknown review commit discards session, forbids retry and never claims success',async()=>{
 const calls:string[]=[];let discarded:Error|undefined;
 const db={connect:async()=>({release:(e?:Error)=>{discarded=e},query:async(sql:string)=>{calls.push(sql);
 if(sql==='COMMIT')throw Error('lost acknowledgment');
 if(sql.startsWith('SELECT'))return {rows:[{id:'acct',policy_hash:hash,evidence_digest:hash}]};
 if(sql.startsWith('INSERT'))return {rows:[{release_id:owner}]};return {rows:[]};}})};
 const r=await recordOwnerSelfStandingReview(owner,body,{db,sha:()=>sha,scope:()=>({ownerId:owner,accountId:'acct'})});
 assert.equal(r.ok,false);assert.equal(r.reason,'owner_self_review_outcome_unknown');assert.equal(discarded?.message,'owner_self_commit_unknown');assert.equal(calls.includes('ROLLBACK'),false);
 assert.equal(r.workerStarted,false);assert.equal(r.ordersSubmitted,false);
});

test('unset or foreign server enrollment scope refuses before database activity',async()=>{
 const db={connect:async()=>{throw Error('must not connect')}};
 for(const scope of [undefined,{ownerId:other,accountId:'acct'},{ownerId:owner,accountId:'foreign'}]){
  const r=await recordOwnerSelfStandingReview(owner,body,{db,sha:()=>sha,scope:()=>scope});assert.equal(r.reason,'owner_self_account_not_enabled');
 }
});
