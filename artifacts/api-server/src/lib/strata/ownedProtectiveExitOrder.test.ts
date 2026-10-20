import test from "node:test";
import assert from "node:assert/strict";
import { makeOwnedProtectiveExitOrder } from "./ownedProtectiveExitOrder";
import type { MarketEvidence } from "../v13-production/types";

const NOW = 1792432800000;
const ID = "11111111-1111-4111-8111-111111111111";
const MARKET = "KXBTC15M-26OCT191900-00";
const book = (bid: string, availableContracts: string, observedAtMs = NOW) =>
  ({ observedAtMs, bids: [{ priceDollars: bid, availableContracts }] } as MarketEvidence);
const owned = (side: "YES" | "NO", floor = 10_000, quantityHundredths = "1000") =>
  ({ market: MARKET, side, minimumExitMicros: floor, quantityHundredths });

test("owned YES reduces with an exact V2 YES ask at the verified bid", () => {
  const result = makeOwnedProtectiveExitOrder(owned("YES"), book("0.4500", "7.50"), NOW, ID);
  assert.equal(result.side, "ask");
  assert.equal(result.price, "0.4500");
  assert.equal(result.count, "7.50");
  assert.equal(result.client_order_id, `v13p-${ID}`);
  assert.equal(result.reduce_only, true);
  assert.equal(result.post_only, false);
  assert.equal(result.time_in_force, "immediate_or_cancel");
  assert.equal(result.subaccount, 1);
  assert.equal(result.exchange_index, 2);
});
test("owned NO reduces with complement YES bid, never sells or increases NO", () => {
  const result = makeOwnedProtectiveExitOrder(owned("NO"), book("0.6500", "12"), NOW, ID);
  assert.equal(result.side, "bid");
  assert.equal(result.price, "0.3500");
  assert.equal(result.count, "10.00");
});
test("floor is enforced on owner position proceeds for both legs", () => {
  assert.throws(() => makeOwnedProtectiveExitOrder(owned("YES", 10_000), book("0.0099", "1"), NOW, ID),
    /protective_exit_below_owner_floor_or_invalid_price/);
  assert.throws(() => makeOwnedProtectiveExitOrder(owned("NO", 10_000), book("0.0050", "1"), NOW, ID),
    /protective_exit_below_owner_floor_or_invalid_price/);
});
test("never exceed actual owned quantity, book liquidity or hard per-order cap", () => {
  assert.equal(makeOwnedProtectiveExitOrder(owned("YES", 10_000, "123"), book("0.5000", "500"), NOW, ID).count, "1.23");
  assert.equal(makeOwnedProtectiveExitOrder(owned("YES", 10_000, "999999"), book("0.5000", "999999"), NOW, ID).count, "1000.00");
  for (const bad of ["-1", "1.001", "Infinity", "1e9"]) {
    assert.throws(() => makeOwnedProtectiveExitOrder(owned("YES"), book("0.5000", bad), NOW, ID),
      /protective_exit_depth_quantity_invalid/);
  }
});
test("reject stale, missing, unauditable, or zero liquidity inputs before any reservation", () => {
  assert.throws(() => makeOwnedProtectiveExitOrder(owned("YES"), book("0.5000", "1", NOW - 3001), NOW, ID),
    /protective_exit_book_not_fresh/);
  assert.throws(() => makeOwnedProtectiveExitOrder(owned("YES", 10_000, "0"), book("0.5000", "1"), NOW, ID),
    /protective_exit_verified_liquidity_empty/);
  assert.throws(() => makeOwnedProtectiveExitOrder(owned("YES"), book("0.5000", "0"), NOW, ID),
    /protective_exit_verified_liquidity_empty/);
  assert.throws(() => makeOwnedProtectiveExitOrder(owned("YES"), book("1.0010", "1"), NOW, ID),
    /protective_exit_book_price_invalid/);
  assert.throws(() => makeOwnedProtectiveExitOrder(owned("YES"), book("0.5000", "1"), NOW, "fake"),
    /protective_exit_client_id_invalid/);
});
