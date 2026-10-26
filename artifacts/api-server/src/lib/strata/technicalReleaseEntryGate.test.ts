import assert from "node:assert/strict";
import test from "node:test";
import {TechnicalReleaseEntryGate} from "./technicalReleaseEntryGate";

test("live worker starts fail-closed and authentic renewed technical release can reopen", () => {
 const gate = new TechnicalReleaseEntryGate();
 assert.equal(gate.mayEnter(true,false),false);
 gate.beginReconciliation();
 assert.equal(gate.mayEnter(true,false),false);
 gate.completeReconciliation(true);
 assert.equal(gate.mayEnter(true,false),true);
 gate.beginReconciliation();
 assert.equal(gate.mayEnter(true,false),false);
 gate.completeReconciliation(false);
 assert.equal(gate.mayEnter(true,false),false);
 // Only a NEW positive independently verified authorization restores
 // transient eligibility; the signal classifier or heartbeat never does.
 gate.beginReconciliation();
 gate.completeReconciliation(true);
 assert.equal(gate.mayEnter(true,false),true);
});

test("renewed technical evidence never undoes STOP, KILL or a latched exit/fence hold",()=>{
 const gate = new TechnicalReleaseEntryGate();
 gate.beginReconciliation();
 gate.completeReconciliation(true);
 for(const [armed,killed] of [[false,false],[true,true],[false,true]] as const){
  assert.equal(gate.mayEnter(armed,killed),false);
 }
 assert.equal(gate.mayEnter(undefined,false),false);
 assert.equal(gate.mayEnter(true,false),true);
});

test("an interrupted reconciliation cannot leave technical admission open",()=>{
 const gate = new TechnicalReleaseEntryGate();
 gate.completeReconciliation(true);
 gate.beginReconciliation();
 assert.equal(gate.mayEnter(true,false),false);
});
