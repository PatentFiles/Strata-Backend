import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { and, eq, like, sql } from "drizzle-orm";
import {
  db, pool, forwardTestBookSnapshotTable, forwardTestEngineTable,
  forwardTestEvaluationTable, forwardTestPositionTable, forwardTestWindowTable,
} from "@workspace/db";
import { evaluateV13Strategy } from "@workspace/v13-strategy";
import {
  acquireWorkerLease, ensureWorkerEngine, getEngineStatus, releaseWorkerLease,
  renewWorkerLease, withWorkerLeaseTransaction, WorkerLeaseLostError,
} from "./forwardTestRepository";
import {
  isForwardTestWorkerEnabled, paperClose, runForwardTestCycle,
  startServerForwardTestWorker,
} from "./forwardTestWorker";
import type { BtcObservation, ForwardTestFeeds, MarketObservation } from "./forwardTestFeeds";
import { readForwardTestStatus } from "../routes/forwardTest";
import {savePostActionPaperBook, readPaperBookCaptureCoverage} from "./forwardTestBookCapture";
import {parseKalshiResearchOrderbook} from "./forwardTestOrderbookDepth";

const suffix = randomUUID().replaceAll("-", "").slice(0, 14);
const engineId = `TEST-WORKER-${suffix}`;
const firstTicker = `KXBTC15M-TEST-${suffix}-1`;
const nextTicker = `KXBTC15M-TEST-${suffix}-2`;
let lease: NonNullable<Awaited<ReturnType<typeof acquireWorkerLease>>>;
let index = 0;
const base = new Date();
let now = base;
let price = 83999;
let currentTicker = firstTicker;
let result: MarketObservation["result"] = null;
let yesAsk: number | null = 0.52;
let staleBtc = false;
let marketFailure = false;

const market = (ticker: string): MarketObservation => ({
  ticker, target: ticker === firstTicker ? 84000 : 90000,
  startsAt: new Date(now.getTime() - 30_000),
  endsAt: new Date(now.getTime() + 900_000),
  yesBid: 0.52, yesAsk, noBid: 0.44, noAsk: 0.45,
  yesPrice: 0.54, noPrice: 0.46,
  status: "open", fetchedAt: now,
  result: ticker === firstTicker ? result : null,
});
const feeds: ForwardTestFeeds = {
  async btc(): Promise<BtcObservation> {
    return { price, receivedAt: now,
      providerAt: new Date(now.getTime() - (staleBtc ? 60_000 : 0)) };
  },
  async market(ticker) {
    if (marketFailure) throw new Error("Kalshi feed unavailable");
    return market(ticker ?? currentTicker);
  },
};
const cycle = async (owner = "worker-A", epoch = lease.leaseEpoch) => {
  index += 1;
  now = new Date(base.getTime() + index * 5000);
  return runForwardTestCycle({ owner, epoch, engineId, feeds, now });
};
const countEvaluations = async () => (await db.select().from(forwardTestEvaluationTable)
  .where(like(forwardTestEvaluationTable.marketTicker, `KXBTC15M-TEST-${suffix}%`))).length;

before(async () => {
  const expectedSchema = process.env.FORWARD_TEST_ISOLATED_SCHEMA;
  if (!expectedSchema || !/^worker_test_[0-9a-f]{24}$/.test(expectedSchema)) {
    throw new Error("Worker integration tests require a disposable isolated schema");
  }
  const { rows: [context] } = await pool.query("SELECT current_schema() AS schema");
  if (context.schema !== expectedSchema) {
    throw new Error("Worker tests refused to access the shared development schema");
  }
});

after(async () => {
  await pool.end();
});

test("disabled worker cannot lease; competing owners are fenced by database time and epoch", async () => {
  await ensureWorkerEngine(engineId);
  assert.equal(await acquireWorkerLease("worker-A", engineId), null);
  await db.update(forwardTestEngineTable).set({ enabled: true })
    .where(eq(forwardTestEngineTable.id, engineId));
  const acquired = await acquireWorkerLease("worker-A", engineId);
  assert.ok(acquired);
  lease = acquired;
  assert.ok(acquired.leaseAcquiredAt && acquired.leaseExpiresAt);
  assert.equal(await acquireWorkerLease("worker-B", engineId), null);
  assert.ok(await renewWorkerLease("worker-A", lease.leaseEpoch, engineId));
  assert.equal(await renewWorkerLease("worker-A", lease.leaseEpoch - 1, engineId), null);
  await assert.rejects(
    withWorkerLeaseTransaction("worker-B", lease.leaseEpoch,
      async () => { throw new Error("Unexpected competing write"); }, engineId),
    WorkerLeaseLostError,
  );
  await db.update(forwardTestEngineTable).set({
    leaseExpiresAt: sql`clock_timestamp() - interval '1 second'`,
  }).where(eq(forwardTestEngineTable.id, engineId));
  assert.equal(await renewWorkerLease("worker-A", lease.leaseEpoch, engineId), null);
  const takeover = await acquireWorkerLease("worker-B", engineId);
  assert.ok(takeover);
  assert.ok(takeover.leaseEpoch > lease.leaseEpoch);
  assert.equal(await releaseWorkerLease("worker-A", lease.leaseEpoch, engineId), null);
  await assert.rejects(
    withWorkerLeaseTransaction("worker-A", lease.leaseEpoch,
      async () => { throw new Error("Unexpected stale owner write"); }, engineId),
    WorkerLeaseLostError,
  );
  await releaseWorkerLease("worker-B", takeover.leaseEpoch, engineId);
  lease = (await acquireWorkerLease("worker-A", engineId))!;
  assert.ok(lease);
});

test("first tick warms up without crossing; fresh crossing is identical to shared V1.3", async () => {
  const first = await cycle();
  assert.equal(first.signal, "PASS");
  assert.equal(first.positionId, null);
  price = 84010;
  const second = await cycle();
  const [evaluation] = await db.select().from(forwardTestEvaluationTable)
    .where(eq(forwardTestEvaluationTable.id, second.evaluationId!));
  const decision = evaluateV13Strategy({
    marketTicker: firstTicker, btcPrice: price, target: 84000,
    previousBuffer: -1, velocity: (84010 - 83999) / (5_000 / 60_000),
    upOffer: 0.52, downOffer: 0.45, freshness: "current", position: null,
  });
  assert.equal(evaluation.signal, decision.signal);
  assert.equal(evaluation.reason, decision.reason);
  assert.equal(evaluation.freshCross, decision.freshCross);
  assert.equal(evaluation.velocity, decision.qualifyingTrigger ? 132 : evaluation.velocity);
  assert.equal(evaluation.upSpread, 0);
  assert.ok(Math.abs((evaluation.downSpread ?? NaN) - 0.01) < 1e-12);
  assert.equal(evaluation.btcProviderAgeMs, 0);
  assert.equal(evaluation.btcReceiveAgeMs, 0);
  assert.equal(evaluation.marketAgeMs, 0);
  assert.equal(second.signal, "SCOUT");
  assert.ok(evaluation.qualifyingTrigger);
  const [position] = await db.select().from(forwardTestPositionTable)
    .where(eq(forwardTestPositionTable.engineId, engineId));
  assert.equal(position.stake, 4.68);
  assert.equal(position.entryOffer, 0.52);
  assert.equal(position.entryBid, 0.52);
  assert.equal(position.entrySpread, 0);
  assert.ok((position.entrySecondsRemaining ?? 0) > 0);
  assert.equal(position.entryBtcProviderAgeMs, 0);
  assert.equal(position.entryBtcReceiveAgeMs, 0);
  assert.equal(position.entryMarketAgeMs, 0);
  assert.equal(position.strategyParameterSetId, "v13-champion-2-c52-confirm53");
  assert.equal(
    position.strategyParameterHash,
    "314e7b49f5cd9782175dbb88fb7a05bbf80bb4c5e1458d0d48a15348b35f6161",
  );
  assert.equal(position.contracts, 9);
  assert.equal(position.entryVelocity, 132);
  const [window] = await db.select().from(forwardTestWindowTable)
    .where(eq(forwardTestWindowTable.ticker, firstTicker));
  assert.equal(window.crossingDirection, "UP");
  assert.equal(window.firstCrossOccurred, true);
  assert.equal(window.crossingConsumed, true);
  assert.equal(window.scoutTriggered, true);
  assert.equal(window.confirmTriggered, false);
  const status = await getEngineStatus(engineId);
  assert.equal(status?.signal, "SCOUT");
  assert.equal(status?.lastTriggerType, "SCOUT");
  assert.equal(status?.lastError, null);
  assert.equal(status?.cycleCount, 2);
});

test("restart restores BTC samples and prior buffer, without a second first-cross entry", async () => {
  assert.ok(await releaseWorkerLease("worker-A", lease.leaseEpoch, engineId));
  lease = (await acquireWorkerLease("worker-C", engineId))!;
  assert.ok(lease);
  const oldClient = await pool.connect();
  oldClient.release(true);
  const steady = await cycle("worker-C");
  assert.equal(steady.positionId, `${firstTicker}:first:SCOUT`);
  const [evaluation] = await db.select().from(forwardTestEvaluationTable)
    .where(eq(forwardTestEvaluationTable.id, steady.evaluationId!));
  assert.ok(evaluation.velocity !== null);
  assert.equal(evaluation.freshCross, false);
  const [status] = await db.select().from(forwardTestEngineTable)
    .where(eq(forwardTestEngineTable.id, engineId));
  assert.equal(status.markPrice, 0.54);
  assert.equal(status.unrealizedPnl, 0.18);
  const [position] = await db.select().from(forwardTestPositionTable)
    .where(eq(forwardTestPositionTable.engineId, engineId));
  assert.equal(position.status, "OPEN");
});

test("unavailable/stale/missing quote fail closed, retain the position, and record error", async () => {
  const before = await countEvaluations();
  staleBtc = true;
  assert.match((await cycle("worker-C")).error!, /Coinbase/);
  staleBtc = false;
  marketFailure = true;
  assert.match((await cycle("worker-C")).error!, /Kalshi feed unavailable/);
  marketFailure = false;
  // Existing position may still settle without offers; fail-closed for a new
  // entry is verified after settlement below.
  assert.equal(await countEvaluations(), before);
  const [position] = await db.select().from(forwardTestPositionTable)
    .where(eq(forwardTestPositionTable.engineId, engineId));
  assert.equal(position.status, "OPEN");
  assert.match((await getEngineStatus(engineId))!.currentReason!, /DATA ERROR/);
});

test("window rollover settles exactly once, and the new target cannot create an artificial crossing", async () => {
  currentTicker = nextTicker;
  result = "yes";
  const closed = await cycle("worker-C");
  assert.equal(closed.marketTicker, firstTicker);
  const [position] = await db.select().from(forwardTestPositionTable)
    .where(eq(forwardTestPositionTable.engineId, engineId));
  assert.equal(position.status, "SETTLED");
  assert.equal(position.exitPrice, 1);
  assert.equal(position.closeReason, "Kalshi settled");
  assert.equal(position.pnl, 4.32);
  // Simulate a fresh process taking over immediately after settlement.
  assert.ok(await releaseWorkerLease("worker-C", lease.leaseEpoch, engineId));
  lease = (await acquireWorkerLease("worker-C", engineId))!;
  assert.ok(lease);
  const next = await cycle("worker-C");
  assert.equal(next.marketTicker, nextTicker);
  assert.equal(next.positionId, null);
  const [window] = await db.select().from(forwardTestWindowTable)
    .where(eq(forwardTestWindowTable.ticker, nextTicker));
  assert.equal(window.firstCrossOccurred, false);
  assert.equal(window.previousBuffer, price - 90000);
  assert.equal(window.crossingKey, null);
  assert.equal((await db.select().from(forwardTestPositionTable)
    .where(eq(forwardTestPositionTable.engineId, engineId))).length, 1);
  assert.equal((await getEngineStatus(engineId))!.unrealizedPnl, null);
  const [unchanged] = await db.select().from(forwardTestPositionTable)
    .where(eq(forwardTestPositionTable.id, position.id));
  assert.equal(unchanged.pnl, 4.32);
  assert.equal(unchanged.closedAt?.getTime(), position.closedAt?.getTime());
});

test("a required offer cannot trigger entry; exit, expiry, loss, and P&L match browser arithmetic", async () => {
  yesAsk = null;
  const before = await countEvaluations();
  assert.match((await cycle("worker-C")).error!, /offer/);
  assert.equal(await countEvaluations(), before);
  const position = { direction: "DOWN", contracts: 12, stake: 4.8 };
  const quoted = { ...market(firstTicker), result: null };
  assert.deepEqual(
    paperClose(position, quoted, -10, "Wrong-side recross", now),
    { status: "CLOSED", closedAt: now, exitPrice: 0.44,
      closeReason: "Wrong-side recross", settlementResult: null,
      payout: 12 * 0.44, pnl: 0.48 },
  );
  assert.equal(paperClose(position, { ...quoted, result: "yes" }, -10, null, now)?.pnl, -4.8);
  assert.equal(paperClose(position, { ...quoted, result: null,
    endsAt: new Date(now.getTime() - 1) }, -10, null, now), null);
  assert.equal(paperClose(position, { ...quoted, result: null,
    endsAt: new Date(now.getTime() - 60_000) }, -10, null, now), null);
  assert.equal(paperClose(position, quoted, -10, null, now), null);
});

test("Confirm crossing survives takeover and never creates a second action", async () => {
  yesAsk = 0.53;
  price = 90025;
  const triggered = await cycle("worker-C");
  assert.equal(triggered.signal, "CONFIRM");
  const [first] = await db.select().from(forwardTestPositionTable)
    .where(and(eq(forwardTestPositionTable.engineId, engineId),
      eq(forwardTestPositionTable.marketTicker, nextTicker)));
  assert.ok(first);
  assert.equal(first.triggerType, "CONFIRM");
  assert.equal(first.stake, 9 * 0.53);
  const [window] = await db.select().from(forwardTestWindowTable)
    .where(eq(forwardTestWindowTable.ticker, nextTicker));
  assert.equal(window.confirmTriggered, true);
  assert.equal(window.crossingKey, `${nextTicker}:first`);
  await releaseWorkerLease("worker-C", lease.leaseEpoch, engineId);
  lease = (await acquireWorkerLease("worker-D", engineId))!;
  assert.ok(lease);
  const resumed = await cycle("worker-D");
  assert.equal(resumed.positionId, first.id);
  assert.equal((await db.select().from(forwardTestPositionTable).where(and(
    eq(forwardTestPositionTable.engineId, engineId),
    eq(forwardTestPositionTable.marketTicker, nextTicker),
  ))).length, 1);
  assert.equal((await getEngineStatus(engineId))!.lastTriggerType, "CONFIRM");
});

test("transaction rollback leaves no cycle writes; disabled and expired leaders cannot write", async () => {
  const before = await countEvaluations();
  await assert.rejects(withWorkerLeaseTransaction("worker-D", lease.leaseEpoch, async (tx) => {
    await tx.insert(forwardTestEvaluationTable).values({
      id: randomUUID(), evaluatedAt: now, marketTicker: firstTicker,
      btcPrice: 1, target: 1, signedBuffer: 0, absoluteBuffer: 0,
      feedFreshness: "current", freshCross: false, crossingConsumed: false,
      signal: "PASS", direction: "NONE", qualifyingTrigger: false,
      reason: "Rollback probe", positionWasOpen: false,
    });
    throw new Error("Crash before commit");
  }, engineId), /Crash before commit/);
  assert.equal(await countEvaluations(), before);
  await db.update(forwardTestEngineTable).set({ enabled: false })
    .where(eq(forwardTestEngineTable.id, engineId));
  await assert.rejects(cycle("worker-D"), WorkerLeaseLostError);
  assert.equal(await countEvaluations(), before);
});

test("production gate has no order/trading path and never starts a worker", () => {
  const oldNodeEnv = process.env.NODE_ENV;
  const oldWorkerEnabled = process.env.FORWARD_TEST_WORKER_ENABLED;
  const oldProductionEnabled = process.env.FORWARD_TEST_PRODUCTION_WORKER_ENABLED;
  try {
    process.env.NODE_ENV = "production";
    process.env.FORWARD_TEST_WORKER_ENABLED = "true";
    process.env.FORWARD_TEST_PRODUCTION_WORKER_ENABLED = "false";
    assert.equal(startServerForwardTestWorker(feeds).running, false);
    assert.equal(isForwardTestWorkerEnabled("production", "true", undefined), false);
    assert.equal(isForwardTestWorkerEnabled("production", "true", "false"), false);
    assert.equal(isForwardTestWorkerEnabled("production", "true", "true"), true);
    assert.equal(isForwardTestWorkerEnabled("development", "true", "false"), true);
    assert.equal(isForwardTestWorkerEnabled("test", "true", "true"), false);
  } finally {
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldNodeEnv;
    if (oldWorkerEnabled === undefined) delete process.env.FORWARD_TEST_WORKER_ENABLED;
    else process.env.FORWARD_TEST_WORKER_ENABLED = oldWorkerEnabled;
    if (oldProductionEnabled === undefined) delete process.env.FORWARD_TEST_PRODUCTION_WORKER_ENABLED;
    else process.env.FORWARD_TEST_PRODUCTION_WORKER_ENABLED = oldProductionEnabled;
  }
});

test("protected status response builder includes lease, activity, and paper-only metrics", async () => {
  const status = await readForwardTestStatus();
  assert.equal(status.engineMode, "PAPER_ONLY");
  assert.equal(status.strategyVersion, "V1.3");
  assert.equal(status.databaseConnectionStatus, "CONNECTED");
  assert.ok(Number.isInteger(status.cycleCount));
  assert.ok(Number.isInteger(status.scoutTriggers));
  assert.ok(Number.isInteger(status.confirmTriggers));
  assert.ok(status.activeWindow === null || status.activeWindow.ticker.length > 0);
});

test("post-action public Kalshi receipts are append-only, depth-limited, and never actual fills",async()=>{
 const paperPositionId="TEST-RESEARCH-BOOK-"+suffix;
 const eventAt=new Date(Date.now()-1000);
 const event={positionId:paperPositionId,engineId,
   marketTicker:"KXBTC15M-26OCT221530-30",phase:"ENTRY" as const,
   direction:"UP" as const,contracts:8,quotePrice:0.46,eventAt};
 const capture=await savePostActionPaperBook(event,async(ticker)=>{
  const start=Date.now();
  return parseKalshiResearchOrderbook({orderbook_fp:{
   yes_dollars:[["0.4000","1.00"]],
   no_dollars:[["0.5400","2.00"],["0.5500","3.00"]],
  }},ticker,start,start+50);
 });
 assert.equal(capture?.status,"CAPTURED");
 assert.equal(capture?.simulatedPriceLimitedFill,5);
 assert.equal(capture?.simulatedUnfilled,3);
 assert.equal(capture?.actualFillVerified,false);
 const [persisted]=await db.select().from(forwardTestBookSnapshotTable)
    .where(eq(forwardTestBookSnapshotTable.id,paperPositionId+":ENTRY"));
 assert.equal(persisted?.status,"CAPTURED");
 assert.equal(persisted?.capacity?.modeledUnfilledContracts,3);
 const duplicate=await savePostActionPaperBook(event,async()=>{
   throw Error("temporarily_unavailable");
 });
 assert.equal(duplicate,null);
 const coverage=await readPaperBookCaptureCoverage(engineId);
 assert.ok(coverage.receipts>=1);
 assert.equal(coverage.proofOfActualExecution,false);
 assert.equal(coverage.exchangeTimestampVerified,false);
 await db.delete(forwardTestBookSnapshotTable)
   .where(eq(forwardTestBookSnapshotTable.id,paperPositionId+":ENTRY"));
});
