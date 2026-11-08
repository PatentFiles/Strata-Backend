import test from "node:test";
import assert from "node:assert/strict";
import {authenticatedProtectiveRecoveryFresh} from "./ownerFeeEmergencyExitAuthenticatedRecovery";
import {persistAuthenticatedExitReconciliation} from "./ownerFeeEmergencyExitReconciliationCommit";
import {reconcileUnknownProtectiveExitAfterRestart} from "./ownerFeeEmergencyExitRestartRecovery";
import {dispatchReviewedProtectiveExitOnce} from "./ownerFeeEmergencyExitSignedDispatch";
import {fixture,signedPorts,receipt} from "./protectiveRecoveryDeadline.testSupport";

type Stage="CONNECT"|"BEGIN"|"LOCK_TIMEOUT"|"STATEMENT_TIMEOUT"|"SELECT"|"INSERT"|"UPDATE"|"COMMIT"|"ROLLBACK"|"RELEASE";
function database(f:ReturnType<typeof fixture>,options:{
 onStage?:(stage:Stage)=>void|Promise<void>;
 commitThrows?:"before"|"after";rollbackThrows?:"before"|"after";releaseThrows?:boolean;
 noLock?:boolean;badBaseline?:boolean;duplicate?:boolean;
}={}){
 const state={durable:"UNKNOWN",audit:false,staged:false,active:false,commits:0,rollbacks:0,releases:0,evicted:false,
  stages:[] as Stage[],args:[] as unknown[][]};
 const step=async(stage:Stage)=>{state.stages.push(stage);await options.onStage?.(stage);};
 const db={connect:async()=>{
  await step("CONNECT");
  return {release(error?:Error|boolean){state.stages.push("RELEASE");state.releases++;state.evicted=Boolean(error);if(options.releaseThrows)throw Error("release_failed");},
   query:async(sql:string,args?:unknown[])=>{
    const stage:Stage=sql.startsWith("SELECT")?"SELECT":sql.startsWith("INSERT")?"INSERT":sql.startsWith("UPDATE")?"UPDATE":
     sql.includes("lock_timeout")?"LOCK_TIMEOUT":sql.includes("statement_timeout")?"STATEMENT_TIMEOUT":sql as Stage;
    state.args.push(args??[]);
    if(stage==="COMMIT"){
     state.stages.push(stage);state.commits++;
     if(options.commitThrows==="before")throw Error("commit_ack_lost");
     state.durable="RECONCILED";state.audit=true;state.active=false;
     await options.onStage?.(stage);
     if(options.commitThrows==="after")throw Error("commit_ack_lost");
     return {rows:[]};
    }
    await step(stage);
    if(stage==="BEGIN")state.active=true;
    if(stage==="SELECT")return {rows:options.noLock?[]:[{
     reservation_id:f.input.reservationId,initial_position_fp:options.badBaseline?"5.00":"3.00",
     quantity_hundredths:"200",reducing_side:"YES"}]};
    if(stage==="INSERT")return {rows:options.duplicate?[]:[{reservation_id:f.input.reservationId}]};
    if(stage==="UPDATE"){state.staged=true;return {rows:[{reservation_id:f.input.reservationId}]};}
    if(stage==="ROLLBACK"){
     state.rollbacks++;if(options.rollbackThrows==="before")throw Error("rollback_not_executed");
     if(state.active){state.staged=false;state.active=false;}
     if(options.rollbackThrows==="after")throw Error("rollback_ack_lost");
    }
    return {rows:[]};
   }};
 }};
 return {db,state};
}
const PRECOMMIT:Stage[]=["CONNECT","BEGIN","LOCK_TIMEOUT","STATEMENT_TIMEOUT","SELECT","INSERT","UPDATE"];
test("fresh exact-object deadline commits with its original inclusive 3000ms budget",async()=>{
 for(const elapsed of [0,2999,3000]){
  const f=fixture(),observation=await f.read(null),p=database(f);
  f.advance(elapsed);
  const result=await persistAuthenticatedExitReconciliation(f.input,observation,{db:p.db});
  assert.deepEqual(result,{committed:true,commitState:"COMMITTED",freshnessVerified:true,
   reason:"exit_reconcile_durable_terminal",mayRetry:false,tradingAuthorized:false});
  assert.equal(p.state.durable,"RECONCILED");assert.equal(p.state.commits,1);assert.equal(p.state.releases,1);
 }
});
test("expired proof before persistence never acquires a connection",async()=>{
 const f=fixture(),observation=await f.read(null),p=database(f);f.advance(3001);
 const result=await persistAuthenticatedExitReconciliation(f.input,observation,{db:p.db});
 assert.equal(result.commitState,"NOT_ATTEMPTED");assert.equal(result.committed,false);
 assert.deepEqual(p.state.stages,[]);assert.equal(p.state.durable,"UNKNOWN");
});
for(const stage of PRECOMMIT){
 test(`expiry after ${stage} rolls back without attempting COMMIT`,async()=>{
  const f=fixture(),observation=await f.read(null),p=database(f,{onStage:at=>{if(at===stage)f.advance(3001);}});
  const result=await persistAuthenticatedExitReconciliation(f.input,observation,{db:p.db});
  assert.equal(result.committed,false);assert.equal(result.commitState,"NOT_ATTEMPTED");
  assert.equal(result.freshnessVerified,false);assert.equal(result.mayRetry,false);
  assert.equal(p.state.commits,0);assert.equal(p.state.durable,"UNKNOWN");assert.equal(p.state.audit,false);
  assert.equal(p.state.rollbacks,1);assert.equal(p.state.releases,1);
 });
}
test("clock regressions relative to preceding checks cannot renew the original deadline",async()=>{
 for(const key of ["wall","mono"] as const){
  const f=fixture(),observation=await f.read(null),p=database(f,{onStage:stage=>{
   if(stage==="CONNECT")f.clock[key]+=100;
   if(stage==="BEGIN")f.clock[key]-=50;
  }});
  const result=await persistAuthenticatedExitReconciliation(f.input,observation,{db:p.db});
  assert.equal(result.commitState,"NOT_ATTEMPTED");assert.equal(p.state.commits,0);assert.equal(p.state.durable,"UNKNOWN");
  f.clock[key]+=100;
  assert.equal(authenticatedProtectiveRecoveryFresh(f.input,observation),false,"failed receipt stays invalid after clock repair");
 }
});
test("missing, copied, mutated and foreign-scope receipts never reach SQL",async()=>{
 for(const kind of ["copy","json-copy","owner","account","reservation","order","observation","nested-receipt"]){
  const f=fixture(),observation=await f.read(receipt),p=database(f);
  let candidate=observation;const scope=structuredClone(f.input);
  if(kind==="copy")candidate={...observation};
  if(kind==="json-copy")candidate=JSON.parse(JSON.stringify(observation));
  if(kind==="owner")scope.ownerId="99999999-9999-4999-8999-999999999999";
  if(kind==="account")scope.accountId="other-account";
  if(kind==="reservation")scope.reservationId="99999999-9999-4999-8999-999999999999";
  if(kind==="order")scope.order.price="0.5600";
  if(kind==="observation")observation.authenticatedOrder!.status="cancelled";
  if(kind==="nested-receipt")observation.response={...observation.response!,ts_ms:observation.response!.ts_ms as number+1};
  const result=await persistAuthenticatedExitReconciliation(scope,candidate,{db:p.db});
  assert.equal(result.committed,false,kind);assert.deepEqual(p.state.stages,[],kind);
 }
});
test("observation mutation during an awaited SQL result rolls back before terminalization",async()=>{
 const f=fixture(),observation=await f.read(null),p=database(f,{onStage:stage=>{
  if(stage==="SELECT")observation.authenticatedOrder!.status="cancelled";
 }});
 const result=await persistAuthenticatedExitReconciliation(f.input,observation,{db:p.db});
 assert.equal(result.commitState,"NOT_ATTEMPTED");assert.equal(p.state.commits,0);assert.equal(p.state.durable,"UNKNOWN");
});
test("reader captures original scope, full order and receipt before awaited reads",async()=>{
 const f=fixture(),original=structuredClone(f.input),response=structuredClone(receipt);
 f.hooks.baseline=()=>{f.input.ownerId="99999999-9999-4999-8999-999999999999";f.input.accountId="changed";f.input.order.price="0.9000";};
 f.hooks.feed=()=>{response.fill_count="0.00";};
 const observation=await f.read(response);
 assert.equal(observation.response!.fill_count,"1.00");
 assert.equal(authenticatedProtectiveRecoveryFresh(original,observation),true);
 assert.equal(authenticatedProtectiveRecoveryFresh(f.input,observation),false);
});
test("persistence captures input scope before awaited SQL without following caller mutation",async()=>{
 const f=fixture(),observation=await f.read(null),original=structuredClone(f.input);
 const p=database(f,{onStage:stage=>{if(stage==="CONNECT"){f.input.accountId="changed";f.input.order.price="0.9000";}}});
 const result=await persistAuthenticatedExitReconciliation(f.input,observation,{db:p.db});
 assert.equal(result.committed,true);assert.equal(result.freshnessVerified,true);
 assert.equal(p.state.args.some(args=>args.includes("changed")),false);
 assert.equal(p.state.args.some(args=>args.includes(original.accountId)),true);
});
for(const failure of ["before","after"] as const){
 test(`uncertain COMMIT ${failure} durable acceptance stays fail-closed without claiming rollback`,async()=>{
  const f=fixture(),observation=await f.read(null),p=database(f,{commitThrows:failure});
  const result=await persistAuthenticatedExitReconciliation(f.input,observation,{db:p.db});
  assert.equal(result.committed,false);assert.equal(result.commitState,"UNKNOWN");assert.equal(result.mayRetry,false);
  assert.equal(p.state.commits,1);assert.equal(p.state.rollbacks,1);assert.equal(p.state.releases,1);
  assert.equal(p.state.evicted,true);
  assert.equal(p.state.durable,failure==="after"?"RECONCILED":"UNKNOWN");
 });
}
test("late, invalid or throwing post-COMMIT clocks retain acknowledged commit provenance",async()=>{
 for(const failure of ["late","wall-invalid","mono-invalid","wall-throws","mono-throws","wall-regression","mono-regression"]){
  const f=fixture(),observation=await f.read(null),p=database(f,{releaseThrows:true,onStage:stage=>{
   if(stage!=="COMMIT")return;
   if(failure==="late")f.advance(3001);
   if(failure==="wall-invalid")f.clock.wall=NaN;
   if(failure==="mono-invalid")f.clock.mono=Infinity;
   if(failure==="wall-throws")f.clock.throwWall=true;
   if(failure==="mono-throws")f.clock.throwMonotonic=true;
   if(failure==="wall-regression")f.clock.wall--;
   if(failure==="mono-regression")f.clock.mono--;
  }});
  const result=await persistAuthenticatedExitReconciliation(f.input,observation,{db:p.db});
  assert.equal(result.committed,true,failure);assert.equal(result.commitState,"COMMITTED",failure);
  assert.equal(result.freshnessVerified,false,failure);assert.equal(result.mayRetry,false);
  assert.equal(p.state.durable,"RECONCILED");assert.equal(p.state.rollbacks,0);assert.equal(p.state.releases,1);
 }
});
test("slow or failed rollback cannot convert an expired transaction into successful recovery",async()=>{
 const f=fixture(),observation=await f.read(null),p=database(f,{rollbackThrows:"after",onStage:stage=>{
  if(stage==="UPDATE"||stage==="ROLLBACK")f.advance(3001);
 }});
 const result=await persistAuthenticatedExitReconciliation(f.input,observation,{db:p.db});
 assert.equal(result.committed,false);assert.equal(result.commitState,"NOT_ATTEMPTED");assert.equal(result.mayRetry,false);
 assert.equal(p.state.commits,0);assert.equal(p.state.durable,"UNKNOWN");assert.equal(p.state.releases,1);
 assert.equal(p.state.evicted,true);
});
test("rollback failure before execution evicts dirty transaction instead of returning it to the pool",async()=>{
 const f=fixture(),observation=await f.read(null),p=database(f,{rollbackThrows:"before",onStage:stage=>{
  if(stage==="UPDATE")f.advance(3001);
 }});
 const result=await persistAuthenticatedExitReconciliation(f.input,observation,{db:p.db});
 assert.equal(result.commitState,"NOT_ATTEMPTED");assert.equal(result.committed,false);assert.equal(result.mayRetry,false);
 assert.equal(p.state.active,true,"test must model a rollback that never executed");
 assert.equal(p.state.staged,true,"uncommitted changes are still on the failed connection");
 assert.equal(p.state.evicted,true,"dirty connection must not be reusable by another borrower");
 assert.equal(p.state.commits,0);assert.equal(p.state.durable,"UNKNOWN");assert.equal(p.state.releases,1);
});
for(const path of ["restart","receipt"] as const){
 for(const scenario of ["timely","expired-before-commit","late-ack","uncertain-commit"]){
  test(`${path} wrapper preserves deadline and commit uncertainty: ${scenario}`,async()=>{
   const f=fixture(),p=database(f,{
    ...(scenario==="uncertain-commit"?{commitThrows:"after" as const}:{}),
    onStage:stage=>{
     if(scenario==="expired-before-commit"&&stage==="SELECT")f.advance(3001);
     if(scenario==="late-ack"&&stage==="COMMIT")f.advance(3001);
    },
   });
   const persist:typeof persistAuthenticatedExitReconciliation=(i,o)=>persistAuthenticatedExitReconciliation(i,o,{db:p.db});
   const result=path==="restart"?
    await reconcileUnknownProtectiveExitAfterRestart(f.input,{readOutcome:async()=>f.read(null),persistReconciled:persist}):
    await dispatchReviewedProtectiveExitOnce(f.input,{...signedPorts(f).ports,readAuthenticatedOutcome:async()=>f.read(receipt),persistReconciled:persist});
   assert.equal(result.state,scenario==="timely"?"RECONCILED":"UNKNOWN");assert.equal(result.mayRetry,false);
   if(scenario==="late-ack"){
    assert.equal(result.reconciliationCommitState,"COMMITTED");assert.equal(result.reconciliationFreshnessVerified,false);
    assert.equal(p.state.durable,"RECONCILED");
   }
   if(scenario==="uncertain-commit"){assert.equal(result.reconciliationCommitState,"UNKNOWN");assert.equal(p.state.durable,"RECONCILED");}
   if(scenario==="expired-before-commit"){assert.equal(result.reconciliationCommitState,"NOT_ATTEMPTED");assert.equal(p.state.durable,"UNKNOWN");}
  });
 }
}

for(const path of ["restart","receipt"] as const){
 for(const coverage of ["missing",false,null,1,"true"]){
  test(`${path} rejects non-complete history (${String(coverage)}) without persistence`,async()=>{
   const f=fixture(),p=database(f);
   f.hooks.feedResult=feed=>{
    if(coverage==="missing")delete feed.historicalCoverageComplete;
    else feed.historicalCoverageComplete=coverage;
   };
   await assert.rejects(f.read(path==="receipt"?receipt:null),/exit_recovery_exchange_history_incomplete/);
   let persistCalls=0;
   const persist:typeof persistAuthenticatedExitReconciliation=async(i,o)=>{
    persistCalls++;return persistAuthenticatedExitReconciliation(i,o,{db:p.db});
   };
   const result=path==="restart"?
    await reconcileUnknownProtectiveExitAfterRestart(f.input,{readOutcome:async()=>f.read(null),persistReconciled:persist}):
    await dispatchReviewedProtectiveExitOnce(f.input,{...signedPorts(f).ports,readAuthenticatedOutcome:async()=>f.read(receipt),persistReconciled:persist});
   assert.equal(result.state,"UNKNOWN");assert.equal(result.mayRetry,false);
   assert.equal(persistCalls,0);assert.deepEqual(p.state.stages,[]);
   assert.equal(p.state.durable,"UNKNOWN");assert.equal(p.state.audit,false);
  });
 }
}
