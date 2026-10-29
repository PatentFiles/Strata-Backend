import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  db, pool, forwardTestEngineTable, forwardTestEvaluationTable,
  forwardTestPositionTable, forwardTestWindowTable,
} from "@workspace/db";
import type { ForwardTestPosition } from "@workspace/db";
import { evaluateV13Strategy } from "@workspace/v13-strategy";
import {
  aggregateForwardTestStatistics, appendStrategyEvaluation, FORWARD_TEST_ENGINE_ID,
  claimMarketCrossing, createPaperPositionSafely, ForwardTestConflictError, getEngineStatus,
  getOpenPaperPosition, getOrCreateMarketWindow, getRecentStrategyEvaluations,
  settlePaperPositionSafely, updateMarketWindowCrossing, upsertEngineStatus,
} from "../lib/forwardTestRepository";
import { buildForwardTestHistory } from "./forwardTest";

const suffix = randomUUID();
const engineId = `TEST-${suffix}`;
const ticker = `TEST-KXBTC15M-${suffix}`;
const competingTicker = `TEST-COMPETING-${suffix}`;
const scoutId = `TEST-SCOUT-${suffix}`;
const confirmId = `TEST-CONFIRM-${suffix}`;
const evaluationIds = [`TEST-EVAL-1-${suffix}`, `TEST-EVAL-2-${suffix}`];
const now = new Date();

function historyFixture(index: number, pnl: number, status: "CLOSED" | "SETTLED" | "OPEN" = "CLOSED"): ForwardTestPosition {
  return {
    id: `HISTORY-${index}`,
    engineId: "v1.3-paper",
    marketTicker: `KXBTC15M-26SEP240${index}`,
    crossingKey: `cross-${index}`,
    strategyVersion: "V1.3",
    strategyParameterSetId: "v13-champion-2-c52-confirm53",
    strategyParameterHash: "314e7b49f5cd9782175dbb88fb7a05bbf80bb4c5e1458d0d48a15348b35f6161",
    entryPolicyVersion: null,
    direction: index % 2 ? "UP" : "DOWN",
    triggerType: index % 2 ? "SCOUT" : "CONFIRM",
    enteredAt: new Date(`2026-09-24T05:${String(index).padStart(2, "0")}:00Z`),
    entryOffer: 0.4,
    entryBid: 0.39,
    entrySpread: 0.01,
    entrySecondsRemaining: 600,
    entryBtcProviderAgeMs: 0,
    entryBtcReceiveAgeMs: 0,
    entryMarketAgeMs: 0,
    stake: 5,
    contracts: 12.5,
    target: 84_000,
    entryBtcPrice: 84_010,
    entryBuffer: 10,
    entryVelocity: null,
    status,
    closedAt: status === "OPEN" ? null : new Date(`2026-09-24T05:${String(index).padStart(2, "0")}:30Z`),
    exitPrice: status === "OPEN" ? null : 0.5,
    closeReason: status === "OPEN" ? null : "Momentum invalidated",
    settlementResult: status === "SETTLED" ? "UP" : null,
    payout: status === "OPEN" ? null : 5 + pnl,
    pnl: status === "OPEN" ? null : pnl,
    createdAt: new Date("2026-09-24T05:00:00Z"),
    updatedAt: new Date("2026-09-24T05:30:00Z"),
  };
}

test("server forward-test history summarizes only its position rows", () => {
  const firstFivePnls = [2.1, 3.71, 2.07, 1.14, -0.07];
  const firstFive = buildForwardTestHistory(firstFivePnls.map((pnl, index) => historyFixture(index + 1, pnl)));
  assert.equal(firstFive.positions.length, 5);
  assert.equal(firstFive.summary.completed, 5);
  assert.equal(firstFive.summary.wins, 4);
  assert.equal(firstFive.summary.losses, 1);
  assert.equal(firstFive.summary.totalStake, 25);
  assert.equal(firstFive.summary.totalPnl, 8.95);
  assert.equal(firstFive.summary.openPositionCount, 0);
  assert.equal(firstFive.executionAudit.mode, "PAPER_RESEARCH_ONLY");
  assert.equal(firstFive.executionAudit.netPnlVerified, null);
  assert.equal(firstFive.executionAudit.depthEvidenceAvailable, false);
  assert.equal(firstFive.executionAudit.assessedQuotes, 5);
  assert.equal(firstFive.executionAudit.hypotheticalScenarios.length, 3);
  assert.equal(firstFive.executionAudit.hypotheticalScenarios[0]?.netIsExecutable, false);
  assert.equal(firstFive.positions[0].enteredAt.toISOString(), "2026-09-24T05:01:00.000Z");
  assert.equal(firstFive.positions[0].status, "CLOSED");
  assert.equal(firstFive.positions[0].settlementResult, null);

  const withSixthAndOpen = buildForwardTestHistory([
    ...firstFivePnls.map((pnl, index) => historyFixture(index + 1, pnl)),
    historyFixture(6, -0.05),
    historyFixture(7, 999, "OPEN"),
  ]);
  assert.equal(withSixthAndOpen.summary.completed, 6);
  assert.equal(withSixthAndOpen.summary.wins, 4);
  assert.equal(withSixthAndOpen.summary.losses, 2);
  assert.equal(withSixthAndOpen.summary.totalStake, 30);
  assert.equal(withSixthAndOpen.summary.totalPnl, 8.9);
  assert.equal(withSixthAndOpen.summary.openPositionCount, 1);
  assert.equal(withSixthAndOpen.positions.at(-1)?.pnl, null);
});

after(async () => {
  try {
    await db.delete(forwardTestPositionTable).where(eq(forwardTestPositionTable.marketTicker, ticker));
    await db.delete(forwardTestEvaluationTable).where(eq(forwardTestEvaluationTable.marketTicker, ticker));
    await db.delete(forwardTestWindowTable).where(eq(forwardTestWindowTable.ticker, ticker));
    await db.delete(forwardTestWindowTable).where(eq(forwardTestWindowTable.ticker, competingTicker));
    await db.delete(forwardTestEngineTable).where(eq(forwardTestEngineTable.id, engineId));
  } finally {
    await pool.end();
  }
});

test("persistent V1.3 state survives reconnect and actions are idempotent", async () => {
  const input = {
    marketTicker: ticker, btcPrice: 84010, target: 84000,
    previousBuffer: -1, velocity: 20, upOffer: 0.52, downOffer: 0.45,
    freshness: "current" as const, position: null,
  };
  const before = evaluateV13Strategy(input);
  assert.equal(before.signal, "SCOUT");
  assert.equal(before.direction, "UP");
  assert.equal(before.qualifyingTrigger, true);
  assert.equal(before.entrySideOffer, 0.52);

  await upsertEngineStatus({
    enabled: false, lastHeartbeatAt: now, marketTicker: ticker,
    signal: "SCOUT", direction: "UP", signedBuffer: 10,
    btcPrice: 84010, target: 84000, upOffer: 0.52, downOffer: 0.45,
  }, engineId);
  await getOrCreateMarketWindow({
    ticker, target: 84000, startsAt: now,
    endsAt: new Date(now.getTime() + 15 * 60_000),
  });
  await updateMarketWindowCrossing(ticker, {
    previousSide: "DOWN", currentSide: "UP", previousBuffer: -1,
  });
  await claimMarketCrossing(ticker, "first", "UP", now);
  const crossed = await updateMarketWindowCrossing(ticker, {
    crossingConsumed: true, scoutTriggered: true,
  });
  assert.equal(crossed.crossingConsumed, true);
  await getOrCreateMarketWindow({ ticker: competingTicker, target: 84000 });
  const claims = await Promise.allSettled([
    claimMarketCrossing(competingTicker, "first", "UP", now),
    claimMarketCrossing(competingTicker, "second", "DOWN", now),
  ]);
  assert.equal(claims.filter((claim) => claim.status === "fulfilled").length, 1);
  assert.equal(claims.filter((claim) => claim.status === "rejected").length, 1);
  assert.equal((await getOrCreateMarketWindow({ ticker: competingTicker, target: 84000 })).firstCrossOccurred, true);

  // Drop a physical client, then read through a newly acquired DB connection.
  const oldClient = await pool.connect();
  oldClient.release(true);
  const newClient = await pool.connect();
  try {
    const status = await newClient.query(
      "SELECT enabled, market_ticker, signal FROM forward_test_engine WHERE id = $1", [engineId],
    );
    const window = await newClient.query(
      "SELECT crossing_consumed, previous_buffer FROM forward_test_windows WHERE ticker = $1", [ticker],
    );
    assert.equal(status.rows[0].market_ticker, ticker);
    assert.equal(status.rows[0].signal, "SCOUT");
    assert.equal(status.rows[0].enabled, false);
    assert.equal(window.rows[0].crossing_consumed, true);
    assert.equal(window.rows[0].previous_buffer, -1);
  } finally {
    newClient.release();
  }
  assert.equal((await getEngineStatus(engineId))?.marketTicker, ticker);
  await updateMarketWindowCrossing(ticker, {
    crossingConsumed: false, scoutTriggered: false,
  });
  const reloaded = await getOrCreateMarketWindow({ ticker, target: 84000 });
  assert.equal(reloaded.crossingConsumed, true);
  assert.equal(reloaded.firstCrossOccurred, true);
  assert.equal(reloaded.scoutTriggered, true);
  await assert.rejects(claimMarketCrossing(ticker, "new-crossing", "DOWN", now), ForwardTestConflictError);
  assert.equal((await getOrCreateMarketWindow({ ticker, target: 84000 })).crossingKey, "first");
  await assert.rejects(
    getOrCreateMarketWindow({ ticker, target: 84001 }),
    ForwardTestConflictError,
  );

  const evaluation = {
    strategyVersion: "V1.3", marketTicker: ticker, btcPrice: 84010,
    target: 84000, signedBuffer: 10, absoluteBuffer: 10, velocity: 20,
    upOffer: 0.52, downOffer: 0.45, secondsRemaining: 700,
    feedFreshness: "current", previousSide: "DOWN", currentSide: "UP",
    freshCross: true, crossingConsumed: true, crossingKey: "first",
    signal: "SCOUT", direction: "UP",
    qualifyingTrigger: true, reason: "C52/53 qualifying Scout fixture",
    entryOffer: 0.52, positionWasOpen: false,
  };
  await appendStrategyEvaluation({
    ...evaluation, id: evaluationIds[0], evaluatedAt: now,
  });
  await appendStrategyEvaluation({
    ...evaluation, id: evaluationIds[1], evaluatedAt: new Date(now.getTime() + 1000),
  });
  await assert.rejects(appendStrategyEvaluation({
    ...evaluation, id: evaluationIds[0], evaluatedAt: now,
  }));
  const recent = await getRecentStrategyEvaluations(100);
  const own = recent.filter((item) => item.marketTicker === ticker);
  assert.deepEqual(own.map((item) => item.id), [evaluationIds[1], evaluationIds[0]]);

  const positionBase = {
    engineId, marketTicker: ticker, crossingKey: "first",
    direction: "UP", enteredAt: now, entryOffer: 0.52,
    stake: 5, contracts: 5 / 0.52, target: 84000,
    entryBtcPrice: 84010, entryBuffer: 10,
  };
  const scout = await createPaperPositionSafely({
    ...positionBase, id: scoutId, triggerType: "SCOUT",
  });
  const duplicateScout = await createPaperPositionSafely({
    ...positionBase, id: `TEST-DUP-${suffix}`, triggerType: "SCOUT",
  });
  assert.equal(duplicateScout.id, scout.id);
  await assert.rejects(createPaperPositionSafely({
    ...positionBase, id: `TEST-BAD-${suffix}`, triggerType: "SCOUT", stake: 6,
  }), ForwardTestConflictError);
  assert.equal((await getOpenPaperPosition(engineId))?.id, scoutId);
  await assert.rejects(createPaperPositionSafely({
    ...positionBase, id: confirmId, triggerType: "CONFIRM",
  }), ForwardTestConflictError);

  const settlement = {
    status: "SETTLED" as const, closedAt: new Date(now.getTime() + 900_000),
    settlementResult: "UP", payout: 5 / 0.52, pnl: 5 / 0.52 - 5,
  };
  const closed = await settlePaperPositionSafely(scoutId, settlement);
  const repeated = await settlePaperPositionSafely(scoutId, {
    ...settlement, closedAt: new Date(now.getTime() + 901_000),
  });
  assert.equal(repeated.id, closed.id);
  assert.equal(repeated.payout, closed.payout);
  assert.equal(repeated.closedAt?.getTime(), closed.closedAt?.getTime());
  await assert.rejects(settlePaperPositionSafely(scoutId, {
    ...settlement, pnl: 999,
  }), ForwardTestConflictError);
  assert.equal(await getOpenPaperPosition(engineId), null);

  const confirm = await createPaperPositionSafely({
    ...positionBase, id: confirmId, triggerType: "CONFIRM",
  });
  const duplicateConfirm = await createPaperPositionSafely({
    ...positionBase, id: `TEST-DUP-CONFIRM-${suffix}`, triggerType: "CONFIRM",
  });
  assert.equal(duplicateConfirm.id, confirm.id);
  await settlePaperPositionSafely(confirmId, {
    status: "CLOSED", closedAt: now, settlementResult: null,
    payout: 4, pnl: -1,
  });
  const [actual] = await db.select().from(forwardTestPositionTable)
    .where(and(eq(forwardTestPositionTable.marketTicker, ticker),
      eq(forwardTestPositionTable.triggerType, "CONFIRM")));
  assert.equal(actual.status, "CLOSED");

  const stats = await aggregateForwardTestStatistics();
  assert.ok(stats.evaluationCount >= 2);
  assert.ok(stats.triggerCount >= 2);
  assert.ok(stats.completedPaperForwardTests >= 2);
  // Display aggregates must preserve the original producer statistics while
  // the status route coalesces expensive reads; they grant no live authority.
  const { readForwardTestStatus } = await import("./forwardTest");
  const cachedStatus = await readForwardTestStatus();
  assert.equal(cachedStatus.evaluationCount, stats.evaluationCount);
  assert.equal(cachedStatus.triggerCount, stats.triggerCount);
  const scopedStats = await aggregateForwardTestStatistics(FORWARD_TEST_ENGINE_ID);
  assert.equal(cachedStatus.completedPaperForwardTests, scopedStats.completedPaperForwardTests);
  assert.equal(cachedStatus.cumulativePaperPnl, scopedStats.cumulativePaperPnl);
  assert.deepEqual(evaluateV13Strategy(input), before);
});