import assert from "node:assert/strict";
import test from "node:test";
import {
  fifoExitCostBasis,
  reconstructMicroLivePositions,
  type MicroLivePositionFill,
  type MicroLivePositionOrder,
} from "./microLivePosition";

const entry = (overrides: Partial<MicroLivePositionOrder> = {}): MicroLivePositionOrder => ({
  id: "scout",
  marketTicker: "MKT",
  crossingKey: "crossing",
  triggerType: "SCOUT",
  action: "buy",
  intent: "entry",
  positionId: "pos-1",
  exitPositionId: null,
  side: "UP",
  status: "partial",
  requestedLimitPrice: 0.5,
  requestedContracts: 4,
  requestedStakeCents: 200,
  reservedRiskCents: 200,
  filledContracts: 2,
  remainingContracts: 2,
  ...overrides,
});

const fill = (overrides: Partial<MicroLivePositionFill> = {}): MicroLivePositionFill => ({
  id: "fill-1",
  orderId: "scout",
  exchangeFillId: "exchange-fill-1",
  filledAt: "2025-01-01T00:00:00.000Z",
  contracts: 2,
  fillPrice: 0.5,
  action: "buy",
  positionId: "pos-1",
  costCents: 100,
  feeCents: 2,
  feeKnown: true,
  proceedsCents: null,
  costBasisCents: null,
  ...overrides,
});

const position = (orders: MicroLivePositionOrder[], fills: MicroLivePositionFill[]) =>
  reconstructMicroLivePositions({ orders, fills }).positions[0]!;

test("FIFO exit basis consumes actual lots and known fees without double-counting", () => {
  const first = fill({ contracts: 2, costCents: 100, feeCents: 2 });
  const second = fill({
    id: "second", exchangeFillId: "second", contracts: 3, costCents: 120,
    feeCents: 0, feeKnown: false, filledAt: "2025-01-01T00:00:01.000Z",
  });
  const firstSale = fill({
    id: "sale", exchangeFillId: "sale", action: "sell", contracts: 1,
    costCents: 0, proceedsCents: 60, costBasisCents: 51,
  });
  assert.equal(fifoExitCostBasis([second, first], [], 1), 51);
  assert.equal(fifoExitCostBasis([second, first], [firstSale], 3), 131);
  assert.equal(fifoExitCostBasis([first, second], [firstSale], 5), null);
});

test("reconstructs partial entry, confirm add, and partial then confirmed exit", () => {
  const scout = entry();
  const scoutFill = fill();
  assert.equal(position([scout], [scoutFill]).state, "entry_partial");
  assert.equal(position([scout], [scoutFill]).sellableContracts, 2);
  assert.equal(position([scout], [scoutFill]).openCostCents, 102);
  assert.equal(position([scout], [scoutFill]).reservedBuyRiskCents, 200);
  assert.equal(reconstructMicroLivePositions({ orders: [scout], fills: [scoutFill] }).effectiveCommittedRiskCents, 202);

  const confirm = entry({
    id: "confirm",
    triggerType: "CONFIRM",
    requestedContracts: 2,
    requestedStakeCents: 100,
    reservedRiskCents: 0,
    filledContracts: 2,
    remainingContracts: 0,
    status: "filled",
  });
  const confirmFill = fill({
    id: "fill-2",
    orderId: "confirm",
    exchangeFillId: "exchange-fill-2",
    filledAt: "2025-01-01T00:00:01.000Z",
    costCents: 100,
  });
  assert.equal(position([scout, confirm], [scoutFill, confirmFill]).state, "confirm_filled");
  assert.equal(position([scout, confirm], [scoutFill, confirmFill]).contractsBought, 4);

  const exit = entry({
    id: "exit",
    triggerType: "EXIT",
    action: "sell",
    intent: "exit",
    positionId: null,
    exitPositionId: "pos-1",
    requestedContracts: 4,
    requestedStakeCents: 0,
    reservedRiskCents: 0,
    filledContracts: 2,
    remainingContracts: 2,
    status: "partial",
  });
  const firstSale = fill({
    id: "sell-1",
    orderId: "exit",
    exchangeFillId: "exchange-sell-1",
    contracts: 2,
    action: "sell",
    costCents: 0,
    feeCents: 1,
    proceedsCents: 120,
    costBasisCents: 102,
  });
  const partiallyExited = position([scout, confirm, exit], [scoutFill, confirmFill, firstSale]);
  assert.equal(partiallyExited.state, "exit_partial");
  assert.equal(partiallyExited.sellableContracts, 0);
  assert.equal(partiallyExited.openCostCents, 102);
  assert.equal(partiallyExited.realizedPnlCents, 17);
  assert.equal(partiallyExited.closed, false);
});

test("closes only when actual sells account for every bought contract", () => {
  const buyOrder = entry({
    status: "filled",
    requestedContracts: 2,
    requestedStakeCents: 100,
    reservedRiskCents: 0,
    filledContracts: 2,
    remainingContracts: 0,
  });
  const buyFill = fill({ costCents: 100 });
  const sellOrder = entry({
    id: "sell",
    triggerType: "EXIT",
    action: "sell",
    intent: "exit",
    positionId: null,
    exitPositionId: "pos-1",
    status: "filled",
    requestedContracts: 2,
    requestedStakeCents: 0,
    reservedRiskCents: 0,
    filledContracts: 2,
    remainingContracts: 0,
  });
  const sellFill = fill({
    id: "sell-fill",
    orderId: "sell",
    exchangeFillId: "exchange-sell",
    action: "sell",
    contracts: 2,
    costCents: 0,
    feeCents: 1,
    proceedsCents: 130,
    costBasisCents: 102,
  });
  const closed = position([buyOrder, sellOrder], [buyFill, sellFill]);
  assert.equal(closed.state, "closed");
  assert.equal(closed.closed, true);
  assert.equal(closed.openCostCents, 0);
  assert.equal(closed.realizedPnlCents, 27);
});

test("replay and input ordering do not change the reconstructed ledger result", () => {
  const orders = [
    entry({ id: "b", positionId: null }),
    entry({ id: "a", positionId: null, triggerType: "CONFIRM", requestedContracts: 1, filledContracts: 1, remainingContracts: 0, status: "filled" }),
  ];
  const fills = [
    fill({ id: "f-b", exchangeFillId: "f-b", orderId: "b", positionId: null, filledAt: "2025-01-02T00:00:00.000Z" }),
    fill({ id: "f-a", exchangeFillId: "f-a", orderId: "a", positionId: null, contracts: 1, costCents: 50, filledAt: "2025-01-01T00:00:00.000Z" }),
  ];
  const first = reconstructMicroLivePositions({ orders, fills });
  const replay = reconstructMicroLivePositions({ orders: [...orders].reverse(), fills: [...fills].reverse() });
  assert.deepEqual(replay, first);
});

test("effective committed risk counts a filled Confirm and partial Scout remainder once each", () => {
  const scout = entry({
    requestedContracts: 5,
    requestedStakeCents: 250,
    filledContracts: 1,
    remainingContracts: 4,
    reservedRiskCents: 250,
  });
  const confirm = entry({
    id: "confirm",
    triggerType: "CONFIRM",
    requestedContracts: 5,
    requestedStakeCents: 250,
    reservedRiskCents: 0,
    filledContracts: 5,
    remainingContracts: 0,
    status: "filled",
  });
  const fills = [
    fill({ contracts: 1, costCents: 50, feeCents: 0 }),
    fill({
      id: "confirm-fill",
      exchangeFillId: "confirm-fill",
      orderId: "confirm",
      contracts: 5,
      costCents: 250,
      feeCents: 0,
    }),
  ];
  const result = reconstructMicroLivePositions({
    orders: [scout, confirm],
    fills,
    limits: { maxReservedRiskCents: 500 },
  });
  assert.deepEqual(result.anomalies, []);
  assert.equal(result.openCostCents, 300);
  assert.equal(result.reservedBuyRiskCents, 250);
  assert.equal(result.effectiveCommittedRiskCents, 500);
  const scoutAttemptCost = 50;
  const confirmAttemptCost = 50;
  assert.ok(result.effectiveCommittedRiskCents + scoutAttemptCost > 500,
    "an attempted Scout add crosses the $5 cap");
  assert.ok(result.effectiveCommittedRiskCents + confirmAttemptCost > 500,
    "an attempted Confirm add crosses the $5 cap");
  assert.ok(reconstructMicroLivePositions({
    orders: [scout, confirm], fills, limits: { maxReservedRiskCents: 499 },
  }).anomalies.some((anomaly) => anomaly.code === "reserved_risk_limit_exceeded"));
});

test("negative or inconsistent unfilled buy reservations fail closed", () => {
  const scout = entry({ reservedRiskCents: 99 });
  const result = reconstructMicroLivePositions({ orders: [scout], fills: [fill()] });
  assert.ok(result.anomalies.some((anomaly) =>
    anomaly.code === "negative_or_invalid_unfilled_buy_reservation" ||
    anomaly.code === "inconsistent_unfilled_buy_reservation"));
});

test("reports unknown fee evidence as unknown realized PnL, not zero fees", () => {
  const buyOrder = entry({ status: "filled", filledContracts: 2, remainingContracts: 0, reservedRiskCents: 0 });
  const sellOrder = entry({
    id: "sell",
    action: "sell",
    intent: "exit",
    triggerType: "EXIT",
    positionId: null,
    exitPositionId: "pos-1",
    status: "filled",
    filledContracts: 2,
    remainingContracts: 0,
    requestedContracts: 2,
    requestedStakeCents: 0,
    reservedRiskCents: 0,
  });
  const sale = fill({
    id: "sale",
    orderId: "sell",
    exchangeFillId: "sale",
    action: "sell",
    contracts: 2,
    costCents: 0,
    feeKnown: false,
    proceedsCents: 130,
    costBasisCents: 102,
  });
  const result = position([buyOrder, sellOrder], [fill({ feeKnown: false }), sale]);
  assert.equal(result.realizedPnlCents, null);
});

test("detects orphan/duplicate fills, oversell, wrong side, inconsistent counts, and limits", () => {
  const buy = entry({ side: "UP", filledContracts: 1, remainingContracts: 3 });
  const sell = entry({
    id: "sell",
    action: "sell",
    intent: "exit",
    triggerType: "EXIT",
    positionId: null,
    exitPositionId: "pos-1",
    side: "DOWN",
    requestedContracts: 3,
    requestedStakeCents: 0,
    reservedRiskCents: 0,
    filledContracts: 3,
    remainingContracts: 0,
    status: "filled",
  });
  const buyFill = fill({ contracts: 1 });
  const sale = fill({
    id: "sale",
    orderId: "sell",
    exchangeFillId: "same-fill-id",
    action: "sell",
    contracts: 3,
    costCents: 0,
    proceedsCents: 150,
    costBasisCents: 51,
  });
  const result = reconstructMicroLivePositions({
    orders: [buy, sell, entry({ id: "bad-count", filledContracts: 8, requestedContracts: 4 })],
    fills: [
      buyFill,
      sale,
      { ...sale, id: "duplicate-row" },
      fill({ id: "orphan", orderId: "missing", exchangeFillId: "orphan" }),
    ],
    limits: { maxContracts: 0, maxFilledCostCents: 1, maxReservedRiskCents: 1 },
  });
  const codes = new Set(result.anomalies.map((anomaly) => anomaly.code));
  for (const code of [
    "duplicate_fill",
    "orphan_fill",
    "oversell",
    "wrong_exit_side",
    "inconsistent_order_counts",
    "order_fill_count_mismatch",
    "contract_limit_exceeded",
    "filled_cost_limit_exceeded",
  ]) assert.ok(codes.has(code), `expected anomaly ${code}`);
});

test("keeps sellable contracts net of outstanding sell orders and marks only at reliable sell prices", () => {
  const buyOrder = entry({ status: "filled", filledContracts: 4, remainingContracts: 0, reservedRiskCents: 0 });
  const exit = entry({
    id: "exit",
    action: "sell",
    intent: "exit",
    triggerType: "EXIT",
    positionId: null,
    exitPositionId: "pos-1",
    status: "partial",
    requestedContracts: 3,
    filledContracts: 1,
    remainingContracts: 2,
    requestedStakeCents: 0,
    reservedRiskCents: 0,
  });
  const fills = [
    fill({ contracts: 4, costCents: 200 }),
    fill({ id: "sold", orderId: "exit", exchangeFillId: "sold", action: "sell", contracts: 1, costCents: 0, proceedsCents: 60, costBasisCents: 51 }),
  ];
  const marked = reconstructMicroLivePositions({ orders: [buyOrder, exit], fills, sellSideMark: { price: 0.6, reliable: true } }).positions[0]!;
  assert.equal(marked.sellableContracts, 1);
  assert.equal(marked.unrealizedPnlCents, 28);
  assert.equal(reconstructMicroLivePositions({ orders: [buyOrder], fills: [fills[0]!], sellSideMark: { price: 0.6, reliable: false } }).positions[0]!.unrealizedPnlCents, null);
});

test("allocates micro-dollar FIFO PnL across partial and full multi-lot sells", () => {
  const buyOrder = entry({
    status: "filled",
    requestedContracts: 4,
    requestedStakeCents: 220,
    reservedRiskCents: 0,
    filledContracts: 4,
    remainingContracts: 0,
  });
  const exit = entry({
    id: "exit",
    action: "sell",
    intent: "exit",
    triggerType: "EXIT",
    positionId: null,
    exitPositionId: "pos-1",
    status: "partial",
    requestedContracts: 4,
    requestedStakeCents: 0,
    reservedRiskCents: 0,
    filledContracts: 1,
    remainingContracts: 3,
  });
  const buys = [
    fill({
      id: "lot-a",
      exchangeFillId: "lot-a",
      contracts: 2,
      costCents: 100,
      feeCents: 1,
      tradeMicros: 1_000_001,
      feeMicros: 5_001,
    }),
    fill({
      id: "lot-b",
      exchangeFillId: "lot-b",
      filledAt: "2025-01-01T00:00:01.000Z",
      contracts: 2,
      costCents: 120,
      feeCents: 0,
      tradeMicros: 1_200_003,
      feeMicros: 3_003,
    }),
  ];
  const firstSale = fill({
    id: "sale-a",
    orderId: "exit",
    exchangeFillId: "sale-a",
    filledAt: "2025-01-01T00:00:02.000Z",
    action: "sell",
    contracts: 1,
    costCents: 0,
    feeCents: 0,
    feeKnown: true,
    proceedsCents: 60,
    costBasisCents: 50,
    tradeMicros: 600_000,
    feeMicros: 1_001,
  });
  const partial = position([buyOrder, exit], [...buys, firstSale]);
  assert.equal(partial.realizedPnlMicros, 96_499);
  assert.equal(partial.realizedPnlCents, 10);
  assert.equal(partial.openCostCents, 171);

  const completedExit = { ...exit, status: "filled", filledContracts: 4, remainingContracts: 0 };
  const finalSale = fill({
    id: "sale-b",
    orderId: "exit",
    exchangeFillId: "sale-b",
    filledAt: "2025-01-01T00:00:03.000Z",
    action: "sell",
    contracts: 3,
    costCents: 0,
    feeCents: 0,
    feeKnown: true,
    proceedsCents: 200,
    costBasisCents: 171,
    tradeMicros: 2_000_000,
    feeMicros: 2_001,
  });
  const fullResult = reconstructMicroLivePositions({
    orders: [buyOrder, completedExit],
    fills: [...buys, firstSale, finalSale],
  });
  assert.equal(fullResult.positions[0]!.closed, true);
  assert.equal(fullResult.positions[0]!.realizedPnlMicros, 388_990);
  // 38.899 cents is rounded once, at the final cents-facing UI boundary.
  assert.equal(fullResult.positions[0]!.realizedPnlCents, 39);
  assert.equal(fullResult.realizedPnlMicros, 388_990);
  assert.equal(fullResult.realizedPnlCents, 39);
});

test("explicit null micro fee means realized PnL is unknown", () => {
  const buyOrder = entry({
    status: "filled",
    requestedContracts: 2,
    requestedStakeCents: 100,
    reservedRiskCents: 0,
    filledContracts: 2,
    remainingContracts: 0,
  });
  const sellOrder = entry({
    id: "sell",
    action: "sell",
    intent: "exit",
    triggerType: "EXIT",
    positionId: null,
    exitPositionId: "pos-1",
    status: "filled",
    requestedContracts: 2,
    requestedStakeCents: 0,
    reservedRiskCents: 0,
    filledContracts: 2,
    remainingContracts: 0,
  });
  const buy = fill({ tradeMicros: 1_000_000, feeMicros: 0 });
  const sale = fill({
    id: "sale",
    orderId: "sell",
    exchangeFillId: "sale",
    action: "sell",
    costCents: 0,
    proceedsCents: 120,
    costBasisCents: 102,
    tradeMicros: 1_200_000,
    feeMicros: null,
  });
  const result = reconstructMicroLivePositions({ orders: [buyOrder, sellOrder], fills: [buy, sale] });
  assert.equal(result.positions[0]!.realizedPnlMicros, null);
  assert.equal(result.positions[0]!.realizedPnlCents, null);
  assert.equal(result.realizedPnlMicros, null);
  assert.equal(result.realizedPnlCents, null);
});

test("micro-dollar FIFO results are identical on repeated and reordered replay", () => {
  const buyOrder = entry({
    status: "filled",
    requestedContracts: 2,
    requestedStakeCents: 100,
    reservedRiskCents: 0,
    filledContracts: 2,
    remainingContracts: 0,
  });
  const sellOrder = entry({
    id: "sell",
    action: "sell",
    intent: "exit",
    triggerType: "EXIT",
    positionId: null,
    exitPositionId: "pos-1",
    status: "filled",
    requestedContracts: 2,
    requestedStakeCents: 0,
    reservedRiskCents: 0,
    filledContracts: 2,
    remainingContracts: 0,
  });
  const fills = [
    fill({ id: "buy-a", exchangeFillId: "buy-a", contracts: 1, costCents: 50, feeCents: 0, tradeMicros: 500_001, feeMicros: 101 }),
    fill({ id: "buy-b", exchangeFillId: "buy-b", contracts: 1, costCents: 50, feeCents: 0, filledAt: "2025-01-01T00:00:01.000Z", tradeMicros: 500_003, feeMicros: 103 }),
    fill({
      id: "sell-fill",
      orderId: "sell",
      exchangeFillId: "sell-fill",
      action: "sell",
      contracts: 2,
      costCents: 0,
      proceedsCents: 120,
      costBasisCents: 100,
      tradeMicros: 1_200_007,
      feeMicros: 107,
    }),
  ];
  const first = reconstructMicroLivePositions({ orders: [buyOrder, sellOrder], fills });
  for (let replayIndex = 0; replayIndex < 3; replayIndex++) {
    const replay = reconstructMicroLivePositions({
      orders: replayIndex % 2 ? [sellOrder, buyOrder] : [buyOrder, sellOrder],
      fills: replayIndex % 2 ? [...fills].reverse() : [...fills],
    });
    assert.deepEqual(replay, first);
  }
});

test("settlement realizes remaining FIFO lots without charging cumulative fill fees twice", () => {
  const buyOrder = entry({
    status: "filled",
    requestedContracts: 3,
    requestedStakeCents: 150,
    reservedRiskCents: 0,
    filledContracts: 3,
    remainingContracts: 0,
  });
  const sellOrder = entry({
    id: "sell",
    action: "sell",
    intent: "exit",
    triggerType: "EXIT",
    positionId: null,
    exitPositionId: "pos-1",
    status: "filled",
    requestedContracts: 1,
    requestedStakeCents: 0,
    reservedRiskCents: 0,
    filledContracts: 1,
    remainingContracts: 0,
  });
  const buy = fill({
    contracts: 3,
    costCents: 150,
    feeCents: 3,
    tradeMicros: 1_500_000,
    feeMicros: 3_003,
  });
  const sale = fill({
    id: "sale",
    orderId: "sell",
    exchangeFillId: "sale",
    action: "sell",
    contracts: 1,
    costCents: 0,
    feeCents: 0,
    proceedsCents: 60,
    costBasisCents: 51,
    tradeMicros: 600_000,
    feeMicros: 1_000,
  });
  const result = reconstructMicroLivePositions({
    orders: [buyOrder, sellOrder],
    fills: [buy, sale],
    settlements: [{
      positionId: "pos-1",
      marketTicker: "MKT",
      side: "UP",
      contracts: 2,
      payoutMicros: 1_200_000,
      feeMicros: 4_003, // All-market fee total: buy 3,003 + prior exit 1,000.
      settledAt: "2025-01-01T00:00:02.000Z",
    }],
  });
  const settled = result.positions[0]!;
  assert.equal(settled.state, "settled");
  assert.equal(settled.closed, true);
  assert.equal(settled.contractsBought, 3);
  assert.equal(settled.contractsSold, 1);
  assert.equal(settled.sellableContracts, 0);
  assert.equal(settled.openCostCents, 0);
  assert.equal(settled.realizedPnlMicros, 295_997);
  assert.equal(settled.realizedPnlCents, 30);
  assert.equal(result.realizedPnlMicros, 295_997);
  assert.equal(result.realizedPnlCents, 30);
});

test("full settlement closes and realizes without any sell fills", () => {
  const buyOrder = entry({
    status: "filled",
    requestedContracts: 2,
    requestedStakeCents: 100,
    reservedRiskCents: 0,
    filledContracts: 2,
    remainingContracts: 0,
  });
  const result = reconstructMicroLivePositions({
    orders: [buyOrder],
    fills: [fill({
      contracts: 2,
      costCents: 100,
      feeCents: 0,
      tradeMicros: 1_000_000,
      feeMicros: 0,
    })],
    settlements: [{
      positionId: "pos-1",
      marketTicker: "MKT",
      side: "UP",
      contracts: 2,
      payoutMicros: 1_100_000,
      feeMicros: 0,
      settledAt: "2025-01-01T00:00:02.000Z",
    }],
  });
  assert.equal(result.positions[0]!.state, "settled");
  assert.equal(result.positions[0]!.closed, true);
  assert.equal(result.positions[0]!.realizedPnlMicros, 100_000);
  assert.equal(result.realizedPnlMicros, 100_000);
});

test("duplicate or inconsistent settlements are anomalous and never applied", () => {
  const buyOrder = entry({
    status: "filled",
    requestedContracts: 2,
    requestedStakeCents: 100,
    reservedRiskCents: 0,
    filledContracts: 2,
    remainingContracts: 0,
  });
  const buys = [fill({
    contracts: 2,
    costCents: 100,
    feeCents: 0,
    tradeMicros: 1_000_000,
    feeMicros: 0,
  })];
  const settlement = {
    positionId: "pos-1",
    marketTicker: "MKT",
    side: "UP",
    contracts: 2,
    payoutMicros: 1_100_000,
    feeMicros: 0,
    settledAt: "2025-01-01T00:00:02.000Z",
  };
  const repeated = reconstructMicroLivePositions({
    orders: [buyOrder],
    fills: buys,
    settlements: [settlement, settlement],
  });
  assert.ok(repeated.anomalies.some((anomaly) => anomaly.code === "duplicate_settlement"));
  assert.equal(repeated.positions[0]!.closed, true);
  assert.equal(repeated.positions[0]!.realizedPnlMicros, 100_000);

  const wrongQuantity = reconstructMicroLivePositions({
    orders: [buyOrder],
    fills: buys,
    settlements: [{ ...settlement, positionId: "pos-1", contracts: 1 }],
  });
  assert.ok(wrongQuantity.anomalies.some((anomaly) =>
    anomaly.code === "settlement_quantity_mismatch"));
  assert.equal(wrongQuantity.positions[0]!.closed, false);
  assert.equal(wrongQuantity.positions[0]!.realizedPnlMicros, null);

  const wrongIdentity = reconstructMicroLivePositions({
    orders: [buyOrder],
    fills: buys,
    settlements: [{ ...settlement, marketTicker: "OTHER" }],
  });
  assert.ok(wrongIdentity.anomalies.some((anomaly) =>
    anomaly.code === "settlement_identity_mismatch"));
  assert.equal(wrongIdentity.positions[0]!.closed, false);
});

test("settlement with a missing fee or trade amount has unknown realized PnL", () => {
  const buyOrder = entry({
    status: "filled",
    requestedContracts: 2,
    requestedStakeCents: 100,
    reservedRiskCents: 0,
    filledContracts: 2,
    remainingContracts: 0,
  });
  const buy = fill({
    contracts: 2,
    costCents: 100,
    feeCents: 0,
    tradeMicros: 1_000_000,
    feeMicros: 0,
  });
  const settlement = {
    positionId: "pos-1",
    marketTicker: "MKT",
    side: "UP",
    contracts: 2,
    payoutMicros: 1_100_000,
    feeMicros: null,
    settledAt: "2025-01-01T00:00:02.000Z",
  };
  const unknownFee = reconstructMicroLivePositions({
    orders: [buyOrder],
    fills: [buy],
    settlements: [settlement],
  });
  assert.equal(unknownFee.positions[0]!.closed, true);
  assert.equal(unknownFee.positions[0]!.realizedPnlMicros, null);
  assert.equal(unknownFee.realizedPnlMicros, null);

  const missingTrade = reconstructMicroLivePositions({
    orders: [buyOrder],
    fills: [{ ...buy, tradeMicros: null }],
    settlements: [{ ...settlement, feeMicros: 0 }],
  });
  assert.equal(missingTrade.positions[0]!.closed, true);
  assert.equal(missingTrade.positions[0]!.realizedPnlMicros, null);
});
