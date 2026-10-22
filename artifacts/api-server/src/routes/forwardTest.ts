import { getAuth } from "@clerk/express";
import {
  GetForwardTestHistoryResponse,
  GetForwardTestStatusResponse,
} from "@workspace/api-zod";
import { db, forwardTestEvaluationTable, forwardTestPositionTable, forwardTestWindowTable } from "@workspace/db";
import { readKalshiBrtiShadowStatus } from "../lib/kalshiBrtiShadowStream";
import { auditHistoricalPaperExecution } from "../lib/forwardTestExecutionAudit";
import { compareBrtiToKalshiStrike } from "../lib/cfBenchmarksSettlement";
import { and, desc, eq, sql } from "drizzle-orm";
import { Router, type IRouter, type RequestHandler } from "express";
import {
  aggregateForwardTestStatistics,
  FORWARD_TEST_ENGINE_ID,
  getEngineStatus,
} from "../lib/forwardTestRepository";

const router: IRouter = Router();

const requireUser: RequestHandler = (req, res, next) => {
  if (!getAuth(req).userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
};

router.use("/forward-test", requireUser);

export async function readForwardTestStatus() {
  const [engine, statistics, [openPosition], [lastSettlement], [breakdown], [triggers]] = await Promise.all([
    getEngineStatus(),
    aggregateForwardTestStatistics(FORWARD_TEST_ENGINE_ID),
    db.select().from(forwardTestPositionTable)
      .where(and(eq(forwardTestPositionTable.engineId, FORWARD_TEST_ENGINE_ID),
        eq(forwardTestPositionTable.status, "OPEN"))).limit(1),
    db.select().from(forwardTestPositionTable)
      .where(and(eq(forwardTestPositionTable.engineId, FORWARD_TEST_ENGINE_ID),
        eq(forwardTestPositionTable.status, "SETTLED")))
      .orderBy(desc(forwardTestPositionTable.closedAt)).limit(1),
    db.select({
      wins: sql<number>`count(*) FILTER (WHERE ${forwardTestPositionTable.status} IN ('SETTLED', 'CLOSED') AND ${forwardTestPositionTable.pnl} > 0)::integer`,
      losses: sql<number>`count(*) FILTER (WHERE ${forwardTestPositionTable.status} IN ('SETTLED', 'CLOSED') AND ${forwardTestPositionTable.pnl} <= 0)::integer`,
    }).from(forwardTestPositionTable)
      .where(eq(forwardTestPositionTable.engineId, FORWARD_TEST_ENGINE_ID)),
    db.select({
      scoutTriggers: sql<number>`count(*) FILTER (WHERE ${forwardTestEvaluationTable.qualifyingTrigger} = true AND ${forwardTestEvaluationTable.signal} = 'SCOUT')::integer`,
      confirmTriggers: sql<number>`count(*) FILTER (WHERE ${forwardTestEvaluationTable.qualifyingTrigger} = true AND ${forwardTestEvaluationTable.signal} = 'CONFIRM')::integer`,
    }).from(forwardTestEvaluationTable),
  ]);
  const [window] = engine?.marketTicker
    ? await db.select().from(forwardTestWindowTable)
      .where(eq(forwardTestWindowTable.ticker, engine.marketTicker)).limit(1)
    : [];
  const running = Boolean(engine?.enabled && engine.leaseOwner &&
    engine.leaseExpiresAt && engine.leaseExpiresAt.getTime() > Date.now());
  return GetForwardTestStatusResponse.parse({
    engineId: engine?.id ?? null,
    engineMode: "PAPER_ONLY",
    strategyVersion: "V1.3",
    enabled: engine?.enabled ?? false,
    workerRunning: running,
    workerOwner: running ? engine?.leaseOwner?.slice(0, 8) ?? null : null,
    leaseAcquiredAt: engine?.leaseAcquiredAt?.toISOString() ?? null,
    lastAttemptedCycleAt: engine?.lastAttemptedCycleAt?.toISOString() ?? null,
    lastSuccessfulCycleAt: engine?.lastSuccessfulCycleAt?.toISOString() ?? null,
    cycleCount: engine?.cycleCount ?? 0,
    workerUptimeSeconds: running && engine?.workerStartedAt
      ? Math.max(0, Math.floor((Date.now() - engine.workerStartedAt.getTime()) / 1000)) : null,
    lastHeartbeatAt: engine?.lastHeartbeatAt?.toISOString() ?? null,
    lastMarketPollAt: engine?.lastMarketPollAt?.toISOString() ?? null,
    lastEvaluationAt: engine?.lastEvaluationAt?.toISOString() ?? null,
    marketTicker: engine?.marketTicker ?? null,
    activeWindow: window ? {
      ticker: window.ticker, startsAt: window.startsAt?.toISOString() ?? null,
      endsAt: window.endsAt?.toISOString() ?? null, target: window.target,
      firstCrossOccurred: window.firstCrossOccurred,
      crossingConsumed: window.crossingConsumed,
      scoutTriggered: window.scoutTriggered,
      confirmTriggered: window.confirmTriggered,
      finalized: window.finalized,
    } : null,
    signal: engine?.signal ?? null,
    direction: engine?.direction ?? null,
    currentReason: engine?.currentReason ?? null,
    signedBuffer: engine?.signedBuffer ?? null,
    btcPrice: engine?.btcPrice ?? null,
    target: engine?.target ?? null,
    upOffer: engine?.upOffer ?? null,
    downOffer: engine?.downOffer ?? null,
    lastTriggerType: engine?.lastTriggerType ?? null,
    lastTriggerAt: engine?.lastTriggerAt?.toISOString() ?? null,
    openPaperPosition: openPosition ? {
      id: openPosition.id, ticker: openPosition.marketTicker,
      direction: openPosition.direction, triggerType: openPosition.triggerType,
      enteredAt: openPosition.enteredAt.toISOString(), stake: openPosition.stake,
      entryOffer: openPosition.entryOffer,
      confirmTriggered: window?.ticker === openPosition.marketTicker
        ? window.confirmTriggered : openPosition.triggerType === "CONFIRM",
    } : null,
    markPrice: openPosition ? engine?.markPrice ?? null : null,
    unrealizedPaperPnl: openPosition ? engine?.unrealizedPnl ?? null : null,
    lastSettlement: lastSettlement?.closedAt && lastSettlement.pnl !== null ? {
      ticker: lastSettlement.marketTicker, closedAt: lastSettlement.closedAt.toISOString(),
      result: lastSettlement.settlementResult, pnl: lastSettlement.pnl,
    } : null,
    lastError: engine?.lastError ?? null,
    databaseConnectionStatus: "CONNECTED",
    ...statistics,
    ...breakdown,
    ...triggers,
  });
}

/**
 * Authenticated read-only CF Benchmarks market-reference diagnostics.
 * Does not return credentials, provide a provider settlement verdict, or
 * change the Coinbase champion's execution threshold.
 */
export async function readForwardTestBrtiReference() {
  const status=readKalshiBrtiShadowStatus();
  let comparison=null;
  let spotComparison=null;
  if((status.sourceFresh&&status.lastFrame)||(status.instantSourceFresh&&status.lastIndex)){
    try {
      const engine=await getEngineStatus();
      const [window]=engine?.marketTicker
        ? await db.select().from(forwardTestWindowTable)
          .where(eq(forwardTestWindowTable.ticker,engine.marketTicker)).limit(1)
        : [];
      if(window?.target!=null&&window.endsAt&&window.startsAt){
        if(status.sourceFresh&&status.lastFrame){
          comparison=compareBrtiToKalshiStrike(status.lastFrame,{
            ticker:window.ticker,target:window.target,
            closeAtMs:window.endsAt.getTime(),coinbaseSpot:engine?.btcPrice,
          });
        }
        const tick=status.lastIndex;
        if(status.instantSourceFresh&&tick&&
           tick.sourceTimestampMs>=window.startsAt.getTime()&&
           tick.sourceTimestampMs<=window.endsAt.getTime()){
          const p=Number(tick.currentIndexUsd);
          const coinbase=engine?.btcPrice;
          spotComparison={
            ticker:window.ticker,
            source:"CF_BENCHMARKS_BRTI_CURRENT_INDEX",
            spotUsd:tick.currentIndexUsd,
            strikeUsd:window.target.toFixed(2),
            spreadToStrikeUsd:Math.round((p-window.target)*100)/100,
            coinbaseBasisUsd:typeof coinbase==="number"&&Number.isFinite(coinbase)&&coinbase>0
              ?Math.round((coinbase-p)*100)/100:null,
            observedAtMs:tick.sourceTimestampMs,
            settlementAuthority:false,readOnly:true,tradingAuthority:false,
          };
        }
      }
    }catch{/* No same-market signal/target => no calculated comparison. */}
  }
  return {...status,comparison,spotComparison,producer:"KALSHI_AUTHENTICATED_CF_BENCHMARKS",
    sourceIndex:"BRTI",readOnly:true,paperOnly:true,tradingAuthority:false,
    warning:"Reference only. Not a Kalshi official settlement or entry authorization."};
}

// Legacy Clerk-authenticated endpoint keeps the same payload. The modern
// Supabase-authenticated Strata router calls this same read-only implementation.
router.get("/forward-test/settlement-reference", async (_req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  res.json(await readForwardTestBrtiReference());
});

router.get("/forward-test/status", async (_req, res): Promise<void> => {
  res.json(await readForwardTestStatus());
});

type ForwardTestPosition = typeof forwardTestPositionTable.$inferSelect;

export function buildForwardTestHistory(rows: ForwardTestPosition[]) {
  const positions = rows.map((row) => ({
    id: row.id,
    marketTicker: row.marketTicker,
    strategyVersion: row.strategyVersion,
    triggerType: row.triggerType,
    direction: row.direction,
    enteredAt: row.enteredAt.toISOString(),
    entryBtcPrice: row.entryBtcPrice,
    target: row.target,
    entryOffer: row.entryOffer,
    stake: row.stake,
    contracts: row.contracts,
    status: row.status,
    closedAt: row.closedAt?.toISOString() ?? null,
    exitPrice: row.exitPrice,
    closeReason: row.closeReason,
    settlementResult: row.settlementResult,
    payout: row.payout,
    pnl: row.pnl,
  }));
  const completed = rows.filter((row) => row.status === "CLOSED" || row.status === "SETTLED");
  const original = GetForwardTestHistoryResponse.parse({
    positions,
    summary: {
      completed: completed.length,
      wins: completed.filter((row) => row.pnl !== null && row.pnl > 0).length,
      losses: completed.filter((row) => row.pnl !== null && row.pnl <= 0).length,
      totalStake: completed.reduce((total, row) => total + row.stake, 0),
      totalPnl: completed.reduce(
        (totalCents, row) => totalCents + Math.round((row.pnl ?? 0) * 100),
        0,
      ) / 100,
      openPositionCount: rows.filter((row) => row.status === "OPEN").length,
    },
  });
  // The original quote-based history and API schema stay backward compatible.
  // Additive research-only audit; no change to positions, champion or orders.
  return {...original, executionAudit: auditHistoricalPaperExecution(rows)};
}

export async function readForwardTestHistory() {
  const rows = await db.select().from(forwardTestPositionTable)
    .where(eq(forwardTestPositionTable.engineId, FORWARD_TEST_ENGINE_ID))
    .orderBy(desc(forwardTestPositionTable.enteredAt), desc(forwardTestPositionTable.id));
  return buildForwardTestHistory(rows);
}

router.get("/forward-test/history", async (_req, res): Promise<void> => {
  res.json(await readForwardTestHistory());
});

export default router;