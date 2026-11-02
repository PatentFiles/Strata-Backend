import test from 'node:test';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {ExecutionSubtimings,validExecutionSubtimings} from './executionSubtimings';
import {beginExecutionStage,type StageTiming} from './stageTiming';
import {ProductionExecutor} from './executor';

test('subtimings are bounded monotonic groups, not eligibility clock readings',()=>{
 let clock=0;const t=new ExecutionSubtimings(()=>clock);
 t.mark('grant_history');clock=3;t.mark('technical_lease');clock=8;
 const rows=t.snapshot(false);
 assert.deepEqual(rows,[{stage:'grant_history',durationMs:3,completed:true},{stage:'technical_lease',durationMs:5,completed:false}]);
 clock=99;t.mark('flat_entry_evidence');assert.deepEqual(t.snapshot(true),rows);
 assert.ok(Object.isFrozen(rows)&&rows.every(Object.isFrozen));
});
test('throwing or nonfinite telemetry clocks do not throw or manufacture timings',()=>{
 const t=new ExecutionSubtimings(()=>{throw Error('clock broke')});
 assert.doesNotThrow(()=>{t.mark('grant_history');t.mark('technical_lease');t.snapshot(false)});
 assert.deepEqual(t.snapshot(true),[]);
 const invalid=new ExecutionSubtimings(()=>Infinity);invalid.mark('grant_history');assert.deepEqual(invalid.snapshot(true),[]);
});
test('only eight whitelisted payload-free groups can be emitted',()=>{
 let now=0;const t=new ExecutionSubtimings(()=>++now);
 for(let n=0;n<30;n++)t.mark('grant_history');
 assert.equal(t.snapshot(true).length,8);
 assert.equal(validExecutionSubtimings([{stage:'secret_payload',durationMs:1,completed:true}]),false);
 assert.equal(validExecutionSubtimings([{stage:'grant_history',durationMs:1,completed:true,secret:'x'}]),false);
 assert.equal(validExecutionSubtimings([{stage:'grant_history',durationMs:-1,completed:true}]),false);
});
test('existing stage event carries immutable subgroups only for permitted parents',async()=>{
 const events:StageTiming[]=[];const rows=[{stage:'grant_history' as const,durationMs:3,completed:true}];
 const done=beginExecutionStage(e=>{events.push(e)},'after_reconcile',{accountId:'a',mode:'SIMULATION'},()=>1);
 done('completed',{substageTimings:rows});rows[0].durationMs=900;
 beginExecutionStage(e=>{events.push(e)},'dispatch',{accountId:'a',mode:'SIMULATION'},()=>1)('completed',{substageTimings:rows});
 await Promise.resolve();
 assert.equal(events.length,2);assert.equal(events[0].substageTimings?.[0].durationMs,3);
 assert.ok(Object.isFrozen(events[0].substageTimings));assert.equal(events[1].substageTimings,undefined);
});
test('executor callback subgroups keep original calls, eligibility clock count and failure identity',async()=>{
 const order:string[]=[];let eligibilityClockCalls=0;const failure=Error('authority_revoked');
 const ledger={accountId:'account',readAccount:async()=>{order.push('read');return{id:'account'}},
  pool:{query:async()=>{order.push('floor');return{rows:[{earliest:null}]}}},
  reconcile:async()=>{order.push('commit');return undefined}};
 const exchange={mode:'SIMULATION',snapshot:async()=>{order.push('signed');return{identity:{}}}};
 const executor=new ProductionExecutor(ledger as never,exchange as never,()=>{eligibilityClockCalls++;return 1000});
 executor.afterReconcile=async(_snapshot,t)=>{t?.mark('grant_history');order.push('history');t?.mark('technical_lease');order.push('renew');throw failure};
 const events:StageTiming[]=[];executor.timingObserver=e=>{events.push(e);throw Error('logger failed')};
 await assert.rejects(executor.reconcile(),e=>e===failure);await Promise.resolve();
 assert.deepEqual(order,['read','floor','signed','commit','history','renew']);assert.equal(eligibilityClockCalls,2);
 const event=events.find(e=>e.stage==='after_reconcile')!;assert.equal(event.outcome,'rejected');
 assert.deepEqual(event.substageTimings?.map(x=>[x.stage,x.completed]),[['grant_history',true],['technical_lease',false]]);
 assert.equal(events.filter(e=>e.stage==='after_reconcile').length,1);
});

// Execute the actual owned-session callback body, not a substitute callback.
// Reading this exact source section avoids a production-only test export/refactor.
const supervisorSource=readFileSync(resolve(process.cwd(),'src/lib/strata/personalExecutionSupervisor.ts'),'utf8');
const callbackStart='session.executor.afterReconcile=async (snapshot,subtimings,scheduling)=>{';
const callbackEnd='    session.executor.authorizeFinalEntry=';
const bodyStart=supervisorSource.indexOf(callbackStart);
const bodyEnd=supervisorSource.indexOf(callbackEnd,bodyStart);
assert.ok(bodyStart>=0&&bodyEnd>bodyStart,'actual owned callback source boundary must remain explicit');
const callbackBody=supervisorSource.slice(bodyStart+callbackStart.length,bodyEnd).replace(/};\s*$/,'').replace('let technicalRenewal: \"deferred\" | \"settled\" | undefined;','let technicalRenewal;');
const actualCallback=new Function('deps',`const {deployedGitSha,hasContinuousGrantHistory,db,input,renewContinuousTechnicalLease,policyHash,state,now,checkContinuousEligibility,verifyProtectiveExitStartupRelease,reconciledFlatEntryEvidence,technicalRelease}=deps;return async(snapshot,subtimings,scheduling)=>{${callbackBody}}`);
for(const scenario of [
 {name:'grant current eligible',grant:true,renewed:true,eligible:true,flat:true,expected:true,order:['history','renew','eligible','flat','complete']},
 {name:'renewal denial skips eligibility but retains flat check',grant:true,renewed:false,eligible:true,flat:true,expected:false,order:['history','renew','flat','complete']},
 {name:'legacy release still checked',grant:false,renewed:false,eligible:true,flat:true,expected:true,order:['history','legacy','flat','complete']},
 {name:'flat hold prevents entries',grant:true,renewed:true,eligible:true,flat:false,expected:false,order:['history','renew','eligible','flat','complete']},
])test(`actual owned afterReconcile preserves ${scenario.name}`,async()=>{
 const calls:string[]=[];let nowCalls=0;let completion:unknown;const t=new ExecutionSubtimings();
 const snapshot={observedAtMs:100,cashMicros:'25',authenticated:true,complete:true,unexplainedCashActivity:false};
 const deps={deployedGitSha:()=> 'a'.repeat(40),db:{connect:()=>{}},input:{userId:'owner',accountId:'acct'},policyHash:'policy',state:{fencingToken:29},now:()=>{nowCalls++;return 100},
  hasContinuousGrantHistory:async()=>{calls.push('history');return scenario.grant},
  renewContinuousTechnicalLease:async(input:unknown)=>{calls.push('renew');assert.equal((input as {providerEvidence:unknown}).providerEvidence,snapshot);return {ok:scenario.renewed}},
  checkContinuousEligibility:async()=>{calls.push('eligible');return scenario.eligible},
  verifyProtectiveExitStartupRelease:async()=>{calls.push('legacy');return{ok:scenario.eligible}},
  reconciledFlatEntryEvidence:async()=>{calls.push('flat');return scenario.flat},
  technicalRelease:{completeReconciliation:(value:unknown)=>{calls.push('complete');completion=value}},
 };
 await actualCallback(deps)(snapshot,t);assert.deepEqual(calls,scenario.order);assert.equal(completion,scenario.expected);assert.equal(nowCalls,1);
 assert.equal(t.snapshot(true).length,scenario.grant&&scenario.renewed?4:3);
});
test('actual owned callback propagates same history error without later calls',async()=>{
 const failure=Error('standing_scope_invalid');let later=0;
 const callback=actualCallback({deployedGitSha:()=> 'a'.repeat(40),db:{},input:{userId:'owner'},hasContinuousGrantHistory:async()=>{throw failure},
  technicalRelease:{completeReconciliation:()=>later++},reconciledFlatEntryEvidence:async()=>{later++;return true}});
 await assert.rejects(callback({},new ExecutionSubtimings()),e=>e===failure);assert.equal(later,0);
});

test('stage subtiming sanitizer snapshots hostile accessors once and never leaks objects',async()=>{
 let reads=0;const events:StageTiming[]=[];
 const hostile={stage:'grant_history',get durationMs(){return ++reads===1?1:{secret:'must_not_escape'}},completed:true};
 beginExecutionStage(e=>{events.push(e)},'after_reconcile',{accountId:'a',mode:'SIMULATION'},()=>1)('completed',{substageTimings:[hostile] as never});
 await Promise.resolve();assert.equal(reads,1);assert.equal(events[0].substageTimings?.[0].durationMs,1);
 assert.doesNotMatch(JSON.stringify(events),/must_not_escape/);
 beginExecutionStage(e=>{events.push(e)},'after_reconcile',{accountId:'a',mode:'SIMULATION'},()=>1)('completed',{substageTimings:[{stage:'grant_history',get durationMs(){throw Error('secret')},completed:true}] as never});
 await Promise.resolve();assert.equal(events[1].substageTimings,undefined);
});

test('actual owned callback only requests scoped source reuse and scheduling result never grants entry',async()=>{
 for(const scheduling of [undefined,{origin:'normal',allowEarlyTechnicalLeaseReuse:true},{origin:'committed_signal',allowEarlyTechnicalLeaseReuse:false},{origin:'committed_signal',allowEarlyTechnicalLeaseReuse:true}]){
  let passed:unknown,complete:unknown;const expected=scheduling?.origin==='committed_signal'&&scheduling.allowEarlyTechnicalLeaseReuse===true;
  const callback=actualCallback({deployedGitSha:()=> 'a'.repeat(40),db:{connect:()=>{}},input:{userId:'owner',accountId:'acct'},policyHash:'policy',state:{fencingToken:29},now:()=>100,
   hasContinuousGrantHistory:async()=>true,renewContinuousTechnicalLease:async(input:any)=>{passed=input.allowEarlyRotationDeferral;return{ok:true,earlyRotationDeferred:expected}},checkContinuousEligibility:async()=>false,reconciledFlatEntryEvidence:async()=>true,technicalRelease:{completeReconciliation:(x:unknown)=>{complete=x}}});
  const result=await callback({observedAtMs:100,cashMicros:'25',authenticated:true,complete:true,unexplainedCashActivity:false},undefined,scheduling);
  assert.equal(passed,expected);assert.equal(complete,false);assert.equal(result.technicalRenewal,expected?'deferred':'settled');
 }
});
