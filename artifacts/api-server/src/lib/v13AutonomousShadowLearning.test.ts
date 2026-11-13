import assert from "node:assert/strict";
import test from "node:test";
import {db} from "@workspace/db";
import {PgDialect} from "drizzle-orm/pg-core";
import {recordV13ShadowOpportunities} from "./v13StrategyResearch";
import {AutonomousShadowSchedule} from "./autonomousShadowSchedule";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {V13_CHAMPION_PARAMETER_SET,V13_CHAMPION_PARAMETER_HASH,V13_ENTRY_POLICY_VERSION,
 assertV13HistoricalTuningCandidate} from "@workspace/v13-strategy";
import {autonomousShadowLearningConfigured,netResearchQuoteProxy,
 proposeAutonomousShadowCandidate,runAutonomousShadowResearch,type AutolearnCompletedTrade} from "./v13AutonomousShadowLearning";

const NOW=new Date("2026-11-04T12:00:00.000Z");
const DAY=86_400_000;
function dataset(opts:{validationWin?:boolean;hugeOutlier?:boolean}={}):AutolearnCompletedTrade[]{
 return Array.from({length:100},(_,i)=>{
  const day=Math.floor(i/10);
  const high=i%5===0; // 20% high-priced entries are consistently weak.
  const validationLoss=opts.validationWin&&day>=7;
  return {
   id:"paper-"+i,enteredAt:new Date(NOW.getTime()-(10-day)*DAY+i*1000),
   trigger:"SCOUT" as const,entryOffer:high?0.51:0.45,
   entrySpread:0.01,entryBuffer:10,exitPrice:high?0.30:0.60,
   contracts:10,
   pnl:opts.hugeOutlier&&i===3?318.02:high?(validationLoss?1.4:-2.1):1.5,
   settled:false,
  };
 });
}
test("production learning follows actual policy/startup gate and respects research pause",()=>{
 const enabled={NODE_ENV:"production",FORWARD_TEST_PRODUCTION_WORKER_ENABLED:"true",
  V13_ENTRY_POLICY_RUNTIME_APPROVED:V13_ENTRY_POLICY_VERSION,
  STRATA_AUTONOMOUS_SHADOW_LEARNING_ENABLED:"true"};
 assert.equal(autonomousShadowLearningConfigured(enabled),true,'development flag is not a production requirement');
 assert.equal(autonomousShadowLearningConfigured({...enabled,FORWARD_TEST_WORKER_ENABLED:"false"}),true);
 for(const patch of [{NODE_ENV:"development",FORWARD_TEST_WORKER_ENABLED:"true"},
  {FORWARD_TEST_PRODUCTION_WORKER_ENABLED:"false"},{V13_ENTRY_POLICY_RUNTIME_APPROVED:undefined},
  {V13_ENTRY_POLICY_RUNTIME_APPROVED:"wrong"},{STRATA_AUTONOMOUS_SHADOW_LEARNING_ENABLED:undefined},
  {STRATA_SHADOW_EVALUATION_WRITES_ENABLED:"false"}])
  assert.equal(autonomousShadowLearningConfigured({...enabled,...patch}),false);
 assert.equal(Object.isFrozen(V13_CHAMPION_PARAMETER_SET),true);
});
test("requires prospective historical span and chronological by-day holdout, not a recent backfit",()=>{
 const fresh=dataset().map(r=>({...r,
   enteredAt:new Date(NOW.getTime()-2*DAY)}));
 assert.equal(proposeAutonomousShadowCandidate(fresh,NOW).status,"INSUFFICIENT_PROSPECTIVE_DATA");
 const tooFew=dataset().slice(0,30);
 assert.equal(proposeAutonomousShadowCandidate(tooFew,NOW).status,"INSUFFICIENT_PROSPECTIVE_DATA");
});
test("learns a strict-subset version from training and later validation, NOT champion changes",()=>{
 const result=proposeAutonomousShadowCandidate(dataset(),NOW);
 assert.equal(result.status,"CANDIDATE");
 assert.equal(result.executionAuthority,false);
 assert.equal(result.evidence,"UNVERIFIED_QUOTE_COST_PROXY_ONLY");
 if(!result.candidate)throw Error("expected research candidate");
 const p=result.candidate.parameters;
 assertV13HistoricalTuningCandidate(p);
 assert.ok(p.scoutMaxOffer<=0.50); // rejected consistently harmful 51c entry
 assert.equal(p.wrongSideRecrossSeparation,8);
 assert.equal(p.exitOnMomentumInvalidation,true);
 assert.equal(V13_CHAMPION_PARAMETER_SET.parameters.scoutMaxOffer,0.52);
 assert.ok(result.candidate.trainImprovementUsd>=2);
 assert.ok(result.candidate.validateImprovementUsd>=2);
 assert.ok(result.candidate.trainKept>=20);
 assert.ok(result.candidate.validateKept>=20);
 const noDuplicate=proposeAutonomousShadowCandidate(dataset(),NOW,[result.candidate.parameterHash]);
 assert.notEqual(noDuplicate.candidate?.parameterHash,result.candidate.parameterHash);
 assert.notEqual(result.candidate.parameterHash,V13_CHAMPION_PARAMETER_HASH);
});
test("refuses a fitted candidate that loses its independent validation",()=>{
 const result=proposeAutonomousShadowCandidate(dataset({validationWin:true}),NOW);
 assert.notEqual(result.status,"CANDIDATE");
});
test("single giant quote winner cannot create a phantom decision edge",()=>{
 const plain=proposeAutonomousShadowCandidate(dataset(),NOW);
 const outlier=proposeAutonomousShadowCandidate(dataset({hugeOutlier:true}),NOW);
 assert.equal(outlier.status,"CANDIDATE");
 assert.equal(plain.candidate?.parameterHash,outlier.candidate?.parameterHash);
 assert.equal(plain.candidate?.scoreUsd,outlier.candidate?.scoreUsd);
});
test("missing/invalid paper quotes are excluded, and modeled fees are explicitly approximate",()=>{
 const rows=dataset().map((r,i)=>i<90?{...r,entrySpread:Number.NaN}:r);
 assert.equal(proposeAutonomousShadowCandidate(rows,NOW).status,"INSUFFICIENT_PROSPECTIVE_DATA");
 assert.ok(netResearchQuoteProxy(dataset()[0]!)<dataset()[0]!.pnl);
});


test("daily research retry is bounded, delayed after failure and single-flight",async()=>{
 let clock=NOW.getTime(),calls=0,errors=0,release!:()=>void;
 const schedule=new AutonomousShadowSchedule(()=>clock);
 const held=new Promise<void>(r=>release=r);
 assert.equal(schedule.submit(clock,async()=>{calls++;await held;throw Error("temporary");},()=>{},()=>errors++),true);
 await Promise.resolve();
 for(let i=0;i<100;i++)assert.equal(schedule.submit(clock,async()=>calls++,()=>{},()=>{}),false);
 clock+=5000;release();await schedule.drain();
 assert.equal(calls,1);assert.equal(errors,1);
 assert.equal(schedule.submit(clock+59999,async()=>calls++,()=>{},()=>{}),false);
 clock+=60000;
 assert.equal(schedule.submit(clock,async()=>{calls++;throw Error("again");},()=>{},()=>errors++),true);
 await schedule.drain();clock+=300000;
 assert.equal(schedule.submit(clock,async()=>{calls++;throw Error("last");},()=>{},()=>errors++),true);
 await schedule.drain();clock+=300000;
 assert.equal(schedule.submit(clock,async()=>calls++,()=>{},()=>{}),false);
 assert.equal(calls,3);assert.equal(errors,3);
});

test("successful research completes date; next date waits for prior in-flight job",async()=>{
 let clock=NOW.getTime(),calls=0,release!:()=>void;
 const schedule=new AutonomousShadowSchedule(()=>clock);
 const held=new Promise<void>(r=>release=r);
 schedule.submit(clock,async()=>{calls++;await held;return "COLLECTING";},()=>{throw Error("log");},()=>{});
 await Promise.resolve();clock+=DAY;
 assert.equal(schedule.submit(clock,async()=>calls++,()=>{},()=>{}),false);
 release();await schedule.drain();
 assert.equal(schedule.submit(clock,async()=>{calls++;return "NO_CHANGE";},()=>{},()=>{}),true);
 await schedule.drain();
 assert.equal(schedule.submit(clock+1000,async()=>calls++,()=>{},()=>{}),false);
 assert.equal(calls,2);
 schedule.stop();
 assert.equal(schedule.submit(clock+DAY,async()=>calls++,()=>{},()=>{}),false);
});

test("uncertain insert retry rechecks durable date and does not duplicate candidate",async()=>{
 let clock=NOW.getTime(),inserts=0,reads=0;const durable=new Set<string>();
 const schedule=new AutonomousShadowSchedule(()=>clock);
 const work=async(at:Date)=>{
  const day=at.toISOString().slice(0,10);reads++;
  if(durable.has(day))return "NO_CHANGE";
  inserts++;durable.add(day);throw Error("commit response lost");
 };
 schedule.submit(clock,work,()=>{},()=>{});await schedule.drain();clock+=60000;
 schedule.submit(clock,work,()=>{},()=>{});await schedule.drain();
 assert.equal(reads,2);assert.equal(inserts,1);
 assert.equal(schedule.submit(clock+1000,work,()=>{},()=>{}),false);
 const source=readFileSync(resolve('src/lib/v13AutonomousShadowLearning.ts'),'utf8');
 assert.ok(source.indexOf('if(today)return')<source.indexOf('await db.insert(v13StrategyParameterSetTable)'));
 assert.ok(source.includes('.onConflictDoNothing()'));
});

test("invalid/regressed research clock never resets day budget; failing reports are isolated",async()=>{
 let clock=NOW.getTime();const schedule=new AutonomousShadowSchedule(()=>clock);
 const fail=async()=>{throw Error("offline")};
 schedule.submit(clock,fail,()=>{},()=>{throw Error("log");});await schedule.drain();
 for(const bad of [NaN,Infinity,-1,clock-1,clock+0.5])assert.equal(schedule.submit(bad,fail,()=>{},()=>{}),false);
 assert.equal(schedule.submit(clock+1000,fail,()=>{},()=>{}),false);
});


test("actual research job resolves today's durable uncertain commit before retraining/inserting",async()=>{
 const env={NODE_ENV:"production",FORWARD_TEST_PRODUCTION_WORKER_ENABLED:"true",
  V13_ENTRY_POLICY_RUNTIME_APPROVED:V13_ENTRY_POLICY_VERSION,
  STRATA_AUTONOMOUS_SHADOW_LEARNING_ENABLED:"true",STRATA_SHADOW_EVALUATION_WRITES_ENABLED:"true"};
 const before=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));
 const select=db.select,insert=db.insert;let selections=0,inserts=0;const wheres:unknown[]=[];
 try{
  Object.assign(process.env,env);
  db.select=(()=>{selections++;return {from:()=>({where:(q:unknown)=>{
   wheres.push(q);return {limit:async()=>[{id:"v13-auto-shadow-20261104"}]};
  }})};}) as unknown as typeof db.select;
  db.insert=(()=>{inserts++;throw Error("unexpected insert");}) as typeof db.insert;
  const result=await runAutonomousShadowResearch(NOW);
  assert.equal(result.status,"NO_CHANGE");assert.equal(selections,1);assert.equal(inserts,0);
  const query=new PgDialect().sqlToQuery(wheres[0] as any);
  assert.deepEqual(query.params,["v13-auto-shadow-20261104"]);
 }finally{
  db.select=select;db.insert=insert;
  for(const [k,v] of Object.entries(before)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
 }
});

test("actual research lifetime cap checks generated prefix before newest manual history",async()=>{
 const env={NODE_ENV:"production",FORWARD_TEST_PRODUCTION_WORKER_ENABLED:"true",
  V13_ENTRY_POLICY_RUNTIME_APPROVED:V13_ENTRY_POLICY_VERSION,
  STRATA_AUTONOMOUS_SHADOW_LEARNING_ENABLED:"true",STRATA_SHADOW_EVALUATION_WRITES_ENABLED:"true"};
 const before=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));
 const select=db.select,insert=db.insert;let selections=0,inserts=0;const wheres:unknown[]=[];
 try{
  Object.assign(process.env,env);
  db.select=(()=>{const call=++selections;return {from:()=>({where:(q:unknown)=>{
   wheres.push(q);return {limit:async(limit:number)=>{
    if(call===1){assert.equal(limit,1);return [];}
    assert.equal(limit,20);return Array.from({length:20},(_,i)=>({id:"v13-auto-shadow-"+i,state:"RETIRED"}));
   }};
  }})};}) as unknown as typeof db.select;
  db.insert=(()=>{inserts++;throw Error("unexpected insert");}) as typeof db.insert;
  const result=await runAutonomousShadowResearch(NOW);
  assert.equal(result.status,"CAPACITY");assert.equal(selections,2);assert.equal(inserts,0);
  assert.deepEqual(new PgDialect().sqlToQuery(wheres[1] as any).params,["v13-auto-shadow-%"]);
 }finally{
  db.select=select;db.insert=insert;
  for(const [k,v] of Object.entries(before)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
 }
});


test("actual prospective writer excludes models created or activated after source event",async()=>{
 const select=db.select,insert=db.insert;let selections=0,inserts=0;let catalogWhere:unknown;
 const source={id:"committed-champion",evaluationSource:"paper",feedFreshness:"current",
   marketTicker:"KXBTC15M-TEST",evaluatedAt:NOW};
 try{
  db.select=(()=>{const call=++selections;return {from:()=>({where:(q:unknown)=>{
   if(call===1)return {limit:async()=>[source]};
   if(call===2)return {orderBy:()=>({limit:async()=>[]})};
   catalogWhere=q;return Promise.resolve([]);
  }})};}) as unknown as typeof db.select;
  db.insert=(()=>{inserts++;throw Error("unexpected insert");}) as typeof db.insert;
  const result=await recordV13ShadowOpportunities(source.id);
  assert.equal(result.recorded,0);assert.equal(selections,3);assert.equal(inserts,0);
  const query=new PgDialect().sqlToQuery(catalogWhere as any);
  assert.match(query.sql,/"created_at" <=/);
  assert.match(query.sql,/"activated_at" <=/);
  assert.deepEqual(query.params,["SHADOW",false,NOW.toISOString(),NOW.toISOString()]);
 }finally{db.select=select;db.insert=insert;}
});


import { ShadowEventCapture, type ShadowCaptureFrame } from "./shadowEventCapture";
const quietFrame: ShadowCaptureFrame = { model:"model",market:"market",atMs:1000,
 baselineSignal:"PASS",baselineDirection:"NONE",baselineQualifying:false,positionWasOpen:false,
 freshCross:false,signal:"WATCH",direction:"UP",qualifying:false,wouldEnter:false };
test("event capture retains first market receipt and all meaningful evidence; skips only stable quiet frames",()=>{
 const capture=new ShadowEventCapture();
 const first=capture.plan(quietFrame);assert.equal(first.retain,true);first.commit();
 const quiet=capture.plan({...quietFrame,atMs:2000});assert.equal(quiet.retain,false);quiet.commit();
 for(const delta of [ {baselineQualifying:true},{qualifying:true},{wouldEnter:true},{freshCross:true},
  {baselineSignal:"SCOUT"},{signal:"CONFIRM"},{baselineSignal:"EXIT"},{signal:"EXIT"},
  {direction:"DOWN"},{baselineDirection:"UP"},{positionWasOpen:true},{signal:"PASS"},
  {market:"next"},{atMs:500},{atMs:NaN}]){
  const planned=capture.plan({...quietFrame,atMs:3000,...delta});assert.equal(planned.retain,true);
  assert.match(planned.reason,/capture=EVENT_V1/);
 }
 const changed=capture.plan({...quietFrame,atMs:3000,signal:"PASS"});
 assert.match(changed.reason,/observed_quiet_skipped=1/);changed.commit();
 assert.equal(capture.plan({...quietFrame,atMs:4000,signal:"PASS"}).retain,false);
});
test("failed persistence never advances event capture; eviction and restart are fail-open",()=>{
 const capture=new ShadowEventCapture(1);
 assert.equal(capture.plan(quietFrame).retain,true);
 assert.equal(capture.plan({...quietFrame,atMs:2000}).retain,true); // no successful insert/commit
 capture.plan(quietFrame).commit();
 capture.plan({...quietFrame,model:"other"}).commit();
 assert.equal(capture.plan({...quietFrame,atMs:2000}).retain,true);
 assert.equal(new ShadowEventCapture().plan(quietFrame).retain,true);
 assert.throws(()=>new ShadowEventCapture(0));
});

test("actual writer persists first/event receipts with sampling metadata, omits redundant quiet rows",async()=>{
 const select=db.select,insert=db.insert;let selections=0;const writes:any[]=[];
 const set={id:"capture-writer-test",state:"SHADOW",classifierVersion:"V1.3",executionAuthority:false,
   parameterHash:V13_CHAMPION_PARAMETER_HASH,...V13_CHAMPION_PARAMETER_SET.parameters};
 let source:any={id:"capture-source-1",evaluationSource:"paper",feedFreshness:"current",marketTicker:"CAPTURE-TEST",
   evaluatedAt:NOW,btcPrice:100001,target:100000,signedBuffer:1,velocity:1,upBid:0.49,upOffer:0.50,
   downBid:0.49,downOffer:0.50,secondsRemaining:300,freshCross:false,crossingKey:null,
   entryPolicyVersion:V13_ENTRY_POLICY_VERSION,qualifyingTrigger:false,signal:"WATCH",direction:"NONE",
   positionWasOpen:false,strategyParameterSetId:V13_CHAMPION_PARAMETER_SET.id,strategyParameterHash:V13_CHAMPION_PARAMETER_HASH};
 try{
  db.select=(()=>{const call=++selections%3;return {from:()=>({where:()=>{
   if(call===1)return {limit:async()=>[source]};
   if(call===2)return {orderBy:()=>({limit:async()=>[{signedBuffer:1,crossingKey:null,crossingConsumed:false}]})};
   return Promise.resolve([set]);
  }})};}) as unknown as typeof db.select;
  db.insert=(()=>({values:(row:any)=>({onConflictDoNothing:()=>({returning:async()=>{writes.push(row);return [{id:row.id}];}})})})) as unknown as typeof db.insert;
  assert.equal((await recordV13ShadowOpportunities(source.id)).recorded,1);
  source={...source,id:"capture-source-2",evaluatedAt:new Date(NOW.getTime()+5000)};
  assert.equal((await recordV13ShadowOpportunities(source.id)).recorded,0);
  source={...source,id:"capture-source-3",evaluatedAt:new Date(NOW.getTime()+10000),signal:"EXIT"};
  assert.equal((await recordV13ShadowOpportunities(source.id)).recorded,1);
  assert.equal(writes.length,2);
  assert.match(writes[1].reason,/capture=EVENT_V1\|observed_quiet_skipped=1\|coverage=OPTIONAL_LANE_NOT_TICK_COMPLETE/);
  assert.equal(writes[1].sourceEvaluationId,"capture-source-3");assert.equal(writes[1].executionAuthority,false);
 }finally{db.select=select;db.insert=insert;}
});
