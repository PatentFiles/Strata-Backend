import assert from "node:assert/strict";
import test from "node:test";
import { prepareFrozenKeyRecovery, executeFrozenKeyRecovery,
  RECOVERY_PLAN, RESTRICTED_KEY_RECOVERY_CONFIRMATION, type RecoveryIdentity
} from "./ownerRestrictedKeyRecovery";
import type { CredentialClient, CredentialDatabase } from "./accountCredentialStore";

const id:RecoveryIdentity={
  owner:"11111111-1111-4111-8111-111111111111",
  financial:"22222222-2222-4222-8222-222222222222",
  connection:"33333333-3333-4333-8333-333333333333",
  execution:"strata-account-owner",
  previous:"a".repeat(64),
  setupId:"44444444-4444-4444-8444-444444444444",
  setupFingerprint:"b".repeat(64),
  verificationId:"55555555-5555-4555-8555-555555555555",
  verificationFingerprint:"c".repeat(64)
};
const attemptId="66666666-6666-4666-8666-666666666666";

function harness(options:{frozen?:boolean; existingState?:string; wrongOwner?:boolean}={}) {
  const calls:string[]=[];
  const client:CredentialClient={
    async query(sql,params=[]){
      calls.push(sql);
      if(sql.includes("owner-key-recovery:connection"))
        return {rows:options.wrongOwner?[]:[{id:id.connection}]};
      if(sql.includes("account-credential:frozen-recovery"))
        return {rows:[{execution_account_id:id.execution,previous_fingerprint:id.previous,permitted:options.frozen!==false}]};
      if(sql.includes("owner-key-recovery:credential"))
        return {rows:[{id:attemptId,key_fingerprint:id.previous}]};
      if(sql.includes("owner-key-recovery:authority"))return {rows:[{id:params[0]}]};
      if(sql.includes("owner-key-recovery:unresolved"))
        return {rows:options.existingState?[{id:attemptId,state:options.existingState,previous_fingerprint:id.previous,
          setup_fingerprint:id.setupFingerprint,verification_fingerprint:id.verificationFingerprint}]:[]};
      if(sql.includes("owner-key-recovery:prepare"))return {rows:[{id:attemptId}]};
      if(sql.includes("owner-key-recovery:lock-prepared"))
        return {rows:[{id:attemptId,state:options.existingState??"prepared",
          execution_account_id:id.execution,previous_fingerprint:id.previous,
          setup_credential_id:id.setupId,setup_fingerprint:id.setupFingerprint,
          verification_credential_id:id.verificationId,verification_fingerprint:id.verificationFingerprint}]};
      if(sql.includes("owner-key-recovery:claim"))return {rows:[{id:attemptId}]};
      throw Error("unexpected database operation");
    }
  };
  const db:CredentialDatabase={query:client.query,transaction:async work=>work(client)};
  return {db,calls};
}

test("fixed restricted Kalshi API plan grants trading only inside subaccount 1",()=>{
  assert.deepEqual(RECOVERY_PLAN,{name:"STRATA_V13_SUBACCOUNT_1",key_type:"rsa",
    scopes:["read","write::trade"],subaccount:1});
  assert.equal(Object.hasOwn(RECOVERY_PLAN,"write"),false);
});

test("preparation is owner-scoped and makes no exchange POST",async()=>{
  const {db,calls}=harness();
  const prepared=await prepareFrozenKeyRecovery(db,id);
  assert.equal(prepared.ok,true);
  assert.equal(prepared.attemptId,attemptId);
  assert.equal(prepared.exchangePostAttempted,false);
  assert.ok(calls.some(x=>x.includes("owner-key-recovery:prepare")));
});

test("preparation is denied if the owner is missing or account is not safely frozen",async()=>{
  for(const seed of [{wrongOwner:true},{frozen:false}]) {
    const {db,calls}=harness(seed);
    const result=await prepareFrozenKeyRecovery(db,id);
    assert.equal(result.ok,false);
    assert.equal(calls.some(x=>x.includes("owner-key-recovery:prepare")),false);
  }
});

test("unresolved attempted state can never be silently overwritten by another preparation",async()=>{
  const {db,calls}=harness({existingState:"uncertain"});
  const result=await prepareFrozenKeyRecovery(db,id);
  assert.equal(result.ok,false);
  assert.equal(result.reason,"recovery_prior_attempt_requires_reconciliation");
  assert.equal(calls.some(x=>x.includes("owner-key-recovery:prepare")),false);
});

test("replayed preparation is idempotent while still prepared",async()=>{
  const {db}=harness({existingState:"prepared"});
  const result=await prepareFrozenKeyRecovery(db,id);
  assert.equal(result.ok,true);
  assert.equal(result.attemptId,attemptId);
});

test("unapproved execute never opens the database or calls Kalshi",async()=>{
  const {db,calls}=harness();
  let postCount=0;
  const result=await executeFrozenKeyRecovery(db,{
    identity:id,attemptId,confirmation:"NOT_AUTHORIZED",
    setupMaterial:{keyId:"fake",privateKey:"fake"},
    transport:async()=>{postCount++;return "uncertain";},
    verify:async()=>({ok:false,reason:"not_verified"}),
  });
  assert.equal(result.ok,false);
  assert.equal(result.exchangePostAttempted,false);
  assert.equal(postCount,0);
  assert.equal(calls.length,0);
});

test("a stale prepared state is refused before attempting any Kalshi POST",async()=>{
  const {db}=harness({existingState:"uncertain"});
  let postCount=0;
  const result=await executeFrozenKeyRecovery(db,{
    identity:id,attemptId,confirmation:RESTRICTED_KEY_RECOVERY_CONFIRMATION,
    setupMaterial:{keyId:"fake",privateKey:"fake"},
    transport:async()=>{postCount++;return "uncertain";},
    verify:async()=>({ok:false,reason:"not_verified"}),
  });
  assert.equal(result.exchangePostAttempted,false);
  assert.equal(postCount,0);
});

test("no private credentials are returned by preparation",async()=>{
  const {db}=harness();
  const prepared=await prepareFrozenKeyRecovery(db,id);
  assert.equal(JSON.stringify(prepared).includes("private_key"),false);
});
