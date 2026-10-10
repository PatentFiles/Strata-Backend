import assert from "node:assert/strict";
import test from "node:test";
import type { microLiveOrderTable } from "@workspace/db";
import type { KalshiAccountActivity, KalshiAccountSnapshot } from "./kalshiAccountClient";
import {
  attributePrimaryMicroLiveAccountActivity,
  diagnoseMicroLiveAccountActivity,
  separateMicroLiveAccountActivity,
} from "./microLiveOwnership";

const nowMs = 50_000;
const emptySnapshot: KalshiAccountSnapshot = {
  balance: { availableCashDollars: "0", portfolioValueDollars: null },
  openOrders: [],
  positions: [],
  fills: [],
  truncated: { openOrders: false, positions: false, fills: false },
};

function evidence(overrides: Partial<KalshiAccountActivity> = {}): KalshiAccountActivity {
  const timestamp = new Date(nowMs).toISOString();
  return {
    orders: [],
    fills: [],
    available: true,
    truncated: false,
    keyRestrictionVerified: true,
    selectedSubaccount: 9,
    scanStartedAt: timestamp,
    scanFinishedAt: timestamp,
    exclusiveControlVerified: false,
    ...overrides,
  };
}

const baseInput = (activity: KalshiAccountActivity) => ({
  activity,
  snapshot: emptySnapshot,
  localOrders: [],
  boundaryMs: 10_000,
  configuredSubaccount: 9,
  nowMs,
});

test("account activity diagnostics require complete scoped recent evidence", () => {
  const clean = evidence();
  assert.equal(diagnoseMicroLiveAccountActivity(baseInput(clean)).reason, null);
  assert.equal(
    separateMicroLiveAccountActivity(baseInput(clean)).reason,
    "account_exclusive_control_unproven",
    "clean historical evidence cannot authorize while exclusivity remains false",
  );

  assert.equal(diagnoseMicroLiveAccountActivity(baseInput(
    evidence({ keyRestrictionVerified: false }),
  )).reason, "account_key_restriction_unverified");
  assert.equal(diagnoseMicroLiveAccountActivity(baseInput(
    evidence({ selectedSubaccount: 8 }),
  )).reason, "account_subaccount_mismatch");
  assert.equal(diagnoseMicroLiveAccountActivity(baseInput(
    evidence({ selectedSubaccount: 64 }),
  )).reason, "account_subaccount_unverified");
  assert.equal(diagnoseMicroLiveAccountActivity(baseInput(
    evidence({ scanStartedAt: undefined }),
  )).reason, "account_history_scan_stale_or_incomplete");
  assert.equal(diagnoseMicroLiveAccountActivity(baseInput(
    evidence({ scanStartedAt: new Date(nowMs - 5_001).toISOString() }),
  )).reason, "account_history_scan_stale_or_incomplete");
  assert.equal(diagnoseMicroLiveAccountActivity(baseInput(
    evidence({ scanFinishedAt: new Date(nowMs + 1).toISOString() }),
  )).reason, "account_history_scan_stale_or_incomplete");
  assert.equal(diagnoseMicroLiveAccountActivity(baseInput(
    evidence({ available: false }),
  )).reason, "account_history_incomplete");
  assert.equal(diagnoseMicroLiveAccountActivity({
    ...baseInput(clean),
    snapshot: {
      ...emptySnapshot,
      truncated: { ...emptySnapshot.truncated, positions: true },
    },
  }).reason, "account_snapshot_truncated");
});

test("diagnostics retain foreign order, fill, and fill-total checks", () => {
  const clean = evidence();
  const recentForeignOrder = {
    id: "foreign-order",
    clientOrderId: null,
    ticker: "OTHER-MARKET",
    side: "yes",
    action: "buy",
    type: "limit",
    status: "executed",
    priceDollars: "0.40",
    initialCount: "1",
    filledCount: "0",
    remainingCount: "0",
    createdAt: new Date(20_000).toISOString(),
  };
  assert.equal(diagnoseMicroLiveAccountActivity(baseInput(evidence({
    orders: [recentForeignOrder],
  }))).reason, "account_history_unexplained_order");

  const foreignFill = {
    id: "foreign-fill",
    orderId: "missing-order",
    ticker: "OTHER-MARKET",
    side: "yes",
    action: "buy",
    countFp: "1",
    priceDollars: "0.40",
    createdAt: new Date(5_000).toISOString(),
    feeCostDollars: null,
  };
  assert.equal(diagnoseMicroLiveAccountActivity(baseInput(evidence({
    fills: [foreignFill],
  }))).reason, "account_history_unexplained_fill");

  assert.equal(diagnoseMicroLiveAccountActivity(baseInput({
    ...clean,
    orders: [{
      ...recentForeignOrder,
      createdAt: new Date(5_000).toISOString(),
      filledCount: "1",
    }],
    fills: [],
  })).reason, "account_history_order_fill_count_mismatch");
});

const botOrder = {
  id: "local-order",
  clientOrderId: "bot-client",
  marketTicker: "BOT-MARKET",
  side: "UP",
  action: "buy",
  requestedContracts: 2,
  exchangeOrderId: "bot-exchange-order",
  status: "filled",
  submittedAt: new Date(nowMs - 1_000),
  filledContracts: 2,
  remainingContracts: 0,
  createdAt: new Date(nowMs - 2_000),
} as unknown as typeof microLiveOrderTable.$inferSelect;

const botExchangeOrder = {
  id: "bot-exchange-order",
  clientOrderId: "bot-client",
  ticker: "BOT-MARKET",
  side: "yes",
  action: "buy",
  type: "limit",
  status: "executed",
  priceDollars: "0.4",
  initialCount: "2",
  filledCount: "2",
  remainingCount: "0",
  createdAt: new Date(nowMs - 2_000).toISOString(),
};

const botFill = {
  id: "bot-fill",
  orderId: "bot-exchange-order",
  ticker: "BOT-MARKET",
  side: "yes",
  action: "buy",
  countFp: "2",
  priceDollars: "0.4",
  createdAt: new Date(nowMs - 1_000).toISOString(),
  feeCostDollars: null,
};

function primaryInput(overrides: {
  activity?: Partial<KalshiAccountActivity>;
  snapshot?: Partial<KalshiAccountSnapshot>;
  localOrders?: typeof microLiveOrderTable.$inferSelect[];
} = {}) {
  const snapshot: KalshiAccountSnapshot = {
    ...emptySnapshot,
    positions: [{ ticker: "BOT-MARKET", positionFp: "2", marketExposureDollars: null, realizedPnlDollars: null }],
    fills: [botFill],
    ...overrides.snapshot,
  };
  return {
    activity: evidence({
      selectedSubaccount: 0,
      keyRestrictionVerified: false,
      orders: [botExchangeOrder],
      fills: [botFill],
      ...overrides.activity,
    }),
    snapshot,
    localOrders: overrides.localOrders ?? [botOrder],
    boundaryMs: 10_000,
    configuredSubaccount: 0,
    nowMs,
  };
}

test("primary attribution allows unrelated manual activity while preserving exact bot attribution", () => {
  const manualOrder = {
    id: "manual-order",
    clientOrderId: "manual-client",
    ticker: "OTHER-MARKET",
    side: "no",
    action: "buy",
    type: "limit",
    status: "executed",
    priceDollars: "0.4",
    initialCount: "1",
    filledCount: "1",
    remainingCount: "0",
    createdAt: new Date(nowMs - 1_000).toISOString(),
  };
  const manualFill = {
    ...botFill,
    id: "manual-fill",
    orderId: "manual-order",
    ticker: "OTHER-MARKET",
    side: "no",
    countFp: "1",
  };
  const input = primaryInput({
    activity: {
      orders: [botExchangeOrder, manualOrder],
      fills: [botFill, manualFill],
    },
    snapshot: {
      fills: [botFill, manualFill],
      positions: [
        { ticker: "BOT-MARKET", positionFp: "2", marketExposureDollars: null, realizedPnlDollars: null },
        { ticker: "OTHER-MARKET", positionFp: "-1", marketExposureDollars: null, realizedPnlDollars: null },
      ],
    },
  });
  const result = attributePrimaryMicroLiveAccountActivity(input);
  assert.equal(result.reason, null);
  assert.deepEqual(result.botFills.map((fill) => fill.id), ["bot-fill"]);
  assert.equal(input.activity.exclusiveControlVerified, false);
  assert.equal(input.activity.keyRestrictionVerified, false);
});

test("primary attribution freezes same-market foreign orders, fills, and net-position conflicts", () => {
  const foreignOrder = {
    ...botExchangeOrder,
    id: "manual-same-market",
    clientOrderId: "manual-same-market-client",
    status: "canceled",
    filledCount: "0",
  };
  assert.equal(attributePrimaryMicroLiveAccountActivity(primaryInput({
    activity: { orders: [botExchangeOrder, foreignOrder] },
  })).reason, "primary_account_same_market_order_conflict");

  const foreignFill = {
    ...botFill,
    id: "manual-same-market-fill",
    orderId: "manual-same-market",
  };
  assert.equal(attributePrimaryMicroLiveAccountActivity(primaryInput({
    activity: {
      orders: [botExchangeOrder, { ...foreignOrder, filledCount: "1" }],
      fills: [botFill, foreignFill],
    },
    snapshot: {
      fills: [botFill, foreignFill],
      positions: [{ ticker: "BOT-MARKET", positionFp: "3", marketExposureDollars: null, realizedPnlDollars: null }],
    },
  })).reason, "primary_account_same_market_order_conflict");

  assert.equal(attributePrimaryMicroLiveAccountActivity(primaryInput({
    snapshot: {
      positions: [{ ticker: "BOT-MARKET", positionFp: "1", marketExposureDollars: null, realizedPnlDollars: null }],
    },
  })).reason, "primary_account_net_position_conflict");
});

test("primary attribution rejects incomplete history without requiring exclusive or restricted-key proof", () => {
  const clean = primaryInput();
  assert.equal(clean.activity.exclusiveControlVerified, false);
  assert.equal(clean.activity.keyRestrictionVerified, false);
  assert.equal(attributePrimaryMicroLiveAccountActivity(clean).reason, null);
  assert.equal(attributePrimaryMicroLiveAccountActivity(primaryInput({
    activity: { available: false },
  })).reason, "account_history_incomplete");
});

test("primary attribution exactly sums covered fractional fills on unrelated markets", () => {
  const manualOrder = {
    ...botExchangeOrder, id: "manual-fractional", clientOrderId: null,
    ticker: "OTHER-MARKET", initialCount: "0.30", filledCount: "0.30",
  };
  const manualFills = ["0.10", "0.20"].map((countFp, index) => ({
    ...botFill, id: `manual-fractional-fill-${index}`, orderId: manualOrder.id,
    ticker: manualOrder.ticker, countFp,
  }));
  const input = primaryInput({
    activity: {
      orders: [botExchangeOrder, manualOrder],
      fills: [botFill, ...manualFills],
    },
    snapshot: { fills: [botFill, ...manualFills] },
  });
  const clean = attributePrimaryMicroLiveAccountActivity(input);
  assert.equal(clean.reason, null);
  assert.deepEqual(clean.botFills.map((fill) => fill.id), ["bot-fill"],
    "unrelated fractional fills must never become bot fills");
  for (const filledCount of ["0.31", "0.29", "0", "0.001", "90071992547409.92"]) {
    assert.equal(attributePrimaryMicroLiveAccountActivity({
      ...input, activity: {
        ...input.activity,
        orders: [botExchangeOrder, { ...manualOrder, filledCount }],
      },
    }).reason, "primary_account_order_fill_count_mismatch");
  }
  assert.equal(attributePrimaryMicroLiveAccountActivity({
    ...input, activity: { ...input.activity, fills: [botFill, manualFills[0]!] },
  }).reason, "primary_account_order_fill_count_mismatch",
  "missing one historical fill must not silently pass an order total");
  for (const incomplete of [{ available: false }, { truncated: true }]) {
    assert.equal(attributePrimaryMicroLiveAccountActivity({
      ...input, activity: { ...input.activity, ...incomplete },
    }).reason, "account_history_incomplete");
  }
});

test("primary attribution rejects invalid counts and fractional bot fills without rounding", () => {
  const manualOrder = {
    ...botExchangeOrder, id: "manual-fractional", clientOrderId: null,
    ticker: "OTHER-MARKET", initialCount: "1.00", filledCount: "1.00",
  };
  const manualFill = {
    ...botFill, id: "manual-fractional-fill",
    orderId: manualOrder.id, ticker: manualOrder.ticker,
  };
  const input = primaryInput({
    activity: { orders: [botExchangeOrder, manualOrder], fills: [botFill, manualFill] },
  });
  for (const countFp of ["0", "-0.50", "0.001", "1e0", "90071992547409.92"]) {
    assert.equal(attributePrimaryMicroLiveAccountActivity({
      ...input, activity: {
        ...input.activity,
        fills: [botFill, { ...manualFill, countFp }],
      },
    }).reason, "primary_account_unexplained_fill");
  }
  assert.equal(attributePrimaryMicroLiveAccountActivity(primaryInput({
    activity: {
      orders: [botExchangeOrder],
      fills: [{ ...botFill, countFp: "2.00" }, {
        ...botFill, id: "partial-bot", countFp: "0.50",
      }],
    },
  })).reason, "primary_account_unexplained_fill",
  "whole-contract bot sizing must not be expanded to fractional bot fills");
  assert.equal(attributePrimaryMicroLiveAccountActivity(primaryInput({
    activity: {
      orders: [botExchangeOrder, { ...manualOrder, ticker: "BOT-MARKET" }],
      fills: [botFill, { ...manualFill, ticker: "BOT-MARKET", countFp: "0.50" }],
    },
  })).reason, "primary_account_same_market_order_conflict");
});