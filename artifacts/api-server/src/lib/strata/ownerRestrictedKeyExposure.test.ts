import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { getScopedKalshiJson } from "../kalshiAccountClient";
import {
  inspectSignedRestrictedRecoveryExposure,
  RECOVERY_RESTING_ORDERS_PATH,
  RECOVERY_RESTING_ORDERS_QUERY,
  RECOVERY_UNSETTLED_POSITIONS_PATH,
  RECOVERY_UNSETTLED_POSITIONS_QUERY,
} from "./ownerRestrictedKeyExposure";

const placeholderKey = { keyId: "fake-verifier", privateKey: "not-sent-to-network" };
const clear = { orders: [], cursor: "" };
const flat = { market_positions: [], event_positions: [], cursor: "" };

test("Kalshi recovery URLs use ? before subaccount and correct provider endpoints", () => {
  assert.equal(RECOVERY_RESTING_ORDERS_QUERY, "?subaccount=1&status=resting&limit=200");
  assert.equal(RECOVERY_UNSETTLED_POSITIONS_QUERY, "?subaccount=1&limit=200");
  assert.equal(new URL(RECOVERY_RESTING_ORDERS_PATH + RECOVERY_RESTING_ORDERS_QUERY, "https://external-api.kalshi.com").pathname, RECOVERY_RESTING_ORDERS_PATH);
  assert.equal(new URL(RECOVERY_UNSETTLED_POSITIONS_PATH + RECOVERY_UNSETTLED_POSITIONS_QUERY, "https://external-api.kalshi.com").pathname, RECOVERY_UNSETTLED_POSITIONS_PATH);
});

test("integration with real signed GET transport constructs correct URL and authenticates each read", async () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const calls: string[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("subaccount"), "1");
    assert.equal(parsed.searchParams.get("limit"), "200");
    assert.equal(init?.method, "GET");
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers["KALSHI-ACCESS-KEY"], "test-owner-verifier");
    assert.ok(headers["KALSHI-ACCESS-SIGNATURE"]);
    assert.ok(headers["KALSHI-ACCESS-TIMESTAMP"]);
    if (parsed.pathname === RECOVERY_RESTING_ORDERS_PATH) {
      assert.equal(parsed.searchParams.get("status"), "resting");
      return new Response(JSON.stringify(clear), { status: 200 });
    }
    if (parsed.pathname === RECOVERY_UNSETTLED_POSITIONS_PATH) {
      assert.equal(parsed.searchParams.has("status"), false);
      return new Response(JSON.stringify(flat), { status: 200 });
    }
    return new Response(JSON.stringify({code:"unexpected_path"}), {status:404});
  };
  const owner = { keyId: "test-owner-verifier", privateKey: pem };
  const result = await inspectSignedRestrictedRecoveryExposure(
    (creds, path, query) => getScopedKalshiJson(creds, path, query, fetchMock, "https://external-api.kalshi.com"),
    owner,
  );
  assert.deepEqual(result, {ok:true,reason:"recovery_exchange_exposure_clear"});
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0]!).pathname, RECOVERY_RESTING_ORDERS_PATH);
  assert.equal(new URL(calls[1]!).pathname, RECOVERY_UNSETTLED_POSITIONS_PATH);
});

test("a resting order blocks recovery before the positions read",async()=>{
  let count=0;
  const result = await inspectSignedRestrictedRecoveryExposure(async()=>{
    count++;
    return { orders: [{ order_id: "open" }], cursor: "" };
  },placeholderKey);
  assert.deepEqual(result,{ok:false,reason:"recovery_exchange_exposure_or_pagination_unresolved"});
  assert.equal(count,1);
});

test("unsettled market or event positions block recovery",async()=>{
  for(const nonempty of [
    {market_positions:[{position_fp:"1.00"}],event_positions:[],cursor:""},
    {market_positions:[],event_positions:[{event_ticker:"TEST"}],cursor:""},
  ]){
    let count=0;
    const result=await inspectSignedRestrictedRecoveryExposure(async()=>{
      count++;
      return count===1 ? clear : nonempty;
    },placeholderKey);
    assert.equal(result.ok,false);
    assert.equal(result.reason,"recovery_exchange_exposure_or_pagination_unresolved");
  }
});

test("pagination or malformed inventory is not evidence of zero exposure",async()=>{
  const failureCases=[
    {orders:[],cursor:"next"},
    {orders:[] ,cursor:4},
    {orders:"not an array",cursor:""},
    null,
    {market_positions:[],event_positions:[],cursor:"next"},
    {market_positions:[],cursor:""},
    {market_positions:[],event_positions:[],cursor:8},
  ];
  for(const value of failureCases){
    let count=0;
    const response=await inspectSignedRestrictedRecoveryExposure(async()=>{
      count++;
      return count===1 && !("market_positions" in Object(value)) ? value : count===1 ? clear : value;
    },placeholderKey);
    assert.equal(response.ok,false,JSON.stringify(value));
    assert.equal(response.reason,"recovery_exchange_exposure_or_pagination_unresolved");
  }
});

test("provider failure at either signed endpoint fails closed with a non-secret reason",async()=>{
  const ordersFail=await inspectSignedRestrictedRecoveryExposure(async()=>{throw new Error("HTTP 404 secret");},placeholderKey);
  assert.deepEqual(ordersFail,{ok:false,reason:"recovery_signed_orders_unavailable"});
  const positionsFail=await inspectSignedRestrictedRecoveryExposure(async(_creds,path)=>{
    if(path===RECOVERY_RESTING_ORDERS_PATH)return clear;
    throw new Error("HTTP 429 secret");
  },placeholderKey);
  assert.deepEqual(positionsFail,{ok:false,reason:"recovery_signed_positions_unavailable"});
  assert.equal(JSON.stringify(positionsFail).includes("secret"),false);
});
