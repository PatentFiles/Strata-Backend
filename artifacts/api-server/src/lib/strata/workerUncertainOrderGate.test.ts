import assert from "node:assert/strict";
import test from "node:test";
import {verifiedUnresolvedIntentMode} from "./workerUncertainOrderGate";

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
