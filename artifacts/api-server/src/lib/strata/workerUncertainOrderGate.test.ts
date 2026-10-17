import assert from "node:assert/strict";
import test from "node:test";
import {verifiedUnresolvedIntentMode,readUnresolvedIntentMode} from "./workerUncertainOrderGate";

test("Only an authenticated database count of exactly zero enables entries",()=>{
  assert.deepEqual(verifiedUnresolvedIntentMode([{n:"0"}]),{ok:true,mode:"entries"});
});
test("Every valid nonzero count requires recovery-only scheduling",()=>{
  for(const n of ["1","4","100","9007199254740991"])
    assert.deepEqual(verifiedUnresolvedIntentMode([{n}]),{ok:true,mode:"recovery"});
});
test("No inference of zero from missing/duplicate/malformed/overflow counts",()=>{
  const bad=[null,undefined,[],[{}],[null],{},[{n:"0"},{n:"0"}],
    [{n:null}],[{n:0}],[{n:-1}],[{n:""}],[{n:"00"}],[{n:" 0"}],
    [{n:"0 "}],[{n:"-1"}],[{n:"NaN"}],[{n:"Infinity"}],
    [{n:"1.0"}],[{n:"1e3"}],[{n:"9007199254740992"}],[{n:"18446744073709551615"}]];
  for(const evidence of bad)
    assert.deepEqual(verifiedUnresolvedIntentMode(evidence),
      {ok:false,reason:"unresolved_intent_count_unverified"});
});

test("Database query failure cannot grant entry scheduling", async()=>{
  const failed=await readUnresolvedIntentMode(async()=>{throw new Error("database offline")},"account-1");
  assert.deepEqual(failed,{ok:false,reason:"unresolved_intent_count_unverified"});
});
test("Read helper requires exact account-scoped count before selecting a mode", async()=>{
  let sql = "";let params:unknown[]=[];
  const mode=await readUnresolvedIntentMode(async(q,v)=>{
    sql=q;params=v;return {rows:[{n:"0"}]};
  },"account-7");
  assert.deepEqual(mode,{ok:true,mode:"entries"});
  assert.match(sql,/count\(\*\)::text/);
  assert.match(sql,/state IN \('DISPATCHED','UNKNOWN'\)/);
  assert.deepEqual(params,["account-7"]);
});
