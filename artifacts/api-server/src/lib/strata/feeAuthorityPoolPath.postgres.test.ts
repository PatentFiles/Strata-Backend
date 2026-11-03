import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {pool} from '@workspace/db';
import {FeeAuthorityTimingCapture,withFeeAuthorityTimingPurpose} from './feeAuthorityTiming';
import {beginExecutionStage,type StageTiming} from '../v13-production/stageTiming';
import {verifyReviewedApiFeeSourceStage} from './apiFeeSourceStage';
import {renewStandingFeeObservationLease} from './apiFeeStandingDelegation';
import type {KalshiMarketFeeReadOnly} from './twoSourceFeeEvidence';
assert.match(process.env.V13_DISPOSABLE_DATABASE_URL??'',/^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/,'fresh disposable PostgreSQL only');
after(()=>pool.end());
const owner='11111111-1111-4111-8111-111111111111',grant='22222222-2222-4222-8222-222222222222',sha='a'.repeat(40),ticker='KXBTC15M-LOCAL-TEST';
const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
const stage=(c:FeeAuthorityTimingCapture,operation:string,purpose='FINAL_MARKET')=>c.snapshot()!.stages.find(r=>r.purpose===purpose&&r.operation===operation)!;
const proof=(at:number):KalshiMarketFeeReadOnly=>({ok:true,reason:'live_series_event_fee_metadata_verified_read_only',series:'KXBTC15M',exchangeIndex:2,referenceDigest:'a'.repeat(64),liveVerifiedAt:new Date(at-500).toISOString(),marketTicker:ticker,eventTicker:ticker,feeType:'quadratic',feeMultiplier:'1',metadataDigest:'b'.repeat(64),pdfProvenanceApproved:false,ownerPolicyApproved:false,commissioningApproved:false,tradingEnabled:false});
async function emptyReviewSchema(){
 // ONLY empty local shapes needed to execute the unchanged real review SELECT.
 // No consent/model/grant is manufactured, and no positive fee authority exists.
 await pool.query(`CREATE SCHEMA IF NOT EXISTS private; CREATE SCHEMA IF NOT EXISTS auth;
 CREATE TABLE IF NOT EXISTS auth.users(id uuid,email text,email_confirmed_at timestamptz);
 CREATE TABLE IF NOT EXISTS private.role_assignments(email text,role text);
 CREATE TABLE IF NOT EXISTS private.strata_api_fee_source_grants(grant_id uuid,owner_user_id uuid,issuer_admin_id uuid,rate_decision_digest text,fee_model_version text,policy_version text,scope text,issued_at timestamptz,expires_at timestamptz,revoked_at timestamptz,authorized_stages text[],confirmation text);
 CREATE TABLE IF NOT EXISTS private.strata_api_fee_owner_consents(grant_id uuid,owner_user_id uuid,confirmed_at timestamptz,revoked_at timestamptz,confirmation text);
 CREATE TABLE IF NOT EXISTS private.strata_api_fee_rate_reviews(review_id uuid,owner_user_id uuid,reviewer_user_id uuid,rate_decision_digest text,fee_model_version text,scope text,signed_at timestamptz,expires_at timestamptz,revoked_at timestamptz,confirmation text);`);
}
async function saturated<T>(run:()=>Promise<T>){
 const holders=[];const outer=await pool.connect();await outer.query('BEGIN');
 let released=false;let pending:Promise<T>|undefined;
 try{
  for(let n=1;n<10;n++)holders.push(await pool.connect());
  assert.equal(pool.totalCount,10);assert.equal(pool.idleCount,0);
  const start=performance.now();pending=run();
  const deadline=start+2000;
  while(pool.waitingCount===0&&performance.now()<deadline)await sleep(1);
  assert.equal(pool.waitingCount,1,'actual global pool query queued behind outer transaction and9holders');
  await sleep(80);const waited=performance.now()-start;
  holders.pop()!.release();released=true;
  const value=await pending;
  assert.equal((await outer.query('SELECT 1 AS outer_transaction_still_usable')).rows[0].outer_transaction_still_usable,1);
  return {value,waited};
 }finally{
  for(const c of holders)c.release();
  await outer.query('ROLLBACK');outer.release();
  if(pending&&!released)await pending.catch(()=>{});
 }
}

test('actual FINAL fee review + conditional renewal attribute global-pool queue without fabricating authority',async()=>{
 await emptyReviewSchema();const at=Date.now(),sample=proof(at),before=JSON.stringify(sample);let probeCalls=0,clockCalls=0;
 const invoke=()=>verifyReviewedApiFeeSourceStage(owner,'ORDER_ENTRY','strata-api-reviewed://kxbtc15m/'+grant,ticker,
  {now:()=>{clockCalls++;return at;},sha:()=>sha,probe:async()=>{probeCalls++;return sample;}});
 const baseline=await invoke();const baselineProbe=probeCalls,baselineClock=clockCalls;
 const capture=new FeeAuthorityTimingCapture();
 const {value,waited}=await saturated(()=>capture.run(invoke));
 assert.deepEqual(value,baseline);assert.equal(value.ok,false);assert.equal(value.reason,'standing_fee_lease_unavailable');
 assert.equal(probeCalls,2*baselineProbe);assert.equal(clockCalls,2*baselineClock);assert.equal(JSON.stringify(sample),before);
 const review=stage(capture,'fee_review_query'),renewal=stage(capture,'fee_standing_renewal_query');
 for(const row of [review,renewal]){
  assert.equal(row.attempted,1);assert.equal(row.completed,1);assert.equal(row.active,0);
  assert.equal(row.poolCheckout?.attempted,1);assert.equal(row.poolCheckout?.completed,1);assert.equal(row.poolCheckout?.active,0);
  assert.equal(row.poolCheckout?.rejected,0,'SQL rejection is not checkout rejection');
  assert.ok(row.elapsedMs!>=row.poolCheckout!.elapsedMs!-1);
 }
 assert.equal(review.rejected,0,'real empty review query succeeded');assert.equal(renewal.rejected,1,'real renewal SQL fails closed without standing authority schema');
 assert.ok(review.poolCheckout!.elapsedMs!>=70,'controlled80ms queue is attributed to actual fee review checkout');
 assert.ok(review.poolCheckout!.elapsedMs!<=waited+1000);
 assert.equal(stage(capture,'fee_public_probe').poolCheckout,undefined);
 const diagnostics=capture.snapshot()!,events:StageTiming[]=[];
 const finish=beginExecutionStage(event=>{events.push(event);},'dispatch',{accountId:'local-fee-path',mode:'LIVE'});
 finish('proven_not_posted',{feeAuthorityReads:diagnostics});
 await new Promise<void>(resolve=>setImmediate(resolve));
 assert.equal(events.length,1,'same existing dispatch event only');
 assert.equal(events[0].feeAuthorityReads,diagnostics,'actual fee capture reaches branded dispatch payload unchanged');
 assert.equal(events[0].feeAuthorityReads!.stages.find(r=>r.operation==='fee_review_query'&&r.purpose==='FINAL_MARKET')!.poolCheckout?.attempted,1);
 console.log('ACTUAL_FEE_POOL_QUEUE',JSON.stringify({waitedMs:waited,review,renewal,outcome:value.reason,proofTimestampUnchanged:sample.liveVerifiedAt}));
});

test('actual direct standing renewal uses its separate FINAL checkout scope and keeps SQL denial',async()=>{
 const capture=new FeeAuthorityTimingCapture();
 const {value}=await saturated(()=>capture.run(()=>renewStandingFeeObservationLease(owner,grant,'ORDER_ENTRY',{sha:()=>sha})));
 assert.deepEqual(value,{ok:false,reason:'standing_fee_lease_unavailable'});
 const row=stage(capture,'fee_standing_renewal_query');assert.equal(row.attempted,1);assert.equal(row.rejected,1);
 assert.equal(row.poolCheckout?.attempted,1);assert.equal(row.poolCheckout?.rejected,0);assert.ok(row.poolCheckout!.elapsedMs!>=70);
 assert.equal(stage(capture,'fee_review_query').attempted,0);
});

test('actual WIRE borrowed-client fee queries do not claim a global pool checkout',async()=>{
 const tx=await pool.connect();await tx.query('BEGIN');const holders=[];
 try{
  for(let n=1;n<10;n++)holders.push(await pool.connect());
  const capture=new FeeAuthorityTimingCapture(),at=Date.now();
  const result=await capture.run(()=>withFeeAuthorityTimingPurpose('WIRE_FEE',()=>verifyReviewedApiFeeSourceStage(owner,'ORDER_ENTRY','strata-api-reviewed://kxbtc15m/'+grant,ticker,{db:tx as never,now:()=>at,sha:()=>sha,probe:async()=>proof(at)})));
  assert.equal(result.ok,false);assert.equal(result.reason,'standing_fee_lease_unavailable');assert.equal(pool.waitingCount,0);
  for(const operation of ['fee_review_query','fee_standing_renewal_query']){const r=stage(capture,operation,'WIRE_FEE');assert.equal(r.attempted,1);assert.equal(r.poolCheckout,undefined);}
 }finally{for(const c of holders)c.release();await tx.query('ROLLBACK');tx.release();}
});
