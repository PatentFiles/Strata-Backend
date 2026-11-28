import test from 'node:test';import assert from 'node:assert/strict';
import {assessDurableFee,publicationTransition,verifyDurableOwnerFee,DURABLE_FEE_VERSION,type DurableModel} from './durableOwnerFeePolicy';
const fixtureClock=Date.parse("2026-10-15T22:00:00Z");
const marketTicker="KXBTC15M-26OCT15T2200";
function feeApiPages(){
 const close="2026-10-15T22:12:00Z", expiration="2026-10-15T22:13:00Z";
 return {
  "/markets?series_ticker=KXBTC15M&status=open&limit=100":{
   markets:[{ticker:marketTicker,event_ticker:marketTicker,close_time:close,status:"open"}],cursor:""},
  ["/markets/"+marketTicker]:{
   market:{ticker:marketTicker,event_ticker:marketTicker,close_time:close,status:"open",exchange_index:2,open_time:"2026-10-15T21:59:00Z",
   expiration_time:expiration,latest_expiration_time:expiration,expected_expiration_time:expiration}},
  ["/events/"+marketTicker]:{event:{event_ticker:marketTicker,series_ticker:"KXBTC15M",
   fee_type_override:null,fee_multiplier_override:null}},
  "/series/KXBTC15M":{series:{ticker:"KXBTC15M",exchange_index:2,
   fee_type:"quadratic",fee_multiplier:1}},
  "/series/fee_changes?series_ticker=KXBTC15M&show_historical=false":{
   series_fee_change_arr:[],cursor:""},
  ["/events/fee_changes?event_ticker="+marketTicker+"&limit=100"]:{
   event_fee_changes:[],cursor:""},
 } as Record<string,Record<string,unknown>>;
}
function kalshiFeed(pages:Record<string,Record<string,unknown>>):typeof fetch{
 return (async(request:Parameters<typeof fetch>[0],init?:RequestInit)=>{
  assert.equal(init?.method,"GET");
  assert.equal(init?.redirect,"error");
  const url=String(request),base="https://external-api.kalshi.com/trade-api/v2";
  assert.ok(url.startsWith(base+"/"));
  return new Response(JSON.stringify(pages[url.slice(base.length)]??{}),{
   status:200,headers:{"content-type":"application/json"}});
 }) as typeof fetch;
}

const scope={owner:'11111111-1111-4111-8111-111111111111',account:'account',sha:'a'.repeat(40),policyHash:'b'.repeat(64)};
const model:DurableModel={...scope,digest:'c'.repeat(64),version:DURABLE_FEE_VERSION,formula:'standard-quadratic-0.07-v1',effectiveDate:'2026-07-07',approved:true,entryRevoked:false,integrityValid:true,knownPublicationChange:false,monitorState:'never_checked'};
const live={ok:true,ticker:marketTicker,verifiedAt:fixtureClock};
test('durable approved evidence has no recurring PDF lease, but does not claim current publication',()=>{const r=assessDurableFee(model,scope,'ENTRY',live,fixtureClock);assert.equal(r.ok,true);if(r.ok){assert.equal(r.publicationKnownCurrent,false);assert.equal(r.tradingAuthorized,false)}});
for(const intent of ['ENTRY','PROTECTIVE_EXIT'] as const){
 test(intent+' publication transport outage alone does not discard approved terms',()=>assert.equal(assessDurableFee({...model,monitorState:'unavailable'},scope,intent,live,fixtureClock).ok,true));
 for(const [key,value] of Object.entries({approved:false,integrityValid:false,knownPublicationChange:true,formula:'changed',digest:'bad',owner:'foreign',sha:'wrong'}))test(intent+' rejects '+key,()=>assert.equal(assessDurableFee({...model,[key]:value},scope,intent,live,fixtureClock).ok,false));
 test(intent+' fresh metadata missing/stale/future refuses without guessed fee bound',()=>{for(const m of [{...live,ok:false},{...live,verifiedAt:fixtureClock-5001},{...live,verifiedAt:fixtureClock+1}])assert.equal(assessDurableFee(model,scope,intent,m,fixtureClock).ok,false)});
}
test('entry revocation does not disable independent reduce-only fee proof',()=>{const revoked={...model,entryRevoked:true};assert.equal(assessDurableFee(revoked,scope,'ENTRY',live,fixtureClock).ok,false);assert.equal(assessDurableFee(revoked,scope,'PROTECTIVE_EXIT',live,fixtureClock).ok,true)});
test('known change latch cannot be cleared by stale matching response or429',()=>{const a=publicationTransition({knownChange:false,monitorState:'never_checked'},{kind:'verified_canonical_digest',digest:'d'.repeat(64)},model.digest);assert.equal(a.knownChange,true);const b=publicationTransition(a,{kind:'transport_unavailable'},model.digest);assert.equal(b.knownChange,true);assert.equal(publicationTransition(b,{kind:'verified_canonical_digest',digest:model.digest},model.digest).knownChange,true)});
test('malformed change evidence rejects',()=>assert.throws(()=>publicationTransition({knownChange:false,monitorState:'never_checked'},{kind:'verified_canonical_digest',digest:'bad'},model.digest)));
const row={owner_user_id:scope.owner,execution_account_id:scope.account,release_commit_sha:scope.sha,approved_policy_hash:scope.policyHash,official_source_digest:model.digest,policy_version:model.version,formula_version:model.formula,effective_date_text:model.effectiveDate,policy_state:'APPROVED',entry_revoked:false,genuine_source_verified:true,known_publication_change:false,monitor_state:'unavailable'};
test('locked durable row plus existing actual market verifier makes ZERO PDF calls',async()=>{process.env.STRATA_DURABLE_OWNER_FEE_ENABLED='true';let calls=0;const fetcher=kalshiFeed(feeApiPages());const r=await verifyDurableOwnerFee({query:async sql=>{assert.match(sql,/FOR SHARE OF m,s,a,p/);return {rows:[row]}}},scope,marketTicker,'ENTRY',{clock:()=>fixtureClock,fetcher:async(...args)=>{calls++;assert.ok(!String(args[0]).includes('.pdf'));return fetcher(...args)}});assert.equal(r.ok,true,JSON.stringify(r));assert.ok(calls>0)});
test('real market multiplier change is refused without publication polling',async()=>{const pages=feeApiPages();(pages['/series/KXBTC15M'].series as Record<string,unknown>).fee_multiplier=2;const r=await verifyDurableOwnerFee({query:async()=>({rows:[row]})},scope,marketTicker,'ENTRY',{clock:()=>fixtureClock,fetcher:kalshiFeed(pages)});assert.equal(r.ok,false)});
test('missing/ambiguous durable state refuses',async()=>{for(const rows of [[],[row,row]])assert.equal((await verifyDurableOwnerFee({query:async()=>({rows})},scope,marketTicker,'ENTRY',{clock:()=>fixtureClock,fetcher:kalshiFeed(feeApiPages())})).ok,false)});
for(const intent of ['ENTRY','PROTECTIVE_EXIT'] as const){
 test(intent+' oldest request cannot be restamped by a late final metadata body',async()=>{
  process.env.STRATA_DURABLE_OWNER_FEE_ENABLED='true';let at=fixtureClock;
  const feed=kalshiFeed(feeApiPages());
  const fetcher:typeof fetch=async(...args)=>{const response=await feed(...args);
   if(String(args[0]).includes('/events/fee_changes?')){const bytes=response.arrayBuffer.bind(response);Object.defineProperty(response,'arrayBuffer',{value:async()=>{const result=await bytes();at+=14000;return result;}});}
   return response;};
  const result=await verifyDurableOwnerFee({query:async()=>({rows:[row]})},scope,marketTicker,intent,{clock:()=>at,fetcher});
  assert.equal(result.ok,false,'14-second source must not acquire a fresh completion timestamp');
 });
}
for(const intent of ['ENTRY','PROTECTIVE_EXIT'] as const){
 for(const [stage,delay] of [['first',5000],['last',5000],['first',5001],['last',5001],['last',14000]] as const){
  test(`${intent} conservative oldest-request age: ${stage} body +${delay}ms`,async()=>{
   process.env.STRATA_DURABLE_OWNER_FEE_ENABLED='true';let at=fixtureClock,mono=0;
   const feed=kalshiFeed(feeApiPages());const fetcher:typeof fetch=async(...args)=>{
    const response=await feed(...args);const path=String(args[0]);
    if(stage==='first'?path.includes('/markets/'):path.includes('/events/fee_changes?')){
     const bytes=response.arrayBuffer.bind(response);Object.defineProperty(response,'arrayBuffer',{value:async()=>{const result=await bytes();at+=delay;mono+=delay;return result;}});}
    return response;
   };
   const result=await verifyDurableOwnerFee({query:async()=>({rows:[row]})},scope,marketTicker,intent,{clock:()=>at,monotonicNow:()=>mono,fetcher});
   assert.equal(result.ok,delay<=5000,JSON.stringify(result));
   if(result.ok)assert.equal(result.verifiedAtMs,fixtureClock,'must retain pre-transport origin, not completion');
  });
 }
}
test('monotonic elapsed rejects wall-clock restamping/rollback even if wall age looks fresh',async()=>{
 let mono=0;const feed=kalshiFeed(feeApiPages());
 const result=await verifyDurableOwnerFee({query:async()=>({rows:[row]})},scope,marketTicker,'ENTRY',{
 clock:()=>fixtureClock,monotonicNow:()=>mono,fetcher:async(...args)=>{const response=await feed(...args);if(String(args[0]).includes('/events/fee_changes?'))mono=5001;return response;}});
 assert.equal(result.ok,false);
});
test('invalid observation clocks never start provider reads',async()=>{
 for(const invalid of [NaN,Infinity,-1]){let calls=0;
 const result=await verifyDurableOwnerFee({query:async()=>({rows:[row]})},scope,marketTicker,'ENTRY',{
 clock:()=>fixtureClock,monotonicNow:()=>invalid,fetcher:async()=>{calls++;throw Error('must not fetch')}});
 assert.equal(result.ok,false);assert.equal(calls,0);}
});
import {createGuardedDurableFeeFetch,isDurableFeePreTransportRefusal} from './guardedDurableFeeWire';
for(const rollback of [false,true])for(const reduceOnly of [false,true])for(const afterVerification of [1000,1001]){
 test(`final ${reduceOnly?'exit':'entry'} wire retains source age across ${afterVerification}ms boundary delay rollback=${rollback}`, async()=>{
 const token=Object.freeze({}),clientId='v13p-44444444-4444-4444-8444-444444444444';
 const savedNow=Date.now,savedFlag=process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE;
 process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE='true';let at=fixtureClock,mono=0,sends=0;
 Date.now=()=>at;
 try{
 const tx={query:async(sql:string)=>({rows:sql.includes('strata_durable_owner_fee_model')?[row]:[{id:scope.account}]})};
 const feed=kalshiFeed(feeApiPages());const fetcher:typeof fetch=async(...args)=>{const response=await feed(...args);if(String(args[0]).includes('/events/fee_changes?')){at+=4000;mono+=4000;}return response};
 const guarded=createGuardedDurableFeeFetch(scope.owner,scope.account,'strata-durable-owner-fee://33333333-3333-4333-8333-333333333333',
 (async()=>{sends++;return new Response('{}',{status:200})}) as typeof fetch,scope.policyHash,'d'.repeat(64),1,'holder',model.digest,{
 borrowTransaction:()=>tx as never,wireScope:()=>token,sha:()=>scope.sha,hasHistory:async()=>true,currentStanding:async()=>true,exitReview:async()=>true,
 verifyDurable:async()=>{const proof=await verifyDurableOwnerFee(tx,scope,marketTicker,reduceOnly?'PROTECTIVE_EXIT':'ENTRY',{clock:()=>at,monotonicNow:()=>mono,fetcher});at+=rollback?-3000:afterVerification;mono+=afterVerification;return proof;},
 });
 const request=()=>guarded('https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders',{method:'POST',body:JSON.stringify({ticker:marketTicker,subaccount:1,exchange_index:2,reduce_only:reduceOnly,time_in_force:'immediate_or_cancel',self_trade_prevention_type:'taker_at_cross',post_only:false,client_order_id:'v13p-44444444-4444-4444-8444-444444444444',side:'bid',count:'1.00',price:'0.2500'})});
 if(afterVerification>1000){
  const error=await request().then(()=>assert.fail('expected local refusal'),e=>e);
  assert.match(error.message,/durable_fee_final_fresh_model_unverified/);
  assert.equal(isDurableFeePreTransportRefusal(token,error,clientId),!reduceOnly);
  for(const wrong of [null,{}])assert.equal(isDurableFeePreTransportRefusal(wrong,error,clientId),false);
  assert.equal(isDurableFeePreTransportRefusal(token,error,clientId+'-other'),false);
  assert.equal(isDurableFeePreTransportRefusal(token,new Error(error.message),clientId),false);
  if(!reduceOnly){
   await assert.rejects(request());
   assert.equal(isDurableFeePreTransportRefusal(token,error,clientId),false,'ambiguous reuse invalidates earlier proof');
  }
 }else assert.equal((await request()).status,200);
 assert.equal(sends,afterVerification>1000?0:1);
 }finally{Date.now=savedNow;if(savedFlag===undefined)delete process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE;else process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE=savedFlag;}
 });
}

test('source capability cannot be reconstructed from serialized proof',async()=>{
 const proof=await verifyDurableOwnerFee({query:async()=>({rows:[row]})},scope,marketTicker,'ENTRY',{
 clock:()=>fixtureClock,monotonicNow:()=>0,fetcher:kalshiFeed(feeApiPages())});
 assert.equal(proof.ok,true);if(!proof.ok)return;
 assert.equal(proof.sourceFresh(),true);assert.equal(JSON.parse(JSON.stringify(proof)).sourceFresh,undefined);
});

import {HISTORICAL_FEE_VERSION,HISTORICAL_SOURCE_KIND,HISTORICAL_BASELINE_ID,HISTORICAL_BASELINE_SHA256,readHistoricalBaselineBytes} from './historicalOwnerFeeBaseline';
test('historical pinned bytes are an explicit assumption, never an implicit fresh source',async()=>{
 const saved=process.env.STRATA_DURABLE_HISTORICAL_BASELINE_ENABLED;
 try{
 delete process.env.STRATA_DURABLE_HISTORICAL_BASELINE_ENABLED;assert.equal(await readHistoricalBaselineBytes(),null);
 process.env.STRATA_DURABLE_HISTORICAL_BASELINE_ENABLED='true';const source=await readHistoricalBaselineBytes();assert.ok(source);assert.equal(source.digest,HISTORICAL_BASELINE_SHA256);assert.equal(source.effectiveDate,'2026-07-07');
 const historical={...row,policy_version:HISTORICAL_FEE_VERSION,source_kind:HISTORICAL_SOURCE_KIND,genuine_source_verified:false,source_capture_id:null,historical_baseline_id:HISTORICAL_BASELINE_ID,historical_digest:HISTORICAL_BASELINE_SHA256,historical_actual_digest:source.digest,official_source_digest:HISTORICAL_BASELINE_SHA256};
 const verify=(r:Record<string,unknown>)=>verifyDurableOwnerFee({query:async()=>({rows:[r]})},scope,marketTicker,'ENTRY',{clock:()=>fixtureClock,fetcher:kalshiFeed(feeApiPages())});
 const proof=await verify(historical);assert.equal(proof.ok,true);if(proof.ok){assert.equal(proof.sourceAuthenticityVerified,false);assert.equal(proof.publicationKnownCurrent,false);assert.equal(proof.sourceKind,HISTORICAL_SOURCE_KIND);}
 for(const patch of [{genuine_source_verified:true},{source_capture_id:'1'},{historical_baseline_id:'other'},{historical_actual_digest:'0'.repeat(64)},{historical_actual_digest:null},{historical_actual_digest:undefined},{source_kind:'FRESH_CANONICAL_CAPTURE'},{historical_digest:'d'.repeat(64)}])assert.equal((await verify({...historical,...patch})).ok,false);
 }finally{if(saved===undefined)delete process.env.STRATA_DURABLE_HISTORICAL_BASELINE_ENABLED;else process.env.STRATA_DURABLE_HISTORICAL_BASELINE_ENABLED=saved;}
});

import {CommittedPublicMetadataCoordinator,type PrefetchedPublicMetadata} from './committedPublicMetadata';
async function durablePrefetchFixture(overrides:Record<string,unknown>={},failedTransport=false){
 let wall=fixtureClock,mono=0,calls=0,queries=0,currentRow:Record<string,unknown>={...row,...overrides};
 const coordinator=new CommittedPublicMetadataCoordinator(async(...args)=>{calls++;if(failedTransport)return new Response('{}',{status:503});return kalshiFeed(feeApiPages())(...args);},()=>wall,()=>mono);
 const metadataScope={ownerId:scope.owner,accountId:scope.account,releaseSha:scope.sha,policyHash:scope.policyHash,holderId:'holder',fence:'1'};
 const hint={evaluationId:'evaluation',marketTicker,evaluatedAtMs:fixtureClock,committedAtMs:fixtureClock,qualifyingTrigger:true as const,btcProviderAgeMs:0,btcReceiveAgeMs:0,marketAgeMs:0};
 const attempt=coordinator.start(metadataScope,hint)!;await attempt.drained;
 const metadata=attempt.consume(metadataScope,hint);
 const query=async()=>{queries++;return {rows:[currentRow]};};
 const check=(supplied=metadata,intent:'ENTRY'|'PROTECTIVE_EXIT'='ENTRY',expected=scope)=>verifyDurableOwnerFee({query},expected,marketTicker,intent,
  {clock:()=>wall,monotonicNow:()=>mono,fetcher:async()=>{throw Error('fresh_fallback_forbidden');}},supplied);
 return {metadata,attempt,check,clock:(w:number,m:number)=>{wall=w;mono=m;},revoke:()=>{currentRow.entry_revoked=true;},counts:()=>({calls,queries})};
}
test('durable PREPARE overlaps public transport but rechecks locked authority and keeps original clocks',async()=>{
 const f=await durablePrefetchFixture();try{
  f.clock(fixtureClock+1100,1100);const proof=await f.check();assert.equal(proof.ok,true,JSON.stringify(proof));
  assert.deepEqual(f.counts(),{calls:5,queries:1});
  if(!proof.ok)throw Error('proof_missing');assert.equal(proof.verifiedAtMs,fixtureClock);assert.equal(proof.sourceFresh(),true);
  // Wall rollback cannot hide monotonic expiry or reset source age at consume.
  f.clock(fixtureClock+1200,5001);assert.equal(proof.sourceFresh(),false);
 }finally{f.attempt.discard();}
});
test('durable PREPARE never reuses authority across revocation and never retries expired metadata',async()=>{
 const f=await durablePrefetchFixture();try{f.revoke();assert.equal((await f.check()).ok,false);
 f.clock(fixtureClock+5001,5001);assert.equal((await f.check()).ok,false);assert.equal(f.counts().calls,5);
 }finally{f.attempt.discard();}
});
test('durable metadata cannot be forged, used for another scope, or adopted for protective exits',async()=>{
 const f=await durablePrefetchFixture();try{
  assert.equal((await f.check({...f.metadata} as PrefetchedPublicMetadata)).ok,false);
  for(const key of ['owner','account','sha','policyHash'] as const)assert.equal((await f.check(f.metadata,'ENTRY',{...scope,[key]:'wrong'})).ok,false);
  assert.equal((await f.check(f.metadata,'PROTECTIVE_EXIT')).ok,false);assert.equal(f.counts().calls,5);
 }finally{f.attempt.discard();}
});
test('discarded durable metadata cannot authorize after STOP or scope invalidation',async()=>{
 const f=await durablePrefetchFixture();f.attempt.discard('entry_metadata_stopped');assert.equal((await f.check()).ok,false);assert.equal(f.counts().calls,5);
});

test('owner-attested historical durable PREPARE keeps provenance disclosures and current locked authority',async()=>{
 process.env.STRATA_DURABLE_HISTORICAL_BASELINE_ENABLED='true';
 const baseline=await readHistoricalBaselineBytes();assert.ok(baseline);
 const f=await durablePrefetchFixture({policy_version:HISTORICAL_FEE_VERSION,source_kind:HISTORICAL_SOURCE_KIND,
 genuine_source_verified:false,source_capture_id:null,historical_baseline_id:HISTORICAL_BASELINE_ID,
 historical_digest:HISTORICAL_BASELINE_SHA256,historical_actual_digest:baseline.digest,official_source_digest:HISTORICAL_BASELINE_SHA256});
 try{f.clock(fixtureClock+1100,1100);const proof=await f.check();assert.equal(proof.ok,true,JSON.stringify(proof));
 if(!proof.ok)throw Error('proof_missing');assert.equal(proof.publicationKnownCurrent,false);assert.equal(proof.sourceAuthenticityVerified,false);
 f.revoke();assert.equal((await f.check()).ok,false);
 }finally{f.attempt.discard();}
});
test('admitted speculative provider failure cannot trigger direct fee retry',async()=>{
 const f=await durablePrefetchFixture({},true);try{const before=f.counts().calls;
 assert.equal((await f.check()).ok,false);assert.equal(f.counts().calls,before);
 }finally{f.attempt.discard();}
});

import {readOwnedEntryMarket} from './ownedEntryMarketRead';
test('actual durable PREPARE market adapter adopts captured bytes, keeps signed book fresh, and passes original provenance',async()=>{
 let at=fixtureClock,calls=0,books=0;
 const binding={ownerId:scope.owner,accountId:scope.account,releaseSha:scope.sha,policyHash:scope.policyHash,holderId:'holder',fence:'1'};
 const hint={evaluationId:'adapter-evaluation',marketTicker,evaluatedAtMs:at,committedAtMs:at,qualifyingTrigger:true as const,btcProviderAgeMs:0,btcReceiveAgeMs:0,marketAgeMs:0};
 const pages=feeApiPages();Object.assign(pages['/markets/'+marketTicker].market as object,{status:'active',price_level_structure:'deci_cent',price_ranges:[{start:'0.0000',end:'1.0000',step:'0.0010'}]});
 const coordinator=new CommittedPublicMetadataCoordinator(async(...args)=>{calls++;return kalshiFeed(pages)(...args);},()=>at,()=>at-fixtureClock);
 const attempt=coordinator.start(binding,hint)!;await attempt.drained;at+=1100;
 try{
 const evidence=await readOwnedEntryMarket({market:marketTicker,side:'YES',context:{...hint,stage:'prepare'},now:()=>at,apiSource:false,durableSource:true,
 activeMetadata:attempt,metadataScope:()=>binding,
 verifyFee:async(_clock,_read,_capture,metadata)=>{assert.ok(metadata);const proof=await verifyDurableOwnerFee({query:async()=>({rows:[row]})},scope,marketTicker,'ENTRY',
 {clock:()=>at,monotonicNow:()=>at-fixtureClock,fetcher:async()=>{throw Error('direct_fee_fallback_forbidden');}},metadata);
 assert.equal(proof.ok,true);if(!proof.ok)throw Error('proof_missing');return proof.verifiedAtMs;},
 readBook:async()=>{books++;return {orderbook_fp:{yes_dollars:[['0.4900','100']],no_dollars:[['0.5100','100']]}};},
 readPublic:async()=>{throw Error('direct_public_fallback_forbidden');},configuredStakeCents:500,
 policyVersion:model.version,sourceUrl:'strata-durable-owner-fee://11111111-1111-4111-8111-111111111111',formulaVersion:model.formula,artifactDigest:model.digest,policyHash:scope.policyHash});
 assert.equal(calls,5);assert.equal(books,1);assert.equal(evidence.observedAtMs,at);
 assert.equal(evidence.fee.verifiedAtMs,fixtureClock);assert.ok(evidence.publicMetadataCapture);
 }finally{attempt.discard();}
});

import {verifyDurableOwnerFeeSource,DURABLE_FEE_SOURCE_LOCK_SQL,DURABLE_FEE_LOCK_SQL} from './durableOwnerFeePolicy';
const exactSource='strata-durable-owner-fee://11111111-1111-4111-8111-111111111111';
test('exact-source stage fuses current policy and locked model without loosening joins or locks',async()=>{
 assert.equal(DURABLE_FEE_SOURCE_LOCK_SQL,DURABLE_FEE_LOCK_SQL.replace("AND m.approved_policy_hash=$4 AND p.policy_hash=$4 AND p.state='APPROVED'","AND m.approved_policy_hash=p.policy_hash AND p.fee_source_url=$4 AND p.state='APPROVED'"));
 let queries=0;
 const proof=await verifyDurableOwnerFeeSource({async query(sql,args){queries++;assert.equal(sql,DURABLE_FEE_SOURCE_LOCK_SQL);assert.deepEqual(args,[scope.owner,scope.account,scope.sha,exactSource]);return {rows:[row]};}},scope,exactSource,marketTicker,'ENTRY',{clock:()=>fixtureClock,fetcher:kalshiFeed(feeApiPages())});
 assert.equal(proof.ok,true);assert.equal(queries,1);if(proof.ok)assert.equal(proof.tradingAuthorized,false);
});
test('source-bound revoked changed malformed missing or ambiguous row never issues provider reads',async()=>{
 for(const rows of [[],[row,row],[{...row,entry_revoked:true}],[{...row,known_publication_change:true}],[{...row,approved_policy_hash:null}]]){
 let calls=0;
 const proof=await verifyDurableOwnerFeeSource({async query(){return {rows};}},scope,exactSource,marketTicker,'ENTRY',{clock:()=>fixtureClock,fetcher:async()=>{calls++;throw Error('forbidden');}});
 assert.equal(proof.ok,false);assert.equal(calls,0);
 }
});
test('source-bound lost connection never retries or changes transaction ownership',async()=>{
 let queries=0,calls=0;
 const proof=await verifyDurableOwnerFeeSource({async query(){queries++;throw Object.assign(Error('lost'),{code:'08006'});}},scope,exactSource,marketTicker,'ENTRY',{clock:()=>fixtureClock,fetcher:async()=>{calls++;throw Error('forbidden');}});
 assert.equal(proof.ok,false);assert.equal(queries,1);assert.equal(calls,0);
});
test('source-bound metadata is checked against current locked policy, not old caller hash',async()=>{
 const fixture=await durablePrefetchFixture();let calls=0;
 const proof=await verifyDurableOwnerFeeSource({async query(){return {rows:[{...row,approved_policy_hash:'e'.repeat(64)}]};}},scope,exactSource,marketTicker,'ENTRY',{clock:()=>fixtureClock,fetcher:async()=>{calls++;throw Error('no fallback');}},fixture.metadata);
 assert.equal(proof.ok,false);assert.equal(calls,0);
});
test('source-only wrapper rejects malformed namespace without lookup or discovery',async()=>{
 let queries=0,calls=0;
 const proof=await verifyDurableOwnerFeeSource({async query(){queries++;return {rows:[row]};}},scope,'https://example.com',marketTicker,'ENTRY',{fetcher:async()=>{calls++;throw Error('forbidden');}});
 assert.equal(proof.ok,false);assert.equal(proof.reason,'durable_source_invalid');assert.equal(queries,0);assert.equal(calls,0);
});
test('source-bound FINAL rejects forged or other-phase capability without fresh fallback',async()=>{
 let calls=0;const handle={kind:'DURABLE_PHASE_PUBLIC_BYTES' as const,read:async()=>{calls++;throw Error('forbidden');},capture:()=>{throw Error('forbidden');}};
 const proof=await verifyDurableOwnerFeeSource({async query(){return {rows:[row]};}},scope,exactSource,marketTicker,'ENTRY',{clock:()=>fixtureClock,fetcher:async()=>{calls++;throw Error('no fallback');}},undefined,{phase:'FINAL_MARKET',handle});
 assert.equal(proof.ok,false);assert.equal(calls,0);
});

// Manual documents remain usable beyond the old 55-minute PDF lease, but the
// same current exact-market, owner consent and invalidation checks still apply.
test("admin-uploaded durable terms have no recurring PDF age lease",()=>{
 const old=process.env.STRATA_PLATFORM_FEE_UPLOAD_ENABLED;
 process.env.STRATA_PLATFORM_FEE_UPLOAD_ENABLED="true";
 try{
  const now=Date.parse("2026-11-24T18:00:00Z");
  const scope={owner:"owner",account:"account",sha:"a".repeat(40),policyHash:"b".repeat(64)};
  const model={...scope,sourceKind:"ADMIN_UPLOADED_FEE_SCHEDULE",digest:"c".repeat(64),
   version:"owner_attested_historical_terms_v1",formula:"standard-quadratic-0.07-v1",effectiveDate:"2026-07-07",
   approved:true,entryRevoked:false,integrityValid:true,manualBaselineCurrent:true,knownPublicationChange:false,monitorState:"never_checked" as const};
  const market={ok:true,ticker:"KXBTC15M-26NOV24",verifiedAt:now-1};
  const valid=assessDurableFee(model,scope,"ENTRY",market,now);
  assert.equal(valid.ok,true);
  if(valid.ok){assert.equal(valid.sourceAuthenticityVerified,false);assert.equal(valid.publicationKnownCurrent,false);assert.equal(valid.tradingAuthorized,false);}
  assert.equal(assessDurableFee({...model,manualBaselineCurrent:false},scope,"ENTRY",market,now).ok,false);
  assert.equal(assessDurableFee({...model,knownPublicationChange:true},scope,"ENTRY",market,now).ok,false);
  assert.equal(assessDurableFee({...model,entryRevoked:true},scope,"ENTRY",market,now).ok,false);
  assert.equal(assessDurableFee(model,scope,"ENTRY",{...market,verifiedAt:now-5001},now).ok,false);
 }finally{if(old===undefined)delete process.env.STRATA_PLATFORM_FEE_UPLOAD_ENABLED;else process.env.STRATA_PLATFORM_FEE_UPLOAD_ENABLED=old;}
});

test('a raw durable send that throws an earlier local refusal stays uncertain',async t=>{
 const previous=process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE;
 process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE='true';
 t.after(()=>{if(previous===undefined)delete process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE;else process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE=previous;});
 const token=Object.freeze({}),clientId='v13p-44444444-4444-4444-8444-444444444444';
 let fresh=false,sends=0,prior:Error|undefined;
 const guard=createGuardedDurableFeeFetch(scope.owner,scope.account,'strata-durable-owner-fee://33333333-3333-4333-8333-333333333333',
  async()=>{sends++;throw prior;},scope.policyHash,'d'.repeat(64),1,'holder',model.digest,{
   borrowTransaction:()=>({query:async()=>({rows:[{}]})}) as never,wireScope:()=>token,
   sha:()=>scope.sha,hasHistory:async()=>true,currentStanding:async()=>true,
   verifyDurable:async()=>{
    const now=Date.now(),proof=assessDurableFee(model,scope,'ENTRY',{...live,verifiedAt:now},now);
    assert.ok(proof.ok);
    return {...proof,sourceFresh:()=>fresh};
   }
  });
 const send=()=>guard('https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders',{method:'POST',
  body:JSON.stringify({ticker:marketTicker,subaccount:1,exchange_index:2,reduce_only:false,time_in_force:'immediate_or_cancel',
   self_trade_prevention_type:'taker_at_cross',post_only:false,client_order_id:clientId,side:'bid',count:'1.00',price:'0.2500'})});
 await assert.rejects(send(),(error:Error)=>{prior=error;return isDurableFeePreTransportRefusal(token,error,clientId);});
 assert.equal(sends,0);
 fresh=true;
 await assert.rejects(send(),(error:Error)=>error===prior&&!isDurableFeePreTransportRefusal(token,error,clientId));
 assert.equal(sends,1);
});
