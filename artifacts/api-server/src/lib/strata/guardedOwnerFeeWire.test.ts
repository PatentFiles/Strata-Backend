import {describe,it} from "node:test";
import assert from "node:assert/strict";
import type {PoolClient} from "@workspace/db";
import {createGuardedOwnerFeeFetch} from "./guardedOwnerFeeWire";
import {encodeOwnerFeeSource} from "./ownerFeeSourceStage";
import type {verifyOwnerFeeSourceStage} from "./ownerFeeSourceStage";
const owner="11111111-1111-4111-8111-111111111111";
const grant="22222222-2222-4222-8222-222222222222";
const release="33333333-3333-4333-8333-333333333333";
const market="KXBTC15M-26OCT160100-00";
const source=encodeOwnerFeeSource(grant,release)!;
const url="https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders";
function order(reduceOnly=false, ticker=market){
  return {method:"POST",body:JSON.stringify({ticker,subaccount:1,exchange_index:2,
    reduce_only:reduceOnly})};
}
const result={ok:true as const,identity:{
  sourceKind:"operator_attested_not_provider" as const,
  grantId:grant,releaseId:release,
  digest:"c326a69f596a11e8f8be2620402d39a8d4823920c21cc97c93a114d862699601",
  policyVersion:"operator_attested_fee_source_v1" as const,
  sourceUrl:source,
  formulaVersion:"standard-quadratic-0.07-v1" as const,
  marketTicker:market,metadataFingerprint:"a".repeat(64),verifiedAtMs:Date.now(),
}};
function harness(open:boolean,authorized:boolean){
  let posted=0,connected=0,rolledBack=0,committed=0,released=0;
  const transport:typeof fetch=async()=>{posted++;return new Response("ok",{status:200});};
  const client={
    query:async(sql:string)=>{
      if(sql==="COMMIT")committed++;
      if(sql==="ROLLBACK")rolledBack++;
      return {rows:sql.includes("SELECT g.grant_id")&&authorized?[{grant_id:grant}]:[]};
    },
    release:()=>{released++;},
  };
  const wire=createGuardedOwnerFeeFetch(owner,source,transport,{
    verifyStage:(async()=>open?result:{ok:false as const,reason:"revoked_or_expired"}) as typeof verifyOwnerFeeSourceStage,
    connect:async()=>{connected++;return client as unknown as PoolClient;},
  });
  return {wire,stats:()=>({posted,connected,rolledBack,committed,released})};
}
describe("final order source fence",()=>{
  it("revoked grant also prevents reduce-only exit before transport and database access",async()=>{
    const h=harness(false,true);
    await assert.rejects(h.wire(url,order(true)),/source_order_fence_closed/);
    assert.equal(h.stats().posted,0);assert.equal(h.stats().connected,0);
  });
  it("expired authorization also blocks reduce-only protective exit POST",async()=>{
    const h=harness(false,true);
    await assert.rejects(h.wire(url,order(true)),/source_order_fence_closed/);
    assert.equal(h.stats().posted,0);
  });
  it("new risk is blocked even with a valid grant until protective exits are reviewed",async()=>{
    const h=harness(true,true);
    await assert.rejects(h.wire(url,order(false)),/new_entries_paused_pending_protective_exit/);
    await assert.rejects(h.wire(url,{method:"POST",body:JSON.stringify({
      ticker:market,subaccount:1,exchange_index:2,
    })}),/new_entries_paused_pending_protective_exit/);
    await assert.rejects(h.wire(url,{method:"POST",body:JSON.stringify({
      ticker:market,subaccount:1,exchange_index:2,reduce_only:"true",
    })}),/new_entries_paused_pending_protective_exit/);
    assert.deepEqual(h.stats(),{posted:0,connected:0,rolledBack:0,committed:0,released:0});
  });
  it("DELETE cancellation is still forwarded when fee authorization is revoked",async()=>{
    const h=harness(false,false);
    const res=await h.wire(url+"/resting-order-id",{method:"DELETE"});
    assert.equal(res.ok,true);
    assert.equal(h.stats().posted,1);
    assert.equal(h.stats().connected,0);
  });
  it("a missing or revoked ledger lock prevents the last POST",async()=>{
    const h=harness(true,false);
    await assert.rejects(h.wire(url,order(true)),/not_unique/);
    assert.equal(h.stats().posted,0);
    assert.equal(h.stats().committed,0);
    assert.equal(h.stats().rolledBack,1);
    assert.equal(h.stats().released,1);
  });
  it("a fresh matching locked source permits only a reduce-only POST and commits",async()=>{
    const h=harness(true,true);
    const response=await h.wire(url,order(true));
    assert.equal(response.ok,true);
    assert.deepEqual(h.stats(),{posted:1,connected:1,rolledBack:0,committed:1,released:1});
  });
  it("changed endpoint or account never reaches Kalshi",async()=>{
    const h=harness(true,true);
    await assert.rejects(h.wire(url+"/other",order()),/unexpected_production/);
    await assert.rejects(h.wire(url,{method:"POST",body:JSON.stringify({ticker:market,subaccount:0,exchange_index:2})}),/owner_order_scope_invalid/);
    assert.equal(h.stats().posted,0);
  });
  it("restart repeats source decision; it does not cache prior authority",async()=>{
    const before=harness(true,true);
    await before.wire(url,order(true));
    const restarted=harness(false,true);
    await assert.rejects(restarted.wire(url,order(true)),/source_order_fence_closed/);
    assert.equal(restarted.stats().posted,0);
  });
});
