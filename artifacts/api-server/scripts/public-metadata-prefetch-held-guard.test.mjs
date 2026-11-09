import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {runInNewContext} from "node:vm";

const path=fileURLToPath(new URL("../src/lib/strata/personalExecutionSupervisor.ts",import.meta.url));
const text=await readFile(path,"utf8");
const start=text.indexOf("    if(apiSource&&options.publicMetadataPrefetch===true){");
const end=text.indexOf("    // Opt-in, same owning session only.",start);
assert.ok(start>=0&&end>start,"exact reviewed hook must be present");
// Run the actual complete hook-installation block, not a parallel test-only
// guard. Its coordinator and scope readers are offline spies; no worker,
// provider, authority SQL, eligibility clock or transport is invoked.
const hook=text.slice(start,end);
function session({entriesAuthorized=true,apiSource=true,enabled=true,patch={}}={}){
  const state={armRequested:true,entriesAuthorized,accountKill:false,globalKill:false,
    presentedToken:7,fencingToken:7,...patch};
  const starts=[],scopes=[];
  const attempt={source:{evaluationId:"committed-exact-source"},drained:Promise.resolve(),
    pause(){},discard(){}};
  const context={state,apiSource,options:{publicMetadataPrefetch:enabled},activeMetadata:null,
    session:{executor:{}},
    metadataScope(){scopes.push("read");return {accountId:"account-a",fence:7};},
    processCommittedPublicMetadata:{start(scope,hint){starts.push({scope,hint});return attempt;}},
    Date:{now(){throw Error("eligibility_clock_forbidden_in_hook_test");}},
    fetch(){throw Error("network_forbidden_in_hook_test");},
    setTimeout(){throw Error("scheduling_forbidden_in_hook_test");},
  };
  runInNewContext(hook,context,{timeout:1000});
  return {run:context.session.executor.prefetchCommittedPublicMetadata,state,starts,scopes};
}

test("sticky observed entry hold suppresses advisory reads even when a committed hint claims authority",()=>{
  const held=session({entriesAuthorized:false});
  for(let i=0;i<100;i++){
    assert.equal(held.run({evaluationId:"source-"+i,qualifyingTrigger:true,
      entriesAuthorized:true,armRequested:true}),null);
  }
  assert.equal(held.starts.length,0);assert.equal(held.scopes.length,0);
  assert.equal(held.state.entriesAuthorized,false,"hints cannot lift the observed hold");
});

test("fresh legitimate START-state session can prefetch; held session remains held",()=>{
  const held=session({entriesAuthorized:false}),restarted=session({entriesAuthorized:true});
  assert.equal(held.run({evaluationId:"source-held"}),null);
  const hint=Object.freeze({evaluationId:"source-new-start"});
  const attempt=restarted.run(hint);assert.ok(attempt);
  assert.equal(restarted.starts.length,1);assert.equal(restarted.starts[0].hint,hint);
  assert.equal(held.starts.length,0);assert.equal(held.state.entriesAuthorized,false);
  assert.equal(restarted.run(hint),null,"existing one-active-attempt bound remains unchanged");
});

test("existing arm, kill and fence exclusions still suppress advisory work",()=>{
  for(const patch of [{armRequested:false},{accountKill:true},{globalKill:true},{presentedToken:6}]){
    const s=session({patch});assert.equal(s.run({evaluationId:"source"}),null);
    assert.equal(s.starts.length,0);assert.equal(s.scopes.length,0);
  }
});

test("public-coordinator hook still requires both exact API source and explicit opt-in",()=>{
  for(const args of [{apiSource:false},{enabled:false},{enabled:"true"}])assert.equal(session(args).run,undefined);
  assert.ok(session({patch:{entriesAuthorized:undefined}}).run({evaluationId:"source"}),
    "only explicit sticky false adds an exclusion; absent legacy field is not a new authority gate");
});
