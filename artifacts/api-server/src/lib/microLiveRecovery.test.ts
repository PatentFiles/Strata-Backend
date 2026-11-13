import assert from "node:assert/strict";
import test from "node:test";
import type {
  KalshiAccountSnapshot,
  KalshiSubmissionEvidence,
} from "./kalshiAccountClient";
import { verifyMicroLiveRecoveryEvidence } from "./microLiveRecovery";

const ticker = "KXBTC15M-RECOVERY";
const createdAt = new Date().toISOString();

const reserved = {
  marketTicker: ticker,
  clientOrderId: "bot-client-id",
  side: "UP",
  action: "buy",
  intent: "entry",
  requestedContracts: 2,
  requestedLimitPrice: 0.2,
} as unknown as Parameters<typeof verifyMicroLiveRecoveryEvidence>[2];

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: "exchange-order-id",
    clientOrderId: "bot-client-id",
    ticker,
    side: "yes",
    action: "buy",
    type: "limit",
    status: "resting",
    priceDollars: "0.20",
    initialCount: "2",
    filledCount: "0",
    remainingCount: "2",
    createdAt,
    ...overrides,
  };
}

function evidence(
  candidate: Record<string, unknown> = order(),
  fills: Array<Record<string, unknown>> = [],
): KalshiSubmissionEvidence {
  return {
    orders: [candidate] as KalshiSubmissionEvidence["orders"],
    fills: fills as KalshiSubmissionEvidence["fills"],
    historicalFills: fills as KalshiSubmissionEvidence["fills"],
    historicalFillsAvailable: true,
    truncated: false,
  };
}

function account(
  currentOrder: Record<string, unknown> = {
    id: "exchange-order-id",
    ticker,
    side: "yes",
    action: "buy",
    priceDollars: "0.20",
    remainingCount: "2",
    status: "resting",
    createdAt,
  },
  fills: Array<Record<string, unknown>> = [],
): KalshiAccountSnapshot {
  return {
    balance: { availableCashDollars: "25.00", portfolioValueDollars: "25.00" },
    openOrders: [currentOrder] as KalshiAccountSnapshot["openOrders"],
    positions: [],
    fills: fills as KalshiAccountSnapshot["fills"],
    truncated: { openOrders: false, positions: false, fills: false },
  };
}

const expectedPair = { subaccountNumber: 2, exchangeIndex: 2 as const };

test("uncertain recovery requires explicit shard-2 identity for dedicated orders", () => {
  const validOrder = order({ exchangeIndex: 2 });
  const validAccountOrder = {
    id: "exchange-order-id",
    ticker,
    side: "yes",
    action: "buy",
    priceDollars: "0.20",
    remainingCount: "2",
    status: "resting",
    createdAt,
    exchangeIndex: 2,
  };
  assert.equal(
    verifyMicroLiveRecoveryEvidence(
      evidence(validOrder),
      account(validAccountOrder),
      reserved,
      expectedPair,
    ).exchangeOrderId,
    "exchange-order-id",
  );
  assert.equal(
    verifyMicroLiveRecoveryEvidence(
      evidence(validOrder),
      account(validAccountOrder),
      reserved,
      { subaccountNumber: 37, exchangeIndex: 2 },
    ).exchangeOrderId,
    "exchange-order-id",
    "the dedicated account may use any validated subaccount N",
  );
  assert.equal(
    verifyMicroLiveRecoveryEvidence(
      evidence(order()),
      account(),
      reserved,
      expectedPair,
    ).reason,
    "uncertain_recovery_record_exchange_index_unproven",
  );
  assert.equal(
    verifyMicroLiveRecoveryEvidence(
      evidence(validOrder),
      account(),
      reserved,
      expectedPair,
    ).reason,
    "uncertain_recovery_record_exchange_index_unproven",
  );
});

test("uncertain recovery rejects a missing or wrong-shard fill index", () => {
  const partialOrder = order({
    exchangeIndex: 2,
    filledCount: "1",
    remainingCount: "1",
  });
  const accountOrder = {
    id: "exchange-order-id",
    ticker,
    side: "yes",
    action: "buy",
    priceDollars: "0.20",
    remainingCount: "1",
    status: "resting",
    createdAt,
    exchangeIndex: 2,
  };
  const fill = {
    id: "exchange-fill-id",
    orderId: "exchange-order-id",
    ticker,
    side: "yes",
    action: "buy",
    countFp: "1",
    priceDollars: "0.20",
    createdAt,
    feeCostDollars: "0.001000",
    exchangeIndex: 2,
  };
  const missingIndex = { ...fill };
  delete (missingIndex as { exchangeIndex?: number }).exchangeIndex;
  const wrongIndex = { ...fill, exchangeIndex: 1 };
  for (const badFill of [missingIndex, wrongIndex]) {
    assert.equal(
      verifyMicroLiveRecoveryEvidence(
        evidence(partialOrder, [badFill]),
        account(accountOrder, [fill]),
        reserved,
        expectedPair,
      ).reason,
      "uncertain_recovery_record_exchange_index_unproven",
    );
  }
});

test("legacy primary GET-only recovery does not infer a shard for its historical evidence", () => {
  const result = verifyMicroLiveRecoveryEvidence(
    evidence(order()),
    account(),
    reserved,
  );
  assert.equal(result.exchangeOrderId, "exchange-order-id");
});