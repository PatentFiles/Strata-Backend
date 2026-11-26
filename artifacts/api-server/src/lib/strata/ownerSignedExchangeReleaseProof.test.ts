import test from "node:test";
import assert from "node:assert/strict";
import {inspectOwnerSignedExchangeReleaseProof,OWNER_SIGNED_PROOF_ACCOUNT_SQL,OWNER_SIGNED_PROOF_INTENTS_SQL} from "./ownerSignedExchangeReleaseProof";
const owner="11111111-1111-4111-8111-111111111111";
const at=Date.parse("2026-10-25T12:00:00Z");
const account={
 id:"owner-execution-1",owner_id:owner,kalshi_connection_id:"owner-credential",
 key_fingerprint:"issuer-signature-fingerprint",commissioned:true,
 diagnostic_held:true,hold_revision:{account:"1",lease:null,credential:"2"},kill_switch:true,blocked_reason:"awaiting_account_commissioning",
 cash_precision_verified:true,cash_micros:"25000000",reserved_micros:"0",
 policy_id:"approved-v4-policy",policy_state:"APPROVED",
 fee_policy_version:"strata_owner_provider_dynamic_fee_v4",
};
function mock(row:Record<string,unknown>=account,readCash="25000000",coverage:true|false|"missing"=true){
 const seen:string[]=[];
 let reads=0,feeCalls=0,signerCalls=0;
 const deps={
  db:{async query(sql:string,params?:unknown[]){
   assert.ok(!/\b(INSERT|UPDATE|DELETE|CALL|TRUNCATE)\b/i.test(sql));
   seen.push(sql);
   if(sql.includes("v13_production_account")){
    assert.deepEqual(params,[owner]);return {rows:[row]};
   }
   if(sql.includes("v13_production_intent")){assert.deepEqual(params,[account.id]);return {rows:[]};}
   throw Error("unexpected SQL");
  }},
  now:()=>at,
  material:async()=>{signerCalls++;return {keyId:"mock",privateKey:"never-used"};},
  read:async()=>{reads++;return {ok:true,observedAtMs:at,cashMicros:readCash,
   ...(coverage==="missing"?{}:{historicalCoverageComplete:coverage}),
   orders:[],fills:[],positions:[],settlements:[]};},
  feeProbe:async()=>{feeCalls++;return {ok:true};},
  v4:async()=>({ok:true,checks:{protectiveExitRelease:false,ownerShaApproval:false}}),
 } as never;
 return {deps,seen,stats:()=>({reads,feeCalls,signerCalls})};
}
test("authenticated owner gets real empty-history read with separate non-authorizing flags",async()=>{
 const m=mock();
 const r=await inspectOwnerSignedExchangeReleaseProof(owner,m.deps);
 assert.equal(r.ok,true,JSON.stringify(r));
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
 assert.equal(r.ok,true,JSON.stringify(r));
 if(!r.ok)return;
 assert.equal(r.exchangeCashMatchesLedger,false);
 assert.equal(r.apiMarketFeeMetadataVerified,false);
 assert.equal(m.stats().feeCalls,0);
 assert.equal(r.liveEligible,false);
});
test("owner kill OFF and non-provisional holds reject before retrieving signer",async()=>{
 for(const row of [{...account,kill_switch:false,diagnostic_held:false},
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
  ...(m.deps as object),read:async()=>({ok:false,reason:"kalshi_read_rate_limited"}) as never,
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

test("signed release proof compares exact subcent cash without inventing authority",async()=>{
 const m=mock({...account,cash_micros:"24482500"},"24482500");
 const r=await inspectOwnerSignedExchangeReleaseProof(owner,m.deps);
 assert.equal(r.ok,true);if(!r.ok)return;
 assert.equal(r.exchangeCashMatchesLedger,true);
 assert.equal(r.tradingAuthorized,false);assert.equal(r.liveEligible,false);
 const mismatch=await inspectOwnerSignedExchangeReleaseProof(owner,mock({...account,cash_micros:"24482500"},"24482501").deps);
 assert.equal(mismatch.ok,true);if(mismatch.ok)assert.equal(mismatch.exchangeCashMatchesLedger,false);
});

test('stopped commissioned account qualifies without changing saved execution or kill',async()=>{
 const m=mock({...account,kill_switch:false,diagnostic_held:true});
 const r=await inspectOwnerSignedExchangeReleaseProof(owner,m.deps);assert.equal(r.ok,true);
 assert.equal(r.tradingAuthorized,false);assert.equal(r.recordPersisted,false);
});
test('final guard failure after signed read reports attempted but never flat',async()=>{
 const m=mock();let accountReads=0;
 const original=(m.deps as {db:{query:(s:string,p?:unknown[])=>Promise<{rows:Record<string,unknown>[]}>}}).db;
 const r=await inspectOwnerSignedExchangeReleaseProof(owner,{...(m.deps as object),db:{query:async(s:string,p?:unknown[])=>{
  if(s===OWNER_SIGNED_PROOF_ACCOUNT_SQL&&++accountReads===2)throw Error('secret database details');return original.query(s,p);
 }}} as never);
 assert.equal(r.ok,false);assert.equal(r.reason,'signed_diagnostic_final_hold_unavailable');assert.equal(r.signedExchangeReadAttempted,true);assert.equal(r.authenticatedExchangeFlat,false);assert.doesNotMatch(JSON.stringify(r),/secret database/);
});

for(const coverage of [false,"missing"] as const){
 test(`signed exchange diagnostic refuses ${coverage} history without authority or persistence`,async()=>{
  const m=mock(account,"25000000",coverage),r=await inspectOwnerSignedExchangeReleaseProof(owner,m.deps);
  assert.equal(r.ok,false);assert.equal(r.reason,"personal_exchange_history_unreconciled");
  assert.equal(r.signedExchangeReadAttempted,true);assert.equal(r.authenticatedExchangeFlat,false);
  assert.equal(r.exchangeCashMatchesLedger,false);assert.equal(r.apiMarketFeeMetadataVerified,false);
  assert.equal(r.completeIssuerMonetaryAuthorityVerified,false);
  assert.equal(r.protectiveExitQualified,false);assert.equal(r.ownerShaReleasePresent,false);
  assert.equal(r.liveEligible,false);assert.equal(r.recordPersisted,false);
  assert.equal(r.tradingAuthorized,false);assert.equal(r.ordersSubmitted,false);
  assert.deepEqual(m.stats(),{reads:1,feeCalls:0,signerCalls:1});
  assert.equal(m.seen.some(sql=>/\b(INSERT|UPDATE|DELETE|CALL|TRUNCATE)\b/i.test(sql)),false);
 });
}

test("internal financial check can inspect an approved stopped uncommissioned account; default diagnostic cannot",async()=>{
 const row={...account,commissioned:false,execution_enabled:false,kill_switch:true};
 const f=mock(row);
 assert.equal((await inspectOwnerSignedExchangeReleaseProof(owner,f.deps)).ok,false);
 assert.equal(f.stats().reads,0);
 const result=await inspectOwnerSignedExchangeReleaseProof(owner,{...(f.deps as object),allowStoppedUncommissioned:true} as never);
 assert.equal(result.ok,true);
 assert.equal(result.tradingAuthorized,false);
 for(const bad of [{...row,kill_switch:false},{...row,execution_enabled:true},{...row,policy_state:"DRAFT"}]){
  const refused=mock(bad);
  assert.equal((await inspectOwnerSignedExchangeReleaseProof(owner,{...(refused.deps as object),allowStoppedUncommissioned:true} as never)).ok,false);
  assert.equal(refused.stats().reads,0);
 }
});

import {readOwnerSignedProofAccount} from './ownerSignedExchangeReleaseProof';
import {economicSettlementFixture} from './ownerEconomicSettlementFixture';
import {proveEconomicSettlement,economicSettlementPlan} from './ownerEconomicSettlementProof';
import {digest} from '../v13-production/types';

test('signed cash scope accepts only the exact receipt and rechecks stopped predicates',async()=>{
 const f=economicSettlementFixture(),p=economicSettlementPlan(proveEconomicSettlement(f));
 const a=f.account;let additional=false,changed=false,secondQueries=0;
 const db={async query(sql:string,args?:unknown[]){
  if(sql.includes('SELECT d.*, s.payload'))return {rows:[{payload:p,payload_digest:digest(p),
   exit_intent_id:p.exitId,entry_intent_id:p.parentId,reservation_id:p.reservationId,market:p.settlement.market,
   client_order_id:f.history.requests[1]!.clientOrderId,settlement_event_id:p.eventId,
   settlement_digest:digest(p.settlement),occurred_at:new Date(p.settlement.occurredAtMs)}]};
  if(sql.includes(' AS positions,')&&sql.includes(' AS exits'))
   return {rows:[{positions:false,intents:additional,exits:false}]};
  if(args?.length===3){
   secondQueries++;
   assert.deepEqual(args,[a.owner_user_id,p.exitId,p.reservationId]);
   assert.match(sql,/i\.id<>\$2/);assert.match(sql,/r\.reservation_id<>\$3::uuid/);
   assert.match(sql,/w\.arm_requested=false/);assert.match(sql,/a\.reserved_micros=0/);
   return {rows:[{id:a.id,commissioned:true,diagnostic_held:true,hold_revision:{revision:changed?'b':'a'}}]};
  }
  return {rows:[{id:a.id,commissioned:true,diagnostic_held:false,hold_revision:{revision:'a'}}]};
 }};
 const lastSha=process.env.RAILWAY_GIT_COMMIT_SHA,lastFlag=process.env.STRATA_SETTLED_EXIT_RESERVE_READINESS_SHA;
 try{
  process.env.RAILWAY_GIT_COMMIT_SHA='a'.repeat(40);process.env.STRATA_SETTLED_EXIT_RESERVE_READINESS_SHA='a'.repeat(40);
  assert.ok((await readOwnerSignedProofAccount(db,a.owner_user_id)).rows[0]?.settled_reserve_receipt_digest);
  changed=true;
  assert.equal((await readOwnerSignedProofAccount(db,a.owner_user_id)).rows[0]?.diagnostic_held,false);
  additional=true;
  assert.equal((await readOwnerSignedProofAccount(db,a.owner_user_id)).rows[0]?.diagnostic_held,false);
  assert.equal(secondQueries,2);
 }finally{
  if(lastSha===undefined)delete process.env.RAILWAY_GIT_COMMIT_SHA;else process.env.RAILWAY_GIT_COMMIT_SHA=lastSha;
  if(lastFlag===undefined)delete process.env.STRATA_SETTLED_EXIT_RESERVE_READINESS_SHA;else process.env.STRATA_SETTLED_EXIT_RESERVE_READINESS_SHA=lastFlag;
 }
});
