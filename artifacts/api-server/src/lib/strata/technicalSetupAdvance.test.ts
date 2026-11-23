import assert from "node:assert/strict";
import test from "node:test";
import {advanceTechnicalSetup,createTechnicalSetupAdmission,technicalSetupResult,SETUP_ROLE_ORDER,type SetupRole,type SetupRoleBinding,type TechnicalSetupPorts} from "./technicalSetupAdvance";
import type {AccountSetupOperation, PublicAccountSetupAttempt} from "./accountSetupPreparation";

const ATTEMPT="11111111-1111-4111-8111-111111111111";
const roleBinding=(role:SetupRole,index:number,verified=false):SetupRoleBinding=>({
  role,fingerprint:String(index+1).repeat(64),vaultSecretId:"22222222-2222-4222-8222-"+String(index+1).padStart(12,"0"),verified,
});
function harness(initial=SETUP_ROLE_ORDER.slice(0,3).map((role,i)=>roleBinding(role,i))){
  let bindings=[...initial],scope="owner-a/connection-a",existing=false,unknown:string|null=null,now=0;
  const calls:string[]=[];
  let failRole:SetupRole|null=null,throwRole:SetupRole|null=null,driftRole:SetupRole|null=null;
  let prepareFailure=false,prepareThrows=false;
  let op:AccountSetupOperation="create_subaccount";
  const attempt=():PublicAccountSetupAttempt=>({attemptId:ATTEMPT,operation:op,state:"prepared",
    plan:{operation:"create_subaccount",exchangePath:"/trade-api/v2/portfolio/subaccounts",method:"POST",request:{exchange_index:2},expectedSubaccount:1},
    preparedAt:"2026-11-23T00:00:00Z",updatedAt:"2026-11-23T00:00:00Z"});
  let prepared:PublicAccountSetupAttempt|null=null;
  const ports:TechnicalSetupPorts={
    now:()=>now,
    async snapshot(){return {scope,executionAccountExists:existing,bindings:bindings.map(b=>({...b})),unresolvedAttemptId:unknown,preparedAttempts:prepared?[prepared]:[]};},
    async verify(b){calls.push("verify:"+b.role);
      if(throwRole===b.role)throw Error("synthetic timeout");
      if(failRole===b.role)return {ok:false,reason:"provider_refused"};
      bindings=bindings.map(x=>x.role===b.role?{...x,verified:true}:x);
      if(driftRole===b.role)scope="different";
      return {ok:true,reason:"credential_verified"};
    },
    async status(){calls.push("status");return {executionAccountExists:existing,
      operationPreparations:prepared?[prepared]:[],
      nextAuthorizedAction:{action:prepared?"separately_authorize_subaccount_creation":"prepare_"+op,
        operation:op,endpoint:null,requiredConfirmation:null,effect:"review_only",attemptId:prepared?.attemptId??null}};},
    async prepare(o){calls.push("prepare:"+o);if(prepareThrows)throw Error("lost commit acknowledgement");
      if(prepareFailure)return {ok:false,reason:"provider_refused"};
      prepared=attempt();return {ok:true,reason:"prepared",attempt:prepared};
    },
  };
  return {ports,calls,setExisting:()=>{existing=true;},setUnknown:()=>{unknown=ATTEMPT;},
    fail:(r:SetupRole|null)=>{failRole=r;},timeout:(r:SetupRole)=>{throwRole=r;},
    drift:(r:SetupRole)=>{driftRole=r;},expire:()=>{now=65_000;},setClock:(n:number)=>{now=n;},
    prepareFailure:()=>{prepareFailure=true;},prepareThrows:()=>{prepareThrows=true;},
    add:(r:SetupRole)=>{bindings.push(roleBinding(r,3));},setOperation:(o:AccountSetupOperation)=>{op=o;},
    get bindings(){return bindings;}};
}
test("technical setup verifies prerequisites in order and prepares once, then resumes from durable facts",async()=>{
  const h=harness();
  const first=await advanceTechnicalSetup(h.ports);
  assert.equal(first.stage,"PREPARED");
  assert.deepEqual(h.calls,["verify:provisioning","verify:verification","verify:account_setup_execution","status","prepare:create_subaccount"]);
  assert.equal(first.attemptId,ATTEMPT);
  assert.equal(first.executable,false);assert.equal(first.ordersSubmitted,false);assert.equal(first.transferAttempted,false);
  h.calls.length=0;
  const resumed=await advanceTechnicalSetup(h.ports);
  assert.equal(resumed.stage,"NEEDS_OWNER_ACTION");
  assert.deepEqual(h.calls,["status"]);
});
test("missing key pauses before dependent verification or provisioning",async()=>{
  const h=harness([roleBinding("provisioning",0)]);
  const r=await advanceTechnicalSetup(h.ports);
  assert.equal(r.stage,"NEEDS_CREDENTIAL");assert.equal(r.nextAction,"register_verification");
  assert.deepEqual(h.calls,["verify:provisioning"]);
});
test("existing execution account is preserved without a provider request",async()=>{
  const h=harness();h.setExisting();
  assert.equal((await advanceTechnicalSetup(h.ports)).stage,"EXISTING_ACCOUNT");
  assert.deepEqual(h.calls,[]);
});
test("unknown durable attempt prevents any verification or preparation",async()=>{
  const h=harness();h.setUnknown();
  const r=await advanceTechnicalSetup(h.ports);
  assert.equal(r.stage,"WAITING_RECONCILIATION");assert.equal(r.attemptId,ATTEMPT);
  assert.deepEqual(h.calls,[]);
});
test("refused verification persists earlier success and resumes from the first incomplete key",async()=>{
  const h=harness();h.fail("verification");
  assert.equal((await advanceTechnicalSetup(h.ports)).stage,"BLOCKED");
  assert.deepEqual(h.calls,["verify:provisioning","verify:verification"]);
  h.fail(null);h.calls.length=0;
  assert.equal((await advanceTechnicalSetup(h.ports)).stage,"PREPARED");
  assert.deepEqual(h.calls,["verify:verification","verify:account_setup_execution","status","prepare:create_subaccount"]);
});
test("rotation or owner drift stops immediately after the exact saved verification",async()=>{
  const h=harness();h.drift("provisioning");
  const r=await advanceTechnicalSetup(h.ports);
  assert.equal(r.stage,"BLOCKED");assert.equal(r.reason,"technical_setup_scope_changed");
  assert.deepEqual(h.calls,["verify:provisioning"]);
});
test("verification and preparation transport exceptions are UNKNOWN, not replayed",async()=>{
  const h=harness();h.timeout("verification");
  assert.equal((await advanceTechnicalSetup(h.ports)).stage,"UNKNOWN");
  assert.deepEqual(h.calls,["verify:provisioning","verify:verification"]);
  const other=harness();other.prepareThrows();
  assert.equal((await advanceTechnicalSetup(other.ports)).stage,"UNKNOWN");
  assert.equal(other.calls.filter(c=>c.startsWith("prepare:")).length,1);
});
test("bounded elapsed work returns resumable status, never starts a new operation after deadline",async()=>{
  const h=harness();const original=h.ports.verify;
  h.ports.verify=async b=>{const r=await original(b);h.expire();return r;};
  const r=await advanceTechnicalSetup(h.ports);
  assert.equal(r.stage,"RESUME_REQUIRED");assert.deepEqual(h.calls,["verify:provisioning"]);
});
test("same owner and global capacity are bounded without queuing or leaking slots",async()=>{
  const admit=createTechnicalSetupAdmission(1);
  let release!:()=>void;
  const first=admit("owner-a",async()=>{await new Promise<void>(r=>{release=r;});return technicalSetupResult("EXISTING_ACCOUNT","ok");});
  assert.equal((await admit("owner-a",async()=>{throw Error("unexpected");})).stage,"BUSY");
  assert.equal((await admit("owner-b",async()=>{throw Error("unexpected");})).stage,"BUSY");
  release();await first;
  assert.equal((await admit("owner-b",async()=>technicalSetupResult("EXISTING_ACCOUNT","ok"))).stage,"EXISTING_ACCOUNT");
});
