import test from "node:test";
import assert from "node:assert/strict";
import {inspectOwnerSignedExchangeReleaseProof,OWNER_SIGNED_PROOF_ACCOUNT_SQL,OWNER_SIGNED_PROOF_INTENTS_SQL} from "./ownerSignedExchangeReleaseProof";
const owner="11111111-1111-4111-8111-111111111111";
const at=Date.parse("2026-10-25T12:00:00Z");
const account={
 id:"owner-execution-1",owner_id:owner,kalshi_connection_id:"owner-credential",
 key_fingerprint:"issuer-signature-fingerprint",commissioned:true,
 kill_switch:true,blocked_reason:"awaiting_account_commissioning",
 cash_precision_verified:true,cash_micros:"25000000",reserved_micros:"0",
 policy_id:"approved-v4-policy",policy_state:"APPROVED",
 fee_policy_version:"strata_owner_provider_dynamic_fee_v4",
};
function mock(row:Record<string,unknown>=account,readCash="25000000"){
 const seen:string[]=[];
 let reads=0,feeCalls=0,signerCalls=0;
 const deps={
  db:{async query(sql:string,params?:unknown[]){
   assert.ok(!/\b(INSERT|UPDATE|DELETE|CALL|TRUNCATE)\b/i.test(sql));
   seen.push(sql);
   if(sql.includes("v13_production_account")){
    assert.deepEqual(params,[owner]);return {rows:[row]};
   }
   if(sql.includes("v13_production_intent"))return {rows:[]};
   throw Error("unexpected SQL");
  }},
  now:()=>at,
  material:async()=>{signerCalls++;return {keyId:"mock",privateKey:"never-used"};},
  read:async()=>{reads++;return {ok:true,observedAtMs:at,cashMicros:readCash,
   orders:[],fills:[],positions:[],settlements:[]};},
  feeProbe:async()=>{feeCalls++;return {ok:true};},
  v4:async()=>({ok:true,checks:{protectiveExitRelease:false,ownerShaApproval:false}}),
 } as never;
 return {deps,seen,stats:()=>({reads,feeCalls,signerCalls})};
}
test("authenticated owner gets real empty-history read with separate non-authorizing flags",async()=>{
 const m=mock();
 const r=await inspectOwnerSignedExchangeReleaseProof(owner,m.deps);
 assert.equal(r.ok,true);
 if(!r.ok)return;
 assert.equal(r.signedExchangeReadAttempted,true);
 assert.equal(r.authenticatedExchangeFlat,true);
 assert.equal(r.exchangeCashMatchesLedger,true);
 assert.equal(r.apiMarketFeeMetadataVerified,true);
 assert.equal(r.completeIssuerMonetaryAuthorityVerified,false);
 assert.equal(r.liveEligible,false);
 assert.equal(r.recordPersisted,false);
 assert.equal(r.tradingAuthorized,false);
 assert.equal(r.ordersSubmitted,false);
 assert.deepEqual(m.stats(),{reads:1,feeCalls:1,signerCalls:1});
 assert.ok(r.blockedReasons.includes("complete_issuer_monetary_terms_and_owner_fee_authority_not_verified_here"));
 assert.ok(r.blockedReasons.includes("exact_sha_protective_exit_release_missing"));
});
test("signed cash mismatch never becomes fee metadata authority",async()=>{
 const m=mock(account,"24000000");
 const r=await inspectOwnerSignedExchangeReleaseProof(owner,m.deps);
 assert.equal(r.ok,true);
 if(!r.ok)return;
 assert.equal(r.exchangeCashMatchesLedger,false);
 assert.equal(r.apiMarketFeeMetadataVerified,false);
 assert.equal(m.stats().feeCalls,0);
 assert.equal(r.liveEligible,false);
});
test("owner kill OFF and non-provisional holds reject before retrieving signer",async()=>{
 for(const row of [{...account,kill_switch:false},
                   {...account,blocked_reason:"unresolved_exchange_order"}]){
  const m=mock(row);
  const r=await inspectOwnerSignedExchangeReleaseProof(owner,m.deps);
  assert.equal(r.ok,false);
  assert.deepEqual(m.stats(),{reads:0,feeCalls:0,signerCalls:0});
 }
});
test("signed exchange 429 fails without a follow-on series probe or retries",async()=>{
 const m=mock();
 const r=await inspectOwnerSignedExchangeReleaseProof(owner,{
  ...m.deps,read:async()=>({ok:false,reason:"kalshi_read_rate_limited"}) as never,
 } as never);
 assert.equal(r.ok,false);
 assert.match(r.reason,/kalshi_read_rate_limited/);
 assert.equal(m.stats().feeCalls,0);
});
test("malformed owner cannot access other account or signer",async()=>{
 assert.equal((await inspectOwnerSignedExchangeReleaseProof("bad-owner",mock().deps)).ok,false);
});
test("owner SQL strictly scoped and no authority writes",()=>{
 assert.match(OWNER_SIGNED_PROOF_ACCOUNT_SQL,/a.owner_user_id=\$1::uuid/);
 assert.match(OWNER_SIGNED_PROOF_ACCOUNT_SQL,/subaccount=1 AND a.exchange_index=2/);
 assert.match(OWNER_SIGNED_PROOF_INTENTS_SQL,/WHERE account_id=\$1/);
 assert.doesNotMatch(OWNER_SIGNED_PROOF_ACCOUNT_SQL+" "+OWNER_SIGNED_PROOF_INTENTS_SQL,/\b(UPDATE|DELETE|INSERT)\b/);
});
