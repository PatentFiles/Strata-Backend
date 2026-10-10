import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db, liveExecutionConfigTable, microLiveConfigTable, microLivePairBoundaryTable,
  microLivePairFundingAttemptTable, type MicroLivePairFundingAttempt,
} from "@workspace/db";
import {
  readPairTransferHistory, readPrimaryIndex2Balance, postOneShotPairFunding,
  verifyFundingTransferCredential,
  type PrimaryBalanceEvidence,
} from "./kalshiPairFundingClient";
import { verifyFreshPairClean, verifyPairKeyMetadata } from "./generatePairRestrictedKalshiKey";
import { verifyKalshiRestrictedTradingKeyForSubaccount } from "./kalshiAccountClient";
import { databasePairKeyAttemptStore } from "./microLivePairKeyProvisioningAttempt";
import { isFundingBoundaryEligible, reconcileMicroLivePairFunding } from "./microLivePairBoundary";

const PAIR = 1;
const SHARD = 2;
const AMOUNT = 25_000_000n;
const MAX_PREFLIGHT_AGE = 30_000;
type Attempt = MicroLivePairFundingAttempt;
type FundingStatus = { state: "blocked" | "attempted" | "uncertain" | "funded"; reason: string };

function environmentSafe() {
  return process.env.NODE_ENV === "development" &&
    process.env.REPLIT_DEPLOYMENT !== "1" &&
    process.env.KALSHI_API_ENVIRONMENT === "production" &&
    process.env.MICRO_LIVE_PRODUCTION_ENABLED !== "true" &&
    process.env.LIVE_EXECUTION_ENABLED !== "true";
}

function keyIdentity() {
  const id = process.env.KALSHI_INDEX2_API_KEY_ID?.trim();
  const raw = process.env.KALSHI_INDEX2_PRIVATE_KEY?.trim();
  if (!id || !raw) throw new Error("Dedicated key is unavailable");
  const pem = raw.replaceAll("\\n", "\n")
    .replace(/(-----BEGIN [A-Z ]+-----)\s*/, "$1\n")
    .replace(/\s*(-----END [A-Z ]+-----)/, "\n$1");
  return { id, fingerprint: createHash("sha256").update(`${id}\u001f${pem}`).digest("hex") };
}

function gatesSafe(
  config: typeof microLiveConfigTable.$inferSelect | undefined,
  live: typeof liveExecutionConfigTable.$inferSelect | undefined,
): boolean {
  return !!config && !!live && config.microLiveRunPhase === "FROZEN" &&
    config.manualKillSwitch && live.manualKillSwitch &&
    !config.microLiveProductionEnabled && !config.liveExecutionEnabled &&
    !live.liveExecutionEnabled && environmentSafe();
}

function exactBound(
  boundary: typeof microLivePairBoundaryTable.$inferSelect | undefined,
  identity: ReturnType<typeof keyIdentity>,
): boolean {
  return !!boundary && isFundingBoundaryEligible(boundary, {
    subaccountNumber: PAIR, apiKeyId: identity.id, fingerprint: identity.fingerprint,
  }) && boundary.cleanBalanceMicros === "0" &&
    boundary.cleanOrderCount === 0 && boundary.cleanFillCount === 0 &&
    boundary.cleanPositionCount === 0 && boundary.cleanSettlementCount === 0 &&
    boundary.fundingTransferId === null && boundary.ambiguityFrozenAt === null;
}

export type FundingPreflight = {
  primary: PrimaryBalanceEvidence;
  boundaryDigest: string;
  marketTicker: string;
  checkedAt: number;
};

export interface FundingAttemptStore {
  get(): Promise<Attempt | null>;
  reserve(proof: FundingPreflight): Promise<Attempt | null>;
  markResponse(attemptId: string): Promise<void>;
  markUncertain(attemptId: string): Promise<void>;
  markReconciled(attemptId: string, transferId: string): Promise<void>;
}

export const databaseFundingAttemptStore: FundingAttemptStore = {
  async get() {
    const [row] = await db.select().from(microLivePairFundingAttemptTable)
      .where(and(eq(microLivePairFundingAttemptTable.destinationSubaccount, PAIR),
        eq(microLivePairFundingAttemptTable.exchangeIndex, SHARD))).limit(1);
    return row ?? null;
  },
  async reserve(proof) {
    if (!environmentSafe() || Date.now() - proof.checkedAt < 0 ||
        Date.now() - proof.checkedAt > MAX_PREFLIGHT_AGE ||
        BigInt(proof.primary.scopedMicros) < AMOUNT ||
        BigInt(proof.primary.inventoryMicros) < AMOUNT) return null;
    const identity = keyIdentity();
    return db.transaction(async tx => {
      const [config] = await tx.select().from(microLiveConfigTable)
        .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
      const [live] = await tx.select().from(liveExecutionConfigTable)
        .where(eq(liveExecutionConfigTable.id, "singleton")).for("update").limit(1);
      const [boundary] = await tx.select().from(microLivePairBoundaryTable)
        .where(eq(microLivePairBoundaryTable.subaccountNumber, PAIR)).for("update").limit(1);
      if (!gatesSafe(config, live) || !exactBound(boundary, identity) ||
          boundary?.cleanBoundaryEvidenceDigest !== proof.boundaryDigest ||
          Date.now() - proof.checkedAt > MAX_PREFLIGHT_AGE) return null;
      const [row] = await tx.insert(microLivePairFundingAttemptTable).values({
        attemptId: randomUUID(), sourceSubaccount: 0, destinationSubaccount: PAIR,
        exchangeIndex: SHARD, amountCents: 2500,
        marketTicker: proof.marketTicker, state: "attempted",
        sourceScopedBeforeMicros: proof.primary.scopedMicros,
        sourceInventoryBeforeMicros: proof.primary.inventoryMicros,
        cleanBoundaryDigest: proof.boundaryDigest,
        attemptedAt: new Date(),
      }).onConflictDoNothing().returning();
      return row ?? null;
    });
  },
  async markResponse(id) {
    await db.update(microLivePairFundingAttemptTable)
      .set({ state: "response_received", responseReceivedAt: new Date() })
      .where(and(eq(microLivePairFundingAttemptTable.attemptId, id),
        eq(microLivePairFundingAttemptTable.state, "attempted")));
  },
  async markUncertain(id) {
    await db.update(microLivePairFundingAttemptTable).set({ state: "uncertain" })
      .where(and(eq(microLivePairFundingAttemptTable.attemptId, id),
        eq(microLivePairFundingAttemptTable.state, "attempted")));
  },
  async markReconciled(id, transferId) {
    await db.update(microLivePairFundingAttemptTable).set({
      state: "reconciled", transferId, reconciledAt: new Date(),
    }).where(and(eq(microLivePairFundingAttemptTable.attemptId, id),
      eq(microLivePairFundingAttemptTable.destinationSubaccount, PAIR)));
  },
};

async function currentTicker(): Promise<string> {
  const response = await fetch(
    "https://external-api.kalshi.com/trade-api/v2/markets?series_ticker=KXBTC15M&status=open&limit=200",
    { method: "GET", cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(15_000) },
  );
  if (response.status !== 200) throw new Error("Current market unavailable");
  const data: unknown = await response.json();
  const root = data as { markets?: unknown; cursor?: unknown };
  if (!root || !Array.isArray(root.markets) || root.cursor) throw new Error("Market list incomplete");
  const now = Date.now();
  const matches = root.markets.filter((market): market is { ticker: string } => {
    if (!market || typeof market !== "object" || Array.isArray(market)) return false;
    const m = market as Record<string, unknown>;
    return typeof m.ticker === "string" && /^KXBTC15M-[A-Za-z0-9-]+$/.test(m.ticker) &&
      m.exchange_index === SHARD && m.status === "active" &&
      typeof m.open_time === "string" && Date.parse(m.open_time) <= now &&
      typeof m.close_time === "string" && Date.parse(m.close_time) > now;
  });
  if (matches.length !== 1) throw new Error("Current index-2 market ambiguous");
  return matches[0]!.ticker;
}

export type FundingDependencies = {
  store: FundingAttemptStore;
  readPrimary: typeof readPrimaryIndex2Balance;
  readDestination: () => Promise<PrimaryBalanceEvidence>;
  readTransfers: typeof readPairTransferHistory;
  verifyClean: typeof verifyFreshPairClean;
  verifyKey: () => Promise<boolean>;
  verifyTransferKey: () => Promise<boolean>;
  postTransfer: typeof postOneShotPairFunding;
  ticker: typeof currentTicker;
  reconcileBoundary: typeof reconcileMicroLivePairFunding;
  readState: () => Promise<{
    boundary: typeof microLivePairBoundaryTable.$inferSelect | undefined;
    config: typeof microLiveConfigTable.$inferSelect | undefined;
    live: typeof liveExecutionConfigTable.$inferSelect | undefined;
  }>;
};

export const fundingDependencies: FundingDependencies = {
  store: databaseFundingAttemptStore,
  readPrimary: readPrimaryIndex2Balance,
  readDestination: () => readPrimaryIndex2Balance(PAIR),
  readTransfers: readPairTransferHistory,
  verifyClean: verifyFreshPairClean,
  verifyKey: async () => {
    const attempt = await databasePairKeyAttemptStore.get();
    const key = keyIdentity();
    return attempt?.state === "handoff_confirmed" &&
      attempt.keyId === key.id && !!attempt.metadataVerifiedAt &&
      !!attempt.confirmedAt && await verifyPairKeyMetadata(key.id) &&
      await verifyKalshiRestrictedTradingKeyForSubaccount(PAIR, "index2");
  },
  verifyTransferKey: verifyFundingTransferCredential,
  postTransfer: postOneShotPairFunding,
  ticker: currentTicker,
  reconcileBoundary: reconcileMicroLivePairFunding,
  readState: async () => {
    const [[boundary], [config], [live]] = await Promise.all([
      db.select().from(microLivePairBoundaryTable)
        .where(eq(microLivePairBoundaryTable.subaccountNumber, PAIR)).limit(1),
      db.select().from(microLiveConfigTable)
        .where(eq(microLiveConfigTable.id, "singleton")).limit(1),
      db.select().from(liveExecutionConfigTable)
        .where(eq(liveExecutionConfigTable.id, "singleton")).limit(1),
    ]);
    return { boundary, config, live };
  },
};

export async function preflightFunding(deps: FundingDependencies = fundingDependencies): Promise<FundingPreflight> {
  if (!environmentSafe()) throw new Error("Execution environment is not safely frozen");
  const { boundary, config, live } = await deps.readState();
  if (!gatesSafe(config, live) || !exactBound(boundary, keyIdentity()) ||
      await deps.store.get()) throw new Error("Funding boundary or execution gates unavailable");
  if (!await deps.verifyKey() || !await deps.verifyTransferKey()) {
    throw new Error("Saved restricted or unrestricted transfer key did not verify");
  }
  const [primary] = await Promise.all([deps.readPrimary(), deps.verifyClean()]);
  if (BigInt(primary.scopedMicros) < AMOUNT || BigInt(primary.inventoryMicros) < AMOUNT ||
      Date.now() - primary.observedAt > 30_000 || primary.observedAt > Date.now() + 5_000) {
    throw new Error("Primary (0,2) cash not proven");
  }
  const marketTicker = await deps.ticker();
  const checkedAt = Date.now();
  return { primary, boundaryDigest: boundary!.cleanBoundaryEvidenceDigest, marketTicker, checkedAt };
}

export async function submitOneShotFunding(
  deps: FundingDependencies = fundingDependencies,
): Promise<FundingStatus> {
  let proof: FundingPreflight;
  try { proof = await preflightFunding(deps); }
  catch { return { state: "blocked", reason: "Fresh read-only preflight failed; no transfer sent" }; }
  let attempt: Attempt | null;
  try { attempt = await deps.store.reserve(proof); }
  catch { return { state: "blocked", reason: "Durable one-use attempt unavailable; no transfer sent" }; }
  if (!attempt) return { state: "blocked", reason: "Transfer already attempted or safety state changed" };
  // The attempted latch has committed. An uncertain outcome NEVER triggers a second POST.
  try {
    const { boundary, config, live } = await deps.readState();
    if (!gatesSafe(config, live) || !exactBound(boundary, keyIdentity()) ||
        boundary?.cleanBoundaryEvidenceDigest !== proof.boundaryDigest ||
        Date.now() - proof.checkedAt > MAX_PREFLIGHT_AGE) {
      return { state: "blocked", reason: "Safety state changed after one-use reservation; no transfer sent" };
    }
  } catch {
    return { state: "blocked", reason: "Safety recheck failed after reservation; no transfer sent" };
  }
  try {
    await deps.postTransfer(attempt.attemptId);
    await deps.store.markResponse(attempt.attemptId);
  } catch {
    try { await deps.store.markUncertain(attempt.attemptId); } catch { /* latch remains durable */ }
    // Inspect once using GETs, even when the POST response was lost. The
    // absent client-ID echo prevents automatic attribution or a second POST.
    const observed = await reconcileOneShotFunding(deps);
    return observed.state === "funded" ? observed : {
      state: "uncertain",
      reason: `Transfer outcome uncertain; ${observed.reason}. Never retry the transfer`,
    };
  }
  return reconcileOneShotFunding(deps);
}

export async function reconcileOneShotFunding(
  deps: FundingDependencies = fundingDependencies,
): Promise<FundingStatus> {
  try {
    const attempt = await deps.store.get();
    if (!attempt || attempt.sourceSubaccount !== 0 ||
        attempt.destinationSubaccount !== PAIR || attempt.exchangeIndex !== SHARD ||
        attempt.amountCents !== 2500 ||
        !/^KXBTC15M-[A-Za-z0-9-]+$/.test(attempt.marketTicker)) {
      return { state: "blocked", reason: "No exact durable funding attempt" };
    }
    const { boundary, config, live } = await deps.readState();
    if (!gatesSafe(config, live) || !boundary ||
        boundary.cleanBoundaryEvidenceDigest !== attempt.cleanBoundaryDigest ||
        !["KEY_BOUND_VERIFIED", "funded"].includes(boundary.state) ||
        boundary.ambiguityFrozenAt !== null ||
        boundary.restrictedApiKeyId !== keyIdentity().id ||
        boundary.restrictedKeyFingerprint !== keyIdentity().fingerprint) {
      return { state: "blocked", reason: "Funding or execution safety boundary changed" };
    }
    if (attempt.state === "reconciled") {
      return boundary.state === "funded" &&
        boundary.fundingTransferId === attempt.transferId &&
        boundary.postFundingBalanceMicros === "25000000"
        ? { state: "funded", reason: "Already reconciled" }
        : { state: "blocked", reason: "Reconciled attempt does not match funded boundary" };
    }
    const [history, primary, destination] = await Promise.all([
      deps.readTransfers(), deps.readPrimary(), deps.readDestination(),
    ]);
    const since = boundary.cleanBoundaryAt.getTime();
    const later = history.filter(x => Date.parse(x.occurredAt) >= since);
    const touching = later.filter(x => x.exchangeIndex === SHARD &&
      (x.fromSubaccount === PAIR || x.toSubaccount === PAIR));
    const sourceActivity = later.filter(x => x.exchangeIndex === SHARD &&
      (x.fromSubaccount === 0 || x.toSubaccount === 0) &&
      Date.parse(x.occurredAt) >= attempt.attemptedAt.getTime() - 1000);
    const exact = touching.filter(x => x.fromSubaccount === 0 && x.toSubaccount === PAIR &&
      x.exchangeIndex === SHARD && x.amountCents === 2500 &&
      Date.parse(x.occurredAt) >= attempt.attemptedAt.getTime() - 1000);
    if (touching.length !== 1 || exact.length !== 1 || sourceActivity.length !== 1 ||
        sourceActivity[0]!.transferId !== exact[0]!.transferId ||
        primary.updatedAt < attempt.attemptedAt.getTime() - 1000 ||
        destination.updatedAt < attempt.attemptedAt.getTime() - 1000 ||
        BigInt(destination.scopedMicros) !== AMOUNT ||
        BigInt(destination.inventoryMicros) !== AMOUNT ||
        BigInt(attempt.sourceScopedBeforeMicros) - BigInt(primary.scopedMicros) !== AMOUNT ||
        BigInt(attempt.sourceInventoryBeforeMicros) - BigInt(primary.inventoryMicros) !== AMOUNT) {
      return { state: "uncertain", reason: "Exact transfer and source/destination cash not proven; no retry" };
    }
    if (attempt.state !== "response_received") {
      return { state: "uncertain", reason: "One matching transfer and exact cash changes observed, but lost POST response cannot be attributed to its client ID; manual review required, no retry" };
    }
    // The existing reconciler independently proves destination $25, complete
    // account history, no activity, and binds the exact transfer in one DB transaction.
    if (boundary.state === "KEY_BOUND_VERIFIED") {
      const result = await deps.reconcileBoundary({
        subaccountNumber: PAIR, ticker: attempt.marketTicker,
        acknowledgedAttemptId: attempt.attemptId,
      });
      if (result.status !== "funded") {
        return { state: "uncertain", reason: "Destination or activity reconciliation failed; no retry" };
      }
    }
    const latest = await deps.readState();
    if (latest.boundary?.state !== "funded" ||
        latest.boundary.fundingTransferId !== exact[0]!.transferId ||
        latest.boundary.postFundingBalanceMicros !== "25000000" ||
        !gatesSafe(latest.config, latest.live)) {
      return { state: "uncertain", reason: "Funded boundary does not match the one-shot transfer" };
    }
    await deps.store.markReconciled(attempt.attemptId, exact[0]!.transferId);
    return { state: "funded", reason: "Exactly one $25 transfer reconciled; execution remains off" };
  } catch {
    return { state: "uncertain", reason: "GET-only reconciliation unavailable; no retry" };
  }
}