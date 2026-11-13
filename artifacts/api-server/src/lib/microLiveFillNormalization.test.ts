import assert from "node:assert/strict";
import test from "node:test";
import {
  compatibleOptionalDirection, compatibleOptionalPrice, microLiveOrderLegFillPrice,
} from "./microLiveFillNormalization";
import { dollarsToMicros } from "./microLiveMoney";

// Sanitized from an authenticated account-market GET: the legacy fill side
// differs from the linked NO-sell order, but their canonical directions agree.
const noSellOrder = {
  id: "O2", ticker: "KXBTC15M-SANITIZED", side: "no", action: "sell",
  outcomeSide: "yes", bookSide: "bid",
  // Market-order quote only; this is not the execution price.
  priceDollars: "0.0010",
  initialCount: "32.76", filledCount: "32.76", remainingCount: "0.00",
};
const yesSellFill = {
  orderId: "O2", ticker: noSellOrder.ticker, side: "yes", action: "sell",
  outcomeSide: "yes", bookSide: "bid", priceDollars: "0.1300",
  yesPriceDollars: "0.1300", noPriceDollars: "0.8700",
  countFp: "32.76", feeCostDollars: "0.259400",
};

test("linked canonical YES-sell fill prices a NO exit in NO dollars", () => {
  const price = microLiveOrderLegFillPrice(yesSellFill, noSellOrder);
  assert.equal(yesSellFill.orderId, noSellOrder.id);
  assert.equal(yesSellFill.ticker, noSellOrder.ticker);
  assert.equal(yesSellFill.action, noSellOrder.action);
  assert.equal(yesSellFill.outcomeSide, noSellOrder.outcomeSide);
  assert.equal(yesSellFill.bookSide, noSellOrder.bookSide);
  assert.equal(yesSellFill.side, "yes");
  assert.equal(noSellOrder.side, "no");
  assert.equal(yesSellFill.countFp, "32.76");
  assert.equal(noSellOrder.initialCount, "32.76");
  assert.equal(yesSellFill.yesPriceDollars, "0.1300");
  assert.equal(yesSellFill.noPriceDollars, "0.8700");
  assert.equal(price, "0.8700");
  assert.equal(noSellOrder.filledCount, yesSellFill.countFp);
  // Quantities here have two decimal contract places; strategy orders require
  // whole contracts, but the account record can establish the cash arithmetic.
  const quantityHundredths = 3276n;
  assert.ok(quantityHundredths > 0n);
  assert.equal(Number(noSellOrder.initialCount), Number(yesSellFill.countFp));
  assert.equal(Number(noSellOrder.remainingCount), 0);
  assert.equal(dollarsToMicros(yesSellFill.feeCostDollars), 259_400);
  const grossExitMicros = quantityHundredths * BigInt(dollarsToMicros(price)!) / 100n;
  const netExitMicros = grossExitMicros -
    BigInt(dollarsToMicros(yesSellFill.feeCostDollars)!);
  const grossBuyMicros = quantityHundredths * 750_000n / 100n;
  const netPnlMicros = netExitMicros - grossBuyMicros - 430_000n;
  assert.equal(grossExitMicros, 28_501_200n);
  assert.equal(netExitMicros, 28_241_800n);
  assert.equal(netPnlMicros, 3_241_800n);
  assert.equal(Number(noSellOrder.initialCount) - Number(yesSellFill.countFp), 0,
    "the linked NO exit leaves zero NO contracts");
  // The same account subsequently bought 105.07 YES. Its settlement shows
  // 137.83 gross YES and 32.76 gross NO, or 105.07 net YES exposure.
  assert.equal(13_783 - 3_276, 10_507);
});

test("NO-sell alternate representation requires exact linkage, direction and price evidence", () => {
  const badPairs = [
    [{ ...yesSellFill, orderId: "other" }, noSellOrder],
    [{ ...yesSellFill, ticker: "another-market" }, noSellOrder],
    [{ ...yesSellFill, action: "buy" }, noSellOrder],
    [{ ...yesSellFill, side: "no", outcomeSide: "no" }, noSellOrder],
    [{ ...yesSellFill, outcomeSide: "no" }, noSellOrder],
    [{ ...yesSellFill, bookSide: "ask" }, noSellOrder],
    [{ ...yesSellFill, outcomeSide: undefined }, noSellOrder],
    [{ ...yesSellFill, yesPriceDollars: "0.1400" }, noSellOrder],
    [{ ...yesSellFill, noPriceDollars: "0.8600" }, noSellOrder],
    [{ ...yesSellFill, noPriceDollars: null }, noSellOrder],
    [{ ...yesSellFill, priceDollars: "0.8700" }, noSellOrder],
    [yesSellFill, { ...noSellOrder, outcomeSide: "no" }],
    [yesSellFill, { ...noSellOrder, bookSide: null }],
    [yesSellFill, { ...noSellOrder, side: "yes" }],
    [yesSellFill, { ...noSellOrder, action: "buy" }],
  ] as const;
  for (const [fill, order] of badPairs) {
    assert.equal(microLiveOrderLegFillPrice(fill, order), null);
  }
  assert.equal(microLiveOrderLegFillPrice({
    ...yesSellFill, side: "no", priceDollars: "0.8700",
  }, noSellOrder), "0.8700");
  assert.equal(microLiveOrderLegFillPrice({
    ...yesSellFill, side: "no", priceDollars: "0.8500",
    noPriceDollars: "0.8500",
  }, noSellOrder), null, "same-side fills must not bypass complement validation");
  assert.equal(microLiveOrderLegFillPrice({
    ...yesSellFill, side: "no", priceDollars: "0.8500",
    noPriceDollars: null,
  }, noSellOrder), null, "generic leg price must agree with the lone opposite-side quote");
  assert.equal(compatibleOptionalPrice("0.13", "0.1300"), true);
  assert.equal(compatibleOptionalPrice(null, "0.1300"), true);
  assert.equal(compatibleOptionalPrice("0.13", "0.14"), false);
  assert.equal(compatibleOptionalDirection(
    { outcomeSide: "yes" }, { bookSide: "ask" },
  ), false, "partial canonical fields may not combine into a contradiction");
});