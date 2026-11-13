import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { executeFrozenKeyRecovery, RESTRICTED_KEY_RECOVERY_CONFIRMATION, type RecoveryIdentity } from "./ownerRestrictedKeyRecovery";
import type { CredentialClient, CredentialDatabase } from "./accountCredentialStore";

const uuid=(n:number)=>`${String(n).repeat(8).slice(0,8)}-1111-4111-8111-${String(n).repeat(12).slice(0,12)}`;
const identity:RecoveryIdentity={
  owner:uuid(1),financial:uuid(2),connection:uuid(3),
  execution:"strata-account-test",previous:"a".repeat(64),
  setupId:uuid(4),setupFingerprint:"b".repeat(64),
  verificationId:uuid(5),verificationFingerprint:"c".repeat(64),
};
const attemptId=uuid(6),secretId=uuid(7),newCredId=uuid(8),priorId=uuid(9);
test("authorized one-shot: POST once, Vault storage, atomic rebind, signed verification, no trading",async()=>{
  const keys=generateKeyPairSync("rsa",{modulusLength:2048});
  const pem=keys.privateKey.export({type:"pkcs8",format:"pem"}).toString();
  const keyId="kalshi-generated-test";
  let posts=0, oldRetired=false, vaultStored=false, rebind=false, verified=false,completed=false;
  let state="prepared";let generatedFingerprint="";
  const calls:string[]=[];
  const client:CredentialClient={async query(sql,params=[]){
    const name=sql.match(/(?:owner-key-recovery|credential-replacement|account-credential):[\w-]+/)?.[0]??"unknown";
    calls.push(name);
    if(name==="owner-key-recovery:connection"||name==="credential-replacement:lock-connection")
      return {rows:[{id:identity.connection,owner_user_id:identity.owner,
        financial_account_id:identity.financial,provider_connection_id:identity.connection,
        connection_vault_secret_id:uuid(0)}]};
    if(name==="account-credential:frozen-recovery")return {rows:[{
      execution_account_id:identity.execution,previous_fingerprint:identity.previous,permitted:true,
    }]};
    if(name==="owner-key-recovery:credential")return {rows:oldRetired?[]:[{id:priorId,key_fingerprint:identity.previous}]};
    if(name==="owner-key-recovery:authority")return {rows:[{id:params[0]}]};
    if(name==="owner-key-recovery:lock-prepared")return {rows:[{
      state,execution_account_id:identity.execution,previous_fingerprint:identity.previous,
      setup_credential_id:identity.setupId,setup_fingerprint:identity.setupFingerprint,
      verification_credential_id:identity.verificationId,verification_fingerprint:identity.verificationFingerprint,
    }]};
    if(name==="owner-key-recovery:claim"){if(state!=="prepared")return {rows:[]};state="attempted";return {rows:[{id:attemptId}]};}
    if(name==="owner-key-recovery:vault"){vaultStored=true;return {rows:[{id:secretId}]};}
    if(name==="owner-key-recovery:retire-incorrect-key"){oldRetired=true;return {rows:[{id:priorId}]};}
    if(name==="credential-replacement:execution-account")return {rows:[{id:identity.execution}]};
    if(name==="credential-replacement:vault-used")return {rows:[]};
    if(name==="credential-replacement:lock-active")return {rows:[]};
    if(name==="credential-replacement:insert"){generatedFingerprint=String(params[5]);return {rows:[{credential_id:newCredId}]};}
    if(name==="credential-replacement:rebind-frozen-execution"){rebind=true;return {rows:[{id:identity.execution}]};}
    if(name==="owner-key-recovery:store-response"){state="response_received";return {rows:[{id:attemptId}]};}
    if(name==="owner-key-recovery:mark-verified"){verified=true;return {rows:[{id:newCredId}]};}
    if(name==="owner-key-recovery:finish"){completed=true;return {rows:[{id:attemptId}]};}
    throw Error("Unexpected SQL: "+name);
  }};
  const db:CredentialDatabase={query:client.query,transaction:async fn=>fn(client)};
  const result=await executeFrozenKeyRecovery(db,{
    identity,attemptId,confirmation:RESTRICTED_KEY_RECOVERY_CONFIRMATION,
    setupMaterial:{keyId:"verified-setup-key",privateKey:"stored-only"},
    transport:async material=>{
      assert.equal(material.keyId,"verified-setup-key");posts++;
      return {status:201,body:{api_key_id:keyId,private_key:pem,key_type:"rsa"},unreadable:false};
    },
    async verify(material,fingerprint){
      assert.equal(material.keyId,keyId);
      assert.equal(fingerprint,generatedFingerprint);
      assert.equal(vaultStored,true);
      assert.equal(rebind,true);
      return {ok:true,reason:"credential_verified"};
    },
  });
  assert.equal(result.ok,true);
  assert.equal(result.state,"completed");
  assert.equal(posts,1);
  assert.equal(oldRetired,true);
  assert.equal(vaultStored,true);
  assert.equal(rebind,true);
  assert.equal(verified,true);
  assert.equal(completed,true);
  assert.ok(calls.indexOf("owner-key-recovery:vault")<calls.indexOf("owner-key-recovery:retire-incorrect-key"));
  assert.ok(calls.indexOf("owner-key-recovery:retire-incorrect-key")<calls.indexOf("credential-replacement:rebind-frozen-execution"));
});
