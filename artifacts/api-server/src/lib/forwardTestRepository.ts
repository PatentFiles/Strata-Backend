import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  forwardTestEngineTable,
  forwardTestEvaluationTable,
  forwardTestPositionTable,
  forwardTestWindowTable,
  type ForwardTestEngine,
  type ForwardTestEvaluation,
  type InsertForwardTestEvaluation,
  type ForwardTestPosition,
  type ForwardTestWindow,
} from "@workspace/db";

export const FORWARD_TEST_ENGINE_ID = "v1.3-paper";

export class ForwardTestConflictError extends Error {}
export class WorkerLeaseLostError extends Error {}

export type ForwardTestTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function leaseDuration(seconds: number) {
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 120) {
    throw new RangeError("Lease duration must be between 5 and 120 seconds");
  }
  return sql`${seconds} * interval '1 second'`;
}

export async function ensureWorkerEngine(id = FORWARD_TEST_ENGINE_ID) {
  // Creating the disabled status row does not start the worker or create trades.
  await db.insert(forwardTestEngineTable).values({ id, enabled: false }).onConflictDoNothing();
  return getEngineStatus(id);
}

export async function acquireWorkerLease(
  owner: string, id = FORWARD_TEST_ENGINE_ID, durationSeconds = 20,
): Promise<ForwardTestEngine | null> {
  if (!owner) throw new Error("Worker lease owner ID is required");
  const [row] = await db.update(forwardTestEngineTable).set({
    leaseOwner: owner,
    leaseEpoch: sql`${forwardTestEngineTable.leaseEpoch} + 1`,
    leaseAcquiredAt: sql`clock_timestamp()`,
    leaseRenewedAt: sql`clock_timestamp()`,
    leaseExpiresAt: sql`clock_timestamp() + ${leaseDuration(durationSeconds)}`,
    workerStartedAt: sql`clock_timestamp()`,
    lastHeartbeatAt: sql`clock_timestamp()`,
  }).where(and(
    eq(forwardTestEngineTable.id, id),
    eq(forwardTestEngineTable.enabled, true),
    sql`(${forwardTestEngineTable.leaseOwner} IS NULL OR ${forwardTestEngineTable.leaseExpiresAt} <= clock_timestamp())`,
  )).returning();
  return row ?? null;
}

export async function renewWorkerLease(
  owner: string, epoch: number, id = FORWARD_TEST_ENGINE_ID, durationSeconds = 20,
): Promise<ForwardTestEngine | null> {
  const [row] = await db.update(forwardTestEngineTable).set({
    leaseRenewedAt: sql`clock_timestamp()`,
    leaseExpiresAt: sql`clock_timestamp() + ${leaseDuration(durationSeconds)}`,
    lastHeartbeatAt: sql`clock_timestamp()`,
  }).where(and(
    eq(forwardTestEngineTable.id, id),
    eq(forwardTestEngineTable.enabled, true),
    eq(forwardTestEngineTable.leaseOwner, owner),
    eq(forwardTestEngineTable.leaseEpoch, epoch),
    sql`${forwardTestEngineTable.leaseExpiresAt} > clock_timestamp()`,
  )).returning();
  return row ?? null;
}

export async function releaseWorkerLease(owner: string, epoch: number, id = FORWARD_TEST_ENGINE_ID) {
  const [row] = await db.update(forwardTestEngineTable).set({
    leaseOwner: null, leaseExpiresAt: null,
  }).where(and(
    eq(forwardTestEngineTable.id, id),
    eq(forwardTestEngineTable.leaseOwner, owner),
    eq(forwardTestEngineTable.leaseEpoch, epoch),
  )).returning();
  return row ?? null;
}

export async function withWorkerLeaseTransaction<T>(
  owner: string,
  epoch: number,
  work: (tx: ForwardTestTransaction, engine: ForwardTestEngine) => Promise<T>,
  id = FORWARD_TEST_ENGINE_ID,
  durationSeconds = 20,
): Promise<T> {
  return db.transaction(async (tx) => {
    // This row lock fences old owners. Acquisition and every strategy write
    // serialize on the same row, and expiry is checked using PostgreSQL time.
    const [engine] = await tx.select().from(forwardTestEngineTable).where(and(
      eq(forwardTestEngineTable.id, id),
      eq(forwardTestEngineTable.enabled, true),
      eq(forwardTestEngineTable.leaseOwner, owner),
      eq(forwardTestEngineTable.leaseEpoch, epoch),
      sql`${forwardTestEngineTable.leaseExpiresAt} > clock_timestamp()`,
    )).for("update").limit(1);
    if (!engine) throw new WorkerLeaseLostError("Worker lease was lost before evaluation");
    const result = await work(tx, engine);
    const [renewed] = await tx.update(forwardTestEngineTable).set({
      leaseRenewedAt: sql`clock_timestamp()`,
      leaseExpiresAt: sql`clock_timestamp() + ${leaseDuration(durationSeconds)}`,
      lastHeartbeatAt: sql`clock_timestamp()`,
    }).where(and(
      eq(forwardTestEngineTable.id, id),
      eq(forwardTestEngineTable.enabled, true),
      eq(forwardTestEngineTable.leaseOwner, owner),
      eq(forwardTestEngineTable.leaseEpoch, epoch),
      sql`${forwardTestEngineTable.leaseExpiresAt} > clock_timestamp()`,
    )).returning();
    if (!renewed) throw new WorkerLeaseLostError("Worker lease expired during evaluation");
    return result;
  });
}

type EnginePatch = Partial<Pick<ForwardTestEngine,
  "enabled" | "lastHeartbeatAt" | "lastMarketPollAt" | "lastEvaluationAt" |
  "marketTicker" | "signal" | "direction" | "signedBuffer" | "btcPrice" |
  "target" | "upOffer" | "downOffer" | "lastError"
>>;

export async function getEngineStatus(id = FORWARD_TEST_ENGINE_ID) {
  const [row] = await db.select().from(forwardTestEngineTable)
    .where(eq(forwardTestEngineTable.id, id)).limit(1);
  return row ?? null;
}

export async function upsertEngineStatus(patch: EnginePatch, id = FORWARD_TEST_ENGINE_ID) {
  const [row] = await db.insert(forwardTestEngineTable).values({ id, ...patch })
    .onConflictDoUpdate({
      target: forwardTestEngineTable.id,
      set: { ...patch, updatedAt: new Date() },
    }).returning();
  return row;
}

type NewWindow = Pick<ForwardTestWindow, "ticker" | "target"> &
  Partial<Pick<ForwardTestWindow, "startsAt" | "endsAt">>;

export async function getOrCreateMarketWindow(window: NewWindow) {
  await db.insert(forwardTestWindowTable).values(window).onConflictDoNothing();
  const [row] = await db.select().from(forwardTestWindowTable)
    .where(eq(forwardTestWindowTable.ticker, window.ticker)).limit(1);
  if (!row) throw new Error("Market window missing after insert");
  if (row.target !== window.target) {
    throw new ForwardTestConflictError("Market ticker already has a different target");
  }
  return row;
}

type CrossingPatch = Partial<Pick<ForwardTestWindow,
  "previousSide" | "currentSide" | "previousBuffer" |
  "crossingConsumed" |
  "scoutTriggered" | "confirmTriggered" | "finalized" | "settlementResult"
>>;

export async function claimMarketCrossing(
  ticker: string, crossingKey: string, direction: "UP" | "DOWN", at: Date,
) {
  if (!crossingKey) throw new Error("A stable crossing key is required");
  const [claimed] = await db.update(forwardTestWindowTable).set({
    firstCrossOccurred: true,
    crossingKey,
    crossingDirection: direction,
    crossingAt: at,
    updatedAt: new Date(),
  }).where(and(
    eq(forwardTestWindowTable.ticker, ticker),
    eq(forwardTestWindowTable.firstCrossOccurred, false),
    eq(forwardTestWindowTable.finalized, false),
    isNull(forwardTestWindowTable.crossingKey),
  )).returning();
  if (claimed) return claimed;
  const [existing] = await db.select().from(forwardTestWindowTable)
    .where(eq(forwardTestWindowTable.ticker, ticker)).limit(1);
  if (!existing) throw new Error(`Unknown forward-test window: ${ticker}`);
  if (existing.crossingKey !== crossingKey || existing.crossingDirection !== direction) {
    throw new ForwardTestConflictError("The first crossing was already claimed");
  }
  return existing;
}

export async function updateMarketWindowCrossing(ticker: string, patch: CrossingPatch) {
  const [row] = await db.update(forwardTestWindowTable).set({
    ...patch,
    // These flags are monotonic within a market window: a restart cannot
    // reopen a crossing or action that has already been consumed.
    ...(patch.crossingConsumed !== undefined && {
      crossingConsumed: sql`${forwardTestWindowTable.crossingConsumed} OR ${patch.crossingConsumed}`,
    }),
    ...(patch.scoutTriggered !== undefined && {
      scoutTriggered: sql`${forwardTestWindowTable.scoutTriggered} OR ${patch.scoutTriggered}`,
    }),
    ...(patch.confirmTriggered !== undefined && {
      confirmTriggered: sql`${forwardTestWindowTable.confirmTriggered} OR ${patch.confirmTriggered}`,
    }),
    ...(patch.finalized !== undefined && {
      finalized: sql`${forwardTestWindowTable.finalized} OR ${patch.finalized}`,
    }),
    updatedAt: new Date(),
  }).where(eq(forwardTestWindowTable.ticker, ticker)).returning();
  if (!row) throw new Error(`Unknown forward-test window: ${ticker}`);
  return row;
}

type NewEvaluation = Omit<InsertForwardTestEvaluation,
  "createdAt" | "evaluationSource" | "livePositionId" | "sourcePaperEvaluationId">;

export async function appendStrategyEvaluation(evaluation: NewEvaluation) {
  const [row] = await db.insert(forwardTestEvaluationTable).values(evaluation).returning();
  return row;
}

export async function getRecentStrategyEvaluations(limit = 20) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("Evaluation limit must be an integer between 1 and 100");
  }
  return db.select().from(forwardTestEvaluationTable)
    .orderBy(desc(forwardTestEvaluationTable.evaluatedAt), desc(forwardTestEvaluationTable.id))
    .limit(limit);
}

type NewPosition = Pick<ForwardTestPosition,
  "id" | "engineId" | "marketTicker" | "crossingKey" |
  "direction" | "triggerType" | "enteredAt" | "entryOffer" |
  "stake" | "contracts" | "target" | "entryBtcPrice" | "entryBuffer"
>;

function assertSamePosition(existing: ForwardTestPosition, position: NewPosition) {
  if (
    existing.engineId !== position.engineId ||
    existing.direction !== position.direction ||
    existing.enteredAt.getTime() !== position.enteredAt.getTime() ||
    existing.entryOffer !== position.entryOffer ||
    existing.stake !== position.stake ||
    existing.contracts !== position.contracts ||
    existing.target !== position.target ||
    existing.entryBtcPrice !== position.entryBtcPrice ||
    existing.entryBuffer !== position.entryBuffer
  ) throw new ForwardTestConflictError("Crossing action conflicts with its existing position");
}

export async function createPaperPositionSafely(position: NewPosition) {
  if (!position.crossingKey) throw new Error("A stable crossing key is required");
  return db.transaction(async (tx) => {
    // Serialize actions for this window, including concurrent worker restarts.
    const [window] = await tx.select().from(forwardTestWindowTable)
      .where(eq(forwardTestWindowTable.ticker, position.marketTicker)).for("update").limit(1);
    if (!window || !window.firstCrossOccurred ||
        window.crossingKey !== position.crossingKey ||
        window.crossingDirection !== position.direction) {
      throw new ForwardTestConflictError("Position does not match the claimed first crossing");
    }
    const action = and(
      eq(forwardTestPositionTable.marketTicker, position.marketTicker),
      eq(forwardTestPositionTable.crossingKey, position.crossingKey),
      eq(forwardTestPositionTable.triggerType, position.triggerType),
    );
    const [existing] = await tx.select().from(forwardTestPositionTable)
      .where(action).limit(1);
    if (existing) {
      assertSamePosition(existing, position);
      return existing;
    }
    if (window.finalized) throw new ForwardTestConflictError("Market window is finalized");
    const [inserted] = await tx.insert(forwardTestPositionTable).values(position)
      .onConflictDoNothing().returning();
    if (!inserted) {
      throw new ForwardTestConflictError("An open position or position ID already exists");
    }
    await tx.update(forwardTestWindowTable).set({
      crossingConsumed: true,
      ...(position.triggerType === "SCOUT" ? { scoutTriggered: true } : { confirmTriggered: true }),
      updatedAt: new Date(),
    }).where(eq(forwardTestWindowTable.ticker, position.marketTicker));
    return inserted;
  });
}

export async function getOpenPaperPosition(engineId = FORWARD_TEST_ENGINE_ID) {
  const [row] = await db.select().from(forwardTestPositionTable)
    .where(and(eq(forwardTestPositionTable.engineId, engineId), eq(forwardTestPositionTable.status, "OPEN")))
    .limit(1);
  return row ?? null;
}

type Settlement = {
  status: "SETTLED" | "CLOSED";
  closedAt: Date;
  settlementResult: string | null;
  payout: number;
  pnl: number;
};

export async function settlePaperPositionSafely(id: string, settlement: Settlement) {
  const [settled] = await db.update(forwardTestPositionTable)
    .set({ ...settlement, updatedAt: new Date() })
    .where(and(eq(forwardTestPositionTable.id, id), eq(forwardTestPositionTable.status, "OPEN")))
    .returning();
  if (settled) return settled;
  const [existing] = await db.select().from(forwardTestPositionTable)
    .where(eq(forwardTestPositionTable.id, id)).limit(1);
  if (!existing) throw new Error(`Unknown forward-test position: ${id}`);
  if (
    existing.status !== settlement.status ||
    existing.settlementResult !== settlement.settlementResult ||
    existing.payout !== settlement.payout ||
    existing.pnl !== settlement.pnl
  ) throw new ForwardTestConflictError("Position was already settled differently");
  return existing;
}

export async function aggregateForwardTestStatistics(engineId?: string) {
  const [[evaluations], [windows], [triggers], [positions]] = await Promise.all([
    db.select({ value: count() }).from(forwardTestEvaluationTable),
    db.select({ value: count() }).from(forwardTestWindowTable),
    db.select({ value: count() }).from(forwardTestEvaluationTable).where(and(
      eq(forwardTestEvaluationTable.qualifyingTrigger, true),
      inArray(forwardTestEvaluationTable.signal, ["SCOUT", "CONFIRM"]),
    )),
    db.select({
      open: sql<number>`count(*) FILTER (WHERE ${forwardTestPositionTable.status} = 'OPEN')::integer`,
      completed: sql<number>`count(*) FILTER (WHERE ${forwardTestPositionTable.status} IN ('SETTLED','CLOSED'))::integer`,
      pnl: sql<number>`coalesce(sum(${forwardTestPositionTable.pnl}) FILTER (WHERE ${forwardTestPositionTable.status} IN ('SETTLED','CLOSED')), 0)::double precision`,
    }).from(forwardTestPositionTable)
      .where(engineId ? eq(forwardTestPositionTable.engineId, engineId) : undefined),
  ]);
  return {
    evaluationCount: evaluations.value,
    windowsObserved: windows.value,
    triggerCount: triggers.value,
    openPaperPositionCount: positions.open,
    completedPaperForwardTests: positions.completed,
    cumulativePaperPnl: positions.pnl,
  };
}