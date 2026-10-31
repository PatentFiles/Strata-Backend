import assert from 'node:assert/strict';
import {LifecycleStrikePrototype, WINDOW_MS} from './lifecycle-strike.mjs';
const OPEN=1_800_000,T='KXBTC15M-26OCT310000-00';
const polls=[...Array.from({length:11},(_,i)=>i*1000),15000,20000,25000,30000,35000,40000,45000];
const ready=[0,1000,5000,11000,15000,20000,30000];
function run(availableMs,restLagMs,push=true,quoteAgeOverride=null){
 const restAt=polls.find(t=>t>=availableMs+restLagMs)??null;
 const wsAt=push?availableMs+100:null;
 const s=new LifecycleStrikePrototype({ownerId:'fixture-owner',credentialBinding:'fixture-read-key'});
 s.connect({ownerId:'fixture-owner',credentialBinding:'fixture-read-key',authenticated:true,generation:1,sid:1,nowMs:OPEN});
 s.resync({generation:1,nowMs:OPEN,nextSequence:1,scopeVerified:true,markets:[{ticker:T,openMs:OPEN,closeMs:OPEN+WINDOW_MS,strikeType:'greater_or_equal',exchangeIndex:2}]});
 let wsDecision=null;
 if(push){
  // Simulated trusted keepalive; no real socket is opened.
  for(let elapsed=5000;elapsed<wsAt;elapsed+=5000)
   assert.equal(s.heartbeat({generation:1,nowMs:OPEN+elapsed}).ok,true);
  assert.equal(s.heartbeat({generation:1,nowMs:OPEN+wsAt}).ok,true);
  const result=s.ingest(JSON.stringify({type:'market_lifecycle_v2',sid:1,seq:1,sending_ts_ms:OPEN+availableMs,
   msg:{event_type:'metadata_updated',market_ticker:T,strike_type:'greater_or_equal',floor_strike:77080.15}}),{generation:1,nowMs:OPEN+wsAt});
  assert.equal(result.ok,true);
  const quoteAt=quoteAgeOverride===null?polls.filter(t=>t<=wsAt).at(-1):wsAt-quoteAgeOverride;
  const decision=s.evaluateQuote({ticker:T,openMs:OPEN,closeMs:OPEN+WINDOW_MS,exchangeIndex:2,status:'active',depthVerified:true,
   askDollars:0.52,observedAtMs:OPEN+quoteAt,restStrike:null},{generation:1,nowMs:OPEN+wsAt});
  if(decision.ok)wsDecision=wsAt;
 }
 const first=Math.min(restAt??Infinity,wsDecision??Infinity);
 return {strikeActuallyReadyMs:availableMs,assumedRestVisibilityLagMs:restLagMs,restFirstValidMs:restAt,
  pushFeasibilityMs:wsDecision,firstFeasibleMs:Number.isFinite(first)?first:null,
  simulatedImprovementMs:restAt!==null&&Number.isFinite(first)?restAt-first:null};
}
const rows=ready.flatMap(t=>[run(t,0),run(t,5000)]);
assert.equal(run(11000,0).simulatedImprovementMs,3900);
assert.equal(run(0,15000).simulatedImprovementMs,14900);
assert.equal(run(11000,5000,false).simulatedImprovementMs,0);
assert.equal(run(11000,5000,true,5001).pushFeasibilityMs,null);
console.log(JSON.stringify({kind:'OFFLINE_CONDITIONAL_FEASIBILITY_ONLY',
 assumptions:['Baseline poll grid is synthetic: 0..10 seconds then five-second polls; production offsets differ.',
 'Push arrives 100ms after the strike actually exists; this has NOT been measured in production.',
 'Existing REST reads separately retain a valid, executable, exact-market quote even while strike is null.',
 'A future event-driven evaluation wake can use that unchanged quote timestamp; no extra network reads.',
 'Authenticated stream ordering, exact scope, current connection and all remaining production gates pass.',
 'Rows quantify potential, not actual Kalshi latency, order submission, a fill, or profit.'],
 rows,controls:{noPush:run(11000,5000,false),staleQuote:run(11000,5000,true,5001),
 immediatePushRest15sLag:run(0,15000)}},null,2));
