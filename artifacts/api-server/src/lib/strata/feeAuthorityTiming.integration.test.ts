import test from 'node:test';import assert from 'node:assert/strict';
import {FeeAuthorityTimingCapture,withFeeAuthorityTimingPurpose} from './feeAuthorityTiming';
import {hasContinuousGrantHistory,checkContinuousEligibility} from './continuousExecutionAuthorization';
import {verifyReviewedApiFeeSourceStage} from './apiFeeSourceStage';
import {renewStandingFeeObservationLease} from './apiFeeStandingDelegation';
import {beginExecutionStage,type StageTiming} from '../v13-production/stageTiming';
import type {KalshiMarketFeeReadOnly} from './twoSourceFeeEvidence';
const owner='11111111-1111-4111-8111-111111111111',grant='22222222-2222-4222-8222-222222222222',sha='a'.repeat(40),ticker='KXBTC15M-26NOV02T2210';
const at=Date.parse('2026-11-02T22:10:00Z');
const proof=():KalshiMarketFeeReadOnly=>({ok:true,reason:'live_series_event_fee_metadata_verified_read_only',series:'KXBTC15M',exchangeIndex:2,referenceDigest:'a'.repeat(64),liveVerifiedAt:new Date(at-500).toISOString(),marketTicker:ticker,eventTicker:ticker,feeType:'quadratic',feeMultiplier:'1',metadataDigest:'b'.repeat(64),pdfProvenanceApproved:false,ownerPolicyApproved:false,commissioningApproved:false,tradingEnabled:false});
const row=(capture:FeeAuthorityTimingCapture,purpose:string,operation:string)=>capture.snapshot()!.stages.find(r=>r.purpose===purpose&&r.operation===operation)!;
test('actual history throws identical errors; swallowed eligibility query errors remain recorded as rejected',async()=>{
 const error=Error('private database failure'),capture=new FeeAuthorityTimingCapture();let calls=0;
 const db={query:async()=>{calls++;throw error;}};
 await capture.run(()=>withFeeAuthorityTimingPurpose('WIRE_FEE',async()=>{
  await assert.rejects(hasContinuousGrantHistory(db as never,owner,sha),e=>e===error);
  assert.equal(await checkContinuousEligibility(db as never,owner,sha),false);
 }));
 assert.equal(calls,2);for(const operation of ['standing_history_query','standing_eligibility_query']){const r=row(capture,'WIRE_FEE',operation);assert.equal(r.attempted,1);assert.equal(r.rejected,1);assert.equal(r.completed,1);}
 assert.equal(row(capture,'FINAL_MARKET','standing_history_query').attempted,0);
});
test('no history still skips eligibility and no diagnostic can make the conditional query run',async()=>{
 const capture=new FeeAuthorityTimingCapture();let calls=0;
 await capture.run(async()=>{const db={query:async()=>{calls++;return {rows:[]};}};const history=await hasContinuousGrantHistory(db as never,owner,sha);const eligible=history&&await checkContinuousEligibility(db as never,owner,sha);assert.equal(eligible,false);});
 assert.equal(calls,1);assert.equal(row(capture,'FINAL_MARKET','standing_eligibility_query').attempted,0);
});
test('actual fee probe, review and conditional renewal preserve calls, original clocks and identical authority result',async()=>{
 const run=async(capture:FeeAuthorityTimingCapture|null)=>{const calls:string[]=[],sample=proof(),before=JSON.stringify(sample);let clocks=0;
  const work=()=>verifyReviewedApiFeeSourceStage(owner,'ORDER_ENTRY','strata-api-reviewed://kxbtc15m/'+grant,ticker,{now:()=>{clocks++;return at;},sha:()=>sha,probe:async()=>{calls.push('probe');return sample;},db:{query:async(sql:string)=>{calls.push(sql);return {rows:[]};}} as never});
  const value=capture?await capture.run(()=>withFeeAuthorityTimingPurpose('WIRE_FEE',work)):await work();assert.equal(JSON.stringify(sample),before);return {value,calls,clocks};};
 const capture=new FeeAuthorityTimingCapture();assert.deepEqual(await run(capture),await run(null));
 for(const operation of ['fee_public_probe','fee_review_query','fee_standing_renewal_query']){const r=row(capture,'WIRE_FEE',operation);assert.equal(r.attempted,1);assert.equal(r.rejected,0);}
});
test('probe false and query rejection are recorded without changing existing false/throw contracts',async()=>{
 const c=new FeeAuthorityTimingCapture(),error=Error('same failure');let queries=0;
 const denied=await c.run(()=>verifyReviewedApiFeeSourceStage(owner,'ORDER_ENTRY','strata-api-reviewed://kxbtc15m/'+grant,ticker,{now:()=>at,probe:async()=>({ok:false,reason:'fixture_unavailable'}) as never,db:{query:async()=>{queries++;throw error;}} as never}));assert.equal(denied.ok,false);assert.equal(queries,0);assert.equal(row(c,'FINAL_MARKET','fee_public_probe').rejected,1);
 const d=new FeeAuthorityTimingCapture();const result=await d.run(()=>verifyReviewedApiFeeSourceStage(owner,'ORDER_ENTRY','strata-api-reviewed://kxbtc15m/'+grant,ticker,{now:()=>at,probe:async()=>proof(),db:{query:async()=>{queries++;throw error;}} as never}));assert.equal(result.ok,false);assert.equal(result.reason,'api_fee_database_review_unavailable');assert.equal(row(d,'FINAL_MARKET','fee_review_query').rejected,1);
 const e=new FeeAuthorityTimingCapture();const renewal=await e.run(()=>renewStandingFeeObservationLease(owner,grant,'ORDER_ENTRY',{sha:()=>sha,db:{query:async()=>{throw error;}} as never}));assert.deepEqual(renewal,{ok:false,reason:'standing_fee_lease_unavailable'});assert.equal(row(e,'FINAL_MARKET','fee_standing_renewal_query').rejected,1);
});
test('existing dispatch event alone accepts branded metadata; throwing/rejected observers do not change control flow',async()=>{
 const capture=new FeeAuthorityTimingCapture(),diagnostics=capture.snapshot()!,events:StageTiming[]=[];
 for(const kind of ['throw','reject','thenable']){const observer=(event:Readonly<StageTiming>)=>{events.push(event);if(kind==='throw')throw Error('observer');if(kind==='reject')return Promise.reject(Error('observer'));return {then(_resolve:unknown,reject:(error:Error)=>void){reject(Error('observer'));}};};
  const done=beginExecutionStage(observer as never,'dispatch',{accountId:'fixture',mode:'LIVE'});done('proven_not_posted',{feeAuthorityReads:diagnostics});done('completed');}
 beginExecutionStage(e=>{events.push(e);},'prepare_entry',{accountId:'fixture',mode:'LIVE'})('completed',{feeAuthorityReads:diagnostics});
 beginExecutionStage(e=>{events.push(e);},'dispatch',{accountId:'fixture',mode:'LIVE'})('completed',{feeAuthorityReads:{...diagnostics}});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(events.length,5);for(const e of events.slice(0,3))assert.equal(e.feeAuthorityReads,diagnostics);for(const e of events.slice(3))assert.equal(e.feeAuthorityReads,undefined);
});
