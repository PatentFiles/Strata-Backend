import { randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  lt,
  sql,
} from "drizzle-orm";
import {
  db,
  forwardTestEvaluationTable,
  liveExecutionConfigTable,
  liveNotificationEventTable,
  liveProposedOrderTable,
  type LiveExecutionConfig,
  type LiveProposedOrder,
} from "@workspace/db";
import { logger } from "./logger";
import {
  getKalshiCredentialsState,
  readKalshiOrderbook,
} from "./kalshiAccountClient";
import { verifyProductionShadowReads } from "./productionShadowPreflight";

export type ShadowMode = "PAPER_ONLY" | "SHADOW_LIVE";

const SHADOW_FRESHNESS_MS = 15_000;
const DEFAULT_OBSERVER_INTERVAL_MS = 5_000;

function assertDevelopmentOnly(operation: string) {
  if (process.env.NODE_ENV !== "development") {
    throw new Error(`${operation} is available only in development`);
  }
}

export function isShadowObserverEnabled(
  environment: string | undefined,
  productionFlag: string | undefined,
) {
  return environment === "development" ||
    (environment === "production" && productionFlag === "true");
}

function assertShadowObserverAllowed(operation: string) {
  if (!isShadowObserverEnabled(process.env.NODE_ENV, process.env.SHADOW_LIVE_PRODUCTION_ENABLED)) {
    throw new Error(`${operation} is not enabled in this environment`);
  }
}

function assertShadowReadAllowed() {
  if (process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "production") {
    throw new Error("Phase 4 state is unavailable in this environment");
  }
}

function hasKalshiCredentials() {
  return getKalshiCredentialsState() === "CONFIGURED";
}

async function ensureConfig(): Promise<LiveExecutionConfig> {
  // Never initialize production until the configured key has passed GET-only
  // balance, account and orderbook reads against the production Kalshi API.
  if (process.env.NODE_ENV === "production") await verifyProductionShadowReads();
  // The explicit production observer gate authorizes this one-time shadow-only
  // budget. On restart, keep the existing remaining balance; never reset it.
  await db.insert(liveExecutionConfigTable).values(
    process.env.NODE_ENV === "production"
      ? {
          id: "singleton", mode: "SHADOW_LIVE", liveExecutionEnabled: false,
          manualKillSwitch: true, shadowCapitalLimit: 25, shadowCapitalRemaining: 25,
          shadowMaxStakePerTrade: 5, shadowMaxOpenPositions: 1, shadowMaxTotalLoss: 25,
        }
      : { id: "singleton" },
  ).onConflictDoNothing();
  const [config] = await db.select().from(liveExecutionConfigTable)
    .where(eq(liveExecutionConfigTable.id, "singleton")).limit(1);
  if (!config) throw new Error("Phase 4 execution config was not available after initialization");
  if (process.env.NODE_ENV === "production" &&
      (config.mode !== "SHADOW_LIVE" || config.liveExecutionEnabled || !config.manualKillSwitch ||
        config.liveCapitalLimit !== 0 || config.liveCapitalRemaining !== 0 ||
        config.maxStakePerTrade !== 0 || config.maxDailyLoss !== 0 ||
        config.maxTotalExperimentLoss !== 0 || config.maxOpenPositions !== 0 ||
        config.maxEntryPrice !== 0 || config.maxSlippage !== 0 ||
        config.shadowCapitalLimit !== 25 || config.shadowCapitalRemaining < 0 ||
        config.shadowCapitalRemaining > 25 || config.shadowMaxStakePerTrade !== 5 ||
        config.shadowMaxOpenPositions !== 1 || config.shadowMaxTotalLoss !== 25)) {
    throw new Error("Production shadow configuration failed the safety preflight");
  }
  return config;
}

async function appendNotification(
  eventType: "API" | "FEED" | "RISK" | "KILL" | "ENTRY" | "EXIT",
  message: string,
  severity: "INFO" | "WARN" | "ERROR" = "INFO",
  details: Record<string, unknown> = {},
) {
  await db.insert(liveNotificationEventTable).values({
    id: randomUUID(), eventType, severity, message, details,
  });
}

export type ShadowLimitsInput = {
  liveCapitalLimit: number;
  liveCapitalRemaining: number;
  maxStakePerTrade: number;
  maxDailyLoss: number;
  maxTotalExperimentLoss: number;
  maxOpenPositions: number;
  maxEntryPrice: number;
  maxSlippage: number;
  manualKillSwitch: boolean;
  mode?: ShadowMode;
};

function validateShadowLimits(input: ShadowLimitsInput) {
  const numericLimits: Array<[string, number]> = [
    ["liveCapitalLimit", input.liveCapitalLimit],
    ["liveCapitalRemaining", input.liveCapitalRemaining],
    ["maxStakePerTrade", input.maxStakePerTrade],
    ["maxDailyLoss", input.maxDailyLoss],
    ["maxTotalExperimentLoss", input.maxTotalExperimentLoss],
    ["maxOpenPositions", input.maxOpenPositions],
    ["maxEntryPrice", input.maxEntryPrice],
    ["maxSlippage", input.maxSlippage],
  ];
  for (const [name, value] of numericLimits) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new RangeError(`${name} must be a finite nonnegative number`);
    }
  }
  if (!Number.isInteger(input.maxOpenPositions) || input.maxOpenPositions > 100) {
    throw new RangeError("maxOpenPositions must be an integer between 0 and 100");
  }
  if (input.maxEntryPrice > 1) throw new RangeError("maxEntryPrice must be zero or between 0 and 1");
  if (input.maxSlippage > 1) throw new RangeError("maxSlippage must not exceed 1");
  if (input.liveCapitalRemaining > input.liveCapitalLimit) {
    throw new RangeError("liveCapitalRemaining must not exceed liveCapitalLimit");
  }
  if (input.maxStakePerTrade > input.liveCapitalLimit) {
    throw new RangeError("maxStakePerTrade must not exceed liveCapitalLimit");
  }
  if (typeof input.manualKillSwitch !== "boolean") {
    throw new TypeError("manualKillSwitch must be a boolean");
  }
  if (input.mode !== undefined && input.mode !== "PAPER_ONLY" && input.mode !== "SHADOW_LIVE") {
    throw new Error("Phase 4A supports only PAPER_ONLY or SHADOW_LIVE");
  }
}

export async function setShadowLimits(input: ShadowLimitsInput) {
  assertDevelopmentOnly("Changing Phase 4 shadow limits");
  validateShadowLimits(input);
  return db.transaction(async (tx) => {
    await tx.insert(liveExecutionConfigTable).values({ id: "singleton" }).onConflictDoNothing();
    const [current] = await tx.select().from(liveExecutionConfigTable)
      .where(eq(liveExecutionConfigTable.id, "singleton")).for("update").limit(1);
    if (!current) throw new Error("Phase 4 execution config was not available after initialization");
    const mode = input.mode ?? current.mode;
    if (mode !== "PAPER_ONLY" && mode !== "SHADOW_LIVE") {
      throw new Error("Phase 4A supports only PAPER_ONLY or SHADOW_LIVE");
    }
    const [updated] = await tx.update(liveExecutionConfigTable).set({
      mode,
      liveExecutionEnabled: false,
      liveCapitalLimit: input.liveCapitalLimit,
      liveCapitalRemaining: input.liveCapitalRemaining,
      maxStakePerTrade: input.maxStakePerTrade,
      maxDailyLoss: input.maxDailyLoss,
      maxTotalExperimentLoss: input.maxTotalExperimentLoss,
      maxOpenPositions: input.maxOpenPositions,
      maxEntryPrice: input.maxEntryPrice,
      maxSlippage: input.maxSlippage,
      manualKillSwitch: input.manualKillSwitch,
      updatedAt: new Date(),
    }).where(eq(liveExecutionConfigTable.id, "singleton")).returning();
    if (!updated) throw new Error("Unable to update Phase 4 shadow limits");
    await tx.insert(liveNotificationEventTable).values({
      id: randomUUID(),
      eventType: "API",
      severity: "INFO",
      message: "Phase 4 shadow limits updated",
      details: { mode },
    });
    if (!current.manualKillSwitch && input.manualKillSwitch) {
      await tx.insert(liveNotificationEventTable).values({
        id: randomUUID(),
        eventType: "KILL",
        severity: "WARN",
        message: "Manual kill switch enabled",
        details: { manualKillSwitch: true },
      });
    }
    return serializable(updated);
  });
}

function serializable<T>(value: T): T {
  if (value instanceof Date) return value.toISOString() as unknown as T;
  if (Array.isArray(value)) return value.map((item) => serializable(item)) as unknown as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, serializable(item)]),
    ) as T;
  }
  return value;
}

export async function getPhase4State() {
  assertShadowReadAllowed();
  // In production an HTTP GET must never initialize or change configuration.
  const [config] = process.env.NODE_ENV === "production"
    ? await db.select().from(liveExecutionConfigTable)
      .where(eq(liveExecutionConfigTable.id, "singleton")).limit(1)
    : [await ensureConfig()];
  if (!config) throw new Error("Production shadow configuration is not initialized");
  const [proposedOrders, notifications] = await Promise.all([
    db.select().from(liveProposedOrderTable)
      .orderBy(desc(liveProposedOrderTable.recordedAt)).limit(100),
    db.select().from(liveNotificationEventTable)
      .orderBy(desc(liveNotificationEventTable.createdAt)).limit(100),
  ]);
  return serializable({ config, proposedOrders, notifications });
}

export async function setShadowMode(mode: ShadowMode) {
  assertDevelopmentOnly("Changing Phase 4 shadow mode");
  if (mode !== "PAPER_ONLY" && mode !== "SHADOW_LIVE") {
    throw new Error("Phase 4A supports only PAPER_ONLY or SHADOW_LIVE");
  }
  const [config] = await db.update(liveExecutionConfigTable).set({
    mode,
    // The database check independently prevents enabling execution in Phase 4A.
    liveExecutionEnabled: false,
    updatedAt: new Date(),
  }).where(eq(liveExecutionConfigTable.id, "singleton")).returning();
  if (!config) {
    await ensureConfig();
    const [initialized] = await db.update(liveExecutionConfigTable).set({
      mode,
      liveExecutionEnabled: false,
      updatedAt: new Date(),
    }).where(eq(liveExecutionConfigTable.id, "singleton")).returning();
    if (!initialized) throw new Error("Unable to initialize Phase 4 shadow mode");
    await appendNotification("API", `Shadow mode changed to ${mode}`, "INFO", { mode });
    return serializable(initialized);
  }
  await appendNotification("API", `Shadow mode changed to ${mode}`, "INFO", { mode });
  return serializable(config);
}

type ProposedOrderInput = Omit<LiveProposedOrder, "createdAt">;

/**
 * Insert once for the stable crossing action. The unique database key makes
 * concurrent scans/restarts idempotent; a conflict is intentionally a no-op.
 */
export async function recordShadowProposal(order: ProposedOrderInput) {
  const [inserted] = await db.insert(liveProposedOrderTable).values(order)
    .onConflictDoNothing({
      target: [
        liveProposedOrderTable.marketTicker,
        liveProposedOrderTable.crossingKey,
        liveProposedOrderTable.triggerType,
      ],
    }).returning();
  return inserted ?? null;
}

export function calculateShadowContractCount(
  spendable: number,
  price: number,
  availableContracts: number,
) {
  if (
    !Number.isFinite(spendable) || spendable <= 0 ||
    !Number.isFinite(price) || price <= 0 ||
    !Number.isFinite(availableContracts) || availableContracts <= 0
  ) return 0;
  return Math.min(Math.floor(spendable / price), Math.floor(availableContracts));
}

function createBlockedProposal(
  evaluation: typeof forwardTestEvaluationTable.$inferSelect,
  quotePrice: number | null,
  simulatedRemainingCapital: number,
  reason: string,
): ProposedOrderInput {
  return {
    id: randomUUID(),
    marketTicker: evaluation.marketTicker,
    crossingKey: evaluation.crossingKey!,
    triggerType: evaluation.signal as "SCOUT" | "CONFIRM",
    direction: evaluation.direction as "UP" | "DOWN",
    sourceEvaluationId: evaluation.id,
    quotePrice,
    proposedLimitPrice: quotePrice,
    contracts: 0,
    intendedStake: 0,
    simulatedRemainingCapital,
    status: "BLOCKED",
    riskVerdict: "BLOCK",
    riskReason: reason,
    recordedAt: new Date(),
  };
}

export async function scanShadowOnce() {
  assertShadowObserverAllowed("Shadow scan");
  const config = await ensureConfig();
  if (config.mode !== "SHADOW_LIVE") return { scanned: 0, recorded: 0, skipped: "mode_not_shadow_live" };
  if (config.liveExecutionEnabled) return { scanned: 0, recorded: 0, skipped: "execution_must_remain_disabled" };
  const now = new Date();
  const freshAfter = new Date(now.getTime() - SHADOW_FRESHNESS_MS);
  const evaluations = await db.select().from(forwardTestEvaluationTable).where(and(
    eq(forwardTestEvaluationTable.qualifyingTrigger, true),
    inArray(forwardTestEvaluationTable.signal, ["SCOUT", "CONFIRM"]),
    inArray(forwardTestEvaluationTable.direction, ["UP", "DOWN"]),
    gte(forwardTestEvaluationTable.evaluatedAt, freshAfter),
    lt(forwardTestEvaluationTable.evaluatedAt, new Date(now.getTime() + 1)),
  )).orderBy(desc(forwardTestEvaluationTable.evaluatedAt)).limit(100);
  if (evaluations.length === 0) {
    return { scanned: 0, recorded: 0, skipped: "no_fresh_evaluations" };
  }

  const tickers = [...new Set(evaluations.map((evaluation) => evaluation.marketTicker))];
  const existingProposals = await db.select({
    marketTicker: liveProposedOrderTable.marketTicker,
    crossingKey: liveProposedOrderTable.crossingKey,
    triggerType: liveProposedOrderTable.triggerType,
  }).from(liveProposedOrderTable).where(inArray(liveProposedOrderTable.marketTicker, tickers));
  const existingKeys = new Set(existingProposals.map((proposal) =>
    `${proposal.marketTicker}\u001f${proposal.crossingKey}\u001f${proposal.triggerType}`));
  const unprocessedEvaluations: typeof evaluations = [];
  for (const evaluation of evaluations) {
    if (!evaluation.crossingKey) continue;
    const key = `${evaluation.marketTicker}\u001f${evaluation.crossingKey}\u001f${evaluation.signal}`;
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);
    unprocessedEvaluations.push(evaluation);
  }
  if (unprocessedEvaluations.length === 0) {
    return { scanned: evaluations.length, recorded: 0, skipped: "already_proposed" };
  }
  if (!hasKalshiCredentials()) {
    return { scanned: evaluations.length, recorded: 0, skipped: "credentials_not_configured" };
  }

  let recorded = 0;
  for (const evaluation of unprocessedEvaluations) {
    if (!evaluation.crossingKey) continue;
    let orderbook: Awaited<ReturnType<typeof readKalshiOrderbook>> | null = null;
    let feedError = "";
    try {
      orderbook = await readKalshiOrderbook(evaluation.marketTicker);
    } catch {
      feedError = "orderbook_unavailable";
      await appendNotification("FEED", "Kalshi orderbook unavailable for a fresh trigger", "WARN", {
        marketTicker: evaluation.marketTicker,
        evaluationId: evaluation.id,
      });
    }

    const side = evaluation.direction === "UP" ? "YES" : "NO";
    const price = orderbook
      ? Number(side === "YES" ? orderbook.yesAskDollars : orderbook.noAskDollars)
      : Number.NaN;
    const availableContracts = orderbook
      ? Number(side === "YES" ? orderbook.yesAskAvailableContracts : orderbook.noAskAvailableContracts)
      : 0;
    const decision = await db.transaction(async (tx) => {
      // Serialize simulated reservations across observer/manual scans and restarts.
      const [current] = await tx.select().from(liveExecutionConfigTable)
        .where(eq(liveExecutionConfigTable.id, "singleton")).for("update").limit(1);
      if (!current || current.mode !== "SHADOW_LIVE" || current.liveExecutionEnabled) {
        return { inserted: false, reasons: [] as string[] };
      }
      const decisionTime = new Date();
      const [open] = await tx.select({ count: sql<number>`count(*)::integer` })
        .from(liveProposedOrderTable).where(and(
          eq(liveProposedOrderTable.status, "PROPOSED"),
          gte(liveProposedOrderTable.recordedAt, new Date(decisionTime.getTime() - 15 * 60_000)),
        ));
      // No shadow fills exist: conservatively reserve the full stake as potential loss.
      const reservedLoss = Math.max(0, current.shadowCapitalLimit - current.shadowCapitalRemaining);
      const remainingLossBudget = Math.max(0, current.shadowMaxTotalLoss - reservedLoss);
      const quoteAge = orderbook ? decisionTime.getTime() - Date.parse(orderbook.observedAt) : Number.NaN;
      const reasons: string[] = [];
      if (current.shadowCapitalLimit <= 0 || current.shadowCapitalRemaining <= 0) reasons.push("shadow_capital_exhausted");
      if (current.shadowMaxStakePerTrade <= 0) reasons.push("shadow_stake_limit_is_zero");
      if (current.shadowMaxOpenPositions <= Number(open?.count ?? 0)) reasons.push("shadow_open_position_limit_reached");
      if (current.shadowMaxTotalLoss <= 0 || remainingLossBudget <= 0) reasons.push("shadow_loss_exposure_limit_reached");
      const evaluationAge = decisionTime.getTime() - evaluation.evaluatedAt.getTime();
      if (evaluationAge < 0 || evaluationAge > SHADOW_FRESHNESS_MS) reasons.push("evaluation_stale");
      if (feedError || !orderbook || !Number.isFinite(price) || price <= 0 || price > 1) reasons.push("quote_missing");
      if (!Number.isFinite(quoteAge) || quoteAge < 0 || quoteAge > SHADOW_FRESHNESS_MS) reasons.push("quote_stale");
      // Preserve the V1.3 Scout/Confirm offer ceilings without using real-money config.
      if (Number.isFinite(price) && price > (evaluation.signal === "SCOUT" ? 0.60 : 0.68)) {
        reasons.push("quote_above_v13_entry_cap");
      }
      if (evaluation.entryOffer === null) reasons.push("reference_entry_price_missing");
      else if (Number.isFinite(price) && price > evaluation.entryOffer) reasons.push("quote_above_reference_offer");
      const spendable = Math.min(
        current.shadowCapitalRemaining, current.shadowMaxStakePerTrade, remainingLossBudget,
      );
      const contracts = calculateShadowContractCount(spendable, price, availableContracts);
      if (contracts < 1) reasons.push("no_available_contracts_or_shadow_budget");
      const intendedStake = Number((contracts * price).toFixed(4));
      const allowed = reasons.length === 0;
      const remainingCapital = allowed
        ? Number((current.shadowCapitalRemaining - intendedStake).toFixed(4))
        : current.shadowCapitalRemaining;
      const quotePrice = Number.isFinite(price) && price > 0 && price <= 1 ? price : null;
      const proposal: ProposedOrderInput = allowed
        ? {
            id: randomUUID(),
            marketTicker: evaluation.marketTicker,
            crossingKey: evaluation.crossingKey!,
            triggerType: evaluation.signal as "SCOUT" | "CONFIRM",
            direction: evaluation.direction as "UP" | "DOWN",
            sourceEvaluationId: evaluation.id,
            quotePrice: price,
            proposedLimitPrice: price,
            contracts,
            intendedStake,
            simulatedRemainingCapital: remainingCapital,
            status: "PROPOSED",
            riskVerdict: "ALLOW",
            riskReason: "shadow_only; no Kalshi order submission",
            recordedAt: decisionTime,
          }
        : createBlockedProposal(evaluation, quotePrice, remainingCapital, reasons.join(","));
      const [inserted] = await tx.insert(liveProposedOrderTable).values(proposal)
        .onConflictDoNothing({
          target: [
            liveProposedOrderTable.marketTicker,
            liveProposedOrderTable.crossingKey,
            liveProposedOrderTable.triggerType,
          ],
        }).returning();
      if (inserted && allowed) {
        await tx.update(liveExecutionConfigTable)
          .set({ shadowCapitalRemaining: remainingCapital, updatedAt: decisionTime })
          .where(eq(liveExecutionConfigTable.id, "singleton"));
      }
      return { inserted: Boolean(inserted), reasons };
    });
    if (decision.inserted) {
      recorded += 1;
      if (decision.reasons.length > 0) {
        await appendNotification("RISK", "A shadow proposal was blocked by risk checks", "WARN", {
          marketTicker: evaluation.marketTicker,
          evaluationId: evaluation.id,
          reasons: decision.reasons,
        });
      }
    }
  }
  return { scanned: unprocessedEvaluations.length, recorded };
}

let observerTimer: ReturnType<typeof setInterval> | null = null;
let scanInProgress = false;
let productionScanCount = 0;

export function startShadowObserver(intervalMs = DEFAULT_OBSERVER_INTERVAL_MS) {
  if (!isShadowObserverEnabled(process.env.NODE_ENV, process.env.SHADOW_LIVE_PRODUCTION_ENABLED)) {
    return null;
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 1_000) {
    throw new RangeError("Shadow observer interval must be at least 1000ms");
  }
  if (observerTimer) return observerTimer;
  observerTimer = setInterval(async () => {
    if (scanInProgress) return;
    scanInProgress = true;
    try {
      const result = await scanShadowOnce();
      if (process.env.NODE_ENV === "production" && ++productionScanCount % 12 === 0) {
        logger.info({ scanned: result.scanned, recorded: result.recorded, skipped: result.skipped },
          "Production shadow observer heartbeat");
      }
    } catch (error) {
      // Never log account payloads, credentials, or raw client exceptions.
      logger.error({ errorType: error instanceof Error ? error.name : "UnknownError" },
        "Shadow observer scan failed");
    } finally {
      scanInProgress = false;
    }
  }, intervalMs);
  observerTimer.unref?.();
  return observerTimer;
}

export function stopShadowObserver() {
  if (!observerTimer) return;
  clearInterval(observerTimer);
  observerTimer = null;
}