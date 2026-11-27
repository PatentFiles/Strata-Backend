import test from 'node:test';
import assert from 'node:assert/strict';
import {V13_CHAMPION_PARAMETER_SET,evaluateV13Strategy,type V13Input} from '@workspace/v13-strategy';
import {WarrenBuffettResearch,WARREN_BUFFETT_SPEC,evaluateWarrenBuffettExit,type WarrenObservation,type WarrenCandidate} from './warrenBuffett';
const open=Date.parse('2026-11-27T00:00:00Z');
function snapshot(index:number,buffer:number,patch:Partial<WarrenObservation>={}):WarrenObservation{
 const nowMs=open+10000+index*2500;
 return {market:'KXBTC15M-WARREN-FIXTURE',target:100000,btc:100000+buffer,openMs:open,closeMs:open+900000,
  nowMs,providerAtMs:nowMs-100,receivedAtMs:nowMs-50,marketObservedAtMs:nowMs,...patch};
}
function candidate(engine:WarrenBuffettResearch,values:number[]):WarrenCandidate{
 let out:ReturnType<WarrenBuffettResearch['observe']>|undefined;
 for(let i=0;i<values.length;i++)out=engine.observe(snapshot(i,values[i]!));
 assert.ok(out);assert.equal(out.outcome,'QUOTE_REQUIRED');assert.ok(out.candidate);return out.candidate;
}
function priced(engine:WarrenBuffettResearch,c:WarrenCandidate,up=.52,down=.52,extra:Record<string,unknown>={}){
 return engine.price(c,{market:c.observation.market,requestStartedAtMs:c.observation.nowMs,receivedAtMs:c.observation.nowMs+50,upOffer:up,downOffer:down,...extra},c.observation.nowMs+75);
}
for(const [direction,values] of [['UP',[-1,3,10]],['DOWN',[1,-3,-10]]] as const){
 test(`${direction}: delayed confirmation qualifies without inventing a new crossing`,()=>{
  const engine=new WarrenBuffettResearch(),c=candidate(engine,[...values]);
  assert.equal(c.direction,direction);assert.equal(c.freshCrossAtObservation,false);
  assert.equal(c.crossing.crossedAtMs,snapshot(1,values[1]).nowMs);
  const out=priced(engine,c);assert.equal(out.outcome,'QUALIFIED');assert.equal(out.executionAuthority,'NONE');
  const old=evaluateV13Strategy({marketTicker:c.observation.market,btcPrice:c.observation.btc,target:100000,
   previousBuffer:values[1],velocity:c.velocity,upOffer:.52,downOffer:.52,freshness:'current',position:null});
  assert.equal(old.qualifyingTrigger,false,'original classifier remains unchanged');
 });
}
test('an immediate crossing remains a Scout at the original price ceiling',()=>{
 const e=new WarrenBuffettResearch(),c=candidate(e,[-1,10]);assert.equal(c.signal,'SCOUT');assert.equal(c.freshCrossAtObservation,true);
 assert.equal(priced(e,c).outcome,'QUALIFIED');
});
test('a pending crossing may pass through the gap and confirm later without wider prices',()=>{
 const e=new WarrenBuffettResearch(),c=candidate(e,[-1,17,21]);assert.equal(c.signal,'CONFIRM');
 assert.equal(priced(e,c,.53).outcome,'QUALIFIED');
});
for(const [values,price] of [[[-1,10],.5201],[[-1,21],.5301]] as const){
 test(`reject repriced ${price} quote without qualifying`,()=>{
  const e=new WarrenBuffettResearch(),c=candidate(e,[...values]);assert.equal(priced(e,c,price).reason,'market_already_repriced');
 });
}
test('a missing quote is not a trade or fill',()=>{
 const e=new WarrenBuffettResearch(),c=candidate(e,[-1,3,10]);assert.equal(c.executionAuthority,'NONE');
 assert.equal(priced(e,c,NaN).outcome,'ERROR');
});
test('confirmation expires even when continuous data keeps arriving',()=>{
 const e=new WarrenBuffettResearch();e.observe(snapshot(0,-1));e.observe(snapshot(1,1));
 for(let i=2;i<7;i++)assert.equal(e.observe(snapshot(i,1)).outcome,'PASS');
 assert.equal(e.observe(snapshot(7,10)).reason,'confirmation_window_expired');
 assert.equal(e.observe(snapshot(8,12)).reason,'no_pending_cross');
});
test('recross replaces direction, and does not reuse an old upward candidate',()=>{
 const e=new WarrenBuffettResearch(),old=candidate(e,[-1,3,10]);
 const reverse=e.observe(snapshot(3,-10));assert.equal(reverse.candidate?.direction,'DOWN');
 assert.equal(priced(e,old).reason,'candidate_custody_unverified');
});
test('touching the target invalidates an unfinished crossing',()=>{
 const e=new WarrenBuffettResearch();e.observe(snapshot(0,-1));e.observe(snapshot(1,3));
 assert.equal(e.observe(snapshot(2,0)).reason,'cross_invalidated');
});
test('a data gap resets pending confirmation without fabricating a crossing',()=>{
 const e=new WarrenBuffettResearch();e.observe(snapshot(0,-1));e.observe(snapshot(1,3));
 assert.equal(e.observe(snapshot(4,10)).reason,'continuous_crossing_history_required');
 assert.equal(e.observe(snapshot(5,12)).reason,'no_pending_cross');
});
test('repeated provider time resets continuity',()=>{
 const e=new WarrenBuffettResearch();e.observe(snapshot(0,-1));e.observe(snapshot(1,3));
 const out=e.observe(snapshot(2,10,{providerAtMs:snapshot(1,3).providerAtMs}));
 assert.equal(out.reason,'continuous_crossing_history_required');
});
test('changed market target fails rather than reusing crossing history',()=>{
 const e=new WarrenBuffettResearch();e.observe(snapshot(0,-1));
 assert.equal(e.observe(snapshot(1,10,{target:100001})).reason,'market_identity_changed');
});
test('rollover and restart need their own consecutive observations',()=>{
 const e=new WarrenBuffettResearch();e.observe(snapshot(0,-1));e.observe(snapshot(1,3));
 assert.equal(e.observe(snapshot(2,10,{market:'KXBTC15M-NEXT'})).reason,'continuous_crossing_history_required');
 assert.equal(new WarrenBuffettResearch().observe(snapshot(2,10)).reason,'continuous_crossing_history_required');
});
for(const patch of [{btc:NaN},{target:0},{providerAtMs:open},{receivedAtMs:open+999999},{closeMs:open+1}]){
 test('invalid or stale input cannot carry pending evidence '+JSON.stringify(patch),()=>{
  const e=new WarrenBuffettResearch();e.observe(snapshot(0,-1));e.observe(snapshot(1,3));
  assert.equal(e.observe(snapshot(2,10,patch)).outcome,'ERROR');
  assert.equal(e.observe(snapshot(3,12)).reason,'continuous_crossing_history_required');
 });
}
test('clock rollback is refused in observation and quote phases',()=>{
 const e=new WarrenBuffettResearch(),c=candidate(e,[-1,10]);
 assert.equal(e.observe(snapshot(0,12)).reason,'clock_regression');
 const other=new WarrenBuffettResearch(),d=candidate(other,[-1,10]);
 assert.equal(other.price(d,{market:d.observation.market,requestStartedAtMs:d.observation.nowMs,receivedAtMs:d.observation.nowMs,upOffer:.5,downOffer:.5},d.observation.nowMs-1).reason,'clock_regression');
 assert.equal(c.executionAuthority,'NONE');
});
test('a copied or previously emitted candidate cannot be priced',()=>{
 const e=new WarrenBuffettResearch(),c=candidate(e,[-1,10]);
 assert.equal(priced(e,{...c}).reason,'candidate_custody_unverified');
 assert.equal(priced(e,c).outcome,'QUALIFIED');assert.equal(priced(e,c).outcome,'ERROR');
 assert.equal(e.observe(snapshot(4,-10)).reason,'continuous_crossing_history_required');
 assert.equal(e.observe(snapshot(5,10)).reason,'market_signal_already_emitted');
});
test('confirmation window never extends current quote freshness',()=>{
 const e=new WarrenBuffettResearch(),c=candidate(e,[-1,3,10]),now=c.observation.nowMs+5001;
 assert.equal(e.price(c,{market:c.observation.market,requestStartedAtMs:now-50,receivedAtMs:now,upOffer:.5,downOffer:.5},now).reason,'quote_or_source_evidence_invalid');
});
test('late or wrong-market quotes are refused',()=>{
 for(const change of [{market:'KXBTC15M-FOREIGN'},{requestStartedAtMs:open},{receivedAtMs:open+999999}]){
  const e=new WarrenBuffettResearch(),c=candidate(e,[-1,10]);assert.equal(priced(e,c,.5,.5,change).outcome,'ERROR');
 }
});
test('original exit classifier and immutable entry parameters are retained exactly',()=>{
 assert.equal(WARREN_BUFFETT_SPEC.entryParameters,V13_CHAMPION_PARAMETER_SET.parameters);
 assert.equal(WARREN_BUFFETT_SPEC.liveSelectable,false);assert.equal(WARREN_BUFFETT_SPEC.trainingStatus,'NOT_TRAINED');
 for(const direction of ['up','down'] as const)for(const buffer of [-20,0,20])for(const velocity of [-1,0,1]){
  const i:V13Input={marketTicker:'KXBTC15M-EXIT',btcPrice:100000+buffer,target:100000,previousBuffer:0,
   velocity,upOffer:.51,downOffer:.51,freshness:'current',position:{status:'open',direction}};
  assert.deepEqual(evaluateWarrenBuffettExit(i),evaluateV13Strategy(i));
 }
});
