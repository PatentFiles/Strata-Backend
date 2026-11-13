import assert from "node:assert/strict";
import test from "node:test";
import { automaticResumeAuthorized } from "./autoWithdrawalMaintenance";

const eligible={
  wasRunning:true,wasArmed:true,initialKillSwitch:false,
  ownerInterrupted:false,ruleEnabled:true,ruleMatches:true,
};

test("auto-resume requires explicit previously running and armed state",()=>{
  assert.equal(automaticResumeAuthorized(eligible),true);
  for(const key of ["wasRunning","wasArmed","ruleEnabled","ruleMatches"] as const)
    assert.equal(automaticResumeAuthorized({...eligible,[key]:false}),false,key);
});

test("prior kill switch and any operator interruption permanently prevent automatic restart",()=>{
  assert.equal(automaticResumeAuthorized({...eligible,initialKillSwitch:true}),false);
  assert.equal(automaticResumeAuthorized({...eligible,ownerInterrupted:true}),false);
});

test("missing or uncertain flags fail closed and never authorize restart",()=>{
  assert.equal(automaticResumeAuthorized({...eligible,ownerInterrupted:undefined as never}),false);
  assert.equal(automaticResumeAuthorized({...eligible,initialKillSwitch:undefined as never}),false);
  assert.equal(automaticResumeAuthorized({...eligible,wasRunning:undefined as never}),false);
});
