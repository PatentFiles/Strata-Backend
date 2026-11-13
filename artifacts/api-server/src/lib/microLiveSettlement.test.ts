import assert from "node:assert/strict";
import test from "node:test";
import type {
  KalshiAccountActivity, KalshiAccountSnapshot, KalshiDedicatedPairEvidence,
  KalshiSubmissionEvidence,
} from "./kalshiAccountClient";
import {
  verifyDedicatedSettlementPairActivity,
  verifyPrimarySettlementMarketActivity,
} from "./microLiveSettlement";
import { proveSettlementMarketOwnership } from "./microLiveSettlementOwnership";

const ticker = "KXBTC15M-PRIMARY-SETTLEMENT";
const observedAt = new Date().toISOString();

const order: KalshiSubmissionEvidence["orders"][number] = {
  id: "bot-order",
  clientOrderId: "bot-client-order",
  ticker,
  side: "yes",
  action: "buy",
  type: "limit",
  status: "executed",
  priceDollars: "0.20",
  initialCount: "2",
  filledCount: "2",
  remainingCount: "0",
};

const fill: KalshiSubmissionEvidence["fills"][number] = {
  id: "bot-fill",
  orderId: order.id,
  ticker,
  side: "yes",
  action: "buy",
  countFp: "2",
  priceDollars: "0.20",
  createdAt: observedAt,
  feeCostDollars: "0.001000",
};

function history(
  overrides: Partial<KalshiSubmissionEvidence> = {},
): KalshiSubmissionEvidence {
  return {
    orders: [order],
    fills: [fill],
    historicalFills: [fill],
    historicalFillsAvailable: true,
    truncated: false,
    ...overrides,
  };
}

function activity(
  overrides: Partial<KalshiAccountActivity> = {},
): KalshiAccountActivity {
  return {
    orders: [{ ...order, createdAt: observedAt }],
    fills: [fill],
    available: true,
    truncated: false,
    keyRestrictionVerified: false,
    tradePermissionVerified: false,
    selectedSubaccount: 0,
    scanStartedAt: observedAt,
    scanFinishedAt: observedAt,
    exclusiveControlVerified: false,
    ...overrides,
  };
}

test("primary settlement requires complete, explicitly scoped account history", () => {
  assert.equal(verifyPrimarySettlementMarketActivity(activity(), history(), ticker), null);
  assert.equal(
    verifyPrimarySettlementMarketActivity(
      activity({ selectedSubaccount: 1 }), history(), ticker,
    ),
    "micro_live_primary_nonexclusive_accounting_unresolved:account_history_incomplete_or_wrong_subaccount",
  );
  assert.equal(
    verifyPrimarySettlementMarketActivity(
      activity({ available: false }), history(), ticker,
    ),
    "micro_live_primary_nonexclusive_accounting_unresolved:account_history_incomplete_or_wrong_subaccount",
  );
  assert.equal(
    verifyPrimarySettlementMarketActivity(
      activity({ truncated: true }), history(), ticker,
    ),
    "micro_live_primary_nonexclusive_accounting_unresolved:account_history_incomplete_or_wrong_subaccount",
  );
});

function dedicatedConfig(): Parameters<
  typeof verifyDedicatedSettlementPairActivity
>[0]["config"] {
  return dedicatedConfigForSubaccount(2);
}

function dedicatedConfigForSubaccount(
  subaccountNumber: number,
): Parameters<typeof verifyDedicatedSettlementPairActivity>[0]["config"] {
  return {
    microLiveAccountMode: "exclusive",
    microLiveSelectedSubaccount: subaccountNumber,
    microLiveSelectedExchangeIndex: 2,
    microLiveRestrictedApiKeyId: "dedicated-key",
    microLiveRestrictedKeyFingerprint: "a".repeat(64),
    microLiveFundingAnchorSubaccount: subaccountNumber,
    microLiveFundingAnchorExchangeIndex: 2,
    microLiveFundingAnchorTransferId: "funding-transfer",
    microLiveFundingAnchorTransferAt: new Date(observedAt),
    microLiveFundingAnchorAmountCents: 2500,
    microLiveRunId: "dedicated-run",
    microLivePairCashBaselineMicros: "25000000",
    microLivePairCashBaselineRunId: "dedicated-run",
    microLivePairCashBaselineAt: new Date(observedAt),
    microLivePairCashBaselineEvidenceDigest: "b".repeat(64),
    microLiveAccountActivityCheckpointRunId: "dedicated-run",
    microLiveAccountActivityCheckpointCursor: "cursor-1",
    microLiveAccountActivityCheckpointAt: new Date(observedAt),
    microLiveAccountActivityCheckpointEvidenceDigest: "c".repeat(64),
    microLiveAccountActivityCheckpointSubaccount: subaccountNumber,
    microLiveAccountActivityCheckpointExchangeIndex: 2,
  } as Parameters<typeof verifyDedicatedSettlementPairActivity>[0]["config"];
}

function dedicatedActivity(
  subaccountNumber = 2,
  overrides: Partial<KalshiAccountActivity> = {},
): KalshiAccountActivity {
  return activity({
    selectedSubaccount: subaccountNumber,
    orders: [{
      ...order, exchangeIndex: 2, createdAt: observedAt,
    } as unknown as KalshiAccountActivity["orders"][number]],
    fills: [{ ...fill, exchangeIndex: 2 } as unknown as KalshiAccountActivity["fills"][number]],
    ...overrides,
  });
}

function dedicatedHistory(
  overrides: Partial<KalshiSubmissionEvidence> = {},
): KalshiSubmissionEvidence {
  return history({
    orders: [{ ...order, exchangeIndex: 2 } as unknown as KalshiSubmissionEvidence["orders"][number]],
    fills: [{ ...fill, exchangeIndex: 2 } as unknown as KalshiSubmissionEvidence["fills"][number]],
    historicalFills: [{
      ...fill, exchangeIndex: 2,
    } as unknown as NonNullable<KalshiSubmissionEvidence["historicalFills"]>[number]],
    ...overrides,
  });
}

function dedicatedAccount(): KalshiAccountSnapshot {
  return {
    balance: { availableCashDollars: "25.00", portfolioValueDollars: "25.00" },
    openOrders: [],
    positions: [],
    fills: [],
    truncated: { openOrders: false, positions: false, fills: false },
  };
}

function dedicatedPairEvidence(subaccountNumber = 2): KalshiDedicatedPairEvidence {
  return {
    pair: { subaccountNumber, exchangeIndex: 2 },
    balance: {
      subaccountNumber, exchangeIndex: 2,
      balanceDollars: "25.00", updatedTs: Date.now(),
    },
    marketExchangeIndex: 2,
    keyRestrictionVerified: true,
    tradePermissionVerified: true,
    allTimeHistoryExhaustive: false,
    exclusiveControlVerified: false,
    recordCounts: { positions: 0, orders: 1, fills: 1, settlements: 1, transfers: 1 },
    scanStartedAt: observedAt,
    scanFinishedAt: new Date().toISOString(),
  };
}

const dedicatedSettlement = {
  ticker,
  eventTicker: "KXBTC15M-SETTLEMENT",
  marketResult: "yes",
  yesCountFp: "2",
  yesTotalCostDollars: "0.40",
  noCountFp: "0",
  noTotalCostDollars: "0",
  revenueCents: "200",
  settledAt: observedAt,
  feeCostDollars: "0.001000",
  exchangeIndex: 2,
};

test("dedicated settlement requires a persisted (N,2) anchor and explicit shard on records", () => {
  const input = {
    config: dedicatedConfig(),
    pairEvidence: dedicatedPairEvidence(),
    account: dedicatedAccount(),
    activity: dedicatedActivity(),
    history: dedicatedHistory(),
    settlements: [dedicatedSettlement],
    ticker,
    nowMs: Date.now(),
  } as Parameters<typeof verifyDedicatedSettlementPairActivity>[0];
  assert.equal(verifyDedicatedSettlementPairActivity(input), null);
  assert.equal(verifyDedicatedSettlementPairActivity({
    ...input,
    config: dedicatedConfigForSubaccount(37),
    pairEvidence: dedicatedPairEvidence(37),
    activity: dedicatedActivity(37),
  }), null, "the subaccount component is not fixed to a particular N");

  assert.equal(verifyDedicatedSettlementPairActivity({
    ...input,
    history: dedicatedHistory({ orders: [{ ...order }] }),
  }), "micro_live_dedicated_pair_record_exchange_index_unproven");
  assert.equal(verifyDedicatedSettlementPairActivity({
    ...input,
    activity: dedicatedActivity(2, { fills: [{ ...fill }] }),
  }), "micro_live_dedicated_pair_record_exchange_index_unproven");
  assert.equal(verifyDedicatedSettlementPairActivity({
    ...input,
    settlements: [{
      ...dedicatedSettlement, exchangeIndex: undefined,
    } as unknown as (typeof input.settlements)[number]],
  }), "micro_live_dedicated_pair_record_exchange_index_unproven");
  assert.equal(verifyDedicatedSettlementPairActivity({
    ...input,
    pairEvidence: {
      ...dedicatedPairEvidence(), marketExchangeIndex: 1 as unknown as 2,
    },
  }), "micro_live_dedicated_pair_exchange_evidence_mismatch");
  assert.equal(verifyDedicatedSettlementPairActivity({
    ...input,
    config: { ...dedicatedConfig(), microLiveFundingAnchorSubaccount: 1 },
  }), "micro_live_dedicated_pair_identity_missing_or_invalid");
});

test("primary settlement rejects stale or cross-endpoint conflicting order history", () => {
  assert.equal(
    verifyPrimarySettlementMarketActivity(
      activity({ scanStartedAt: new Date(Date.now() - 60_000).toISOString() }),
      history(),
      ticker,
    ),
    "micro_live_primary_nonexclusive_accounting_unresolved:account_history_scan_stale_or_incomplete",
  );
  assert.equal(
    verifyPrimarySettlementMarketActivity(
      activity({ orders: [] }), history(), ticker,
    ),
    "micro_live_primary_nonexclusive_accounting_unresolved:account_market_order_history_conflict",
  );
});

test("primary settlement requires exact same-market fills in both complete histories", () => {
  assert.equal(
    verifyPrimarySettlementMarketActivity(
      activity({ fills: [] }), history(), ticker,
    ),
    "micro_live_primary_nonexclusive_accounting_unresolved:account_market_fill_history_conflict",
  );
  assert.equal(
    verifyPrimarySettlementMarketActivity(
      activity(),
      history({ historicalFillsAvailable: false }),
      ticker,
    ),
    "micro_live_primary_nonexclusive_accounting_unresolved:market_history_incomplete",
  );
});

test("primary settlement tolerates other markets but rejects a same-market manual order", () => {
  const unrelatedOrder = { ...order, id: "manual-other-market", ticker: "KXBTC15M-OTHER" };
  const unrelatedFill = {
    ...fill, id: "manual-other-fill", orderId: unrelatedOrder.id,
    ticker: unrelatedOrder.ticker,
  };
  assert.equal(
    verifyPrimarySettlementMarketActivity(
      activity({
        orders: [{ ...order, createdAt: observedAt }, { ...unrelatedOrder, createdAt: observedAt }],
        fills: [fill, unrelatedFill],
      }),
      history(),
      ticker,
    ),
    null,
  );

  const localOrder = {
    id: "local-order",
    exchangeOrderId: order.id,
    clientOrderId: order.clientOrderId,
    marketTicker: ticker,
    action: "buy",
    side: "UP",
    requestedContracts: 2,
    requestedLimitPrice: 0.2,
  } as unknown as Parameters<typeof proveSettlementMarketOwnership>[0]["localMarketOrders"][number];
  const localFill = {
    id: "local-fill",
    orderId: localOrder.id,
    exchangeFillId: fill.id,
    positionId: "position",
    contracts: 2,
  } as unknown as Parameters<typeof proveSettlementMarketOwnership>[0]["positionFills"][number];
  const manualOrder = { ...order, id: "manual-same-market", clientOrderId: null };
  const manualFill = {
    ...fill, id: "manual-same-market-fill", orderId: manualOrder.id,
  };
  const conflictingHistory = history({
    orders: [order, manualOrder],
    fills: [fill, manualFill],
    historicalFills: [fill, manualFill],
  });
  assert.equal(
    verifyPrimarySettlementMarketActivity(
      activity({
        orders: [
          { ...order, createdAt: observedAt },
          { ...manualOrder, createdAt: observedAt },
        ],
        fills: [fill, manualFill],
      }),
      conflictingHistory,
      ticker,
    ),
    null,
    "the account-wide comparison alone does not assert market exclusivity",
  );
  const proof = proveSettlementMarketOwnership({
    ticker,
    localMarketOrders: [localOrder],
    positionOrders: [localOrder],
    positionFills: [localFill],
    accountFills: [fill, manualFill],
    history: conflictingHistory,
  });
  assert.deepEqual(proof, {
    verified: false,
    reason: "micro_live_settlement_market_orders_not_exclusive",
  });
});