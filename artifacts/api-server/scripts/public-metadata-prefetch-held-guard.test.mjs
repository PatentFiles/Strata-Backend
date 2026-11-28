import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {runInNewContext} from "node:vm";

import {build, transformSync} from "esbuild";

const path=fileURLToPath(new URL("../src/lib/strata/personalExecutionSupervisor.ts",import.meta.url));
const text=await readFile(path,"utf8");
// Surround both installations with independent supervisor landmarks. Include adjacent
// statements so an assignment before or after the opt-in block also executes.
function uniqueOffset(statement){
  const offset=text.indexOf(statement);
  assert.ok(offset>=0 && offset===text.lastIndexOf(statement), "expected unique supervisor landmark: "+statement);
  return offset;
}
const start=uniqueOffset("    finalLedger=session.executor.ledger;");
const end=uniqueOffset("    let recoveryAttempted=false;");
assert.ok(end>start);
const hook=transformSync(text.slice(start,end),{loader:"ts",target:"es2022"}).code;
const scope=Object.freeze({accountId:"account-a",ownerId:"owner-a",holderId:"holder-a",
  releaseSha:"a".repeat(40),fence:"7",policyHash:"b".repeat(64)});
function session({entriesAuthorized=true,apiSource=true,durableSource=false,directSource=null,enabled=true,patch={},coordinator}={}){
  const state={armRequested:true,entriesAuthorized,accountKill:false,globalKill:false,
    presentedToken:7,fencingToken:7,...patch};
  const starts=[],scopes=[];
  const attempt={source:{evaluationId:"committed-exact-source"},drained:Promise.resolve(),
    pause(){},discard(){}};
  const executor={};
  const context={state,apiSource,durableSource,directSource,options:{publicMetadataPrefetch:enabled},activeMetadata:null,
    session:{executor},finalLedger:null,
    metadataScope(){scopes.push(scope);return scope;},
    processCommittedPublicMetadata:{start(bound,hint){
      starts.push({scope:bound,hint});
      return coordinator ? coordinator.start(bound,hint) : attempt;
    }},
    Date:{now(){throw Error("eligibility_clock_forbidden_in_hook_test");}},
    fetch(){throw Error("network_forbidden_in_hook_test");},
    setTimeout(){throw Error("scheduling_forbidden_in_hook_test");},
  };
  runInNewContext(hook,context,{timeout:1000});
  return {run:executor.prefetchCommittedPublicMetadata,runDirect:executor.prefetchDirectPublicMetadata,
    state,starts,scopes,executor};
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

test("public-coordinator hook still requires supported API or durable source and explicit opt-in",()=>{
  for(const args of [{apiSource:false},{enabled:false},{enabled:"true"}])assert.equal(session(args).run,undefined);
  assert.ok(session({patch:{entriesAuthorized:undefined}}).run({evaluationId:"source"}),
    "only explicit sticky false adds an exclusion; absent legacy field is not a new authority gate");
});

for(const patch of [{},{entriesAuthorized:false},{accountKill:true},{globalKill:true},{armRequested:false},{presentedToken:6}])test("durable hook preserves all entry controls "+JSON.stringify(patch),()=>{
 const s=session({apiSource:false,durableSource:true,patch});const attempt=s.run({evaluationId:"source"});
 assert.equal(!!attempt,Object.keys(patch).length===0);
});

// Model the producer's exact object-identity boundary, including two producers
// committing byte-for-byte identical hints.
function producer(){
  const owned=new WeakSet();
  return {
    source:{ownsCommittedMetadata(hint){return owned.has(hint);}},
    commit(fields){const hint=Object.freeze({...fields});owned.add(hint);return hint;},
  };
}

test("direct sessions never expose generic prefetch and require strict opt-in and a fee source for direct PREPARE",()=>{
  for(const apiSource of [false,true])for(const durableSource of [false,true]){
    for(const enabled of [false,true,"true"]){
      const s=session({apiSource,durableSource,enabled,directSource:producer().source});
      assert.equal(s.run,undefined);
      assert.equal(typeof s.runDirect,enabled===true&&(apiSource||durableSource)?"function":"undefined");
      assert.equal(s.starts.length,0);assert.equal(s.scopes.length,0);
    }
  }
  assert.equal(session().runDirect,undefined);
});

for(const [lane,feeSource] of [["reviewed",{apiSource:true}],["durable",{apiSource:false,durableSource:true}]]){
  test(lane+" direct PREPARE rejects copied and foreign hints before reading scope",()=>{
    const own=producer(),foreign=producer(),s=session({...feeSource,directSource:own.source});
    const hint=own.commit({evaluationId:"same",qualifyingTrigger:true});
    for(const other of [Object.freeze({...hint}),foreign.commit(hint)]){
      assert.equal(s.runDirect(other),null);
    }
    assert.deepEqual(s.scopes,[]);assert.deepEqual(s.starts,[]);
    assert.ok(s.runDirect(hint));assert.equal(s.starts[0].hint,hint);
    assert.equal(s.starts[0].scope,scope);
    assert.equal(s.runDirect(own.commit({...hint,evaluationId:"next"})),null);
    assert.equal(s.starts.length,1);assert.equal(s.scopes.length,1);
  });

  test(lane+" direct PREPARE rechecks observed holds, STOP, kills, lost lease and fence for an owned hint",()=>{
    const states=[
      ["held or authority revoked",{entriesAuthorized:false}],["STOP",{armRequested:false}],
      ["account kill",{accountKill:true}],["global kill",{globalKill:true}],
      ["lost lease",{presentedToken:-1,entriesAuthorized:false}],["changed fence",{fencingToken:8}],
    ];
    for(const [name,patch] of states){
      const own=producer(),s=session({...feeSource,directSource:own.source});
      const hint=own.commit({evaluationId:"source",entriesAuthorized:true,armRequested:true,presentedToken:7});
      Object.assign(s.state,patch);
      assert.equal(s.runDirect(hint),null,name);
      assert.equal(s.starts.length,0,name);assert.equal(s.scopes.length,0,name);
      for(const [key,value] of Object.entries(patch))assert.equal(s.state[key],value,name);
    }
  });
}

test("owned direct hint starts only bounded public PREPARE and exposes no consume or phase authority",async()=>{
  const entry=fileURLToPath(new URL("../src/lib/strata/committedPublicMetadata.ts",import.meta.url));
  const bundle=await build({entryPoints:[entry],bundle:true,write:false,platform:"node",format:"esm"});
  const url="data:text/javascript;base64,"+Buffer.from(bundle.outputFiles[0].contents).toString("base64");
  const {CommittedPublicMetadataCoordinator}=await import(url);
  const at=Date.parse("2026-11-02T11:31:00Z"),market="KXBTC15M-26NOV021145-00",event="KXBTC15M-26NOV021145";
  const root="https://external-api.kalshi.com/trade-api/v2";
  const pages=new Map([
    [root+"/markets/"+market,{market:{ticker:market,event_ticker:event,exchange_index:2}}],
    [root+"/events/"+event,{event:{event_ticker:event}}],[root+"/series/KXBTC15M",{series:{}}],
    [root+"/series/fee_changes?series_ticker=KXBTC15M&show_historical=false",{series_fee_change_arr:[]}],
    [root+"/events/fee_changes?event_ticker="+event+"&limit=100",{event_fee_changes:[],cursor:""}],
  ]);
  const calls=[];
  let release,active=0,peak=0;
  const hold=new Promise(resolve=>{release=resolve;});
  const coordinator=new CommittedPublicMetadataCoordinator(async(input,init)=>{
    calls.push({url:String(input),method:init.method,credentials:init.credentials,headers:init.headers});
    peak=Math.max(peak,++active);
    try{await hold;return Response.json(pages.get(String(input)));}
    finally{active--;}
  },()=>at,()=>0);
  const own=producer(),s=session({directSource:own.source,coordinator});
  const hint=own.commit({evaluationId:"exact",marketTicker:market,evaluatedAtMs:at-100,committedAtMs:at,
    btcProviderAgeMs:100,btcReceiveAgeMs:0,marketAgeMs:0,qualifyingTrigger:true,
    directSourceSha256:"c".repeat(64),directOldestMs:at-200});
  const attempt=s.runDirect(hint);
  assert.ok(attempt);assert.deepEqual(Object.keys(attempt).sort(),["discard","drained","pause","source"]);
  assert.equal(s.executor.finalPublicMetadata,undefined);
  try{
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls.length,3);
    assert.equal(s.runDirect(own.commit({...hint,evaluationId:"next"})),null);
  }finally{release();}
  await attempt.drained;
  assert.equal(peak,3);assert.equal(s.starts.length,1);
  assert.deepEqual(calls.map(c=>c.url).sort(),[...pages.keys()].sort());
  for(const call of calls){
    assert.equal(call.method,"GET");assert.equal(call.credentials,"omit");
    assert.deepEqual(call.headers,{Accept:"application/json"});
  }
  attempt.discard();
});
