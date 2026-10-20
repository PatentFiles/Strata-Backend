import test from "node:test";
import assert from "node:assert/strict";
import {ProductionWorker} from "./worker";
test("recovery-only owned worker invokes protective UNKNOWN audit before normal reconciliation",async()=>{
 const phases:string[]=[];
 const executor={
  ledger:{readAccount:async()=>{phases.push("read-account");}},
  reconcile:async()=>{phases.push("reconcile");},
 };
 const worker=new ProductionWorker(executor as never,60000,()=>{throw Error("unexpected")},
   ()=>false,async()=>{phases.push("protective-read");});
 await worker.startRecovery();worker.stop();
 assert.deepEqual(phases,["read-account","protective-read","reconcile"]);
});
test("failed protective history cannot be silently bypassed by normal reconcile",async()=>{
 let reconcileCalls=0,reports=0;
 const executor={ledger:{readAccount:async()=>{}},reconcile:async()=>{reconcileCalls++;}};
 const worker=new ProductionWorker(executor as never,60000,()=>{reports++;},
  ()=>true,async()=>{throw Error("exchange_history_unavailable");});
 await worker.startRecovery();worker.stop();
 assert.equal(reconcileCalls,0);
 assert.equal(reports,1);
});
