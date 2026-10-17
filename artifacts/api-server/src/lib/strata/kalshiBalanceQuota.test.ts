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

test("all verified keys for one account share a quota; other owners are independent",async()=>{
  const captures:string[]=[];
  const ownerA="11111111-1111-4111-8111-111111111111";
  const ownerB="22222222-2222-4222-8222-222222222222";
  const fake=async (sql:string,params:unknown[])=>{
    if(sql.includes("SELECT DISTINCT owner_user_id"))
      return {rows:[{owner:String(params[0]).startsWith("a")?ownerA:ownerB}]};
    captures.push(String(params[0]));
    return {rows:[{wait_ms:0}]};
  };
  await reserveKalshiBalanceReadSlot("key-a",undefined,fake as never,"a".repeat(64));
  await reserveKalshiBalanceReadSlot("key-b",undefined,fake as never,("a".repeat(63)+"b"));
  await reserveKalshiBalanceReadSlot("key-c",undefined,fake as never,"b".repeat(64));
  assert.equal(captures.length,3);
  assert.equal(captures[0],captures[1]);
  assert.notEqual(captures[0],captures[2]);
});
