import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {reconciledFlatEntryEvidence} from "./reconciledFlatEntryEvidence";
import type {Snapshot} from "../v13-production/types";

const snapshot:Snapshot={identity:{subaccount:1,exchangeIndex:2,keyFingerprint:"test"},
 observedAtMs:1000,complete:true,authenticated:true,historyFromMs:0,cashMicros:"25000000",
 cashExact:true,orders:[],fills:[],settlements:[],positions:[],unexplainedCashActivity:false};
const row={reserved_micros:"0",cash_micros:snapshot.cashMicros,blocked_reason:null,
 kill_switch:false,execution_enabled:true,unresolved:"0",exits:"0",positions:"0"};
const check=(s=snapshot,r:Record<string,unknown>=row,nowMs=1000)=>reconciledFlatEntryEvidence(
 {query:async(_sql,params)=>{assert.deepEqual(params,["account","owner"]);return {rows:[r]};}},
 {accountId:"account",ownerId:"owner",snapshot:s,nowMs});
test("only fresh signed complete flat exchange and ledger proof allows continuation",async()=>{
 assert.equal(await check(),true);
 for(const key of ["authenticated","complete","cashExact"] as const)
  assert.equal(await check({...snapshot,[key]:false}),false,key);
 assert.equal(await check({...snapshot,unexplainedCashActivity:true}),false);
 for(const now of [999,16001,NaN])assert.equal(await check(snapshot,row,now),false);
 assert.equal(await check({...snapshot,positions:[{market:"m",side:"YES",quantityHundredths:"1"}]}),false);
 assert.equal(await check({...snapshot,orders:[{terminal:false} as Snapshot["orders"][number]]}),false);
 for(const key of ["reserved_micros","unresolved","exits","positions"])
  for(const value of ["1",undefined,0,"00"])
   assert.equal(await check(snapshot,{...row,[key]:value}),false,`${key}=${value}`);
 for(const patch of [{cash_micros:"1"},{blocked_reason:"timeout"},{kill_switch:true},{execution_enabled:false}])
  assert.equal(await check(snapshot,{...row,...patch}),false);
});
test("missing database evidence fails closed without writes",async()=>{
 for(const rows of [[],[row,row]])assert.equal(await reconciledFlatEntryEvidence({query:async()=>({rows})},
  {accountId:"account",ownerId:"owner",snapshot,nowMs:1000}),false);
 assert.equal(await reconciledFlatEntryEvidence({query:async()=>{throw Error("offline")}},
  {accountId:"account",ownerId:"owner",snapshot,nowMs:1000}),false);
});
test("production wiring does not convert ordinary reconciliation or successful exits into sticky STOP",()=>{
 const source=readFileSync("src/lib/strata/personalExecutionSupervisor.ts","utf8");
 assert.doesNotMatch(source,/if\(unresolvedNow.mode==="recovery"\)state.entriesAuthorized=false/);
 const exit=source.slice(source.indexOf("dispatchProtectiveExit: async selection"),source.indexOf("recoverProtectiveExits: async"));
 assert.match(exit,/technicalRelease.beginReconciliation\(\)/);
 assert.match(exit,/catch \(error\)[\s\S]*state.entriesAuthorized = false/);
 assert.match(source,/technicalRelease.completeReconciliation\(eligible&&flat\)/);
 assert.match(source,/if\(currentEntry\)throw new Error\("production_other_uncertain_order"\)/);
 assert.doesNotMatch(source,/state.entriesAuthorized\s*=\s*true/);
});
