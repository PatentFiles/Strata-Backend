import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {runInNewContext} from "node:vm";
import {build} from "esbuild";

const entry=fileURLToPath(new URL("../src/lib/strata/sharedPersonalTradingControls.ts",import.meta.url));
const supervisor=fileURLToPath(new URL("../src/lib/strata/personalExecutionSupervisor.ts",import.meta.url));
const flag="STRATA_PUBLIC_METADATA_PREFETCH_ENABLED";
// Compile the ACTUAL process-wide construction module. Only its DB, supervisor
// factory and HTTP-control-port dependencies are offline stubs. Config parsing
// and option forwarding are real; no worker, DB, provider or socket is started.
const bundled=await build({entryPoints:[entry],bundle:true,write:false,platform:"node",format:"cjs",
  plugins:[{name:"offline-construction-dependencies",setup(b){
    b.onResolve({filter:/^(?:@workspace\/db|\.\/personalExecutionSupervisor|\.\/userScopeDatabase)$/},args=>({path:args.path,namespace:"offline"}));
    b.onLoad({filter:/.*/,namespace:"offline"},args=>({loader:"js",contents:
      args.path==="@workspace/db" ? `export const pool=Object.freeze({offlinePool:true});` :
      args.path==="./personalExecutionSupervisor" ? `
        export function createProductionPersonalSession(pool,options={}) {
          globalThis.calls.push({kind:"supervisor",pool,options});
          return Object.freeze({session:true});
        }` : `
        export function createDatabaseUserScopePort(pool,options) {
          globalThis.calls.push({kind:"controls",pool,options});
          return Object.freeze({controls:true,session:options.session});
        }`,
    }));
  }}],
});
const source=bundled.outputFiles[0].text;
function construct(value,{extra={},throwDiagnostic=false}={}){
  const calls=[],diagnostics=[],envReads=[];
  const values=Object.freeze({...extra,...(value===undefined?{}:{[flag]:value})});
  const env=new Proxy(values,{get(target,key){envReads.push(key);return target[key];},
    set(){throw Error("environment_mutation_forbidden");}});
  const module={exports:{}};
  const context={module,exports:module.exports,process:{env},calls,
    console:{warn(...args){diagnostics.push(args);if(throwDiagnostic)throw Error("diagnostic_unavailable");}},
    Date:{now(){throw Error("eligibility_clock_forbidden_in_configuration_test");}},
    performance:{now(){throw Error("clock_forbidden_in_configuration_test");}},
    setTimeout(){throw Error("scheduling_forbidden_in_configuration_test");},
    fetch(){throw Error("network_forbidden_in_configuration_test");}};
  return {run:()=>runInNewContext(source,context,{timeout:1000}),calls,values,module,diagnostics,envReads};
}
function verifySharedConstruction(c,enabled){
  assert.equal(c.calls.length,2);const [session,controls]=c.calls;
  assert.equal(session.kind,"supervisor");assert.equal(session.options.publicMetadataPrefetch,enabled);
  assert.deepEqual(Object.keys(session.options),["publicMetadataPrefetch"]);
  assert.equal(controls.kind,"controls");assert.equal(controls.pool,session.pool);
  assert.equal(controls.options.session,c.module.exports.personalTradingSession);
  assert.equal(c.module.exports.personalTradingControls.session,c.module.exports.personalTradingSession);
  assert.deepEqual(c.envReads,[flag],"only the explicit rollout flag is read, exactly once");
}

test("unset and exact false retain OFF at the actual shared supervisor construction",()=>{
  for(const value of [undefined,"false"]){
    const c=construct(value);c.run();verifySharedConstruction(c,false);
    assert.equal(c.diagnostics.length,0);assert.equal(c.values[flag],value);
  }
});

test("exact true opts the same supervisor into its existing reviewed public-only coordinator",async()=>{
  const c=construct("true");c.run();verifySharedConstruction(c,true);assert.equal(c.diagnostics.length,0);
  // Static integration assertion: this is the unchanged reviewed hook, not a
  // new coordinator, book cache, alternate worker construction or bypass.
  const text=await readFile(supervisor,"utf8");
  assert.match(text,/if\(apiSource&&options\.publicMetadataPrefetch===true\)\{/);
  assert.match(text,/const attempt=processCommittedPublicMetadata\.start\(metadataScope\(\),hint\)/);
});

test("malformed values are explicitly diagnosed but keep supervisor/recovery construction available with OFF",()=>{
  for(const value of ["","TRUE","False"," true","true ","1","0","yes","on","null",true,false,1,0,null]){
    const c=construct(value);c.run();verifySharedConstruction(c,false);
    assert.equal(c.diagnostics.length,1);
    assert.deepEqual(JSON.parse(JSON.stringify(c.diagnostics)),[
      ["strata_public_metadata_prefetch_config_invalid",{enabled:false}],
    ]);
    assert.equal(c.values[flag],value);
  }
});

test("invalid-content diagnostics are bounded, sanitized, and cannot disable recovery if reporting fails",()=>{
  for(const value of ["secret="+"x".repeat(100000),{toString(){throw Error("never_coerce");}}]){
    const c=construct(value,{throwDiagnostic:true});c.run();verifySharedConstruction(c,false);
    assert.equal(c.diagnostics.length,1);
    const diagnostic=JSON.stringify(c.diagnostics);assert.ok(diagnostic.length<100);assert.ok(!diagnostic.includes("secret="));
  }
});

test("other execution flags cannot opt in and are neither read nor changed",()=>{
  for(const value of [undefined,"false","true"]){
    const extra={LIVE_EXECUTION_ENABLED:"true",V13_PRODUCTION_EXECUTION_ENABLED:"true",
      STRATA_AUTOMATIC_WITHDRAWALS_ENABLED:"true",STRATA_BOGUS_PREFETCH_ENABLED:"true"};
    const c=construct(value,{extra});c.run();verifySharedConstruction(c,value==="true");
    for(const [name,setting] of Object.entries(extra))assert.equal(c.values[name],setting);
  }
});
