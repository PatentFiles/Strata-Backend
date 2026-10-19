import test from "node:test";
import assert from "node:assert/strict";
import { createGuardedMonetaryFeeFetch, FINAL_MONETARY_ACCOUNT_FENCE_SQL } from "./guardedMonetaryFeeWire";

const owner="11111111-1111-4111-8111-111111111111";
const account="owner-account-1";
const hash="a".repeat(64);
const signer="b".repeat(64);
const digest="c".repeat(64);
const ticker="KXBTC15M-26OCT191145-45";
const url="https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders";
const body=JSON.stringify({
 ticker,subaccount:1,exchange_index:2,reduce_only:true,
 time_in_force:"immediate_or_cancel",self_trade_prevention_type:"taker_at_cross",
 post_only:false,side:"ask",count:"1.00",price:"0.0100",
 client_order_id:"v13p-11111111-1111-4111-8111-111111111111",
});
const args=()=>[owner,account,hash,signer,3,"worker-1",digest] as const;
function mocks(rows:Record<string,unknown>[],sourceOk:boolean){
 const queries:string[]=[];
 let sent=0,released=false;
 const connect=async()=>({
  query:async(sql:string)=>{
   queries.push(sql);
   return {rows:sql===FINAL_MONETARY_ACCOUNT_FENCE_SQL?rows:[]};
  },
  release:()=>{released=true;},
 });
 const verify=(async(stage:string,market?:string)=>{
  assert.equal(stage,"ORDER_ENTRY");assert.equal(market,ticker);
  return {
   ok:sourceOk,reason:sourceOk?"provider_monetary_fee_schedule_and_market_verified":"official_fee_schedule_http_429",
   stage:"ORDER_ENTRY" as const,marketTicker:ticker,sourceDigest:digest,
   monetaryFeeAuthorized:sourceOk,policyApproved:false as const,tradingAuthorized:false as const,
  };
 }) as never;
 const transport=(async()=>{sent++;return new Response(null,{status:200});}) as typeof fetch;
 const [ownerId,accountId,policyHash,fingerprint,token,holder,feeDigest]=args();
 const guarded=createGuardedMonetaryFeeFetch(ownerId,accountId,transport,policyHash,fingerprint,token,holder,feeDigest,
  {connect,verify});
 return {guarded,queries,get sent(){return sent;},get released(){return released;}};
}
test("SQL binds owner, account, approved policy, credential, lease, live kills and exact fee digest",()=>{
 for(const clause of ["a.owner_user_id=$1::uuid","a.fee_artifact_digest=$8",
  "p.policy_hash=$4","p.state='APPROVED'","live.manual_kill_switch=false",
  "lease.fencing_token=$6::bigint","c.revoked_at IS NULL","FOR SHARE OF a,p,live,c,lease"])
  assert.ok(FINAL_MONETARY_ACCOUNT_FENCE_SQL.includes(clause),clause);
});
test("unapproved final account stops before source verification and transport",async()=>{
 const x=mocks([],true);
 await assert.rejects(x.guarded(url,{method:"POST",body}),/monetary_fee_final_account_or_kill_closed/);
 assert.equal(x.sent,0);assert.equal(x.released,true);
 assert.ok(x.queries.includes("ROLLBACK"));
});
test("provider fee unavailable rolls back without transmitting",async()=>{
 const x=mocks([{id:account}],false);
 await assert.rejects(x.guarded(url,{method:"POST",body}),/monetary_fee_final_order_source_unverified/);
 assert.equal(x.sent,0);assert.equal(x.released,true);
 assert.ok(x.queries.includes("ROLLBACK"));
});
test("malformed and non-reduce-only orders stop before DB and transport",async()=>{
 for(const overrides of [{reduce_only:false},{exchange_index:1},{post_only:true},{price:"0"},{ticker:"UNRELATED"}]){
  const x=mocks([{id:account}],true);
  await assert.rejects(x.guarded(url,{method:"POST",body:JSON.stringify({...JSON.parse(body),...overrides})}));
  assert.equal(x.sent,0);
  assert.equal(x.queries.length,0);
 }
});
test("only fully qualified, reducer-only official order can commit once",async()=>{
 const x=mocks([{id:account}],true);
 const response=await x.guarded(url,{method:"POST",body});
 assert.equal(response.status,200);
 assert.equal(x.sent,1);assert.equal(x.released,true);
 assert.ok(x.queries.includes("COMMIT"));
 assert.ok(!x.queries.includes("ROLLBACK"));
});
