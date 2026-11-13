import test from 'node:test';
import assert from 'node:assert/strict';
import {LifecycleStrikePrototype, WINDOW_MS, QUOTE_MAX_AGE_MS} from './lifecycle-strike.mjs';
const OPEN = 1_800_000, T = 'KXBTC15M-26OCT310000-00', NEXT = 'KXBTC15M-26OCT310015-15';
const scope = (extra={}) => ({ticker:T,openMs:OPEN,closeMs:OPEN+WINDOW_MS,strikeType:'greater_or_equal',exchangeIndex:2,...extra});
const ctx = (nowMs=OPEN+1000,generation=1) => ({nowMs,generation});
const envelope = (seq=1,extra={},nowMs=OPEN+1000) => ({type:'market_lifecycle_v2',sid:13,seq,sending_ts_ms:nowMs,
 msg:{event_type:'metadata_updated',market_ticker:T,strike_type:'greater_or_equal',floor_strike:77080.15,...extra}});
const frame = (...args) => JSON.stringify(envelope(...args));
const quote = (extra={}) => ({ticker:T,openMs:OPEN,closeMs:OPEN+WINDOW_MS,observedAtMs:OPEN+1000,
 exchangeIndex:2,status:'active',depthVerified:true,askDollars:0.52,restStrike:null,...extra});
function store(markets=[scope()], nowMs=OPEN) {
 const s=new LifecycleStrikePrototype({ownerId:'owner-A',credentialBinding:'verified-key-binding-A'});
 assert.equal(s.connect({ownerId:'owner-A',credentialBinding:'verified-key-binding-A',authenticated:true,generation:1,sid:13,nowMs}).ok,true);
 assert.equal(s.resync({generation:1,nowMs,nextSequence:1,scopeVerified:true,markets}).ok,true);
 return s;
}

test('strike push admits fresh exact quote while REST strike is null; preserves quote timestamp',()=>{
 const s=store();assert.equal(s.ingest(frame(),ctx()).ok,true);
 const q=quote({observedAtMs:OPEN+500});const before=structuredClone(q);
 const r=s.evaluateQuote(q,ctx());assert.equal(r.ok,true);assert.equal(r.quoteObservedAtMs,OPEN+500);
 assert.equal(r.quoteAgeMs,500);assert.equal(r.strikeSource,'authenticated_lifecycle');assert.deepEqual(q,before);
});
test('quote freshness is exactly five seconds, not refreshed by metadata',()=>{
 const s=store();s.ingest(frame(1,{},OPEN+6000),ctx(OPEN+6000));
 assert.equal(s.evaluateQuote(quote({observedAtMs:OPEN+1000}),ctx(OPEN+6000)).ok,true);
 assert.equal(s.evaluateQuote(quote({observedAtMs:OPEN+1000}),ctx(OPEN+6001)).reason,'quote_stale');
 assert.equal(QUOTE_MAX_AGE_MS,5000);
});
test('no push and no verified REST seed means no strike',()=>{
 assert.equal(store().evaluateQuote(quote(),ctx()).reason,'strike_unavailable');
});
test('verified REST seed is independent fallback when push absent',()=>{
 assert.equal(store([scope({seedStrike:77080.15})]).evaluateQuote(quote(),ctx()).ok,true);
});
test('sequence consumed across other tickers before filtering',()=>{
 const s=store();assert.equal(s.ingest(frame(1,{market_ticker:'UNRELATED-MARKET'}),ctx()).ignored,true);
 assert.equal(s.ingest(frame(2),ctx()).ok,true);assert.equal(s.evaluateQuote(quote(),ctx()).ok,true);
});
test('sequence consumed across other lifecycle stream message types',()=>{
 const s=store();const other=envelope();other.type='event_lifecycle';
 assert.equal(s.ingest(JSON.stringify(other),ctx()).ignored,true);
 assert.equal(s.ingest(frame(2),ctx()).ok,true);
});
for(const seq of [0,2,1.5]) test(`sequence anomaly ${seq} invalidates all metadata`,()=>{
 const s=store([scope({seedStrike:77080.15})]);assert.equal(s.ingest(frame(seq),ctx()).reason,'stream_discontinuity');
 assert.equal(s.snapshot().marketCount,0);assert.equal(s.evaluateQuote(quote(),ctx()).reason,'resync_required');
});
test('duplicate event after success poisons continuity; no stale fallback',()=>{
 const s=store();s.ingest(frame(),ctx());assert.equal(s.ingest(frame(),ctx()).reason,'stream_discontinuity');
 assert.equal(s.evaluateQuote(quote(),ctx()).ok,false);
});
test('wrong subscription id rejects and requires resync',()=>{
 const s=store();const e=envelope();e.sid=14;
 assert.equal(s.ingest(JSON.stringify(e),ctx()).reason,'stream_discontinuity');
});
for(const age of [5001,-251]) test(`event age ${age} rejects delayed or future messages`,()=>{
 const s=store();assert.equal(s.ingest(frame(1,{},OPEN+10000-age),ctx(OPEN+10000)).reason,'stale_or_regressed_event');
});
test('source timestamp regression fails even if sequence is contiguous',()=>{
 const s=store();s.ingest(frame(1),ctx());
 assert.equal(s.ingest(frame(2,{},OPEN+999),ctx(OPEN+1001)).reason,'stale_or_regressed_event');
});
test('local clock regression fails closed',()=>{
 const s=store();s.ingest(frame(),ctx());assert.equal(s.evaluateQuote(quote(),ctx(OPEN+999)).reason,'clock_regression_or_invalid');
});
for(const value of [null,undefined,'77080.15',NaN,Infinity,0,-1,{},[]]) test(`invalid strike ${String(value)} never guessed`,()=>{
 const s=store();const r=s.ingest(frame(1,{floor_strike:value}),ctx());
 assert.equal(r.ok,false);assert.equal(s.evaluateQuote(quote(),ctx()).ok,false);
});
test('unsupported strike type and cap fail closed',()=>{
 for(const extra of [{strike_type:'between',cap_strike:80000},{strike_type:'less'},{cap_strike:80000}]) {
  const s=store();assert.equal(s.ingest(frame(1,extra),ctx()).reason,'invalid_strike');
 }
});
test('subtitle-only update does not supply strike or change freshness',()=>{
 const s=store();const e=envelope();e.msg={event_type:'metadata_updated',market_ticker:T,yes_sub_title:'BTC above $77080.15'};
 assert.equal(s.ingest(JSON.stringify(e),ctx()).ignored,true);assert.equal(s.evaluateQuote(quote(),ctx()).ok,false);
});
test('created metadata uses nested fields and exact verified windows',()=>{
 const s=store();const e=envelope();e.msg={event_type:'created',market_ticker:T,exchange_index:2,
 open_ts:OPEN/1000,close_ts:(OPEN+WINDOW_MS)/1000,additional_metadata:{strike_type:'greater_or_equal',floor_strike:77080.15}};
 assert.equal(s.ingest(JSON.stringify(e),ctx()).ok,true);
});
test('created wrong window or exchange index invalidates market',()=>{
 for(const extra of [{open_ts:OPEN/1000+1},{close_ts:(OPEN+WINDOW_MS)/1000+1},{exchange_index:0}]) {
  const s=store();assert.equal(s.ingest(frame(1,extra),ctx()).ok,false);
  assert.equal(s.evaluateQuote(quote(),ctx()).ok,false);
 }
});
test('a conflicting lifecycle strike requires resync, not latest-value-wins',()=>{
 const s=store();s.ingest(frame(),ctx());assert.equal(s.ingest(frame(2,{floor_strike:77081}),ctx()).reason,'strike_conflict');
 assert.equal(s.ingest(frame(3),ctx()).reason,'market_resync_required');
});
test('REST and push disagreement fails closed without discarding known conflict',()=>{
 const s=store();s.ingest(frame(),ctx());assert.equal(s.evaluateQuote(quote({restStrike:77081}),ctx()).reason,'rest_strike_conflict');
 assert.equal(s.evaluateQuote(quote(),ctx()).ok,false);
});
test('null strike update invalidates previous value',()=>{
 const s=store();s.ingest(frame(),ctx());assert.equal(s.ingest(frame(2,{floor_strike:null}),ctx()).ok,false);
 assert.equal(s.evaluateQuote(quote(),ctx()).ok,false);
});
for(const event_type of ['deactivated','determined','settled','closed','close_date_updated','price_level_structure_updated'])
 test(`lifecycle ${event_type} blocks previous strike`,()=>{
  const s=store();s.ingest(frame(),ctx());assert.equal(s.ingest(frame(2,{event_type}),ctx()).reason,'lifecycle_requires_resync');
  assert.equal(s.evaluateQuote(quote(),ctx()).ok,false);
 });
test('next-market metadata cannot admit a quote before its own window',()=>{
 const s=store([scope(),scope({ticker:NEXT,openMs:OPEN+WINDOW_MS,closeMs:OPEN+2*WINDOW_MS})]);
 s.ingest(frame(1,{market_ticker:NEXT}),ctx());
 assert.equal(s.evaluateQuote(quote({ticker:NEXT,openMs:OPEN+WINDOW_MS,closeMs:OPEN+2*WINDOW_MS}),ctx()).reason,'quote_window_mismatch');
});
test('old-window metadata does not leak across rollover',()=>{
 const s=store();s.ingest(frame(),ctx());
 for(let t=OPEN+5000;t<=OPEN+WINDOW_MS;t+=5000) assert.equal(s.heartbeat(ctx(t)).ok,true);
 assert.equal(s.evaluateQuote(quote({observedAtMs:OPEN+WINDOW_MS}),ctx(OPEN+WINDOW_MS)).reason,'quote_window_mismatch');
});
test('disconnected and reconnected store cannot reuse old generation or metadata',()=>{
 const s=store();s.ingest(frame(),ctx());s.disconnect(ctx());
 assert.equal(s.evaluateQuote(quote(),ctx()).ok,false);
 s.connect({ownerId:'owner-A',credentialBinding:'verified-key-binding-A',authenticated:true,generation:2,sid:20,nowMs:OPEN+2000});
 assert.equal(s.ingest(frame(),ctx(OPEN+2000,1)).ok,false);
 assert.equal(s.evaluateQuote(quote(),ctx(OPEN+2000,2)).reason,'resync_required');
 assert.equal(s.resync({generation:2,nowMs:OPEN+2000,nextSequence:1,scopeVerified:true,markets:[scope()]}).ok,true);
 assert.equal(s.evaluateQuote(quote(),ctx(OPEN+2000,2)).reason,'strike_unavailable');
});
test('unauthenticated, wrong owner, wrong binding, reused generation cannot connect',()=>{
 for(const extra of [{authenticated:false},{ownerId:'owner-B'},{credentialBinding:'different-key'},{generation:1}]) {
  const s=store();assert.equal(s.connect({ownerId:'owner-A',credentialBinding:'verified-key-binding-A',authenticated:true,generation:2,sid:13,nowMs:OPEN+1000,...extra}).ok,false);
 }
});
test('resync limits memory to current and next verified windows',()=>{
 for(const markets of [[scope(),scope()], [scope(),scope({ticker:NEXT,openMs:OPEN+2*WINDOW_MS,closeMs:OPEN+3*WINDOW_MS})], [scope(),scope(),scope()]]) {
  const s=store();assert.equal(s.resync({generation:1,nowMs:OPEN,nextSequence:1,scopeVerified:true,markets}).ok,false);
  assert.equal(s.snapshot().marketCount,0);
 }
});
test('oversize and malformed frames fail closed with bounded diagnostics',()=>{
 const s=store();assert.equal(s.ingest('x'.repeat(20000),ctx()).reason,'oversize_or_invalid_frame');
 for(let i=0;i<1000;i++)s.ingest('{}',ctx());
 assert.ok(s.snapshot().diagnostics.length<=3);assert.equal(s.snapshot().marketCount,0);
 const t=store();assert.equal(t.ingest('{',ctx()).reason,'invalid_json');
});
test('transport health must remain current independently from a fresh quote',()=>{
 const s=store();s.ingest(frame(),ctx());
 assert.equal(s.evaluateQuote(quote({observedAtMs:OPEN+17000}),ctx(OPEN+17000)).reason,'connection_health_stale');
});
test('inactive market, unverified depth, wrong ticker and invalid prices never admit',()=>{
 for(const extra of [{status:'closed'},{depthVerified:false},{ticker:NEXT},{askDollars:0},{askDollars:1},{askDollars:'0.5'}]) {
  const s=store();s.ingest(frame(),ctx());assert.equal(s.evaluateQuote(quote(extra),ctx()).ok,false);
 }
});
test('same-generation resync cannot rewind accepted stream sequence',()=>{
 const s=store();s.ingest(frame(),ctx());
 assert.equal(s.resync({generation:1,nowMs:OPEN+1000,nextSequence:1,scopeVerified:true,markets:[scope()]}).reason,'invalid_resync');
 assert.equal(s.resync({generation:1,nowMs:OPEN+1000,nextSequence:2,scopeVerified:true,markets:[scope()]}).ok,true);
 assert.equal(s.ingest(frame(1),ctx()).reason,'stream_discontinuity');
});
test('stale transport cannot become trusted merely by delivering a fresh event',()=>{
 const s=store();assert.equal(s.ingest(frame(1,{},OPEN+16000),ctx(OPEN+16000)).reason,'connection_health_stale');
 assert.equal(s.snapshot().synced,false);
});
test('backlogged stream events fail even when quote itself is fresh',()=>{
 const s=store();s.heartbeat(ctx(OPEN+10000));
 assert.equal(s.ingest(frame(1,{},OPEN+1000),ctx(OPEN+10000)).reason,'stale_or_regressed_event');
 assert.equal(s.evaluateQuote(quote({observedAtMs:OPEN+10000}),ctx(OPEN+10000)).ok,false);
});

test('late heartbeat cannot revive cached metadata without resync',()=>{
 const s=store([scope({seedStrike:77080.15})]);
 assert.equal(s.heartbeat(ctx(OPEN+15001)).reason,'connection_health_stale');
 assert.equal(s.evaluateQuote(quote({observedAtMs:OPEN+15001}),ctx(OPEN+15001)).reason,'resync_required');
});
for(const exchangeIndex of [undefined,0,1,'2',null]) test(`quote exchange index ${exchangeIndex} must match verified scope`,()=>{
 const s=store([scope({seedStrike:77080.15})]);
 assert.equal(s.evaluateQuote(quote({exchangeIndex}),ctx()).reason,'quote_exchange_mismatch');
});

test('resync proof fixture requires exact boolean true, not truthy values',()=>{
 for(const scopeVerified of ['false','true',{},[],1,null,undefined,false]){
  const s=store();
  assert.equal(s.resync({generation:1,nowMs:OPEN,nextSequence:1,scopeVerified,markets:[scope()]}).reason,'invalid_resync');
 }
});

for(const strikeType of ['greater','greater_or_equal']) test(`exact prevalidated ${strikeType} contract accepts matching update only`,()=>{
 const s=store([scope({strikeType})]);
 assert.equal(s.ingest(frame(1,{strike_type:strikeType}),ctx()).ok,true);
 assert.equal(s.evaluateQuote(quote(),ctx()).ok,true);
 const mismatch=strikeType==='greater'?'greater_or_equal':'greater';
 assert.equal(s.ingest(frame(2,{strike_type:mismatch}),ctx()).reason,'invalid_strike');
 assert.equal(s.evaluateQuote(quote(),ctx()).ok,false);
});
test('prevalidated strike type must be explicit supported exact type',()=>{
 for(const strikeType of [undefined,null,'GREATER_OR_EQUAL','greater_or_equal ','less','between',{},1]){
  const s=store();
  assert.equal(s.resync({generation:1,nowMs:OPEN,nextSequence:1,scopeVerified:true,markets:[scope({strikeType})]}).reason,'invalid_scope');
 }
});
