import {notifyCommittedForwardSignal} from "./forwardTestSignalWake";
import {producerDelayMs,OptionalResearchLane,BoundaryDiscoveryRecovery,shadowOpportunityRecordingEnabled} from "./forwardTestCadence";
import { randomUUID } from "node:crypto";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import {
  forwardTestBtcPointTable, forwardTestEngineTable,
  forwardTestEvaluationTable, forwardTestPositionTable, forwardTestWindowTable,
  type ForwardTestPosition,
} from "@workspace/db";
import {
  evaluateV13Strategy,
  V13_ENTRY_POLICY_VERSION, entryCrossAvailable,
  V13_CHAMPION_PARAMETER_HASH,
  V13_CHAMPION_PARAMETER_SET,
} from "@workspace/v13-strategy";
import {
  acquireWorkerLease, ensureWorkerEngine, FORWARD_TEST_ENGINE_ID,
  getOpenPaperPosition, releaseWorkerLease, renewWorkerLease,
  upsertEngineStatus, withWorkerLeaseTransaction, WorkerLeaseLostError,
} from "./forwardTestRepository";
import {
  publicForwardTestFeeds,
  type BtcObservation, type ForwardTestFeeds, type MarketObservation,
} from "./forwardTestFeeds";
import { logger } from "./logger";
import { savePostActionPaperBook, type PaperBookCaptureEvent } from "./forwardTestBookCapture";
import { forwardTestStartupDecision } from "./forwardTestStartupGate";
export { isForwardTestWorkerEnabled } from "./forwardTestStartupGate";
import { processMicroLiveForwardTestCycle, registerMicroLiveWorkerLeaseOwner } from "./microLive";
import { ensureV13BuiltInResearchChallengers, recordV13ShadowOpportunities } from "./v13StrategyResearch";
import { autonomousShadowLearningConfigured, runAutonomousShadowResearch } from "./v13AutonomousShadowLearning";

export const FORWARD_TEST_CADENCE_MS = 5_000;
const LEASE_SECONDS = 20;
const FRESHNESS_MS = 15_000;
const POINT_HISTORY_MS = 120_000;
const PAPER_STAKE = 5;

export type WorkerIdentity = {
  owner: string;
  epoch: number;
  engineId?: string;
};

export type CycleOptions = WorkerIdentity & {
  feeds?: ForwardTestFeeds;
  now?: Date;
  signal?: AbortSignal;
};

export type CycleResult = {
  evaluationId: string | null;
  signal: string | null;
  marketTicker: string | null;
  positionId: string | null;
  error: string | null;
  /** Research receipt only. No fill or live-order authority. */
  researchEvent?: PaperBookCaptureEvent;
};

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function validOffer(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0 && value <= 1;
}

function sideOf(buffer: number) {
  return buffer > 0 ? "UP" : buffer < 0 ? "DOWN" : "AT";
}

function feedError(
  btc: BtcObservation,
  market: MarketObservation,
  now: Date,
  hasOpenPosition: boolean,
) {
  const age = (value: Date) => now.getTime() - value.getTime();
  if (!Number.isFinite(btc.price) || btc.price <= 0 ||
      !Number.isFinite(btc.receivedAt.getTime()) ||
      !Number.isFinite(btc.providerAt.getTime()) ||
      age(btc.providerAt) < -FRESHNESS_MS || age(btc.providerAt) > FRESHNESS_MS ||
      age(btc.receivedAt) < -FRESHNESS_MS || age(btc.receivedAt) > FRESHNESS_MS) {
    return "Coinbase BTC feed is missing, malformed, or stale";
  }
  if (!market.ticker.startsWith("KXBTC15M") ||
      !Number.isFinite(market.fetchedAt.getTime()) ||
      age(market.fetchedAt) < -FRESHNESS_MS || age(market.fetchedAt) > FRESHNESS_MS ||
      market.target === null || !Number.isFinite(market.target) || market.target <= 0 ||
      market.endsAt === null || !Number.isFinite(market.endsAt.getTime())) {
    return "Kalshi market ticker, target, end time, or snapshot is missing or stale";
  }
  if (!hasOpenPosition && (
    market.startsAt === null || !Number.isFinite(market.startsAt.getTime()) ||
    market.startsAt.getTime() > now.getTime() ||
    market.startsAt.getTime() >= market.endsAt.getTime() ||
    (market.status !== "open" && market.status !== "active") ||
    market.endsAt.getTime() <= now.getTime() ||
    !validOffer(market.yesAsk) || !validOffer(market.noAsk)
  )) return "Kalshi market is closed or a required side offer is missing";
  if (hasOpenPosition && market.result === null &&
      market.endsAt.getTime() > now.getTime() &&
      market.status !== "open" && market.status !== "active") {
    return "Open paper position's Kalshi market is no longer active without settlement";
  }
  if (hasOpenPosition && market.result === null &&
      market.endsAt.getTime() > now.getTime() &&
      (!validOffer(market.yesPrice) || !validOffer(market.noPrice) ||
       !validOffer(market.yesBid) || !validOffer(market.noBid))) {
    return "Open paper position cannot be marked or exited with a missing executable bid";
  }
  // An already-open position can settle only from an explicit Kalshi result.
  // Expiry alone is not settlement evidence, and a missing quote never
  // authorizes a new entry.
  return null;
}

function velocityOf(points: { price: number; time: number }[]) {
  if (points.length < 2) return null;
  const newest = points[points.length - 1];
  const cutoff = newest.time - 30_000;
  const oldest = points.find((point) => point.time >= cutoff) ?? points[0];
  const elapsedMinutes = (newest.time - oldest.time) / 60_000;
  return elapsedMinutes <= 0 ? null : (newest.price - oldest.price) / elapsedMinutes;
}

// Settlement requires an explicit Kalshi result. Coinbase/BTC observations
// are strategy inputs, not authoritative settlement evidence.
export function paperClose(
  position: Pick<ForwardTestPosition, "direction" | "contracts" | "stake">,
  market: MarketObservation,
  buffer: number,
  exitIntent: string | null,
  now: Date,
) {
  let exitPrice: number;
  let status: "SETTLED" | "CLOSED";
  let reason: string;
  let settlementResult: string | null = null;
  if (market.result !== null) {
    exitPrice = market.result === (position.direction === "UP" ? "yes" : "no") ? 1 : 0;
    status = "SETTLED";
    reason = "Kalshi settled";
    settlementResult = market.result === "yes" ? "UP" : "DOWN";
  } else if (exitIntent) {
    const executableBid = position.direction === "UP" ? market.yesBid : market.noBid;
    if (!validOffer(executableBid)) return null;
    exitPrice = executableBid;
    status = "CLOSED";
    reason = exitIntent;
  } else {
    return null;
  }
  const payout = position.contracts * exitPrice;
  return {
    status, closedAt: now, exitPrice, closeReason: reason,
    settlementResult, payout, pnl: roundMoney(payout - position.stake),
  };
}

async function recordCycleError(identity: WorkerIdentity, reason: string) {
  // Error reporting itself is fenced; a former leader cannot overwrite the
  // current worker's status even if its failed HTTP request completes late.
  await withWorkerLeaseTransaction(identity.owner, identity.epoch, async (tx) => {
    await tx.update(forwardTestEngineTable).set({
      lastError: reason,
      currentReason: `DATA ERROR — ${reason}`,
      signal: "PASS",
      direction: "NONE",
      lastAttemptedCycleAt: sql`clock_timestamp()`,
      cycleCount: sql`${forwardTestEngineTable.cycleCount} + 1`,
      updatedAt: new Date(),
    }).where(eq(forwardTestEngineTable.id, identity.engineId ?? FORWARD_TEST_ENGINE_ID));
  }, identity.engineId);
  // Preserve failed attempts after the engine status is cleared by recovery.
  // This is diagnostic only; no evaluation or entry authority is created.
  logger.warn({event:"forward_test_cycle_rejected",engineId:identity.engineId??FORWARD_TEST_ENGINE_ID,
    epoch:identity.epoch,reason:reason.slice(0,500)}, "Paper producer cycle rejected");
}

export async function runForwardTestCycle(options: CycleOptions): Promise<CycleResult> {
  const { owner, epoch, engineId = FORWARD_TEST_ENGINE_ID,
    feeds = publicForwardTestFeeds, signal } = options;
  if (!await renewWorkerLease(owner, epoch, engineId, LEASE_SECONDS)) {
    throw new WorkerLeaseLostError("Worker no longer owns the active lease");
  }
  const now = options.now ?? new Date();
  await withWorkerLeaseTransaction(owner, epoch, async (tx) => {
    await tx.update(forwardTestEngineTable).set({ lastAttemptedCycleAt: now })
      .where(eq(forwardTestEngineTable.id, engineId));
  }, engineId);
  let btc: BtcObservation;
  let market: MarketObservation;
  let currentMarket: MarketObservation;
  const priorPosition = await getOpenPaperPosition(engineId);
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(8_000)])
    : AbortSignal.timeout(8_000);
  try {
    [btc, currentMarket] = await Promise.all([
      feeds.btc(requestSignal), feeds.market(undefined, requestSignal),
    ]);
    market = priorPosition && priorPosition.marketTicker !== currentMarket.ticker
      ? await feeds.market(priorPosition.marketTicker, requestSignal)
      : currentMarket;
    if (priorPosition && market.ticker !== priorPosition.marketTicker) {
      throw new Error("Open paper position does not match the fetched market window");
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    const reason = error instanceof Error ? error.message : "Public market feed unavailable";
    await recordCycleError({ owner, epoch, engineId }, reason);
    return { evaluationId: null, signal: "PASS", marketTicker: null, positionId: null, error: reason };
  }
  const invalid = feedError(btc, market, now, Boolean(priorPosition));
  if (invalid) {
    await recordCycleError({ owner, epoch, engineId }, invalid);
    return { evaluationId: null, signal: "PASS", marketTicker: market.ticker,
      positionId: priorPosition?.id ?? null, error: invalid };
  }
  // target is validated above. Never invent a target/quote on malformed data.
  const target = market.target!;
  try {
  const result = await withWorkerLeaseTransaction(owner, epoch, async (tx, engine) => {
    const [openPosition] = await tx.select().from(forwardTestPositionTable)
      .where(and(eq(forwardTestPositionTable.engineId, engineId),
        eq(forwardTestPositionTable.status, "OPEN"))).for("update").limit(1);
    if ((openPosition?.id ?? null) !== (priorPosition?.id ?? null)) {
      throw new Error("Open position changed while market data was fetched; retry with a coherent snapshot");
    }
    await tx.insert(forwardTestWindowTable).values({
      ticker: market.ticker, target, startsAt: market.startsAt, endsAt: market.endsAt,
      entryPolicyVersion: V13_ENTRY_POLICY_VERSION,
    }).onConflictDoNothing();
    const [persistedWindow] = await tx.select().from(forwardTestWindowTable)
      .where(eq(forwardTestWindowTable.ticker, market.ticker)).for("update").limit(1);
    if (!persistedWindow || persistedWindow.target !== target ||
        (engine.marketTicker && engine.marketTicker !== market.ticker &&
          openPosition && openPosition.marketTicker !== market.ticker)) {
      throw new Error("BTC observation and Kalshi market window are inconsistent");
    }

    const cutoff = new Date(btc.receivedAt.getTime() - POINT_HISTORY_MS);
    await tx.delete(forwardTestBtcPointTable)
      .where(and(eq(forwardTestBtcPointTable.engineId, engineId),
        lt(forwardTestBtcPointTable.observedAt, cutoff)));
    await tx.insert(forwardTestBtcPointTable).values({
      id: randomUUID(), engineId, price: btc.price, observedAt: btc.receivedAt,
    });
    const samples = await tx.select().from(forwardTestBtcPointTable)
      .where(eq(forwardTestBtcPointTable.engineId, engineId))
      .orderBy(desc(forwardTestBtcPointTable.observedAt)).limit(180);
    const points = samples.reverse().map((point) => ({
      price: point.price, time: point.observedAt.getTime(),
    }));
    const velocity = velocityOf(points);
    const previousBuffer = persistedWindow.previousBuffer;
    const decision = evaluateV13Strategy({
      marketTicker: market.ticker, btcPrice: btc.price, target,
      previousBuffer, velocity,
      upOffer: market.yesAsk, downOffer: market.noAsk,
      freshness: "current",
      position: openPosition
        ? { status: "open", direction: openPosition.direction === "UP" ? "up" : "down" }
        : null,
    });
    if (decision.buffer === null) throw new Error("V1.3 did not produce a signed buffer");
    const direction = sideOf(decision.buffer);
    const crossingKey = `${market.ticker}:first`;
    // The window row is locked; only its first actual strike crossing may
    // become the persistent crossing identity. Later recrosses cannot rename it.
    const firstCross = decision.freshCross && !persistedWindow.firstCrossOccurred;
    if (firstCross) {
      await tx.update(forwardTestWindowTable).set({
        firstCrossOccurred: true, crossingKey,
        crossingDirection: decision.crossedDirection?.toUpperCase() ?? null,
        crossingAt: now,
      }).where(eq(forwardTestWindowTable.ticker, market.ticker));
    }
    const crossAvailable = entryCrossAvailable(persistedWindow.entryPolicyVersion, persistedWindow, decision.freshCross);
    const actionable = !openPosition &&
      crossAvailable &&
      decision.qualifyingTrigger &&
      decision.entrySideOffer !== null && validOffer(market.yesAsk) && validOffer(market.noAsk) &&
      (decision.signal === "SCOUT" || decision.signal === "CONFIRM");
    // Strategy labels alone do not mean a new window entry is eligible.
    // Persist the actual admission explanation instead of suggesting a missed trade.
    const candidateSignal = decision.signal === "SCOUT" || decision.signal === "CONFIRM";
    const admissionBlock = !candidateSignal || actionable ? null
      : openPosition ? "paper position already open"
      : !crossAvailable ? "window crossing consumed or unavailable"
      : !decision.qualifyingTrigger ? "strategy trigger not qualifying"
      : "required executable side offer missing";
    const evaluationReason = admissionBlock
      ? `${decision.reason} — ENTRY INELIGIBLE: ${admissionBlock}` : decision.reason;
    const evaluationId = randomUUID();
    await tx.insert(forwardTestEvaluationTable).values({
      id: evaluationId, evaluatedAt: now, strategyVersion: "V1.3",
      strategyParameterSetId: V13_CHAMPION_PARAMETER_SET.id,
      strategyParameterHash: V13_CHAMPION_PARAMETER_HASH,
      entryPolicyVersion: persistedWindow.entryPolicyVersion,
      marketTicker: market.ticker, btcPrice: btc.price, target,
      signedBuffer: decision.buffer, absoluteBuffer: Math.abs(decision.buffer),
      velocity, upBid: market.yesBid, upOffer: market.yesAsk,
      downBid: market.noBid, downOffer: market.noAsk,
      upSpread: market.yesBid !== null && market.yesAsk !== null
        ? Math.max(0, market.yesAsk - market.yesBid) : null,
      downSpread: market.noBid !== null && market.noAsk !== null
        ? Math.max(0, market.noAsk - market.noBid) : null,
      btcProviderAgeMs: Math.max(0, now.getTime() - btc.providerAt.getTime()),
      btcReceiveAgeMs: Math.max(0, now.getTime() - btc.receivedAt.getTime()),
      marketAgeMs: Math.max(0, now.getTime() - market.fetchedAt.getTime()),
      secondsRemaining: market.endsAt === null ? null :
        Math.max(0, Math.floor((market.endsAt.getTime() - now.getTime()) / 1000)),
      feedFreshness: "current", previousSide: persistedWindow.currentSide,
      currentSide: direction, freshCross: decision.freshCross,
      crossingConsumed: persistedWindow.crossingConsumed || actionable,
      crossingKey: persistedWindow.crossingKey ?? (firstCross ? crossingKey : null),
      signal: decision.signal, direction: decision.direction,
      qualifyingTrigger: actionable, reason: evaluationReason,
      entryOffer: actionable ? decision.entrySideOffer : null,
      positionWasOpen: Boolean(openPosition),
    });
    await tx.update(forwardTestWindowTable).set({
      previousSide: persistedWindow.currentSide,
      currentSide: direction,
      previousBuffer: decision.buffer,
      updatedAt: now,
    }).where(eq(forwardTestWindowTable.ticker, market.ticker));

    let positionId = openPosition?.id ?? null;
    const close = openPosition
      ? paperClose(openPosition, market, decision.buffer, decision.positionExitReason, now)
      : null;
    let currentSignal = decision.signal;
    let reason = evaluationReason;
    if (close && openPosition) {
      const [settled] = await tx.update(forwardTestPositionTable).set({
        ...close, updatedAt: now,
      }).where(and(eq(forwardTestPositionTable.id, openPosition.id),
        eq(forwardTestPositionTable.status, "OPEN"))).returning();
      if (!settled) throw new Error("Paper position changed before settlement");
      if (close.status === "SETTLED") {
        currentSignal = "PASS";
        reason = "Settlement recorded locally";
      }
      await tx.update(forwardTestWindowTable).set({
        ...(close.status === "SETTLED" ? {
          finalized: true,
          settlementResult: close.settlementResult,
        } : {}),
        updatedAt: now,
      }).where(eq(forwardTestWindowTable.ticker, market.ticker));
    }
    if (actionable && decision.entrySideOffer !== null) {
      const side = decision.direction;
      if (side !== "UP" && side !== "DOWN") throw new Error("Qualifying entry has no direction");
      const contracts = Math.floor(PAPER_STAKE / decision.entrySideOffer);
      if (!Number.isSafeInteger(contracts) || contracts < 1) {
        throw new Error("Paper entry cannot buy one whole contract within the stake cap");
      }
      const entryStake = contracts * decision.entrySideOffer;
      const entryBid = side === "UP" ? market.yesBid : market.noBid;
      const entrySpread = entryBid !== null && Number.isFinite(entryBid)
        ? Math.max(0, decision.entrySideOffer - entryBid) : null;
      const entrySecondsRemaining = Math.max(
        0,
        (market.endsAt!.getTime() - now.getTime()) / 1000,
      );
      positionId = `${market.ticker}:first:${decision.signal}`;
      const [created] = await tx.insert(forwardTestPositionTable).values({
        id: positionId, engineId, marketTicker: market.ticker, crossingKey,
        strategyVersion: "V1.3",
        strategyParameterSetId: V13_CHAMPION_PARAMETER_SET.id,
        strategyParameterHash: V13_CHAMPION_PARAMETER_HASH,
        entryPolicyVersion: persistedWindow.entryPolicyVersion,
        direction: side, triggerType: decision.signal,
        enteredAt: now, entryOffer: decision.entrySideOffer,
        entryBid,
        entrySpread,
        entrySecondsRemaining,
        entryBtcProviderAgeMs: Math.max(0, now.getTime() - btc.providerAt.getTime()),
        entryBtcReceiveAgeMs: Math.max(0, now.getTime() - btc.receivedAt.getTime()),
        entryMarketAgeMs: Math.max(0, now.getTime() - market.fetchedAt.getTime()),
        stake: entryStake, contracts,
        target, entryBtcPrice: btc.price, entryBuffer: decision.buffer,
        entryVelocity: velocity,
      }).onConflictDoNothing().returning();
      if (!created) throw new Error("Paper action already exists or another position is open");
      await tx.update(forwardTestWindowTable).set({
        crossingConsumed: true,
        ...(decision.signal === "SCOUT" ? { scoutTriggered: true } : { confirmTriggered: true }),
        updatedAt: now,
      }).where(eq(forwardTestWindowTable.ticker, market.ticker));
    }
    const mark = openPosition && !close
      ? (openPosition.direction === "UP" ? market.yesPrice : market.noPrice)
      : null;
    const unrealized = openPosition && mark !== null && mark !== undefined && !close
      ? roundMoney(openPosition.contracts * mark - openPosition.stake) : null;
    await tx.update(forwardTestEngineTable).set({
      lastAttemptedCycleAt: now,
      lastSuccessfulCycleAt: now,
      lastMarketPollAt: market.fetchedAt,
      lastEvaluationAt: now,
      cycleCount: sql`${forwardTestEngineTable.cycleCount} + 1`,
      marketTicker: market.ticker,
      signal: currentSignal,
      direction: close ? openPosition?.direction ?? "NONE" : decision.direction,
      signedBuffer: decision.buffer,
      btcPrice: btc.price, target,
      upOffer: market.yesAsk, downOffer: market.noAsk,
      currentReason: reason,
      ...(actionable ? { lastTriggerType: decision.signal, lastTriggerAt: now } : {}),
      markPrice: mark ?? null,
      unrealizedPnl: unrealized,
      lastError: null,
      updatedAt: now,
    }).where(eq(forwardTestEngineTable.id, engine.id));
    const researchEvent:PaperBookCaptureEvent|undefined=
      close&&openPosition&&close.status==="CLOSED"
        ? {positionId:openPosition.id,engineId,marketTicker:market.ticker,
           phase:"EXIT",direction:openPosition.direction as "UP"|"DOWN",
           contracts:Math.floor(openPosition.contracts),
           quotePrice:close.exitPrice,eventAt:now}
        : actionable&&positionId&&decision.entrySideOffer!==null&&
          (decision.direction==="UP"||decision.direction==="DOWN")
          ? {positionId,engineId,marketTicker:market.ticker,
             phase:"ENTRY",direction:decision.direction,
             contracts:Math.floor(PAPER_STAKE/decision.entrySideOffer),
             quotePrice:decision.entrySideOffer,eventAt:now}
          : undefined;
    return { evaluationId, signal: currentSignal, marketTicker: market.ticker,
      positionId, error: null, researchEvent } satisfies CycleResult;
  }, engineId, LEASE_SECONDS);
  if(result.evaluationId&&(result.signal==="SCOUT"||result.signal==="CONFIRM"))
    notifyCommittedForwardSignal();
  // The paper action is ALREADY committed. This public REST GET cannot affect
  // a signal, position or account, and is labelled POST_ACTION, never a
  // simultaneous or fill-confirmed snapshot. Mock feeds omit book entirely.
  if(result.researchEvent && feeds.book){
    try{await savePostActionPaperBook(result.researchEvent,feeds.book)}
    catch{/* Research instrumentation may not change paper worker decisions. */}
  }
  return result;
  } catch (error) {
    if (error instanceof WorkerLeaseLostError) throw error;
    const reason = error instanceof Error ? error.message : "Failed to persist paper forward-test cycle";
    await recordCycleError({ owner, epoch, engineId }, reason);
    return { evaluationId: null, signal: "PASS", marketTicker: market.ticker,
      positionId: priorPosition?.id ?? null, error: reason };
  }
}

export function startServerForwardTestWorker(feeds: ForwardTestFeeds = publicForwardTestFeeds) {
  const production = process.env.NODE_ENV === "production";
  // Review gating is unchanged: an incidental Railway process restart never
  // authorizes this PAPER_ONLY producer unless BOTH exact flags are present.
  const startup = forwardTestStartupDecision(process.env, V13_ENTRY_POLICY_VERSION);
  if (!startup.ready) {
    logger.info({ reason: startup.reason, mode: startup.mode },
      "Strategy evaluation producer not scheduled; no new forward-test entries");
    return { running: false, stop: async () => {} };
  }
  logger.info({ mode: startup.mode, reason: startup.reason },
    "Strategy evaluation producer scheduler enabled; awaiting market evaluations");
  const owner = randomUUID();
  const controller = new AbortController();
  let stopped = false;
  let lease: Awaited<ReturnType<typeof acquireWorkerLease>> = null;
  let lastAutolearnDay: string | null = null;
  const researchLane=new OptionalResearchLane();
  const discoveryRecovery=new BoundaryDiscoveryRecovery();
  const pause = (delayMs:number) => new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(() => {
      controller.signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  const task = (async () => {
    while (!stopped) {
      const cycleStarted=performance.now();
      const cycleClock=Date.now();
      let periodMs=FORWARD_TEST_CADENCE_MS;
      try {
        if (!lease) {
          // The explicit production flag is the authorization to enable the
          // PAPER_ONLY engine. When absent, production performs no worker writes.
          if (production) await upsertEngineStatus({ enabled: true });
          else await ensureWorkerEngine();
          lease = await acquireWorkerLease(owner);
          if (lease) {
            registerMicroLiveWorkerLeaseOwner(owner);
            try {
              await ensureV13BuiltInResearchChallengers();
            } catch (error) {
              // Research seeding is intentionally non-authoritative.
              logger.warn({ err: error }, "V13 built-in research challenger seeding failed");
            }
          }
        }
        if (lease) {
          const cycle = await runForwardTestCycle({
            owner, epoch: lease.leaseEpoch, feeds, signal: controller.signal,
          });
          periodMs=discoveryRecovery.periodMs(cycle.error,cycleClock);
          if (!stopped && cycle.evaluationId) {
            try {
              await processMicroLiveForwardTestCycle(cycle.evaluationId);
            } catch (error) {
              logger.error({ err: error }, "Gated micro-live cycle failed");
            }
            const evaluationId=cycle.evaluationId;
            // Zero-authority research can be suspended during database distress.
            // Champion paper processing, signal wakes and live safety remain active.
            if (shadowOpportunityRecordingEnabled(process.env)) {
              researchLane.submit(()=>recordV13ShadowOpportunities(evaluationId),error=>{
                logger.warn({err:error},"V13 shadow opportunity evaluation failed");
              });
            }
            // New daily candidates are trained only AFTER the champion's
            // committed cycle, on a separate non-blocking research promise.
            // The runtime flag is opt-in; no automatic promotion or trades.
            if (autonomousShadowLearningConfigured() && !controller.signal.aborted) {
              const today = new Date().toISOString().slice(0,10);
              if (today !== lastAutolearnDay) {
                lastAutolearnDay = today;
                void runAutonomousShadowResearch(new Date(),controller.signal)
                  .then(result => logger.info({status:result.status,
                    reason:result.reason,candidateId:result.candidateId??null},
                    "Autonomous shadow-only learning cycle"))
                  .catch(error => logger.warn({err:error},
                    "Autonomous shadow research failed; champion unchanged"));
              }
            }
          }
        }
      } catch (error) {
        if (error instanceof WorkerLeaseLostError) {
          lease = null;
          registerMicroLiveWorkerLeaseOwner(null);
        } else if (!stopped) {
          logger.error({ err: error }, "Server paper forward-test cycle failed");
        }
      }
      if (!stopped) await pause(producerDelayMs(periodMs,performance.now()-cycleStarted));
    }
    await researchLane.drain();
    registerMicroLiveWorkerLeaseOwner(null);
    if (lease) await releaseWorkerLease(owner, lease.leaseEpoch);
  })();
  task.catch((error: unknown) => {
    logger.error({ err: error }, "Server paper forward-test worker stopped unexpectedly");
  });
  return {
    running: true,
    stop: async () => {
      stopped = true;
      controller.abort();
      await task;
    },
  };
}