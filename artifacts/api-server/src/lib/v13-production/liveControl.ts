import { and, desc, eq } from "drizzle-orm";
import {
  db,
  microLivePairBoundaryTable,
  pool,
  v13LiveMoneyPolicyTable,
  v13ProductionAccountTable,
  v13ProductionEventTable,
  v13ProductionIntentTable,
  v13ProductionPositionTable,
} from "@workspace/db";
import { V13_CHAMPION_PARAMETER_SET } from "@workspace/v13-strategy";
import { entryPolicyRuntimeState } from "../strata/configuredStake";
import { fundingAnchorFromRow } from "../microLivePairBoundary";
import { ProductionExecutor } from "./executor";
import { ProductionLedger } from "./ledger";
import { createProductionExchange } from "./readers";
import { ProductionWorker } from "./worker";
import {
  assertDirectSessionDatabase,
  releaseProductionWorkerLock,
  tryAcquireProductionWorkerLock,
} from "../strata/instanceLock";
import { REVIEWED_RELEASE } from "../strata/reviewedRelease";
import { ProductionSupervisor, type StopBlockers, type WorkerHandle } from "./control";
import { sanitizePublic } from "./sanitize";

export { sanitizePublic };

function dollars(micros: bigint | number | string | null | undefined): number | null {
  if (micros === null || micros === undefined) return null;
  const text = typeof micros === "bigint" ? micros.toString() : String(micros);
  if (!/^-?\d+$/.test(text)) return null;
  const value = Number(text) / 1_000_000;
  return Number.isFinite(value) ? value : null;
}

function countOf(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

async function accountRow() {
  const [row] = await db.select().from(v13ProductionAccountTable)
    .where(and(
      eq(v13ProductionAccountTable.subaccount, 1),
      eq(v13ProductionAccountTable.exchangeIndex, 2),
    ))
    .limit(1);
  return row ?? null;
}

export async function readStopBlockers(): Promise<StopBlockers> {
  const account = await accountRow();
  if (!account) throw new Error("production_account_missing");
  const { rows } = await pool.query<{
    open: string; unresolved: string; unknown: string; dispatched: string;
  }>(`SELECT
      (SELECT count(*) FROM v13_production_position WHERE account_id=$1 AND quantity_hundredths > 0) AS open,
      (SELECT count(*) FROM v13_production_intent WHERE account_id=$1 AND state NOT IN ('TERMINAL','BLOCKED')) AS unresolved,
      (SELECT count(*) FROM v13_production_intent WHERE account_id=$1 AND state='UNKNOWN') AS unknown,
      (SELECT count(*) FROM v13_production_intent WHERE account_id=$1 AND state='DISPATCHED') AS dispatched`,
  [account.id]);
  const row = rows[0];
  return {
    openPositionCount: countOf(row?.open),
    unresolvedIntentCount: countOf(row?.unresolved),
    unknownIntentCount: countOf(row?.unknown),
    dispatchedIntentCount: countOf(row?.dispatched),
  };
}

async function openMarketTicker(): Promise<string> {
  const response = await fetch(
    "https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXBTC15M&status=open&limit=1",
    { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8_000) },
  );
  if (!response.ok) throw new Error("production_open_market_unavailable");
  const body = await response.json() as { markets?: Array<{ ticker?: string }> };
  const ticker = body.markets?.[0]?.ticker;
  if (!ticker) throw new Error("production_open_market_missing");
  return ticker;
}

/** Constructs the existing worker. Not called at API startup. One database session owns the lock. */
export async function createLiveProductionWorker(): Promise<WorkerHandle> {
  assertDirectSessionDatabase(process.env.DATABASE_URL ?? "");
  const client = await pool.connect();
  const lockClient = {
    query: async (sql: string, values?: unknown[]) => {
      const result = await client.query(sql, values);
      return { rows: result.rows as Array<{ locked?: boolean }> };
    },
  };
  let locked = false;
  const release = async () => {
    try {
      if (locked) await releaseProductionWorkerLock(lockClient);
    } finally {
      locked = false;
      client.release();
    }
  };
  try {
    if (!await tryAcquireProductionWorkerLock(lockClient)) {
      throw new Error("production_worker_instance_locked");
    }
    locked = true;
    const account = await accountRow();
    if (!account) throw new Error("production_account_missing");
    const [boundary] = await db.select().from(microLivePairBoundaryTable)
      .where(and(
        eq(microLivePairBoundaryTable.subaccountNumber, 1),
        eq(microLivePairBoundaryTable.exchangeIndex, 2),
      ))
      .limit(1);
    const anchor = boundary ? fundingAnchorFromRow(boundary) : null;
    if (!anchor) throw new Error("production_funding_anchor_missing");
    const ledger = new ProductionLedger(pool, account.id);
    const exchange = await createProductionExchange(ledger, openMarketTicker, anchor);
    const worker = new ProductionWorker(new ProductionExecutor(ledger, exchange));
    let released = false;
    return {
      start: () => worker.start(),
      stop() {
        worker.stop();
        if (!worker.isScheduled() && !released) {
          released = true;
          void release();
        }
      },
      isScheduled: () => worker.isScheduled(),
    };
  } catch (error) {
    await release();
    throw error;
  }
}

let supervisor: ProductionSupervisor | null = null;

export function getLiveProductionSupervisor(): ProductionSupervisor {
  if (!supervisor) {
    supervisor = new ProductionSupervisor({
      createWorker: createLiveProductionWorker,
      readStopBlockers,
    });
  }
  return supervisor;
}

export async function readProductionStatus(control: ProductionView) {
  const view = control.view();
  const account = await accountRow().catch(() => null);
  let maxEntryStakeCents: number | null = null;
  if (account?.policyId) {
    const [policy] = await db.select({
      maxEntryStakeCents: v13LiveMoneyPolicyTable.maxEntryStakeCents,
    }).from(v13LiveMoneyPolicyTable).where(eq(v13LiveMoneyPolicyTable.id, account.policyId)).limit(1);
    maxEntryStakeCents = policy?.maxEntryStakeCents ?? null;
  }
  const blockers = account ? await readStopBlockers().catch(() => null) : null;
  return sanitizePublic({
    runtimeStatus: view.runtimeStatus,
    workerRunning: view.workerRunning,
    accountId: account?.id ?? null,
    commissioned: account?.commissioned ?? null,
    executionEnabled: account?.executionEnabled ?? null,
    killSwitch: account?.killSwitch ?? null,
    blockedReason: view.blockedReason ?? account?.blockedReason ?? null,
    reconciledAt: account?.reconciledAt?.toISOString() ?? null,
    cash: account ? dollars(account.cashMicros) : null,
    reservedCash: account ? dollars(account.reservedMicros) : null,
    openPositionCount: blockers?.openPositionCount ?? 0,
    unresolvedIntentCount: blockers?.unresolvedIntentCount ?? 0,
    unknownIntentCount: blockers?.unknownIntentCount ?? 0,
    lastProductionError: view.lastProductionError,
    reviewedCommit: REVIEWED_RELEASE.commit,
    reviewedRepository: REVIEWED_RELEASE.repository,
    reviewedBranch: REVIEWED_RELEASE.branch,
    maxEntryStakeCents,
    ...entryPolicyRuntimeState(),
    scoutMaxCents: V13_CHAMPION_PARAMETER_SET.parameters.scoutMaxOffer * 100,
    confirmMaxCents: V13_CHAMPION_PARAMETER_SET.parameters.confirmMaxOffer * 100,
    asOf: new Date().toISOString(),
  });
}

interface ProductionView {
  view(): { runtimeStatus: string; workerRunning: boolean; blockedReason: string | null; lastProductionError: string | null };
}

function requestFields(request: unknown): { action: string | null; contracts: number | null; limitPrice: number | null } {
  if (!request || typeof request !== "object") return { action: null, contracts: null, limitPrice: null };
  const row = request as Record<string, unknown>;
  const contracts = typeof row.contracts === "number" ? row.contracts : null;
  const limit = typeof row.limitMicros === "number" ? row.limitMicros / 1_000_000 : null;
  return {
    action: typeof row.action === "string" ? row.action : null,
    contracts,
    limitPrice: limit,
  };
}

export async function readProductionPositions() {
  const account = await accountRow();
  if (!account) return sanitizePublic({ positions: [] });
  const rows = await db.select().from(v13ProductionPositionTable)
    .where(eq(v13ProductionPositionTable.accountId, account.id));
  return sanitizePublic({
    positions: rows.map((row) => {
      const quantity = Number(row.quantityHundredths) / 100;
      const basis = dollars(row.basisMicros);
      return {
        id: row.id,
        market: row.market,
        side: row.side,
        quantity,
        averagePrice: quantity > 0 && basis !== null ? basis / quantity : null,
        exposure: basis,
        realizedPnl: dollars(row.realizedPnlMicros),
      };
    }),
  });
}

export async function readProductionOrders() {
  const account = await accountRow();
  if (!account) return sanitizePublic({ orders: [] });
  const rows = await db.select().from(v13ProductionIntentTable)
    .where(eq(v13ProductionIntentTable.accountId, account.id))
    .orderBy(desc(v13ProductionIntentTable.createdAt))
    .limit(100);
  return sanitizePublic({
    orders: rows.map((row) => {
      const request = requestFields(row.request);
      return {
        id: row.id,
        market: row.market,
        side: row.side,
        kind: row.kind,
        action: request.action,
        status: row.state,
        requestedQty: request.contracts,
        filledQty: Number(row.filledHundredths) / 100,
        limitPrice: request.limitPrice,
        clientOrderId: row.clientOrderId,
        exchangeOrderId: row.exchangeOrderId,
        terminal: row.terminal,
        createdAt: row.createdAt.toISOString(),
      };
    }),
  });
}

function payloadNumber(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

export async function readProductionFills() {
  const account = await accountRow();
  if (!account) return sanitizePublic({ fills: [] });
  const rows = await db.select().from(v13ProductionEventTable)
    .where(and(
      eq(v13ProductionEventTable.accountId, account.id),
      eq(v13ProductionEventTable.kind, "FILL"),
    ))
    .orderBy(desc(v13ProductionEventTable.occurredAt))
    .limit(100);
  return sanitizePublic({
    fills: rows.map((row) => {
      const payload = row.payload && typeof row.payload === "object" ? row.payload as Record<string, unknown> : {};
      const priceMicros = payloadNumber(payload, "priceMicros");
      const quantityHundredths = payloadString(payload, "quantityHundredths") ?? (
        typeof payload.quantityHundredths === "number" ? String(payload.quantityHundredths) : null
      );
      const feeMicros = payloadString(payload, "feeMicros") ?? (
        typeof payload.feeMicros === "number" ? String(payload.feeMicros) : null
      );
      return {
        id: row.eventId,
        orderId: row.intentId,
        market: payloadString(payload, "market"),
        side: payloadString(payload, "side"),
        action: payloadString(payload, "action"),
        price: priceMicros === null ? null : priceMicros / 1_000_000,
        quantity: quantityHundredths && /^-?\d+$/.test(quantityHundredths) ? Number(quantityHundredths) / 100 : null,
        fee: dollars(feeMicros),
        pnl: dollars(row.pnlMicros),
        filledAt: row.occurredAt.toISOString(),
        kind: row.kind,
      };
    }),
  });
}

export async function readProductionTrades() {
  const account = await accountRow();
  if (!account) return sanitizePublic({ trades: [] });
  const rows = await db.select().from(v13ProductionEventTable)
    .where(and(
      eq(v13ProductionEventTable.accountId, account.id),
      eq(v13ProductionEventTable.kind, "SETTLEMENT"),
    ))
    .orderBy(desc(v13ProductionEventTable.occurredAt))
    .limit(200);
  return sanitizePublic({
    trades: rows.map((row) => {
      const payload = row.payload && typeof row.payload === "object" ? row.payload as Record<string, unknown> : {};
      const pnl = dollars(row.pnlMicros);
      return {
        id: row.eventId,
        market: payloadString(payload, "market"),
        side: payloadString(payload, "side"),
        kind: row.kind,
        status: "COMPLETED",
        result: pnl === null ? null : pnl > 0 ? "profit" : pnl < 0 ? "loss" : "breakeven",
        netPnl: pnl,
        occurredAt: row.occurredAt.toISOString(),
      };
    }),
  });
}

export async function readLatestProductionTrade() {
  const blockers = await readStopBlockers().catch(() => null);
  const unresolved = !blockers || blockers.openPositionCount > 0 || blockers.unresolvedIntentCount > 0;
  if (unresolved) return sanitizePublic({ unresolved: true, latestCompleted: null });
  const trades = await readProductionTrades();
  return sanitizePublic({ unresolved: false, latestCompleted: trades.trades[0] ?? null });
}
