import test from "node:test";
import assert from "node:assert/strict";
import { personalAccountSnapshot, type OwnedKalshiRead } from "./personalExchangeRead";
import type { Identity, Request } from "../v13-production/types";

/** Provider V2 GET does not need to echo the submitted reduce_only request
 * property. The submitted value is already sealed in the V13 intent and
 * one-use private signed reservation; any explicit contradictory echo fails.
 * This is a real provider-shaped offline fixture, not live exchange evidence. */
const ID: Identity = { subaccount: 1, exchangeIndex: 2, keyFingerprint: "a".repeat(64) };
const NOW = Date.parse("2026-10-19T23:30:00.000Z");
const MARKET = "KXBTC15M-26OCT192330-30";
function inspect(side: "YES" | "NO", echoed: boolean | undefined) {
  const request: Request = {
    market: MARKET, side, action: "SELL", contracts: 2, limitMicros: 550_000,
    timeInForce: "IOC", reduceOnly: true,
    clientOrderId: "v13p-33333333-3333-4333-8333-333333333333",
  };
  const order = {
    order_id: "provider-order-1", client_order_id: request.clientOrderId,
    ticker: MARKET, book_side: side === "YES" ? "ask" : "bid",
    yes_price_dollars: side === "YES" ? "0.5500" : "0.4500",
    initial_count_fp: "2.00", fill_count_fp: "1.00", remaining_count_fp: "0.00",
    status: "canceled", subaccount_number: 1, exchange_index: 2,
    ...(echoed === undefined ? {} : { reduce_only: echoed }),
  };
  const feed: OwnedKalshiRead = {
    ok: true, observedAtMs: NOW, cashMicros: "11500000",
    orders: [order],
    fills: [{
      trade_id: "provider-fill-1", order_id: order.order_id,
      ticker: MARKET, count_fp: "1.00",
      yes_price_dollars: side === "YES" ? "0.5500" : "0.4500",
      no_price_dollars: side === "YES" ? "0.4500" : "0.5500",
      fee_cost: "0.010000",
      created_time: new Date(NOW - 1000).toISOString(),
      subaccount_number: 1, exchange_index: 2,
    }],
    positions: [{
      ticker: MARKET,
      position_fp: side === "YES" ? "1.00" : "-1.00",
      subaccount_number: 1, exchange_index: 2,
    }],
    settlements: [],
  };
  return personalAccountSnapshot(ID,feed,[request]);
}
test("authenticated V2 YES SELL IOC maps partial fill when provider omits reduce_only echo",()=>{
  const observed=inspect("YES",undefined);
  assert.equal("orders" in observed,true);
  if("orders" in observed) {
    assert.equal(observed.orders[0]?.terminal,true);
    assert.equal(observed.orders[0]?.filledHundredths,"100");
    assert.equal(observed.fills[0]?.action,"SELL");
    assert.equal(observed.fills[0]?.priceMicros,550000);
  }
});
test("authenticated V2 NO SELL maps complementary YES price on partial fill",()=>{
  const observed=inspect("NO",undefined);
  assert.equal("orders" in observed,true);
  if("orders" in observed) {
    assert.equal(observed.orders[0]?.request.side,"NO");
    assert.equal(observed.fills[0]?.priceMicros,550000);
  }
});
test("explicit provider reduce_only=false contradicts submitted sealed intent",()=>{
  for(const side of ["YES","NO"] as const){
    const observed=inspect(side,false);
    assert.equal("ok" in observed && !observed.ok,true);
    if("reason" in observed) assert.equal(observed.reason,"personal_exchange_history_unreconciled");
  }
});
test("explicit provider reduce_only=true stays accepted",()=>{
  for(const side of ["YES","NO"] as const){
    assert.equal("orders" in inspect(side,true),true);
  }
});
