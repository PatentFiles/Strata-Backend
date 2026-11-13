import assert from "node:assert/strict";
import test from "node:test";
import {
  computeBotAttributableAvailableCashDelta,
  createPrimaryCashActivityEventDigest,
  reconcilePrimaryCashActivityCheckpoint,
  type PrimaryCashActivityEvidence,
  type PrimaryCashActivityEvent,
  type PrimaryCashActivityEventKind,
  type PrimaryCashActivityCheckpointInput,
  type PrimaryCashActivityScan,
  type PrimaryCashReconciliationInput,
} from "./microLivePrimaryCashAccounting";
import { withinLiveTestCap } from "./microLiveFeeCap";

const nowMs = 100_000;
const baseline = {
  availableCashMicros: "10000000",
  runId: "run-abc",
  capturedAt: new Date(nowMs - 20_000).toISOString(),
  evidenceDigest: "a".repeat(64),
};

function activity(overrides: Partial<PrimaryCashActivityEvidence> = {}):
PrimaryCashActivityEvidence {
  return {
    authenticated: true,
    complete: true,
    selectedSubaccount: 0,
    scanFinishedAt: new Date(nowMs).toISOString(),
    allCashComponentsKnown: true,
    fills: [],
    settlements: [],
    botOrderIds: [],
    nonBotOrderIds: [],
    botSettlementIds: [],
    nonBotSettlementIds: [],
    botSettlementOwnershipProven: false,
    ...overrides,
  };
}

function input(
  currentAvailableCashDollars: string,
  evidence: PrimaryCashActivityEvidence = activity(),
  overrides: Partial<PrimaryCashReconciliationInput> = {},
): PrimaryCashReconciliationInput {
  return {
    baseline,
    currentRunId: "run-abc",
    currentAvailableCashDollars,
    activity: evidence,
    nowMs,
    ...overrides,
  };
}

function checkpointEvent(
  overrides: Partial<Omit<PrimaryCashActivityEvent, "evidenceDigest">> = {},
): PrimaryCashActivityEvent {
  const fields = {
    id: "event-1",
    kind: "order" as PrimaryCashActivityEventKind,
    occurredAt: new Date(nowMs - 500).toISOString(),
    classification: "current_run_bot" as const,
    runId: "run-abc",
    affectsBotMarket: false,
    affectsPositions: false,
    affectsReservedExposure: false,
    cashDeltaMicros: null,
    ...overrides,
  };
  return { ...fields, evidenceDigest: createPrimaryCashActivityEventDigest(fields) };
}

function activityScan(overrides: Partial<PrimaryCashActivityScan> = {}):
PrimaryCashActivityScan {
  return {
    authenticated: true,
    accountHistoryComplete: true,
    cashTransferHistoryAvailable: true,
    cashTransferHistoryComplete: true,
    selectedSubaccount: 0,
    historyFromCursor: null,
    nextCursor: "cursor-1",
    historyCoveredFrom: baseline.capturedAt,
    scanStartedAt: new Date(nowMs - 1_000).toISOString(),
    scanFinishedAt: new Date(nowMs).toISOString(),
    events: [],
    ...overrides,
  };
}

function checkpointInput(
  activity: PrimaryCashActivityScan = activityScan(),
  overrides: Partial<PrimaryCashActivityCheckpointInput> = {},
): PrimaryCashActivityCheckpointInput {
  return {
    baseline,
    currentRunId: "run-abc",
    previousCheckpoint: null,
    activity,
    nowMs,
    ...overrides,
  };
}

test("unrelated deposits and withdrawals are unexplained cash deltas", () => {
  const deposit = computeBotAttributableAvailableCashDelta(input("11.00"));
  assert.equal(deposit.ok, false);
  if (!deposit.ok) {
    assert.equal(deposit.reason, "primary_cash_delta_unexplained");
    assert.equal(deposit.unexplainedDeltaMicros, "1000000");
  }

  const withdrawal = computeBotAttributableAvailableCashDelta(input("9.00"));
  assert.equal(withdrawal.ok, false);
  if (!withdrawal.ok) {
    assert.equal(withdrawal.reason, "primary_cash_delta_unexplained");
    assert.equal(withdrawal.unexplainedDeltaMicros, "-1000000");
  }
});

test("complete authenticated activity scans produce a durable run-bound checkpoint", () => {
  const first = reconcilePrimaryCashActivityCheckpoint(checkpointInput(activityScan({
    nextCursor: "opaque-account-cursor-001",
  })));
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.nextCheckpoint.runId, "run-abc");
  assert.equal(first.nextCheckpoint.cursor, "opaque-account-cursor-001");
  assert.match(first.nextCheckpoint.evidenceDigest, /^[0-9a-f]{64}$/);

  // Simulate a process restart: only the persisted checkpoint is carried into
  // the next call; activity after its cursor extends the digest chain.
  const restartedScan = activityScan({
    historyFromCursor: first.nextCheckpoint.cursor,
    nextCursor: "opaque-account-cursor-002",
    historyCoveredFrom: new Date(nowMs).toISOString(),
    scanStartedAt: new Date(nowMs).toISOString(),
    scanFinishedAt: new Date(nowMs + 1_000).toISOString(),
    events: [checkpointEvent({
      id: "bot-order-1",
      occurredAt: new Date(nowMs + 500).toISOString(),
    })],
  });
  const restarted = reconcilePrimaryCashActivityCheckpoint(
    checkpointInput(restartedScan, {
      previousCheckpoint: first.nextCheckpoint,
      nowMs: nowMs + 1_000,
    }),
  );
  assert.equal(restarted.ok, true);
  if (restarted.ok) {
    assert.equal(restarted.nextCheckpoint.cursor, "opaque-account-cursor-002");
    assert.notEqual(restarted.nextCheckpoint.evidenceDigest, first.nextCheckpoint.evidenceDigest);
    assert.deepEqual(restarted.observedEventIds, ["bot-order-1"]);
  }
});

test("offsetting unrelated transfers remain individually visible at zero net cash", () => {
  const deposit = checkpointEvent({
    id: "deposit-1",
    kind: "cash_transfer",
    classification: "unrelated_permitted",
    runId: null,
    cashDeltaMicros: "1000000",
  });
  const withdrawal = checkpointEvent({
    id: "withdrawal-1",
    kind: "cash_transfer",
    classification: "unrelated_permitted",
    runId: null,
    cashDeltaMicros: "-1000000",
  });
  const result = reconcilePrimaryCashActivityCheckpoint(checkpointInput(activityScan({
    events: [deposit, withdrawal],
  })));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.unrelatedCashMovementIds, ["deposit-1", "withdrawal-1"]);
    assert.equal(result.unrelatedCashDeltaMicros, "0");
    assert.deepEqual(result.observedEventIds, ["deposit-1", "withdrawal-1"]);
  }
});

test("missing or incomplete transfer history fails closed instead of inferring no movement", () => {
  for (const overrides of [
    { cashTransferHistoryAvailable: false },
    { cashTransferHistoryComplete: false },
  ]) {
    const result = reconcilePrimaryCashActivityCheckpoint(checkpointInput(activityScan(overrides)));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "primary_cash_transfer_history_unavailable_or_incomplete");
    }
  }
});

test("truncated account history and wrong account fail closed", () => {
  const incomplete = reconcilePrimaryCashActivityCheckpoint(checkpointInput(activityScan({
    accountHistoryComplete: false,
  })));
  assert.equal(incomplete.ok, false);
  if (!incomplete.ok) {
    assert.equal(incomplete.reason, "primary_activity_history_unverified_or_incomplete");
  }

  const wrongAccount = reconcilePrimaryCashActivityCheckpoint(checkpointInput(activityScan({
    selectedSubaccount: 1,
  })));
  assert.equal(wrongAccount.ok, false);
  if (!wrongAccount.ok) {
    assert.equal(wrongAccount.reason, "primary_activity_history_unverified_or_incomplete");
  }
});

test("unknown activity and unrelated activity touching bot scope fail closed", () => {
  const unknown = reconcilePrimaryCashActivityCheckpoint(checkpointInput(activityScan({
    events: [checkpointEvent({
      id: "unknown-fill",
      kind: "fill",
      classification: "unknown",
      runId: null,
    })],
  })));
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.reason, "primary_activity_ownership_unknown");

  const conflicting = reconcilePrimaryCashActivityCheckpoint(checkpointInput(activityScan({
    events: [checkpointEvent({
      id: "unrelated-bot-market-order",
      kind: "order",
      classification: "unrelated_permitted",
      runId: null,
      affectsBotMarket: true,
    })],
  })));
  assert.equal(conflicting.ok, false);
  if (!conflicting.ok) {
    assert.equal(conflicting.reason, "primary_activity_unrelated_item_affects_bot_scope");
  }
});

test("activity checkpoint rejects changed IDs, digest tampering, and invalid transfer amounts", () => {
  const duplicate = checkpointEvent({ id: "same-id" });
  const duplicatedIds = reconcilePrimaryCashActivityCheckpoint(checkpointInput(activityScan({
    events: [duplicate, duplicate],
  })));
  assert.equal(duplicatedIds.ok, false);
  if (!duplicatedIds.ok) {
    assert.equal(duplicatedIds.reason, "primary_activity_event_identity_or_digest_invalid");
  }

  const tampered = {
    ...checkpointEvent({ id: "tampered" }),
    affectsPositions: true,
  };
  const badDigest = reconcilePrimaryCashActivityCheckpoint(checkpointInput(activityScan({
    events: [tampered],
  })));
  assert.equal(badDigest.ok, false);
  if (!badDigest.ok) {
    assert.equal(badDigest.reason, "primary_activity_event_identity_or_digest_invalid");
  }

  const invalidTransfer = checkpointEvent({
    id: "invalid-transfer",
    kind: "cash_transfer",
    classification: "unrelated_permitted",
    runId: null,
    cashDeltaMicros: "-0",
  });
  const badAmount = reconcilePrimaryCashActivityCheckpoint(checkpointInput(activityScan({
    events: [invalidTransfer],
  })));
  assert.equal(badAmount.ok, false);
  if (!badAmount.ok) {
    assert.equal(badAmount.reason, "primary_cash_transfer_attribution_invalid");
  }
});

test("checkpoint rejects run changes and a cursor that does not match persisted state", () => {
  const initial = reconcilePrimaryCashActivityCheckpoint(checkpointInput(activityScan()));
  assert.equal(initial.ok, true);
  if (!initial.ok) return;

  const wrongRun = reconcilePrimaryCashActivityCheckpoint(checkpointInput(activityScan({
    historyFromCursor: initial.nextCheckpoint.cursor,
    historyCoveredFrom: initial.nextCheckpoint.capturedAt,
    scanStartedAt: initial.nextCheckpoint.capturedAt,
    scanFinishedAt: new Date(nowMs + 1_000).toISOString(),
  }), {
    currentRunId: "another-run",
    nowMs: nowMs + 1_000,
    previousCheckpoint: initial.nextCheckpoint,
  }));
  assert.equal(wrongRun.ok, false);
  if (!wrongRun.ok) {
    assert.equal(wrongRun.reason, "primary_cash_baseline_invalid_or_run_changed");
  }

  const wrongCursor = reconcilePrimaryCashActivityCheckpoint(checkpointInput(activityScan({
    historyFromCursor: "not-the-saved-cursor",
    historyCoveredFrom: initial.nextCheckpoint.capturedAt,
    scanStartedAt: initial.nextCheckpoint.capturedAt,
    scanFinishedAt: new Date(nowMs + 1_000).toISOString(),
  }), {
    previousCheckpoint: initial.nextCheckpoint,
    nowMs: nowMs + 1_000,
  }));
  assert.equal(wrongCursor.ok, false);
  if (!wrongCursor.ok) {
    assert.equal(wrongCursor.reason, "primary_activity_checkpoint_invalid_or_cursor_mismatch");
  }
});

test("a known unrelated trade is not attributed to the bot and fails cash reconciliation", () => {
  const result = computeBotAttributableAvailableCashDelta(input("9.69", activity({
    nonBotOrderIds: ["other-order"],
    fills: [{
      id: "other-fill",
      orderId: "other-order",
      ticker: "KXTEST",
      action: "buy",
      countFp: "1",
      priceDollars: "0.30",
      feeCostDollars: "0.01",
    }],
  })));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "primary_cash_delta_unexplained");
    assert.equal(result.botAttributableDeltaMicros, "0");
    assert.equal(result.unexplainedDeltaMicros, "-310000");
  }
});

test("the persisted baseline remains the anchor after process restart", () => {
  // A restart reuses the same persisted baseline/run identity; it does not
  // silently replace the anchor with the current cash snapshot.
  const afterRestart = computeBotAttributableAvailableCashDelta(input("10.00", activity(), {
    baseline: { ...baseline },
  }));
  assert.deepEqual(afterRestart, {
    ok: true,
    baselineAvailableCashMicros: "10000000",
    currentAvailableCashMicros: "10000000",
    observedDeltaMicros: "0",
    botAttributableDeltaMicros: "0",
    unexplainedDeltaMicros: "0",
  });
  assert.equal(computeBotAttributableAvailableCashDelta(input("10.00", activity(), {
    currentRunId: "new-process-new-run",
  })).ok, false);
});

test("cash activity timestamps remain fresh and monotone under an injected clock", () => {
  const capturedAt = new Date(nowMs - 5_000).toISOString();
  const anchoredBaseline = { ...baseline, capturedAt };
  const atAnchor = computeBotAttributableAvailableCashDelta(input("10.00", activity({
    scanFinishedAt: capturedAt,
  }), { baseline: anchoredBaseline }));
  assert.equal(atAnchor.ok, true, "a scan equal to the captured baseline timestamp is valid");

  const stale = computeBotAttributableAvailableCashDelta(input("10.00", activity({
    scanFinishedAt: new Date(nowMs - 5_001).toISOString(),
  }), { baseline: anchoredBaseline }));
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.reason, "primary_cash_activity_stale");

  const future = computeBotAttributableAvailableCashDelta(input("10.00", activity({
    scanFinishedAt: new Date(nowMs + 1).toISOString(),
  }), { baseline: anchoredBaseline }));
  assert.equal(future.ok, false);
  if (!future.ok) assert.equal(future.reason, "primary_cash_activity_stale");

  const laterBaseline = {
    ...baseline, capturedAt: new Date(nowMs - 1_000).toISOString(),
  };
  const beforeBaseline = computeBotAttributableAvailableCashDelta(input("10.00", activity({
    scanFinishedAt: new Date(nowMs - 1_001).toISOString(),
  }), { baseline: laterBaseline }));
  assert.equal(beforeBaseline.ok, false);
  if (!beforeBaseline.ok) assert.equal(beforeBaseline.reason, "primary_cash_activity_stale");
});

test("matching bot fills attribute exact trade value and fees", () => {
  const result = computeBotAttributableAvailableCashDelta(input("9.88", activity({
    botOrderIds: ["bot-buy", "bot-sell"],
    fills: [
      {
        id: "buy-fill",
        orderId: "bot-buy",
        ticker: "KXTEST",
        action: "buy",
        countFp: "2",
        priceDollars: "0.25",
        feeCostDollars: "0.01",
      },
      {
        id: "sell-fill",
        orderId: "bot-sell",
        ticker: "KXTEST",
        action: "sell",
        countFp: "1",
        priceDollars: "0.40",
        feeCostDollars: "0.01",
      },
    ],
  })));
  assert.deepEqual(result, {
    ok: true,
    baselineAvailableCashMicros: "10000000",
    currentAvailableCashMicros: "9880000",
    observedDeltaMicros: "-120000",
    botAttributableDeltaMicros: "-120000",
    unexplainedDeltaMicros: "0",
  });
});

test("missing bot fees and ambiguous bot settlement value fail closed", () => {
  const missingFee = computeBotAttributableAvailableCashDelta(input("9.75", activity({
    botOrderIds: ["bot-order"],
    fills: [{
      id: "bot-fill",
      orderId: "bot-order",
      ticker: "KXTEST",
      action: "buy",
      countFp: "1",
      priceDollars: "0.25",
      feeCostDollars: null,
    }],
  })));
  assert.equal(missingFee.ok, false);

  const ambiguousSettlement = computeBotAttributableAvailableCashDelta(input("10.00", activity({
    botSettlementIds: ["settlement"],
    settlements: [{
      id: "settlement",
      ticker: "KXTEST",
      revenueCents: "100",
      feeCostDollars: "0.00",
    }],
  })));
  assert.equal(ambiguousSettlement.ok, false);
  if (!ambiguousSettlement.ok) {
    assert.equal(ambiguousSettlement.reason, "primary_cash_settlement_attribution_ambiguous");
  }
});

test("primary account checkpoint survives restart and reconciles partial, late-fill cash", () => {
  // This accountant only binds subaccount 0 and has no exchange-index identity;
  // do not treat this fixture as evidence for another subaccount/shard pair.
  const dedicatedBaseline = {
    ...baseline,
    availableCashMicros: "25000000",
    capturedAt: new Date(nowMs - 20_000).toISOString(),
  };
  const initial = reconcilePrimaryCashActivityCheckpoint(checkpointInput(
    activityScan({
      selectedSubaccount: 0,
      nextCursor: "primary-cursor-1",
      historyCoveredFrom: dedicatedBaseline.capturedAt,
    }),
    { baseline: dedicatedBaseline },
  ));
  assert.equal(initial.ok, true, "primary-subaccount checkpoint");
  if (!initial.ok) return;

  // Model process restart: only the durable cursor/digest and original $25
  // anchor are carried forward. The canceled exit's late fill is still
  // checkpointed as bot activity rather than being lost at restart.
  const lifecycleEvents = [
    checkpointEvent({
      id: "primary-entry-order",
      occurredAt: new Date(nowMs + 100).toISOString(),
    }),
    checkpointEvent({
      id: "primary-partial-entry-fill",
      kind: "fill",
      occurredAt: new Date(nowMs + 200).toISOString(),
      affectsBotMarket: true,
      affectsPositions: true,
      affectsReservedExposure: true,
    }),
    checkpointEvent({
      id: "primary-exit-canceled",
      occurredAt: new Date(nowMs + 300).toISOString(),
    }),
    checkpointEvent({
      id: "primary-late-exit-fill",
      kind: "fill",
      occurredAt: new Date(nowMs + 400).toISOString(),
      affectsBotMarket: true,
      affectsPositions: true,
    }),
  ];
  const afterRestart = reconcilePrimaryCashActivityCheckpoint(checkpointInput(
    activityScan({
      selectedSubaccount: 0,
      historyFromCursor: initial.nextCheckpoint.cursor,
      nextCursor: "primary-cursor-2",
      historyCoveredFrom: initial.nextCheckpoint.capturedAt,
      scanStartedAt: new Date(nowMs).toISOString(),
      scanFinishedAt: new Date(nowMs + 1_000).toISOString(),
      events: lifecycleEvents,
    }),
    {
      baseline: dedicatedBaseline,
      previousCheckpoint: initial.nextCheckpoint,
      nowMs: nowMs + 1_000,
    },
  ));
  assert.equal(afterRestart.ok, true);
  if (!afterRestart.ok) return;
  assert.equal(afterRestart.nextCheckpoint.cursor, "primary-cursor-2");
  assert.deepEqual(afterRestart.observedEventIds, [
    "primary-entry-order",
    "primary-exit-canceled",
    "primary-late-exit-fill",
    "primary-partial-entry-fill",
  ]);

  // The partial entry costs $0.49 plus its $0.01 fee, within the $1
  // fee-inclusive entry cap. A subsequent late exit fill returns $0.60 less
  // $0.01 fee, leaving an exact net cash gain of $0.09 from the $25 anchor.
  const finalActivity = activity({
    selectedSubaccount: 0,
    scanFinishedAt: new Date(nowMs + 1_000).toISOString(),
    botOrderIds: ["primary-entry", "primary-exit"],
    fills: [
      {
        id: "primary-entry-partial-fill",
        orderId: "primary-entry",
        ticker: "KXBTC15M",
        action: "buy",
        countFp: "1",
        priceDollars: "0.49",
        feeCostDollars: "0.01",
      },
      {
        id: "primary-late-exit-fill-evidence",
        orderId: "primary-exit",
        ticker: "KXBTC15M",
        action: "sell",
        countFp: "1",
        priceDollars: "0.60",
        feeCostDollars: "0.01",
      },
    ],
  });
  assert.equal(withinLiveTestCap(0, 49, 0, 10_000), true,
    "the actual cap helper accepts the 49-cent debit plus one-cent fee");
  assert.equal(withinLiveTestCap(0, 100, 0, 10_000), false,
    "the actual cap helper rejects a $1 debit plus a one-cent fee");
  const finalCash = computeBotAttributableAvailableCashDelta({
    baseline: dedicatedBaseline,
    currentRunId: dedicatedBaseline.runId,
    currentAvailableCashDollars: "25.09",
    activity: finalActivity,
    nowMs: nowMs + 1_000,
  });
  assert.deepEqual(finalCash, {
    ok: true,
    baselineAvailableCashMicros: "25000000",
    currentAvailableCashMicros: "25090000",
    observedDeltaMicros: "90000",
    botAttributableDeltaMicros: "90000",
    unexplainedDeltaMicros: "0",
  });

  // Even an offsetting pair of cash events remains individually visible; the
  // caller's existing startup policy blocks on any unrelated transfer.
  const unrelatedTransfer = checkpointEvent({
    id: "primary-unexplained-transfer",
    kind: "cash_transfer",
    classification: "unrelated_permitted",
    runId: null,
    occurredAt: new Date(nowMs + 1_500).toISOString(),
    cashDeltaMicros: "250000",
  });
  const transferScan = reconcilePrimaryCashActivityCheckpoint(checkpointInput(
    activityScan({
      selectedSubaccount: 0,
      historyFromCursor: afterRestart.nextCheckpoint.cursor,
      nextCursor: "primary-cursor-3",
      historyCoveredFrom: afterRestart.nextCheckpoint.capturedAt,
      scanStartedAt: new Date(nowMs + 1_000).toISOString(),
      scanFinishedAt: new Date(nowMs + 2_000).toISOString(),
      events: [unrelatedTransfer],
    }),
    {
      baseline: dedicatedBaseline,
      previousCheckpoint: afterRestart.nextCheckpoint,
      nowMs: nowMs + 2_000,
    },
  ));
  assert.equal(transferScan.ok, true);
  if (!transferScan.ok) return;
  assert.deepEqual(transferScan.unrelatedCashMovementIds, [
    "primary-unexplained-transfer",
  ]);
  const unexplainedCash = computeBotAttributableAvailableCashDelta({
    baseline: dedicatedBaseline,
    currentRunId: dedicatedBaseline.runId,
    currentAvailableCashDollars: "25.34",
    activity: { ...finalActivity, scanFinishedAt: new Date(nowMs + 2_000).toISOString() },
    nowMs: nowMs + 2_000,
  });
  assert.equal(unexplainedCash.ok, false);
  if (!unexplainedCash.ok) {
    assert.equal(unexplainedCash.reason, "primary_cash_delta_unexplained");
    assert.equal(unexplainedCash.unexplainedDeltaMicros, "250000");
  }
});

test("primary cash reconciliation remains fail-closed for non-primary selectors", () => {
  for (const selectedSubaccount of [-1, 1, 2, 63, 64, 2.5]) {
    const checkpoint = reconcilePrimaryCashActivityCheckpoint(checkpointInput(
      activityScan({ selectedSubaccount }),
    ));
    assert.equal(checkpoint.ok, false, `checkpoint selector ${selectedSubaccount}`);
    if (!checkpoint.ok) {
      assert.equal(checkpoint.reason, "primary_activity_history_unverified_or_incomplete");
    }

    const cash = computeBotAttributableAvailableCashDelta(input("10.00", activity({
      selectedSubaccount,
    })));
    assert.equal(cash.ok, false, `cash selector ${selectedSubaccount}`);
    if (!cash.ok) {
      assert.equal(cash.reason, "primary_cash_activity_unverified_or_incomplete");
    }
  }
});

test("numbered-subaccount cash reconciliation requires the exact immutable account/shard pair", () => {
  const pair = Object.freeze({ subaccountNumber: 2, exchangeIndex: 2 });
  const numberedBaseline = {
    ...baseline,
    availableCashMicros: "25000000",
    accountIdentity: pair,
  };
  const scan = reconcilePrimaryCashActivityCheckpoint(checkpointInput(activityScan({
    selectedSubaccount: pair.subaccountNumber,
    accountIdentity: pair,
    nextCursor: "subaccount-2-index-2-cursor-1",
  }), {
    baseline: numberedBaseline,
  }));
  assert.equal(scan.ok, true, "matching immutable (2, 2) identity is accepted");

  const cash = computeBotAttributableAvailableCashDelta({
    baseline: numberedBaseline,
    currentRunId: numberedBaseline.runId,
    currentAvailableCashDollars: "25.00",
    activity: activity({
      selectedSubaccount: pair.subaccountNumber,
      accountIdentity: pair,
    }),
    nowMs,
  });
  assert.equal(cash.ok, true, "the matching $25.00 baseline reconciles for (2, 2)");

  const mismatches = [
    {
      name: "missing baseline pair",
      baseline: { ...baseline, availableCashMicros: "25000000" },
      activityIdentity: pair,
    },
    {
      name: "missing activity pair",
      baseline: numberedBaseline,
      activityIdentity: undefined,
    },
    {
      name: "different subaccount number",
      baseline: numberedBaseline,
      activityIdentity: Object.freeze({ subaccountNumber: 1, exchangeIndex: 2 }),
    },
    {
      name: "different exchange index",
      baseline: numberedBaseline,
      activityIdentity: Object.freeze({ subaccountNumber: 2, exchangeIndex: 1 }),
    },
    {
      name: "invalid exchange index",
      baseline: numberedBaseline,
      activityIdentity: Object.freeze({ subaccountNumber: 2, exchangeIndex: -1 }),
    },
  ] as const;

  for (const mismatch of mismatches) {
    const checkpoint = reconcilePrimaryCashActivityCheckpoint(checkpointInput(activityScan({
      selectedSubaccount: pair.subaccountNumber,
      accountIdentity: mismatch.activityIdentity,
    }), {
      baseline: mismatch.baseline,
    }));
    assert.equal(checkpoint.ok, false, mismatch.name);
    if (!checkpoint.ok) {
      assert.equal(
        checkpoint.reason,
        "primary_activity_history_unverified_or_incomplete",
        mismatch.name,
      );
    }

    const reconciliation = computeBotAttributableAvailableCashDelta({
      baseline: mismatch.baseline,
      currentRunId: mismatch.baseline.runId,
      currentAvailableCashDollars: "25.00",
      activity: activity({
        selectedSubaccount: pair.subaccountNumber,
        accountIdentity: mismatch.activityIdentity,
      }),
      nowMs,
    });
    assert.equal(reconciliation.ok, false, mismatch.name);
    if (!reconciliation.ok) {
      assert.equal(
        reconciliation.reason,
        "primary_cash_activity_unverified_or_incomplete",
        mismatch.name,
      );
    }
  }
});