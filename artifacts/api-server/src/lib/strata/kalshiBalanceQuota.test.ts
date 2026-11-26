import assert from "node:assert/strict";
import test from "node:test";
import { KalshiApiError } from "../kalshiAccountClient";
import { reserveKalshiBalanceReadSlot, safeBalanceFailureReason } from "./kalshiBalanceQuota";

test("balance calls from separate keys cannot avoid the shared request bucket",async()=>{
  const digests:string[]=[];
  const fake=async (_sql:string,params:unknown[])=>{
    digests.push(String(params[0]));
    return {rows:[{wait_ms:0}]};
  };
  await reserveKalshiBalanceReadSlot("different-key-A",undefined,fake as never);
  await reserveKalshiBalanceReadSlot("different-key-B",undefined,fake as never);
  assert.equal(digests.length,2);
  assert.equal(digests[0],digests[1]);
  assert.match(digests[0]!,/^[0-9a-f]{64}$/);
});

test("HTTP 429 and 403 remain distinguishable from malformed balance evidence",()=>{
  assert.equal(safeBalanceFailureReason(new KalshiApiError("HTTP_ERROR",429)),"shard_cash_http_429");
  assert.equal(safeBalanceFailureReason(new KalshiApiError("HTTP_ERROR",403)),"shard_cash_http_403");
  assert.equal(safeBalanceFailureReason(new Error("other")),"shard_cash_read_unavailable");
});

test("full or broken quota denies further calls without sending exchange request",async()=>{
  await assert.rejects(reserveKalshiBalanceReadSlot("key",undefined,
    (async()=>({rows:[{wait_ms:20_000}]})) as never),/kalshi_balance_quota_busy/);
  await assert.rejects(reserveKalshiBalanceReadSlot("key",undefined,
    (async()=>{throw new Error("database unavailable");}) as never),/database unavailable/);
});

test("identity-discovery path uses one bounded fused statement; explicit and missing fingerprints retain one original statement",async()=>{
 for(const [owner,fingerprint,fused] of [[undefined,"a".repeat(64),true],["11111111-1111-4111-8111-111111111111","a".repeat(64),false],[undefined,null,false],[undefined,"malformed",false]] as const){
  let calls=0;
  await reserveKalshiBalanceReadSlot("key",owner,(async(sql:string,args:unknown[])=>{
   calls++;assert.equal(sql.includes("WITH identities AS MATERIALIZED"),fused);
   if(fused){assert.deepEqual(args,[fingerprint]);assert.match(sql,/SELECT DISTINCT owner_user_id::text AS owner/);assert.match(sql,/LIMIT 2/);assert.match(sql,/member:unmapped-conservative/);}
   return {rows:[{wait_ms:0}]};
  }) as never,fingerprint);
  assert.equal(calls,1);
 }
});
