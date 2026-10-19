import assert from "node:assert/strict";
import test from "node:test";
import {inspectOwnedEmergencyExitRead} from "./ownerFeeEmergencyExitRead";
import type {EmergencyExitOrder} from "./ownerFeeEmergencyExit";
import type {readOwnedKalshiFeeds} from "./personalExchangeRead";
import type {readExactEmergencyFeeEvidence} from "./ownerFeeEmergencyExitMarket";
import type {dedicatedSignerFingerprint} from "./commissioning";
const OWNER="11111111-1111-4111-8111-111111111111";
const ACCOUNT="owner-execution-2";
const MARKET="KXBTC15M-26OCT161045-45";
const NOW=Date.parse("2026-10-16T19:45:00Z");
const order:EmergencyExitOrder={
  ticker:MARKET,side:"ask",count:"1.00",price:"0.5600",
  client_order_id:"v13p-33333333-3333-4333-8333-333333333333",
  reduce_only:true,time_in_force:"immediate_or_cancel",
  self_trade_prevention_type:"taker_at_cross",
  post_only:false,subaccount:1,exchange_index:2,
};
function harness(opt:{owner?:string;kill?:boolean;globalKill?:boolean;
  positions?:unknown[];orders?:unknown[];pending?:number|null;badFee?:boolean;
  incomplete?:boolean;floor?:number|null}={}){
  let dbReads=0,feedReads=0,feeReads=0;
  const db={query:async(sql:string)=>{
    dbReads++;
    if(sql.includes("v13_production_account")){
      assert.match(sql,/id=\$1::text/);
      return {rows:[{
      owner_user_id:opt.owner??OWNER,subaccount:1,exchange_index:2,
      key_fingerprint:"validated_fingerprint",execution_enabled:true,
      kill_switch:opt.kill??false,
      minimum_exit_micros:opt.floor===undefined?10000:opt.floor,
    }]};
    }
    if(sql.includes("live_execution_config"))return {rows:[{
      manual_kill_switch:opt.globalKill??false,live_execution_enabled:true,
    }]};
    if(sql.includes("v13_production_intent")){
      assert.match(sql,/account_id=\$1::text/);
      return {rows:[{n:opt.pending===undefined?0:opt.pending}]};
    }
    throw Error("unexpected_database_read");
  }};
  const readFeeds=(async()=>{feedReads++;return opt.incomplete?
    {ok:false as const,reason:"account_target_pair_mismatch"}:
    {ok:true as const,observedAtMs:NOW-100,cashMicros:"0",
      positions:opt.positions??[{ticker:MARKET,position_fp:"1.00",exchange_index:2}],
      orders:opt.orders??[],fills:[],settlements:[]};}) as typeof readOwnedKalshiFeeds;
  const readFees=(async(ticker:string)=>{feeReads++;return opt.badFee?
    {ok:false as const,reason:"fee_unavailable"}:
    {ok:true as const,marketTicker:ticker,fingerprint:"b".repeat(64),
     observedAtMs:NOW-100,marketOpen:true as const};}) as typeof readExactEmergencyFeeEvidence;
  const signerFingerprint=(()=> "validated_fingerprint") as typeof dedicatedSignerFingerprint;
  const run=()=>inspectOwnedEmergencyExitRead(OWNER,ACCOUNT,
    {keyId:"mock-key",privateKey:"not_used"},order,
    {db,readFeeds,readFees,signerFingerprint,now:()=>NOW});
  return {run,stats:()=>({dbReads,feedReads,feeReads})};
}
test("verified scoped reads produce only non-authoritative candidate",async()=>{
  const h=harness(),r=await h.run();
  assert.equal(r.diagnosticEligible,true);
  assert.equal(r.tradingAuthorized,false);
  assert.equal(r.ok,false);
  assert.equal(r.reason,"emergency_exit_candidate_verified_requires_fenced_dispatch");
  assert.deepEqual(h.stats(),{dbReads:3,feedReads:1,feeReads:1});
});
test("foreign account or kill switches deny before Kalshi reads",async()=>{
  for(const opt of [
    {owner:"99999999-9999-4999-8999-999999999999"},
    {kill:true},{globalKill:true},
  ]){
    const h=harness(opt),r=await h.run();
    assert.equal(r.diagnosticEligible,false);
    assert.equal(h.stats().feedReads,0);
    assert.equal(h.stats().feeReads,0);
  }
});
test("missing/duplicate/incomplete positions fail",async()=>{
  for(const opt of [
    {positions:[]},
    {positions:[{ticker:MARKET,position_fp:"1.00"},{ticker:MARKET,position_fp:"1.00"}]},
    {positions:[{ticker:MARKET,position_fp:"bad"}]},
    {incomplete:true},
  ])assert.equal((await harness(opt).run()).diagnosticEligible,false);
});
test("resting or unknown orders, unresolved intent, failed fee probe all fail",async()=>{
  for(const opt of [
    {orders:[{status:"resting"}]},{orders:[{status:"mystery"}]},
    {pending:1},{pending:null},{badFee:true},
  ]){
    const r=await harness(opt).run();
    assert.equal(r.diagnosticEligible,false);
    assert.equal(r.tradingAuthorized,false);
  }
});

test("stored account exit floor is mandatory; absent, invalid and excessive floor deny",async()=>{
 for(const floor of [null,0,-1,1000000,1500000,1.5]){
  const h=harness({floor});
  const outcome=await h.run();
  assert.equal(outcome.diagnosticEligible,false);
  assert.equal(outcome.reason,"emergency_exit_approved_floor_unverified");
  assert.equal(outcome.tradingAuthorized,false);
 }
});
