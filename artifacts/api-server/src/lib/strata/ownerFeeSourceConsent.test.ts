import assert from "node:assert/strict";
import test from "node:test";
import {recordOwnerFeeSourceConsent,revokeOwnerFeeSourceConsent,
  FEE_SOURCE_CONSENT_CONFIRMATION,type FeeConsentDb} from "./ownerFeeSourceConsent";
const OWNER="11111111-1111-4111-8111-111111111111";
const OTHER="99999999-9999-4999-8999-999999999999";
const GRANT="33333333-3333-4333-8333-333333333333";
const CONSENT="44444444-4444-4444-8444-444444444444";
function harness(options:{owned?:boolean;grant?:boolean;insert?:boolean;revocable?:boolean}={}){
  let inserts=0,commits=0,rollbacks=0,releases=0,revokeUpdates=0;
  const query=async (sql:string, params:unknown[]=[]):Promise<{rows:Record<string,unknown>[]}>=>{
    if(sql==="BEGIN")return {rows:[]};
    if(sql==="COMMIT"){commits++;return {rows:[]};}
    if(sql==="ROLLBACK"){rollbacks++;return {rows:[]};}
    if(sql.includes("FROM public.v13_production_account"))
      return {rows:options.owned!==false&&params[0]===OWNER?[{id:"owned_account"}]:[]};
    if(sql.includes("FROM private.strata_fee_source_grants"))
      return {rows:options.grant!==false&&params[0]===GRANT&&params[1]===OWNER?
        [{grant_id:GRANT,release_id:"55555555-5555-4555-8555-555555555555"}]:[]};
    if(sql.includes("INSERT INTO private.strata_fee_source_owner_consents")){
      inserts++;
      return {rows:options.insert!==false?[{consent_id:CONSENT}]:[]};
    }
    if(sql.includes("UPDATE private.strata_fee_source_owner_consents")){
      revokeUpdates++;
      return {rows:options.revocable!==false&&params[0]===GRANT&&params[1]===OWNER?
        [{consent_id:CONSENT}]:[]};
    }
    throw Error("unexpected_query");
  };
  const db:FeeConsentDb={connect:async()=>({query,release:()=>{releases++;}}),query};
  return {db,stats:()=>({inserts,commits,rollbacks,releases,revokeUpdates})};
}
const confirmation={grantId:GRANT,confirmation:FEE_SOURCE_CONSENT_CONFIRMATION};
test("standard 8-4-4-4-12 UUID accepts authenticated owner and records consent",async()=>{
  const h=harness();
  const result=await recordOwnerFeeSourceConsent(OWNER,confirmation,h.db);
  assert.equal(result.ok,true);
  assert.equal(result.policyApproved,false);
  assert.equal(result.commissioningApproved,false);
  assert.equal(result.tradingAuthorized,false);
  assert.deepEqual(h.stats(),{inserts:1,commits:1,rollbacks:0,releases:1,revokeUpdates:0});
});
test("consent remains owner-scoped and refuses foreign or malformed UUIDs",async()=>{
  for(const owner of [OTHER,"11111111-1111-1111-111111111111","bad","",GRANT.slice(0,33)]){
    const h=harness();
    const result=await recordOwnerFeeSourceConsent(owner,confirmation,h.db);
    assert.equal(result.ok,false);
    assert.equal(h.stats().inserts,0);
  }
});
test("denies missing, forged, or duplicate consent",async()=>{
  const denied=[
    {body:{grantId:GRANT,confirmation:"no"},options:{}},
    {body:{grantId:"bad",confirmation:FEE_SOURCE_CONSENT_CONFIRMATION},options:{}},
    {body:confirmation,options:{owned:false}},
    {body:confirmation,options:{grant:false}},
    {body:confirmation,options:{insert:false}},
  ];
  for(const {body,options} of denied){
    const h=harness(options);
    const result=await recordOwnerFeeSourceConsent(OWNER,body,h.db);
    assert.equal(result.ok,false);
    assert.equal(result.tradingAuthorized,false);
    assert.equal(h.stats().commits,0);
  }
});
test("owner can revoke consent and another owner cannot revoke it",async()=>{
  const h=harness();
  const request={grantId:GRANT,confirmation:"REVOKE_OPERATOR_FEE_SOURCE_CONSENT",reason:"Owner revoked source authorization"};
  const success=await revokeOwnerFeeSourceConsent(OWNER,request,h.db);
  assert.equal(success.ok,true);
  assert.equal(success.tradingAuthorized,false);
  assert.equal(h.stats().revokeUpdates,1);
  const bad=await revokeOwnerFeeSourceConsent(OTHER,request,h.db);
  assert.equal(bad.ok,false);
  assert.equal(h.stats().revokeUpdates,2);
});
