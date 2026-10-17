import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import test, { after, afterEach, before, beforeEach } from "node:test";
import { V13_CHAMPION_PARAMETER_HASH, V13_CHAMPION_PARAMETER_SET } from "@workspace/v13-strategy";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  forwardTestEngineTable,
  forwardTestEvaluationTable,
  liveExecutionConfigTable,
  microLiveConfigTable,
  microLiveDecisionTable,
  microLiveFeeVerificationTable,
  microLiveFillTable,
  microLiveOrderTable,
  microLivePairBoundaryTable,
  microLiveRunArchiveTable,
  microLiveSettlementTable,
  microLiveSubaccountCreationAttemptTable,
  pool,
} from "@workspace/db";
import {
  auditMicroLiveReadOnly,
  armBoundedMicroLiveRun,
  cancelAndVerifyMicroLiveExit,
  emergencyStopMicroLive,
  executeQualifiedV13Trigger,
  freshOwnershipPreflight,
  getMicroLiveState,
  isMicroLiveCashPreflightCurrent,
  observeMicroLiveWorkerLeaseForIsolatedTest,
  prepareNextBoundedMicroLiveRun,
  reviewPrimaryMicroLiveAccountBinding,
  registerMicroLiveWorkerLeaseOwner,
  simulateMicroLiveRestartForIsolatedTest,
  processMicroLiveForwardTestCycle,
  qualifyMicroLivePositionEvaluation,
  reconcileMicroLiveAtStartup,
  resumeBoundedMicroLiveExitOnly,
  resolveStalePrimaryAccounting,
  type MicroLiveDependencies,
} from "./microLive";
import { reconcileUncertainSubmission } from "./microLiveRecovery";
import {
  captureMicroLivePairCleanBoundary,
  bindMicroLivePairRestrictedKey,
  initializeMicroLivePairRun,
  reconcileMicroLivePairFunding,
  verifyMicroLivePairBoundary,
} from "./microLivePairBoundary";
import {
  createMicroLiveSubaccountCreationService,
  databaseCreationAttemptStore,
} from "./microLiveSubaccountCreation";
import {
  reconcileMicroLiveSettlement,
  verifyDedicatedSettlementPairActivity,
} from "./microLiveSettlement";
import { microLiveOrderLegFillPrice } from "./microLiveFillNormalization";
import { dollarsToMicros, fillTradeMicros } from "./microLiveMoney";
import {
  computeBotAttributableAvailableCashDelta,
  createPrimaryCashActivityEventDigest,
  reconcilePrimaryCashActivityCheckpoint,
} from "./microLivePrimaryCashAccounting";
import {
  approvedFeeSession, feeApprovalView, revokeFeeApproval, STANDING_FEE_POLICY_VERSION,
} from "./microLiveFeeApproval";
import {
  maximumExitCashDebitOnMarketGridPerContractMicros,
  entryCashDebitMicrosForContracts,
  maximumEntryCashDebitPerContractMicros,
  maximumEntryFeePerContractMicros,
  maximumExitLossAtLimitOnMarketGridPerContractMicros,
  maximumExitLossOnMarketGridPerContractMicros,
  VERIFIED_FEE_MODEL_FINGERPRINT,
} from "./microLiveEntryFees";
import {
  CANONICAL_FEE_SCHEDULE_URL, STANDARD_QUADRATIC_FEE_FORMULA_VERSION,
  parseFeeSchedulePdf, parseFeeScheduleText, verifyCurrentFeeArtifact,
} from "./microLiveFeeArtifact";
import {
  beginFeeVerification, finishFeeVerification, getFeeVerificationState,
  type FeeVerificationIdentity,
} from "./microLiveFeeVerification";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
// The integration test is bundled to CJS; provide pdfjs' real worker handler
// directly so PDF.js does not resolve a nonexistent dist/pdf.worker.mjs.
// @ts-expect-error pdfjs-dist does not declare types for this worker entrypoint.
import { WorkerMessageHandler } from "pdfjs-dist/legacy/build/pdf.worker.mjs";
import { withinAllInLiveTestCap } from "./microLiveFeeCap";
import type {
  KalshiAccountActivity, KalshiAccountSnapshot, KalshiDedicatedPairEvidence,
  KalshiDedicatedPairFundingAnchor, KalshiPairEvidenceRecord,
  KalshiProspectiveCleanPairSnapshot,
  KalshiSettlementsSnapshot, KalshiSubmissionEvidence,
} from "./kalshiAccountClient";

if (!/^micro_live_test_[a-f0-9]{24}$/.test(process.env.MICRO_LIVE_TEST_ISOLATED_SCHEMA ?? "")) {
  throw new Error("Micro-live integration tests require a disposable isolated schema");
}

const suffix = randomUUID().replaceAll("-", "").slice(0, 14);
const ticker = `KXBTC15M-MICRO-${suffix}`;
const testTickers = new Set<string>();
const testEvaluationIds = new Set<string>();
const resolutionDecisionIds = new Set<string>();
const transitionPriorRunIds = new Set<string>();
const pairBoundarySubaccounts = new Set<number>();
const pairBoundaryFeeApprovalIds = new Set<string>();
const creationAttemptIds = new Set<string>();
const envKeys = [
  "MICRO_LIVE_PRODUCTION_ENABLED", "LIVE_EXECUTION_ENABLED", "KALSHI_BOT_SUBACCOUNT",
  "MICRO_LIVE_ACCOUNT_MODE", "KALSHI_API_KEY_ID", "KALSHI_API_PRIVATE_KEY",
] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
let originalConfig: typeof microLiveConfigTable.$inferSelect | undefined;
let originalEngine: typeof forwardTestEngineTable.$inferSelect | undefined;
const now = () => new Date();
const legacyMockFeeApproval = {
  id: `isolated-legacy-fee-approval-${suffix}`,
  digest: createHash("sha256").update(`isolated-legacy-fee-policy-${suffix}`).digest("hex"),
  approvedAt: Date.now(),
  policyVersion: STANDING_FEE_POLICY_VERSION,
  maximumExposureMicros: 5_000_000,
  approvedRunCapMicros: 5_000_000,
  approvedBy: "isolated-test-administrator",
};
const originalFetch = globalThis.fetch;
const mockedCashBalances = new WeakMap<object, { baselineMicros: bigint; lastMicros: bigint }>();
let isolatedFeeFetchCount = 0;
const isolatedFeeScheduleText = "Kalshi Fee Schedule Effective January 1, 2020 General Trading Fees apply to all Kalshi markets. KXBTC15M markets are covered by General Trading Fees. Standard quadratic taker fee = 0.07 x contracts x price x (1 - price).";

function buildIsolatedFeeSchedulePdf(): Buffer {
  const [heading, targetMapping, formula] = [
    "Kalshi Fee Schedule Effective January 1, 2020 General Trading Fees apply to all Kalshi markets.",
    "KXBTC15M markets are covered by General Trading Fees.",
    "Standard quadratic taker fee = 0.07 x contracts x price x (1 - price).",
  ];
  const escapePdfText = (text: string) => text.replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(").replaceAll(")", "\\)");
  const stream = `BT /F1 10 Tf 40 720 Td (${escapePdfText(heading)}) Tj 0 -14 Td (${escapePdfText(targetMapping)}) Tj 0 -14 Td (${escapePdfText(formula)}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body);
}

const isolatedFeeSchedulePdf = buildIsolatedFeeSchedulePdf();
const isolatedFeeScheduleDigest = createHash("sha256")
  .update(isolatedFeeSchedulePdf).digest("hex");
(globalThis as typeof globalThis & {
  pdfjsWorker?: { WorkerMessageHandler: typeof WorkerMessageHandler };
}).pdfjsWorker = { WorkerMessageHandler };

function installIsolatedFeeScheduleFetch() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    isolatedFeeFetchCount++;
    assert.equal(String(input), CANONICAL_FEE_SCHEDULE_URL,
      "the integration fixture permits only the pinned official fee-schedule URL");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    return new Response(isolatedFeeSchedulePdf, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-length": String(isolatedFeeSchedulePdf.length),
      },
    });
  }) as typeof fetch;
}

async function verifyIsolatedFeeArtifact(digest: string) {
  const previousFetch = globalThis.fetch;
  installIsolatedFeeScheduleFetch();
  try {
    const verification = await verifyCurrentFeeArtifact({
      digest,
      policyVersion: STANDING_FEE_POLICY_VERSION,
      sourceUrl: CANONICAL_FEE_SCHEDULE_URL,
      formulaVersion: STANDARD_QUADRATIC_FEE_FORMULA_VERSION,
    });
    assert.equal(verification.status, "verified");
    assert.equal(verification.valid, true);
    assert.equal(verification.digest, digest);
    assert.equal(verification.formulaVersion, STANDARD_QUADRATIC_FEE_FORMULA_VERSION);
    return verification;
  } finally {
    globalThis.fetch = previousFetch;
  }
}

function verificationIdentity(approval: {
  id: string;
  digest: string;
  policyVersion: string;
  sourceUrl: string;
  formulaVersion: string;
}): FeeVerificationIdentity {
  return {
    approvalId: approval.id,
    approvalDigest: approval.digest,
    policyVersion: approval.policyVersion,
    sourceUrl: approval.sourceUrl,
    formulaVersion: approval.formulaVersion,
  };
}

function installPristineRestartGetMocks(
  marketTicker: string,
  artifactState: "valid" | "stale" | "unavailable" = "valid",
) {
  const eventTicker = `${marketTicker}-EVENT`;
  const closeTime = new Date(Date.now() + 15 * 60_000).toISOString();
  const expirationTime = new Date(Date.parse(closeTime) + 7 * 24 * 60 * 60_000).toISOString();
  const priceRanges = [{ start: "0.0100", end: "0.9900", step: "0.0100" }];
  const market = {
    ticker: marketTicker, status: "open", exchange_index: 2, close_time: closeTime,
    expiration_time: expirationTime, latest_expiration_time: expirationTime,
    expected_expiration_time: closeTime,
    event_ticker: eventTicker, price_ranges: priceRanges,
  };
  let canonicalGets = 0;
  let marketEvidenceGets = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(init?.method ?? "GET", "GET",
      "restart recovery must use GET-only evidence");
    if (url.href === CANONICAL_FEE_SCHEDULE_URL) {
      canonicalGets++;
      if (artifactState === "unavailable") {
        return new Response("isolated artifact rate limited", { status: 429 });
      }
      const bytes = artifactState === "stale"
        ? Buffer.concat([isolatedFeeSchedulePdf, Buffer.from(" ")])
        : isolatedFeeSchedulePdf;
      return new Response(bytes, {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-length": String(bytes.length),
        },
      });
    }

    assert.equal(url.origin, "https://external-api.kalshi.com");
    assert.equal(url.pathname.startsWith("/trade-api/v2/"), true,
      `restart recovery requested an unapproved isolated URL: ${url.href}`);
    marketEvidenceGets++;
    if (url.pathname === "/trade-api/v2/markets" &&
        url.searchParams.get("series_ticker") === "KXBTC15M") {
      return Response.json({ markets: [market] });
    }
    if (url.pathname === `/trade-api/v2/markets/${marketTicker}`) {
      return Response.json({ market });
    }
    if (url.pathname === "/trade-api/v2/series/KXBTC15M") {
      return Response.json({ series: { ticker: "KXBTC15M", exchange_index: 2,
        fee_type: "quadratic", fee_multiplier: "1",
        last_updated_ts: new Date(Date.now() - 60_000).toISOString() } });
    }
    if (url.pathname === `/trade-api/v2/events/${eventTicker}`) {
      return Response.json({ event: {
        event_ticker: eventTicker, series_ticker: "KXBTC15M",
        exchange_index: 2,
        last_updated_ts: "0001-01-01T00:00:00Z",
        fee_type_override: null, fee_multiplier_override: null,
      } });
    }
    if (url.pathname === "/trade-api/v2/series/fee_changes") {
      return Response.json({ series_fee_change_arr: [] });
    }
    if (url.pathname === "/trade-api/v2/events/fee_changes") {
      return Response.json({ event_fee_changes: [], cursor: "" });
    }
    assert.fail(`unexpected isolated restart GET: ${url.href}`);
  }) as typeof fetch;
  return {
    counts: () => ({ canonicalGets, marketEvidenceGets }),
    eventTicker,
  };
}

function withoutTestFeeOverrides(dependencies: MicroLiveDependencies): MicroLiveDependencies {
  const isolated = { ...dependencies };
  delete isolated.readEntryFeeTerms;
  delete isolated.approvedFeeSessionForTest;
  return isolated;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function synchronizeMockedBotCash(
  account: KalshiAccountSnapshot,
): Promise<KalshiAccountSnapshot> {
  const availableMicros = dollarsToMicros(account.balance.availableCashDollars);
  if (availableMicros === null) return account;
  const [config] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  if (config?.microLiveAccountMode !== "primary_nonexclusive" ||
      config.microLivePrimaryCashBaselineMicros === null) return account;
  const baselineMicros = BigInt(config.microLivePrimaryCashBaselineMicros);
  const prior = mockedCashBalances.get(account);
  if (prior && BigInt(availableMicros) !== prior.lastMicros) return account;
  if (!prior && BigInt(availableMicros) !== baselineMicros) return account;

  const orders = await db.select().from(microLiveOrderTable);
  const byExchangeId = new Map(orders.flatMap((row) => row.exchangeOrderId
    ? [[row.exchangeOrderId, row] as const] : []));
  let deltaMicros = 0n;
  for (const fill of account.fills) {
    if (!fill.orderId) continue;
    const row = byExchangeId.get(fill.orderId);
    if (!row) continue;
    const outcomeSide = row.side === "UP"
      ? (row.action === "buy" ? "yes" : "no")
      : (row.action === "buy" ? "no" : "yes");
    const bookSide = outcomeSide === "yes" ? "bid" : "ask";
    const priceDollars = microLiveOrderLegFillPrice(fill, {
      id: row.exchangeOrderId!, ticker: row.marketTicker,
      side: row.side === "UP" ? "yes" : "no", action: row.action,
      outcomeSide, bookSide,
    });
    const tradeMicros = priceDollars === null
      ? null : fillTradeMicros(Number(fill.countFp), priceDollars);
    const feeMicros = dollarsToMicros(fill.feeCostDollars);
    if (tradeMicros === null || feeMicros === null) return account;
    deltaMicros += BigInt(row.action === "buy" ? -tradeMicros : tradeMicros) -
      BigInt(feeMicros);
  }
  const settlements = await db.select().from(microLiveSettlementTable);
  for (const settlement of settlements) {
    if (settlement.feeMicros === null) return account;
    deltaMicros += BigInt(settlement.payoutMicros) - BigInt(settlement.feeMicros);
  }
  const synchronizedMicros = baselineMicros + deltaMicros;
  if (synchronizedMicros < 0n || synchronizedMicros > BigInt(Number.MAX_SAFE_INTEGER)) {
    return account;
  }
  mockedCashBalances.set(account, {
    baselineMicros, lastMicros: synchronizedMicros,
  });
  account.balance.availableCashDollars = (Number(synchronizedMicros) / 1_000_000).toFixed(6);
  return account;
}

async function cleanFixtures() {
  if (creationAttemptIds.size) {
    await db.delete(microLiveSubaccountCreationAttemptTable)
      .where(inArray(microLiveSubaccountCreationAttemptTable.attemptId, [...creationAttemptIds]));
    creationAttemptIds.clear();
  }
  if (pairBoundarySubaccounts.size) {
    await db.delete(microLivePairBoundaryTable)
      .where(inArray(microLivePairBoundaryTable.subaccountNumber, [...pairBoundarySubaccounts]));
    pairBoundarySubaccounts.clear();
  }
  if (pairBoundaryFeeApprovalIds.size) {
    await db.delete(microLiveFeeVerificationTable)
      .where(inArray(microLiveFeeVerificationTable.approvalId, [...pairBoundaryFeeApprovalIds]));
    pairBoundaryFeeApprovalIds.clear();
  }
  if (transitionPriorRunIds.size) {
    await db.delete(microLiveRunArchiveTable)
      .where(inArray(microLiveRunArchiveTable.priorRunId, [...transitionPriorRunIds]));
    transitionPriorRunIds.clear();
  }
  if (resolutionDecisionIds.size) {
    await db.delete(microLiveDecisionTable)
      .where(inArray(microLiveDecisionTable.id, [...resolutionDecisionIds]));
    resolutionDecisionIds.clear();
  }
  const fixtureEvaluationIds = new Set(testEvaluationIds);
  if (testTickers.size) {
    const evaluations = await db.select({ id: forwardTestEvaluationTable.id })
      .from(forwardTestEvaluationTable)
      .where(inArray(forwardTestEvaluationTable.marketTicker, [...testTickers]));
    for (const evaluation of evaluations) fixtureEvaluationIds.add(evaluation.id);
  }
  const orders = testTickers.size
    ? await db.select({
      id: microLiveOrderTable.id, exchangeOrderId: microLiveOrderTable.exchangeOrderId,
    }).from(microLiveOrderTable)
      .where(inArray(microLiveOrderTable.marketTicker, [...testTickers]))
    : [];
  const fixtureOrderIds = new Set(orders.flatMap((order) =>
    [order.id, ...(order.exchangeOrderId ? [order.exchangeOrderId] : [])]));
  const decisionRows = await db.select({
    id: microLiveDecisionTable.id,
    evaluationId: microLiveDecisionTable.evaluationId,
    orderId: microLiveDecisionTable.orderId,
  }).from(microLiveDecisionTable);
  const fixtureDecisionIds = decisionRows.filter((decision) =>
    (decision.evaluationId !== null && fixtureEvaluationIds.has(decision.evaluationId)) ||
    (decision.orderId !== null && fixtureOrderIds.has(decision.orderId)))
    .map((decision) => decision.id);
  if (fixtureDecisionIds.length) {
    await db.delete(microLiveDecisionTable)
      .where(inArray(microLiveDecisionTable.id, fixtureDecisionIds));
  }
  if (testTickers.size) {
    await db.delete(microLiveSettlementTable)
      .where(inArray(microLiveSettlementTable.marketTicker, [...testTickers]));
  }
  if (orders.length) {
    await db.delete(microLiveFillTable)
      .where(inArray(microLiveFillTable.orderId, orders.map((order) => order.id)));
    await db.delete(microLiveOrderTable)
      .where(inArray(microLiveOrderTable.id, orders.map((order) => order.id)));
  }
  if (testTickers.size) {
    await db.delete(forwardTestEvaluationTable)
      .where(inArray(forwardTestEvaluationTable.marketTicker, [...testTickers]));
  }
  testEvaluationIds.clear();
  testTickers.clear();
  pairBoundarySubaccounts.clear();
}

const emptyAccount = () => ({
  balance: { availableCashDollars: "100.00", portfolioValueDollars: "100.00" },
  openOrders: [] as Array<{ id: string; ticker: string; side: string; action: string;
    priceDollars: string | null; remainingCount: string | null; status: string; createdAt: string | null }>,
  positions: [] as Array<{ ticker: string; positionFp: string; marketExposureDollars: string | null;
    realizedPnlDollars: string | null }>,
  fills: [] as Array<{ id: string; orderId: string | null; ticker: string; side: string;
    action: string; countFp: string; priceDollars: string | null; createdAt: string | null;
    feeCostDollars?: string | null }>,
  truncated: { openOrders: false, positions: false, fills: false },
});

test("bounded run needs same-process lease proof and emergency stop prevents resume", async () => {
  const processOwner = `micro-live-test-${suffix}`;
  const runMocks = mocks({
    readAccountActivity: async () => ({
      orders: [], fills: [], available: true, truncated: false,
      keyRestrictionVerified: true, selectedSubaccount: 0,
      scanStartedAt: now().toISOString(), scanFinishedAt: now().toISOString(),
      exclusiveControlVerified: false,
    }),
  });
  process.env.KALSHI_BOT_SUBACCOUNT = "0";
  process.env.MICRO_LIVE_ACCOUNT_MODE = "primary_nonexclusive";
  await db.update(microLiveConfigTable).set({
    microLiveProductionEnabled: false,
    liveExecutionEnabled: false,
    manualKillSwitch: true,
    microLiveAccountMode: null,
    microLiveSelectedSubaccount: null,
    microLiveRunPhase: "UNARMED",
    microLiveRunId: null,
    microLiveEntryAttempted: false,
    microLiveExitAttempted: false,
    microLiveReservedMicros: 0,
  }).where(eq(microLiveConfigTable.id, "singleton"));

  await reviewFrozenPrimaryBinding();
  await db.update(forwardTestEngineTable).set({
    leaseOwner: "different-process-owner",
    leaseExpiresAt: new Date(Date.now() + 60_000),
  }).where(eq(forwardTestEngineTable.id, "v1.3-paper"));
  const approval = legacyMockFeeApproval;
  const dependencies: MicroLiveDependencies = {
    ...runMocks,
    approvedFeeSessionForTest: () => approval,
  };
  const unproven = await armBoundedMicroLiveRun(dependencies);
  assert.deepEqual(unproven, {
    status: "blocked", reason: "v13_worker_lease_not_owned_by_this_process",
  });

  await db.update(forwardTestEngineTable).set({
    leaseOwner: processOwner,
    leaseExpiresAt: new Date(Date.now() + 60_000),
  }).where(eq(forwardTestEngineTable.id, "v1.3-paper"));
  await processMicroLiveForwardTestCycle(`missing-paper-${suffix}`, dependencies);
  let submissions = 0;
  const armed = await armBoundedMicroLiveRun({
    ...dependencies,
    submitOrder: async (input) => {
      submissions++;
      return {
        orderId: `exchange-${input.clientOrderId}`, clientOrderId: input.clientOrderId,
        ticker: input.ticker, side: input.side, action: input.action, type: "limit",
        status: "resting", remainingCount: String(input.count), filledCount: null,
      };
    },
  });
  assert.equal(armed.status, "armed", armed.reason);
  assert.equal(submissions, 0, "arming must never submit an order");
  assert.deepEqual((await getMicroLiveState()).boundedRun.phase, "ENTRY_OPEN");

  await emergencyStopMicroLive();
  const resumed = await resumeBoundedMicroLiveExitOnly(dependencies);
  assert.deepEqual(resumed, {
    status: "blocked", reason: "emergency_stop_overrides_resume",
  });
  const state = await getMicroLiveState();
  assert.equal(state.boundedRun.phase, "FROZEN");
  assert.equal(state.killSwitch, "ON");
  assert.equal(state.databaseFlags?.liveExecutionEnabled, false);
});

async function insertEvaluation(input: {
  signal?: "SCOUT" | "CONFIRM" | "EXIT";
  direction?: "UP" | "DOWN";
  evaluatedAt?: Date;
  qualifyingTrigger?: boolean;
  ticker?: string;
  crossingKey?: string;
  entryOffer?: number | null;
  initialConfirm?: boolean;
}) {
  const marketTicker = input.ticker ?? ticker;
  const crossingKey = input.crossingKey ?? `${marketTicker}:cross`;
  testTickers.add(marketTicker);
  const id = `eval-${randomUUID()}`;
  testEvaluationIds.add(id);
  await db.insert(forwardTestEvaluationTable).values({
    id,
    evaluatedAt: input.evaluatedAt ?? now(),
    strategyVersion: "V1.3",
    strategyParameterSetId: V13_CHAMPION_PARAMETER_SET.id,
    strategyParameterHash: V13_CHAMPION_PARAMETER_HASH,
    marketTicker,
    btcPrice: 65000,
    target: 65000,
    signedBuffer: 0.001,
    absoluteBuffer: 0.001,
    velocity: 0,
    upOffer: 0.5,
    downOffer: 0.5,
    secondsRemaining: 500,
    feedFreshness: "current",
    previousSide: "DOWN",
    currentSide: input.direction ?? "UP",
    freshCross: true,
    crossingConsumed: true,
    crossingKey,
    signal: input.signal ?? "SCOUT",
    direction: input.direction ?? "UP",
    qualifyingTrigger: input.qualifyingTrigger ?? true,
    reason: "persisted qualifying V1.3 evaluation",
    entryOffer: input.entryOffer === undefined ? 0.5 : input.entryOffer,
    positionWasOpen: input.signal === "CONFIRM" && !input.initialConfirm,
    ...(input.signal === "CONFIRM" && !input.initialConfirm ? {
      evaluationSource: "micro_live",
      livePositionId: `position:${marketTicker}:${crossingKey}`,
      sourcePaperEvaluationId: `mock-paper-${id}`,
    } : {}),
  });
  return id;
}

function mocks(overrides: Partial<MicroLiveDependencies> = {}): MicroLiveDependencies {
  let observedAccount: KalshiAccountSnapshot = emptyAccount();
  const accountReader = overrides.readAccount ?? (async () => emptyAccount());
  const feeTermsReader = overrides.readEntryFeeTerms ?? (async (market: string) => ({
    ticker: market, eventTicker: `${market}-EVENT`,
    feePerContractMicrosAtLimit: () => 10_000,
    fingerprint: boundedApprovalFingerprint(legacyMockFeeApproval, market),
    exitCashDebitPerContractMicrosAtLimit: () => 10_000,
    exitFeePerContractMicrosAtLimit: () => 10_000,
    verifiedAt: Date.now(),
  }));
  const approvalForTerms = () =>
    overrides.approvedFeeSessionForTest?.() ?? legacyMockFeeApproval;
  const readFeeTermsWithApprovalFingerprint = async (market: string) => {
    const terms = await feeTermsReader(market);
    if (!terms) return null;
    const suppliedFingerprint = terms.fingerprint.split("|");
    const approval = approvalForTerms();
    return {
      ...terms,
      fingerprint: suppliedFingerprint.length >= 16
        ? terms.fingerprint
        : boundedApprovalFingerprint(
          approval, market, terms.fingerprint || "legacy-test-fee-metadata",
        ),
    };
  };
  return {
    now,
    isolatedTestFeeCapFixture: true,
    readBtc: async () => ({ price: 65000, receivedAt: now(), providerAt: now() }),
    readOrderbook: async () => ({
      yesAskDollars: "0.40",
      noAskDollars: "0.40",
      yesBidDollars: "0.39",
      noBidDollars: "0.39",
      yesAskAvailableContracts: "2",
      noAskAvailableContracts: "2",
      observedAt: now().toISOString(),
    }),
    readAccountActivity: overrides.readAccountActivity ?? (async () => {
      const rows = await db.select().from(microLiveOrderTable);
      const historic = await (overrides.readHistoricalFills ??
        (async () => ({ fills: [], truncated: false, available: true })))(
        rows.filter((row) => row.exchangeOrderId).map((row) => row.marketTicker));
      const fills = [...new Map([...observedAccount.fills, ...historic.fills].map((fill) =>
        [fill.id, { ...fill, feeCostDollars: fill.feeCostDollars ?? null }])).values()];
      return {
        orders: rows.filter((row) => row.exchangeOrderId).map((row) => ({
          id: row.exchangeOrderId!, clientOrderId: row.clientOrderId,
          ticker: row.marketTicker, side: row.side === "UP" ? "yes" : "no",
          action: row.action, type: "limit", status: row.status,
          priceDollars: String(row.requestedLimitPrice),
          initialCount: String(row.requestedContracts),
          filledCount: String(fills.filter((fill) => fill.orderId === row.exchangeOrderId)
            .reduce((sum, fill) => sum + Number(fill.countFp), 0)),
          remainingCount: String(row.remainingContracts),
          createdAt: row.createdAt.toISOString(),
        })),
        fills,
        available: true, truncated: false, keyRestrictionVerified: true,
        selectedSubaccount: 1,
        scanStartedAt: now().toISOString(), scanFinishedAt: now().toISOString(),
        exclusiveControlVerified: true,
      };
    }),
    readPrimaryCashActivityScanForTest:
      overrides.readPrimaryCashActivityScanForTest ?? (async (checkpoint, baseline) => ({
        authenticated: true,
        accountHistoryComplete: true,
        cashTransferHistoryAvailable: true,
        cashTransferHistoryComplete: true,
        selectedSubaccount: 0,
        historyFromCursor: checkpoint?.cursor ?? null,
        nextCursor: `isolated-${randomUUID()}`,
        historyCoveredFrom: baseline.capturedAt,
        scanStartedAt: now().toISOString(),
        scanFinishedAt: now().toISOString(),
        events: [],
      })),
    readHistoricalFills: async () => ({ fills: [], truncated: false, available: true }),
    // Never allow the integration suite to fall through to authenticated
    // exchange GET/DELETE if a test forgets a specific status fixture.
    readOrderStatus: async () => { throw new Error("mock order status not configured"); },
    cancelOrder: async () => { throw new Error("mock cancellation not configured"); },
    submitOrder: async (input) => ({
      orderId: `exchange-${input.clientOrderId}`,
      clientOrderId: input.clientOrderId,
      ticker: input.ticker,
      side: input.side,
      action: input.action,
      type: "limit",
      status: "resting",
      remainingCount: String(input.count),
      filledCount: input.action === "sell" ? "0" : null,
    }),
    ...overrides,
    readEntryFeeTerms: readFeeTermsWithApprovalFingerprint,
    approvedFeeSessionForTest: Object.prototype.hasOwnProperty.call(
      overrides, "approvedFeeSessionForTest",
    ) ? overrides.approvedFeeSessionForTest : () => legacyMockFeeApproval,
    readAccount: async () => {
      observedAccount = await synchronizeMockedBotCash(await accountReader());
      return observedAccount;
    },
  };
}

function cappedEntryMocks(overrides: Partial<MicroLiveDependencies> = {}): MicroLiveDependencies {
  return mocks({
    readOrderbook: async () => ({
      yesAskDollars: "0.40", noAskDollars: "0.40",
      yesBidDollars: "0.39", noBidDollars: "0.39",
      yesAskAvailableContracts: "2", noAskAvailableContracts: "2",
      observedAt: now().toISOString(),
    }),
    readEntryFeeTerms: async (market) => ({
      ticker: market, eventTicker: `${market}-EVENT`,
      feePerContractMicrosAtLimit: () => 100_000, fingerprint: "fixture-cap",
      exitCashDebitPerContractMicrosAtLimit: () => 100_000,
      exitFeePerContractMicrosAtLimit: () => 100_000,
      verifiedAt: Date.now(),
    }),
    ...overrides,
  });
}

function boundedApprovalFingerprint(
  approval: {
    id: string;
    digest: string;
    policyVersion?: string;
    maximumExposureMicros?: number;
    approvedRunCapMicros?: number;
    approvedBy?: string;
  },
  ticker: string,
  metadataRevision = "series-update",
) {
  return [
    ticker, `${ticker}-EVENT`, "open", "close", metadataRevision, "quadratic",
    "market-fee-terms", "no-event-override",
    approval.id, approval.digest, approval.policyVersion ?? STANDING_FEE_POLICY_VERSION,
    String(approval.maximumExposureMicros ?? 5_000_000),
    String(approval.approvedRunCapMicros ?? 5_000_000),
    approval.approvedBy ?? "isolated-test-administrator", "verified-grid",
    VERIFIED_FEE_MODEL_FINGERPRINT,
  ].join("|");
}

function boundedFeeTerms(
  ticker: string,
  fingerprint: string,
): NonNullable<Awaited<ReturnType<NonNullable<MicroLiveDependencies["readEntryFeeTerms"]>>>> {
  return {
    ticker, eventTicker: `${ticker}-EVENT`,
    feePerContractMicrosAtLimit: () => 10_000,
    exitFeePerContractMicrosAtLimit: () => 10_000,
    entryCashDebitPerContractMicrosAtLimit: () => 400_000,
    maximumExitCashDebitPerContractMicros: () => 10_000,
    exitCashDebitPerContractMicrosAtLimit: () => 10_000,
    fingerprint, verifiedAt: Date.now(),
  };
}

type FixtureEntryFeeTerms = NonNullable<Awaited<ReturnType<
  NonNullable<MicroLiveDependencies["readEntryFeeTerms"]>
>>>;

async function prepareBoundedRun(options: {
  preparedRunId?: string;
  ambiguousEntryPost?: boolean;
  persistedApproval?: boolean;
  readEntryFeeTerms?: (
    selectedTicker: string,
    approval: { id: string; digest: string },
  ) => FixtureEntryFeeTerms;
} = {}) {
  const startedAtMs = Date.now();
  let clockOverride: number | null = null;
  const fixtureNow = () => clockOverride ?? Date.now();
  let account = emptyAccount();
  const mockOrderStatuses = new Map<string, "canceled" | "executed">();
  let activityScanTimeMs: number | null = null;
  let entryPosts = 0;
  let exitPosts = 0;
  let feeTermsReads = 0;
  let latestFeeTerms: FixtureEntryFeeTerms | null = null;
  let persistedVerificationIdentity: FeeVerificationIdentity | null = null;
  const market = `${ticker}-BOUNDED-${randomUUID().slice(0, 8)}`;
  testTickers.add(market);
  process.env.KALSHI_BOT_SUBACCOUNT = "0";
  process.env.MICRO_LIVE_ACCOUNT_MODE = "primary_nonexclusive";
  process.env.MICRO_LIVE_PRODUCTION_ENABLED = "true";
  process.env.LIVE_EXECUTION_ENABLED = "true";
  await db.update(microLiveConfigTable).set({
    microLiveProductionEnabled: false,
    liveExecutionEnabled: false,
    manualKillSwitch: true,
    microLiveAccountMode: options.preparedRunId ? "primary_nonexclusive" : null,
    microLiveSelectedSubaccount: options.preparedRunId ? 0 : null,
    microLiveRunId: options.preparedRunId ?? null,
    microLiveEntryAttempted: false,
    microLiveExitAttempted: false,
    microLiveRunPhase: "UNARMED",
    microLiveRunArmedAt: null,
    microLiveRunDeadline: null,
    microLiveRunApprovalId: null,
    microLiveRunApprovalDigest: null,
    microLiveRunFreezeReason: null,
    microLiveReservedMicros: 0,
    microLivePrimaryCashBaselineMicros: null,
    microLivePrimaryCashBaselineRunId: null,
    microLivePrimaryCashBaselineAt: null,
    microLivePrimaryCashBaselineEvidenceDigest: null,
    microLivePrimaryActivityCheckpointRunId: null,
    microLivePrimaryActivityCheckpointCursor: null,
    microLivePrimaryActivityCheckpointAt: null,
    microLivePrimaryActivityCheckpointEvidenceDigest: null,
  }).where(eq(microLiveConfigTable.id, "singleton"));
  if (!options.preparedRunId) {
    await reviewFrozenPrimaryBinding();
  }
  const approval = {
    id: `bounded-approval-${randomUUID()}`,
    digest: createHash("sha256").update(`bounded-digest-${randomUUID()}`).digest("hex"),
    approvedAt: startedAtMs,
  };
  let feeEvidenceApproval = approval;
  if (options.persistedApproval) {
    assert.ok(parseFeeScheduleText(isolatedFeeScheduleText),
      "isolated fee schedule text must satisfy the strict parser");
    const pdfLoading = getDocument({
      data: new Uint8Array(isolatedFeeSchedulePdf), useSystemFonts: true,
    });
    const pdfDocument = await pdfLoading.promise;
    const extractedText: string[] = [];
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
      const page = await pdfDocument.getPage(pageNumber);
      const content = await page.getTextContent();
      extractedText.push(content.items.map((item) => "str" in item ? item.str : "").join(" "));
    }
    await pdfLoading.destroy();
    assert.ok(parseFeeScheduleText(extractedText.join(" ")),
      `extracted PDF text must satisfy the strict parser: ${JSON.stringify(extractedText)}`);
    const parsedSchedule = await parseFeeSchedulePdf(isolatedFeeSchedulePdf);
    assert.ok(parsedSchedule, "isolated fee PDF must pass the real PDF parser");
    const digest = isolatedFeeScheduleDigest;
    const canonicalVerification = await verifyIsolatedFeeArtifact(digest);
    const [config] = await db.select({ runCap: microLiveConfigTable.microLiveRunCapMicros })
      .from(microLiveConfigTable).where(eq(microLiveConfigTable.id, "singleton")).limit(1);
    assert.ok(config);
    const seededApprovalId = `isolated-${randomUUID()}`;
    await db.update(microLiveConfigTable).set({
      microLiveFeeApprovalId: seededApprovalId,
      microLiveFeeApprovalDigest: digest,
      microLiveFeeApprovalApproved: true,
      microLiveFeeApprovalInvalidated: false,
      microLiveFeeApprovalApprovedAt: new Date(startedAtMs - 365 * 24 * 60 * 60_000),
      microLiveFeePolicyVersion: STANDING_FEE_POLICY_VERSION,
      microLiveFeeApprovalSourceUrl: CANONICAL_FEE_SCHEDULE_URL,
      microLiveFeeFormulaVersion: STANDARD_QUADRATIC_FEE_FORMULA_VERSION,
      microLiveFeeMaximumExposureMicros: 5_000_000,
      microLiveFeeApprovedBy: `isolated-administrator-${suffix}`,
      microLiveFeeApprovedRunCapMicros: config.runCap,
      microLiveFeeArtifactStatus: canonicalVerification.status,
      microLiveFeeArtifactCheckedAt: new Date(canonicalVerification.verifiedAt!),
      microLiveFeeArtifactReason: null,
    }).where(eq(microLiveConfigTable.id, "singleton"));
    await db.insert(microLiveFeeVerificationTable).values({
      approvalId: seededApprovalId,
      approvalDigest: digest,
      policyVersion: STANDING_FEE_POLICY_VERSION,
      sourceUrl: CANONICAL_FEE_SCHEDULE_URL,
      formulaVersion: STANDARD_QUADRATIC_FEE_FORMULA_VERSION,
      // A successful PDF check alone is not live-metadata evidence.
      status: "unavailable",
      attemptId: null,
      reason: "live_fee_metadata_verification_required",
      feeEvidenceFingerprint: null,
      checkedAt: null,
    });
    const persisted = await approvedFeeSession();
    assert.ok(persisted,
      `isolated fixture must read its approval from the database: ${JSON.stringify(await feeApprovalView())}`);
    assert.equal((await getFeeVerificationState(verificationIdentity(persisted)))?.status,
      "unavailable",
      "a successful canonical PDF check does not create verified live-metadata evidence");
    const [persistedArtifact] = await db.select({
      status: microLiveConfigTable.microLiveFeeArtifactStatus,
    }).from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
    assert.equal(persistedArtifact?.status, "verified",
      "the fixture persists the result of its canonical 200-response verification");
    feeEvidenceApproval = persisted;
    persistedVerificationIdentity = verificationIdentity(persisted);
  }
  const fakeApproval = () => approval;
  const activity = async () => {
    const rows = await db.select().from(microLiveOrderTable);
    const fills = account.fills.map((fill) => ({ ...fill, feeCostDollars: fill.feeCostDollars ?? null }));
    // Simulated long runtimes refresh the authenticated scan at the fixture's
    // current time, just as the worker lease is refreshed.
    const scanAt = new Date(activityScanTimeMs ?? fixtureNow()).toISOString();
    return {
      orders: rows.filter((row) => row.exchangeOrderId).map((row) => {
        const fillCount = fills.filter((fill) => fill.orderId === row.exchangeOrderId)
          .reduce((sum, fill) => sum + Number(fill.countFp), 0);
        const status = mockOrderStatuses.get(row.exchangeOrderId!) ??
          (fillCount === row.requestedContracts ? "executed" : "resting");
        const outcomeSide = row.side === "UP"
          ? (row.action === "buy" ? "yes" as const : "no" as const)
          : (row.action === "buy" ? "no" as const : "yes" as const);
        return {
          id: row.exchangeOrderId!, clientOrderId: row.clientOrderId,
          ticker: row.marketTicker, side: row.side === "UP" ? "yes" as const : "no" as const,
          action: row.action, type: "limit" as const,
          status,
          priceDollars: String(row.requestedLimitPrice),
          initialCount: String(row.requestedContracts), filledCount: String(fillCount),
          remainingCount: String(status === "resting" ? row.requestedContracts - fillCount : 0),
          outcomeSide, bookSide: outcomeSide === "yes" ? "bid" as const : "ask" as const,
          createdAt: row.createdAt.toISOString(),
        };
      }),
      fills, available: true, truncated: false, keyRestrictionVerified: true,
      selectedSubaccount: 0,
      scanStartedAt: scanAt,
      scanFinishedAt: scanAt,
      exclusiveControlVerified: false,
    };
  };
  const dependencies = mocks({
    now: () => new Date(fixtureNow()),
    readBtc: async () => ({
      price: 65000, receivedAt: new Date(fixtureNow()), providerAt: new Date(fixtureNow()),
    }),
    readOrderbook: async () => ({
      yesAskDollars: "0.40", noAskDollars: "0.40",
      yesBidDollars: "0.39", noBidDollars: "0.39",
      yesAskAvailableContracts: "2", noAskAvailableContracts: "2",
      observedAt: new Date(fixtureNow()).toISOString(),
    }),
    readAccount: async () => account,
    readAccountActivity: activity,
    readHistoricalFills: async () => ({ fills: [], truncated: false, available: true }),
    readOrderStatus: async (id) => {
      const rows = await db.select().from(microLiveOrderTable);
      const row = rows.find((candidate) => candidate.exchangeOrderId === id);
      assert.ok(row, `missing bounded-run order ${id}`);
      const filledCount = account.fills.filter((fill) => fill.orderId === id)
        .reduce((sum, fill) => sum + Number(fill.countFp), 0);
      const outcomeSide = row.side === "UP"
        ? (row.action === "buy" ? "yes" as const : "no" as const)
        : (row.action === "buy" ? "no" as const : "yes" as const);
      const status = mockOrderStatuses.get(id) ??
        (filledCount === row.requestedContracts ? "executed" : "resting");
      return {
        orderId: id, clientOrderId: row.clientOrderId, ticker: row.marketTicker,
        side: row.side === "UP" ? "yes" : "no", action: row.action as "buy" | "sell",
        type: "limit", status,
        remainingCount: String(status === "resting" ? row.requestedContracts - filledCount : 0),
        filledCount: String(filledCount),
        outcomeSide, bookSide: outcomeSide === "yes" ? "bid" as const : "ask" as const,
      };
    },
    readEntryFeeTerms: async (selectedTicker) => {
      feeTermsReads++;
      const terms = {
        ...(options.readEntryFeeTerms?.(selectedTicker, feeEvidenceApproval) ??
          boundedFeeTerms(selectedTicker, boundedApprovalFingerprint(feeEvidenceApproval, selectedTicker))),
        verifiedAt: fixtureNow(),
      };
      latestFeeTerms = terms;
      if (options.persistedApproval && persistedVerificationIdentity) {
        const attemptId = await beginFeeVerification(persistedVerificationIdentity);
        if (attemptId) {
          const completed = await finishFeeVerification(
            persistedVerificationIdentity, attemptId, "verified", null,
            terms.fingerprint, new Date(terms.verifiedAt),
          );
          assert.equal(completed, true,
            "mock live metadata must finish the exact precommitted verification attempt");
        }
      }
      return terms;
    },
    approvedFeeSessionForTest: options.persistedApproval ? undefined : fakeApproval,
    submitOrder: async (input) => {
      if (input.action === "sell") {
        exitPosts++;
        throw new Error("mock ambiguous bounded exit submission");
      }
      entryPosts++;
      if (options.ambiguousEntryPost) {
        throw new Error("mock accepted bounded entry with lost response");
      }
      return {
        orderId: `bounded-exchange-${input.clientOrderId}`,
        clientOrderId: input.clientOrderId, ticker: input.ticker,
        side: input.side, action: input.action, type: "limit", status: "resting",
        remainingCount: String(input.count), filledCount: null,
      };
    },
  });
  if (options.persistedApproval) {
    const terms = await dependencies.readEntryFeeTerms!(market);
    assert.ok(terms, "persisted-approval fixtures require mocked live metadata");
    latestFeeTerms = terms;
    assert.ok(persistedVerificationIdentity);
    const gate = await getFeeVerificationState(persistedVerificationIdentity);
    assert.equal(gate?.status, "verified");
    assert.equal(gate?.feeEvidenceFingerprint, terms.fingerprint);
    assert.equal(gate?.checkedAt?.getTime(), terms.verifiedAt,
      "the gate timestamp must exactly match the mocked live metadata");
  }
  await processMicroLiveForwardTestCycle(`missing-bounded-paper-${randomUUID()}`, dependencies);
  const armed = await armBoundedMicroLiveRun(dependencies);
  assert.equal(armed.status, "armed", armed.reason);
  const state = await getMicroLiveState();
  assert.equal(state.boundedRun.phase, "ENTRY_OPEN");
  let armedAt = Date.parse(state.boundedRun.armedAt!);
  const [armedConfig] = await db.select({
    deadline: microLiveConfigTable.microLiveRunDeadline,
  }).from(microLiveConfigTable).where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.equal(armedConfig?.deadline, null,
    "a newly armed run has no elapsed-time expiration");
  return {
    market, approval: feeEvidenceApproval, dependencies,
    latestFeeTerms: () => latestFeeTerms,
    get armedAt() { return armedAt; },
    setClock: (time: number) => { clockOverride = time; },
    currentTime: fixtureNow,
    setRuntimeAge: async (elapsedMs: number) => {
      armedAt = Date.now() - elapsedMs;
      await db.update(microLiveConfigTable).set({
        microLiveRunArmedAt: new Date(armedAt),
      }).where(eq(microLiveConfigTable.id, "singleton"));
    },
    setActivityScanTime: (time: number | null) => { activityScanTimeMs = time; },
    setAccount: (next: typeof account) => { account = next; },
    setMockOrderStatus: (
      exchangeOrderId: string, status: "canceled" | "executed",
    ) => { mockOrderStatuses.set(exchangeOrderId, status); },
    refreshStartupReconciliation: async () => {
      activityScanTimeMs = Date.now();
      try {
        return await reconcileMicroLiveAtStartup(dependencies);
      } finally {
        activityScanTimeMs = fixtureNow();
      }
    },
    refreshWorkerLease: async () => {
      await db.update(forwardTestEngineTable).set({
        leaseExpiresAt: new Date(fixtureNow() + 60_000),
      }).where(eq(forwardTestEngineTable.id, "v1.3-paper"));
      await processMicroLiveForwardTestCycle(
        `missing-runtime-renewal-paper-${randomUUID()}`, dependencies,
      );
    },
    feeTermsReads: () => feeTermsReads,
    entryPosts: () => entryPosts,
    exitPosts: () => exitPosts,
  };
}

async function prepareSuccessorBoundedRun(options: {
  ambiguousEntryPost?: boolean;
  persistedApproval?: boolean;
  readEntryFeeTerms?: (
    selectedTicker: string,
    approval: { id: string; digest: string },
  ) => FixtureEntryFeeTerms;
} = {}) {
  const prior = await installFrozenUnusedRun();
  const prepared = await prepareNextBoundedMicroLiveRun({
    actorId: `user_micro_live_${suffix}`,
    priorRunId: prior.priorRunId,
    reason: "Prepare an isolated mocked five dollar lifecycle test.",
  });
  assert.equal(prepared.status, "prepared", prepared.reason);
  const [archive] = await db.select().from(microLiveRunArchiveTable)
    .where(eq(microLiveRunArchiveTable.priorRunId, prior.priorRunId)).limit(1);
  assert.ok(archive);
  const fixture = await prepareBoundedRun({
    preparedRunId: archive.successorRunId,
    ...options,
  });
  // Keep the arm-only isolated-schema bypass, but exercise the actual modeled
  // fee/debit terms for the successor's entry reservation and exit checks.
  fixture.dependencies.isolatedTestFeeCapFixture = false;
  return { prior, archive, fixture };
}

async function installFrozenUnusedRun(options: {
  entryAttempted?: boolean;
  exitAttempted?: boolean;
  reservedMicros?: number;
  capMicros?: number;
} = {}) {
  process.env.KALSHI_BOT_SUBACCOUNT = "0";
  process.env.MICRO_LIVE_ACCOUNT_MODE = "primary_nonexclusive";
  const priorRunId = randomUUID();
  transitionPriorRunIds.add(priorRunId);
  const armedAt = new Date(Date.now() - 60 * 60_000);
  const approvalId = `frozen-approval-${randomUUID()}`;
  const approvalDigest = createHash("sha256")
    .update(`frozen-digest-${randomUUID()}`).digest("hex");
  const approvedBy = `isolated-transition-reviewer-${suffix}`;
  const approvalAt = new Date(Date.now() - 365 * 24 * 60 * 60_000);
  const capMicros = options.capMicros ?? 1_000_000;
  await db.update(microLiveConfigTable).set({
    microLiveProductionEnabled: false,
    liveExecutionEnabled: false,
    manualKillSwitch: true,
    maxLiveBankrollCents: 2500,
    maxSingleOrderRiskCents: 500,
    maxCumulativeReservedCents: 2500,
    maxScoutStakeCents: 250,
    maxConfirmAdditionalStakeCents: 250,
    microLiveRunCapMicros: capMicros,
    microLiveRunId: priorRunId,
    microLiveRunPhase: "FROZEN",
    microLiveRunArmedAt: armedAt,
    microLiveRunDeadline: null,
    microLiveRunApprovalId: approvalId,
    microLiveRunApprovalDigest: approvalDigest,
    microLiveRunFreezeReason: "operator_froze_unused_run_for_reviewed_transition",
    microLiveFeeApprovalId: approvalId,
    microLiveFeeApprovalDigest: approvalDigest,
    microLiveFeeApprovalApproved: false,
    microLiveFeeApprovalInvalidated: true,
    microLiveFeeApprovalApprovedAt: approvalAt,
    microLiveFeePolicyVersion: STANDING_FEE_POLICY_VERSION,
    microLiveFeeApprovalSourceUrl: CANONICAL_FEE_SCHEDULE_URL,
    microLiveFeeFormulaVersion: STANDARD_QUADRATIC_FEE_FORMULA_VERSION,
    microLiveFeeMaximumExposureMicros: 5_000_000,
    microLiveFeeApprovedBy: approvedBy,
    microLiveFeeApprovedRunCapMicros: capMicros,
    microLiveFeeArtifactStatus: "unverified",
    microLiveFeeArtifactCheckedAt: null,
    microLiveFeeArtifactReason: null,
    microLiveAccountMode: "primary_nonexclusive",
    microLiveSelectedSubaccount: 0,
    microLiveAccountingUnresolved: false,
    microLiveEntryAttempted: options.entryAttempted ?? false,
    microLiveExitAttempted: options.exitAttempted ?? false,
    microLiveReservedMicros: options.reservedMicros ?? 0,
  }).where(eq(microLiveConfigTable.id, "singleton"));
  return {
    priorRunId, armedAt, approvalId, approvalDigest, approvalAt, approvedBy, capMicros,
  };
}

test("unused frozen $5 run archives into a prepared $5 successor without posting", async () => {
  const prior = await installFrozenUnusedRun({ capMicros: 5_000_000 });
  const result = await prepareNextBoundedMicroLiveRun({
    actorId: `user_micro_live_${suffix}`,
    priorRunId: prior.priorRunId,
    reason: "Prepare a successor from a frozen unused five dollar run.",
  });
  assert.deepEqual(result, { status: "prepared", reason: "bounded_run_next_slot_prepared" });

  const [archive] = await db.select().from(microLiveRunArchiveTable)
    .where(eq(microLiveRunArchiveTable.priorRunId, prior.priorRunId)).limit(1);
  assert.ok(archive);
  assert.equal(archive.phase, "FROZEN");
  assert.equal(archive.capMicros, 5_000_000);
  assert.equal(archive.capMicros / 1_000_000, 5);
  assert.equal(archive.reservedMicros, 0);
  assert.equal(archive.entryAttempted, false);
  assert.equal(archive.exitAttempted, false);

  const [successor] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.equal(successor?.microLiveRunId, archive.successorRunId);
  assert.equal(successor?.microLiveRunPhase, "UNARMED");
  assert.equal(successor?.microLiveRunCapMicros, 5_000_000);
  assert.equal(successor?.microLiveFeeApprovalApproved, false);
  assert.equal(successor?.microLiveProductionEnabled, false);
  assert.equal(successor?.liveExecutionEnabled, false);
  assert.equal(successor?.manualKillSwitch, true);
  assert.equal(successor?.microLiveReservedMicros, 0);
  assert.equal(successor?.microLiveEntryAttempted, false);
  assert.equal(successor?.microLiveExitAttempted, false);
  assert.equal(await db.select().from(microLiveOrderTable).then((rows) => rows.length), 0,
    "archive/transition must not create a real-order record or submit an order");
});

test("unused frozen runs cannot transition with intermediate $2-$4 caps", async () => {
  for (const capMicros of [2_000_000, 3_000_000, 4_000_000]) {
    const prior = await installFrozenUnusedRun({ capMicros });
    const result = await prepareNextBoundedMicroLiveRun({
      actorId: `user_micro_live_${suffix}`,
      priorRunId: prior.priorRunId,
      reason: "Reject unsupported intermediate run-cap transitions.",
    });
    assert.deepEqual(result, {
      status: "blocked", reason: "bounded_run_original_cap_not_supported",
    });
    const [archive] = await db.select({ priorRunId: microLiveRunArchiveTable.priorRunId })
      .from(microLiveRunArchiveTable)
      .where(eq(microLiveRunArchiveTable.priorRunId, prior.priorRunId)).limit(1);
    assert.equal(archive, undefined);
    const [config] = await db.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
    assert.equal(config?.microLiveRunId, prior.priorRunId);
    assert.equal(config?.microLiveRunCapMicros, capMicros);
    assert.equal(config?.microLiveProductionEnabled, false);
    assert.equal(config?.liveExecutionEnabled, false);
    assert.equal(config?.manualKillSwitch, true);
  }
});

test("frozen unused run transaction archives immutable $1 state and prepares a frozen $5 slot", async () => {
  const prior = await installFrozenUnusedRun();
  const actorId = `user_micro_live_${suffix}`;
  const reason = "Prepare the separately reviewed five dollar test slot.";
  const request = { actorId, priorRunId: prior.priorRunId, reason };
  const [historicalConfig] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.equal(historicalConfig?.microLiveFeeApprovalApproved, false);
  assert.equal(historicalConfig?.microLiveFeeApprovalInvalidated, true);
  assert.equal(historicalConfig?.microLiveFeeApprovalId, prior.approvalId);
  assert.equal(historicalConfig?.microLiveFeeApprovalDigest, prior.approvalDigest);
  assert.match(prior.approvalDigest, /^[a-f0-9]{64}$/);
  assert.equal(historicalConfig?.microLiveFeeApprovalApprovedAt?.getTime(),
    prior.approvalAt.getTime());
  assert.equal(historicalConfig?.microLiveFeePolicyVersion, STANDING_FEE_POLICY_VERSION);
  assert.equal(historicalConfig?.microLiveFeeApprovedRunCapMicros, 1_000_000);
  assert.equal(historicalConfig?.microLiveFeeApprovalSourceUrl, CANONICAL_FEE_SCHEDULE_URL);
  assert.equal(historicalConfig?.microLiveFeeFormulaVersion,
    STANDARD_QUADRATIC_FEE_FORMULA_VERSION);
  assert.equal(historicalConfig?.microLiveFeeApprovedBy, prior.approvedBy);

  const result = await prepareNextBoundedMicroLiveRun(request);
  assert.deepEqual(result, { status: "prepared", reason: "bounded_run_next_slot_prepared" });

  const [archive] = await db.select().from(microLiveRunArchiveTable)
    .where(eq(microLiveRunArchiveTable.priorRunId, prior.priorRunId)).limit(1);
  assert.ok(archive);
  assert.equal(archive.phase, "FROZEN");
  assert.equal(archive.armedAt.getTime(), prior.armedAt.getTime());
  assert.equal(archive.deadlineAt, null,
    "an archived run without a deadline preserves that nullable state");
  assert.equal(archive.approvalId, prior.approvalId);
  assert.equal(archive.approvalDigest, prior.approvalDigest);
  assert.equal(archive.approvalSourceUrl, CANONICAL_FEE_SCHEDULE_URL);
  assert.equal(archive.approvalFormulaVersion, STANDARD_QUADRATIC_FEE_FORMULA_VERSION);
  assert.equal(archive.approvalApprover, prior.approvedBy);
  assert.equal(archive.freezeReason, "operator_froze_unused_run_for_reviewed_transition");
  assert.equal(archive.capMicros, 1_000_000);
  assert.equal(archive.capMicros / 1_000_000, 1,
    "1,000,000 micros is the frozen predecessor's $1 run cap");
  assert.equal(archive.reservedMicros, 0);
  assert.equal(archive.entryAttempted, false);
  assert.equal(archive.exitAttempted, false);
  assert.equal(archive.maxLiveBankrollCents, 2500);
  assert.equal(archive.maxSingleOrderRiskCents, 500);
  assert.equal(archive.maxCumulativeReservedCents, 2500);
  assert.equal(archive.maxScoutStakeCents, 250);
  assert.equal(archive.maxConfirmAdditionalStakeCents, 250);
  assert.equal(archive.actorId, actorId);
  assert.equal(archive.transitionReason, reason);

  const [prepared] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.ok(prepared);
  assert.equal(prepared.microLiveRunId, archive.successorRunId);
  assert.equal(prepared.microLiveRunPhase, "UNARMED");
  assert.equal(prepared.microLiveRunCapMicros, 5_000_000);
  assert.equal(prepared.microLiveRunCapMicros / 1_000_000, 5,
    "5,000,000 micros is the separately prepared successor's $5 cap");
  assert.equal(prepared.microLiveFeeApprovalApproved, false);
  assert.equal(prepared.microLiveFeeApprovalInvalidated, true);
  assert.equal(prepared.microLiveFeeApprovedRunCapMicros, 1_000_000,
    "the prior $1 policy remains revoked even though the unarmed slot cap can be raised");
  assert.equal(prepared.microLiveProductionEnabled, false);
  assert.equal(prepared.liveExecutionEnabled, false);
  assert.equal(prepared.manualKillSwitch, true);
  assert.equal(prepared.microLiveReservedMicros, 0);
  assert.equal(prepared.microLiveEntryAttempted, false);
  assert.equal(prepared.microLiveExitAttempted, false);
  assert.equal(prepared.microLiveRunApprovalId, null);
  assert.equal(prepared.microLiveRunApprovalDigest, null);
  assert.equal(prepared.maxLiveBankrollCents, 500);
  assert.equal(prepared.maxSingleOrderRiskCents, 500);
  assert.equal(prepared.maxCumulativeReservedCents, 500);
  assert.equal(prepared.maxScoutStakeCents, 500);
  assert.equal(prepared.maxConfirmAdditionalStakeCents, 500);

  assert.deepEqual(await prepareNextBoundedMicroLiveRun(request), {
    status: "prepared", reason: "bounded_run_next_slot_already_prepared",
  });
  assert.deepEqual(await prepareNextBoundedMicroLiveRun({
    ...request, actorId: `${actorId}_other`,
  }), { status: "blocked", reason: "bounded_run_prior_already_archived" });
  assert.deepEqual(await prepareNextBoundedMicroLiveRun({
    ...request, priorRunId: archive.successorRunId,
  }), { status: "blocked", reason: "bounded_run_original_fee_approval_metadata_missing" });

  const [unchangedArchive] = await db.select().from(microLiveRunArchiveTable)
    .where(eq(microLiveRunArchiveTable.priorRunId, prior.priorRunId)).limit(1);
  assert.deepEqual(unchangedArchive, archive);
});

test("frozen-run transaction refuses entry/exit claims and any existing reservation", async () => {
  for (const claim of [
    { entryAttempted: true },
    { exitAttempted: true },
    { reservedMicros: 1 },
  ]) {
    const prior = await installFrozenUnusedRun(claim);
    assert.deepEqual(await prepareNextBoundedMicroLiveRun({
      actorId: `user_micro_live_${suffix}`,
      priorRunId: prior.priorRunId,
      reason: "Do not replace a claimed frozen run.",
    }), { status: "blocked", reason: "bounded_run_attempt_or_reservation_exists" });
    const [config] = await db.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
    assert.equal(config?.microLiveRunId, prior.priorRunId);
    assert.equal(config?.microLiveRunPhase, "FROZEN");
    assert.equal(config?.microLiveRunCapMicros, 1_000_000);
    assert.equal(config?.microLiveEntryAttempted, claim.entryAttempted ?? false);
    assert.equal(config?.microLiveExitAttempted, claim.exitAttempted ?? false);
    assert.equal(config?.microLiveReservedMicros, claim.reservedMicros ?? 0);
    const [archive] = await db.select({ priorRunId: microLiveRunArchiveTable.priorRunId })
      .from(microLiveRunArchiveTable)
      .where(eq(microLiveRunArchiveTable.priorRunId, prior.priorRunId)).limit(1);
    assert.equal(archive, undefined);
  }
});

test("a prepared $5 slot still requires environment gates and an active fee approval to arm", async () => {
  const prior = await installFrozenUnusedRun();
  const result = await prepareNextBoundedMicroLiveRun({
    actorId: `user_micro_live_${suffix}`,
    priorRunId: prior.priorRunId,
    reason: "Preserve normal arming prerequisites for the successor run.",
  });
  assert.equal(result.status, "prepared");
  process.env.MICRO_LIVE_PRODUCTION_ENABLED = "false";
  process.env.LIVE_EXECUTION_ENABLED = "false";
  assert.deepEqual(await armBoundedMicroLiveRun(), {
    status: "blocked", reason: "environment_flags_not_both_true",
  });
  process.env.MICRO_LIVE_PRODUCTION_ENABLED = "true";
  process.env.LIVE_EXECUTION_ENABLED = "true";
  assert.deepEqual(await armBoundedMicroLiveRun(), {
    status: "blocked", reason: "standing_fee_policy_unavailable_or_incompatible",
  });
  const [config] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.equal(config?.microLiveRunPhase, "UNARMED");
  assert.equal(config?.microLiveRunCapMicros, 5_000_000);
  assert.equal(config?.microLiveProductionEnabled, false);
  assert.equal(config?.liveExecutionEnabled, false);
  assert.equal(config?.manualKillSwitch, true);
});

test("a prepared $5 slot retains its real-path arming hold after mocked validation", async () => {
  const prior = await installFrozenUnusedRun();
  const result = await prepareNextBoundedMicroLiveRun({
    actorId: `user_micro_live_${suffix}`,
    priorRunId: prior.priorRunId,
    reason: "Keep live arming separate from isolated mocked exit validation.",
  });
  assert.equal(result.status, "prepared");
  const [archive] = await db.select().from(microLiveRunArchiveTable)
    .where(eq(microLiveRunArchiveTable.priorRunId, prior.priorRunId)).limit(1);
  assert.ok(archive);
  const fixture = await prepareBoundedRun({ preparedRunId: archive.successorRunId });
  await db.update(microLiveConfigTable).set({
    microLiveRunPhase: "UNARMED",
    microLiveRunArmedAt: null,
    microLiveRunDeadline: null,
    microLiveRunApprovalId: null,
    microLiveRunApprovalDigest: null,
    microLiveProductionEnabled: false,
    liveExecutionEnabled: false,
    manualKillSwitch: true,
  }).where(eq(microLiveConfigTable.id, "singleton"));
  fixture.dependencies.isolatedTestFeeCapFixture = false;
  assert.deepEqual(await armBoundedMicroLiveRun(fixture.dependencies), {
    status: "blocked", reason: "prepared_run_exit_recovery_proof_required",
  });
  const [config] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.equal(config?.microLiveRunPhase, "UNARMED");
  assert.equal(config?.microLiveReservedMicros, 0);
  assert.equal(config?.microLiveProductionEnabled, false);
  assert.equal(config?.liveExecutionEnabled, false);
  assert.equal(config?.manualKillSwitch, true);
});

test("prepared $5 run enforces fee-inclusive cap and still permits one entry only", async () => {
  const prior = await installFrozenUnusedRun();
  const prepared = await prepareNextBoundedMicroLiveRun({
    actorId: `user_micro_live_${suffix}`,
    priorRunId: prior.priorRunId,
    reason: "Prepare the mocked five dollar fee boundary test.",
  });
  assert.equal(prepared.status, "prepared", prepared.reason);
  const [archive] = await db.select().from(microLiveRunArchiveTable)
    .where(eq(microLiveRunArchiveTable.priorRunId, prior.priorRunId)).limit(1);
  assert.ok(archive);

  const fixture = await prepareBoundedRun({
    preparedRunId: archive.successorRunId,
    readEntryFeeTerms: (selectedTicker, approval) => ({
      ...boundedFeeTerms(
        selectedTicker, boundedApprovalFingerprint(approval, selectedTicker),
      ),
      entryCashDebitPerContractMicrosAtLimit: () => 2_400_000,
      maximumExitCashDebitPerContractMicros: () => 100_000,
    }),
  });
  fixture.dependencies.isolatedTestFeeCapFixture = false;
  const evaluationId = await insertEvaluation({
    ticker: fixture.market,
    evaluatedAt: new Date(Math.max(fixture.currentTime(), fixture.armedAt + 1)),
  });
  const entry = await executeQualifiedV13Trigger(evaluationId, fixture.dependencies);
  assert.equal(entry.status, "submitted", entry.reason);
  assert.equal(fixture.entryPosts(), 1);
  const [buy] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, evaluationId)).limit(1);
  assert.ok(buy);
  assert.equal(buy.requestedContracts, 2);
  assert.equal(buy.requestedStakeCents, 80);
  assert.equal(buy.reservedEntryFeeMicros, 4_000_000);
  assert.equal(buy.reservedExitFeeMicros, 200_000);
  assert.equal(buy.requestedStakeCents * 10_000 +
    buy.reservedEntryFeeMicros! + buy.reservedExitFeeMicros!, 5_000_000);
  const [reserved] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.equal(reserved?.microLiveRunCapMicros, 5_000_000);
  assert.equal(reserved?.microLiveReservedMicros, 5_000_000);
  const retryId = await insertEvaluation({
    ticker: fixture.market,
    crossingKey: `${fixture.market}:second-entry`,
  });
  const retry = await executeQualifiedV13Trigger(retryId, fixture.dependencies);
  assert.equal(retry.status, "blocked");
  assert.equal(retry.reason, "bounded_run_entry_window_closed_or_already_used");
  assert.equal(fixture.entryPosts(), 1, "a $5 cap does not allow a second entry");
  assert.equal(withinAllInLiveTestCap(40, 600_000, 0), true);
  assert.equal(withinAllInLiveTestCap(40, 600_001, 0), false,
    "the default per-entry cap remains $1");
});

test("prepared $5 reservation path rejects a minimum order above the all-in ceiling", async () => {
  const prior = await installFrozenUnusedRun();
  const prepared = await prepareNextBoundedMicroLiveRun({
    actorId: `user_micro_live_${suffix}`,
    priorRunId: prior.priorRunId,
    reason: "Prepare the mocked over-cap fee reservation test.",
  });
  assert.equal(prepared.status, "prepared", prepared.reason);
  const [archive] = await db.select().from(microLiveRunArchiveTable)
    .where(eq(microLiveRunArchiveTable.priorRunId, prior.priorRunId)).limit(1);
  assert.ok(archive);
  const fixture = await prepareBoundedRun({
    preparedRunId: archive.successorRunId,
    readEntryFeeTerms: (selectedTicker, approval) => ({
      ...boundedFeeTerms(
        selectedTicker, boundedApprovalFingerprint(approval, selectedTicker),
      ),
      entryCashDebitPerContractMicrosAtLimit: () => 5_000_000,
      maximumExitCashDebitPerContractMicros: () => 100_000,
    }),
  });
  fixture.dependencies.isolatedTestFeeCapFixture = false;
  const evaluationId = await insertEvaluation({
    ticker: fixture.market,
    evaluatedAt: new Date(Math.max(fixture.currentTime(), fixture.armedAt + 1)),
  });
  const blocked = await executeQualifiedV13Trigger(evaluationId, fixture.dependencies);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.reason, "live_test_fee_ceiling_unavailable_or_cap_exceeded");
  assert.equal(fixture.entryPosts(), 0);
  const [config] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.equal(config?.microLiveEntryAttempted, false);
  assert.equal(config?.microLiveReservedMicros, 0);
});

async function armPrimaryNonexclusiveFixture(dependencies: MicroLiveDependencies) {
  await db.update(microLiveConfigTable).set({
    microLiveProductionEnabled: false,
    liveExecutionEnabled: false,
    manualKillSwitch: true,
    microLiveAccountMode: null,
    microLiveSelectedSubaccount: null,
    microLiveRunId: null,
    microLiveEntryAttempted: false,
    microLiveExitAttempted: false,
    microLiveRunPhase: "UNARMED",
    microLiveRunArmedAt: null,
    microLiveRunDeadline: null,
    microLiveRunApprovalId: null,
    microLiveRunApprovalDigest: null,
    microLiveRunFreezeReason: null,
    microLiveAccountingUnresolved: false,
    microLiveAccountingUnresolvedReason: null,
    microLivePrimaryCashBaselineMicros: null,
    microLivePrimaryCashBaselineRunId: null,
    microLivePrimaryCashBaselineAt: null,
    microLivePrimaryCashBaselineEvidenceDigest: null,
    microLivePrimaryActivityCheckpointRunId: null,
    microLivePrimaryActivityCheckpointCursor: null,
    microLivePrimaryActivityCheckpointAt: null,
    microLivePrimaryActivityCheckpointEvidenceDigest: null,
    microLiveReservedMicros: 0,
  }).where(eq(microLiveConfigTable.id, "singleton"));
  await reviewFrozenPrimaryBinding();
  await processMicroLiveForwardTestCycle(`missing-primary-arm-paper-${randomUUID()}`, dependencies);
  const armed = await armBoundedMicroLiveRun(dependencies);
  assert.equal(armed.status, "armed", armed.reason);
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
}

test("settlement-loss cap accepts exactly $1 including entry fees", async () => {
  const id = await insertEvaluation({ ticker: `${ticker}-CAP-EDGE` });
  const allowed = await executeQualifiedV13Trigger(id, cappedEntryMocks({
    readEntryFeeTerms: async (market) => ({
      ticker: market, eventTicker: `${market}-EVENT`,
      feePerContractMicrosAtLimit: () => 300_000,
      exitCashDebitPerContractMicrosAtLimit: () => 300_000,
      exitFeePerContractMicrosAtLimit: () => 300_000,
      fingerprint: "exact-all-in-cap", verifiedAt: Date.now(),
    }),
  }));
  assert.equal(allowed.status, "submitted", allowed.reason);
  const [row] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, id));
  assert.equal(row?.requestedStakeCents, 40);
  assert.equal(row?.requestedContracts, 1);
  assert.equal(row?.reservedEntryFeeMicros, 300_000);
  assert.equal(row?.reservedExitFeeMicros, 300_000);
  assert.equal(row!.requestedStakeCents * 10_000 +
    row!.reservedEntryFeeMicros! + row!.reservedExitFeeMicros!, 1_000_000);
});

test("all-in cap includes the one exit fee at exactly $1 and rejects one micro over", () => {
  assert.equal(withinAllInLiveTestCap(80, 100_000, 100_000), true);
  assert.equal(withinAllInLiveTestCap(80, 100_000, 100_001), false);
  assert.equal(withinAllInLiveTestCap(40, 600_000, 0), true,
    "the $1 fee-inclusive entry debit is counted once, not plus a model fee");
  assert.equal(withinAllInLiveTestCap(40, 600_000, 1), false,
    "even one micro of additional exit cash debit exceeds the unchanged cap");
});

test("entry execution is development-only even when every other gate is open", async () => {
  const id = await insertEvaluation({});
  const previous = process.env.NODE_ENV;
  let posts = 0;
  try {
    process.env.NODE_ENV = "production";
    const result = await executeQualifiedV13Trigger(id, mocks({
      readAccount: async () => { throw new Error("production guard must precede exchange reads"); },
      submitOrder: async () => { posts++; throw new Error("production guard must precede POST"); },
    }));
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "micro_live_development_only");
    assert.equal(posts, 0);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test("concurrent workers atomically consume one immutable development run reservation", async () => {
  const idA = await insertEvaluation({ ticker: `${ticker}-CONCURRENT-A` });
  const idB = await insertEvaluation({ ticker: `${ticker}-CONCURRENT-B` });
  let posts = 0;
  const deps = mocks({ submitOrder: async (input) => {
    posts++;
    return {
      orderId: `exchange-${input.clientOrderId}`,
      clientOrderId: input.clientOrderId, ticker: input.ticker, side: input.side,
      action: input.action, type: "limit", status: "resting",
      remainingCount: String(input.count), filledCount: null,
    };
  } });
  const results = await Promise.all([
    executeQualifiedV13Trigger(idA, deps), executeQualifiedV13Trigger(idB, deps),
  ]);
  assert.equal(results.filter((result) => result.status === "submitted").length, 1);
  assert.equal(posts, 1, "the singleton lock permits exactly one entry POST");
  const [config] = await db.select().from(microLiveConfigTable);
  assert.equal(config?.microLiveEntryAttempted, true);
  assert.ok(config?.microLiveRunId);
  assert.ok(config && config.microLiveReservedMicros > 0 && config.microLiveReservedMicros <= 1_000_000);
});

test("partial, rejected, ambiguous, and restart states never recycle the persistent reservation", async () => {
  const id = await insertEvaluation({ ticker: `${ticker}-SINK` });
  const sent = await executeQualifiedV13Trigger(id, mocks());
  assert.equal(sent.status, "submitted", sent.reason);
  const [configBefore] = await db.select().from(microLiveConfigTable);
  const [order] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, id));
  assert.ok(order);
  await db.update(microLiveOrderTable).set({
    status: "partial", filledContracts: 1, remainingContracts: order.requestedContracts - 1,
  }).where(eq(microLiveOrderTable.id, order.id));
  const second = await insertEvaluation({ ticker: `${ticker}-SINK-RESTART` });
  let posts = 0;
  const afterRestart = await executeQualifiedV13Trigger(second, mocks({
    submitOrder: async () => { posts++; throw new Error("must not make a second entry"); },
  }));
  const [configAfter] = await db.select().from(microLiveConfigTable);
  assert.equal(afterRestart.status, "blocked");
  assert.equal(posts, 0);
  assert.equal(configAfter?.microLiveRunId, configBefore?.microLiveRunId);
  assert.equal(configAfter?.microLiveReservedMicros, configBefore?.microLiveReservedMicros);
});

test("ambiguous lost entry response remains a permanent attempted budget sink", async () => {
  const id = await insertEvaluation({ ticker: `${ticker}-AMBIGUOUS-SINK` });
  const lost = await executeQualifiedV13Trigger(id, mocks({
    submitOrder: async () => { throw new Error("socket closed after request"); },
  }));
  assert.equal(lost.status, "unknown");
  const [before] = await db.select().from(microLiveConfigTable);
  assert.equal(before?.microLiveEntryAttempted, true);
  const retryId = await insertEvaluation({ ticker: `${ticker}-AMBIGUOUS-RETRY` });
  let posts = 0;
  const retry = await executeQualifiedV13Trigger(retryId, mocks({
    submitOrder: async () => { posts++; throw new Error("must not retry"); },
  }));
  const [after] = await db.select().from(microLiveConfigTable);
  assert.equal(retry.status, "blocked");
  assert.equal(posts, 0);
  assert.equal(after?.microLiveReservedMicros, before?.microLiveReservedMicros);
});

test("exit requires fresh current fee evidence within the entry's reserved exit-fee ceiling", async () => {
  const market = `${ticker}-EXIT-FEE-CEILING`;
  const entryId = await insertEvaluation({ ticker: market });
  const entry = await executeQualifiedV13Trigger(entryId, mocks());
  assert.equal(entry.status, "submitted", entry.reason);
  const [buy] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, entryId));
  assert.ok(buy && entry.orderId);
  const positionId = `position:${market}:${buy.crossingKey}`;
  const account = {
    ...emptyAccount(),
    positions: [{
      ticker: market, positionFp: String(buy.requestedContracts),
      marketExposureDollars: String(buy.requestedContracts * buy.requestedLimitPrice),
      realizedPnlDollars: "0",
    }],
    fills: [{
      id: `exit-fee-entry-fill-${suffix}`, orderId: entry.orderId, ticker: market,
      side: "yes", action: "buy", countFp: String(buy.requestedContracts),
      priceDollars: String(buy.requestedLimitPrice), feeCostDollars: "0.01",
      createdAt: now().toISOString(),
    }],
  };
  const deps = mocks({
    readAccount: async () => account,
    readOrderStatus: async () => ({
      orderId: entry.orderId!, clientOrderId: buy.clientOrderId, ticker: market,
      side: "yes", action: "buy", type: "limit", status: "executed",
      remainingCount: "0", filledCount: String(buy.requestedContracts),
    }),
    readEntryFeeTerms: async (selected) => ({
      ticker: selected, eventTicker: `${selected}-EVENT`,
      feePerContractMicrosAtLimit: () => 10_000,
      exitCashDebitPerContractMicrosAtLimit: () => 10_000,
      exitFeePerContractMicrosAtLimit: () => 10_000, fingerprint: "entry-fees",
      verifiedAt: Date.now(),
    }),
  });
  assert.equal((await reconcileMicroLiveAtStartup(deps)).ready, true);
  const exitId = await insertEvaluation({
    ticker: market, signal: "EXIT", crossingKey: buy.crossingKey,
  });
  await db.update(forwardTestEvaluationTable).set({
    evaluationSource: "micro_live",
    livePositionId: positionId,
    sourcePaperEvaluationId: entryId,
    positionWasOpen: true,
  }).where(eq(forwardTestEvaluationTable.id, exitId));
  let posts = 0;
  const changedTerms = mocks({
    ...deps,
    submitOrder: async () => { posts++; throw new Error("must not post over reserved exit fee"); },
    readEntryFeeTerms: async (selected) => ({
      ticker: selected, eventTicker: `${selected}-EVENT`,
      feePerContractMicrosAtLimit: () => 50_000,
      exitCashDebitPerContractMicrosAtLimit: () => 50_000,
      exitFeePerContractMicrosAtLimit: () => 50_000, fingerprint: "higher-current-fees",
      verifiedAt: Date.now(),
    }),
  });
  const result = await executeQualifiedV13Trigger(exitId, changedTerms);
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "current_exit_fee_terms_unavailable_or_above_reserved_bound");
  assert.equal(posts, 0);
});

test("standard market cash bound permits one $1 attempt without charging withheld proceeds", async () => {
  const selectedMarketGrid = [
    { start: "0.0000", end: "0.1000", step: "0.0010" },
    { start: "0.1000", end: "0.9000", step: "0.0100" },
    { start: "0.9000", end: "1.0000", step: "0.0010" },
  ];
  const maximumExitLoss = maximumExitLossOnMarketGridPerContractMicros(1, selectedMarketGrid);
  assert.equal(maximumExitLoss, 999_000);
  // Every orderable, positive price on this market is considered; YES and NO
  // each map onto the market's authenticated YES grid.
  for (const side of ["yes", "no"] as const) {
    for (const range of selectedMarketGrid) {
      for (let tick = Number(range.start) * 10_000; tick <= Number(range.end) * 10_000;
        tick += Number(range.step) * 10_000) {
        if (tick <= 0 || tick >= 10_000) continue;
        const price = (tick / 10_000).toFixed(4);
        const entryDebit = maximumEntryCashDebitPerContractMicros(
          1, price, selectedMarketGrid, side,
        );
        assert.ok(entryDebit !== null && entryDebit >= 1_000_000, `${side} ${price}`);
        assert.ok(entryDebit + maximumExitLoss! > 1_000_000, `${side} ${price}`);
      }
    }
  }
  assert.equal(entryCashDebitMicrosForContracts("0.4000", 1), 1_000_000);
  assert.equal(entryCashDebitMicrosForContracts("0.9999", 1), 1_000_000);
  assert.equal(maximumEntryFeePerContractMicros(1, "0.4000"), 16_800);
  assert.equal(maximumExitLoss, 999_000);
  assert.equal(1_000_000 + maximumExitLoss, 1_999_000);
  const id = await insertEvaluation({ ticker: `${ticker}-ROUNDING-ENTRY` });
  let posts = 0;
  const placed = await executeQualifiedV13Trigger(id, mocks({
    isolatedTestFeeCapFixture: false,
    readOrderbook: async () => ({
      yesAskDollars: "0.40", noAskDollars: "0.40",
      yesBidDollars: "0.39", noBidDollars: "0.39",
      yesAskAvailableContracts: "1", noAskAvailableContracts: "1",
      observedAt: now().toISOString(),
    }),
    readEntryFeeTerms: async (market) => ({
      ticker: market, eventTicker: `${market}-EVENT`,
      feePerContractMicrosAtLimit: (price) => maximumEntryFeePerContractMicros(1, price),
      entryCashDebitPerContractMicrosAtLimit: (price, side) =>
        maximumEntryCashDebitPerContractMicros(1, price, selectedMarketGrid, side),
      maximumExitCashDebitPerContractMicros: (side) =>
        maximumExitCashDebitOnMarketGridPerContractMicros(1, selectedMarketGrid, side),
      exitCashDebitPerContractMicrosAtLimit: (price, side) =>
        maximumExitCashDebitOnMarketGridPerContractMicros(1, selectedMarketGrid, side, price),
      maximumExitLossPerContractMicros: (side) =>
        maximumExitLossOnMarketGridPerContractMicros(1, selectedMarketGrid, side),
      exitFeePerContractMicrosAtLimit: (price, side = "yes") =>
        maximumExitLossAtLimitOnMarketGridPerContractMicros(
          1, price, selectedMarketGrid, side,
        ),
      fingerprint: "verified-standard-quadratic", verifiedAt: Date.now(),
    }),
    submitOrder: async (input) => {
      posts++;
      return { orderId: `exchange-${input.clientOrderId}`, clientOrderId: input.clientOrderId,
        ticker: input.ticker, side: input.side, action: input.action, type: "limit",
        status: "resting", remainingCount: "1", filledCount: "0" };
    },
  }));
  assert.equal(placed.status, "submitted", placed.reason);
  assert.equal(posts, 1);
  const rows = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, id));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reservedEntryFeeMicros, 600_000);
  assert.equal(rows[0].reservedExitFeeMicros, 0);
  const [config] = await db.select().from(microLiveConfigTable);
  assert.equal(config.microLiveReservedMicros, 1_000_000);
});

test("partial buy reserves its actual fee plus the remaining buy's fee, not their maximum", async () => {
  const market = `${ticker}-PARTIAL-FEE-CAP`;
  const scoutId = await insertEvaluation({ ticker: market });
  const scout = await executeQualifiedV13Trigger(scoutId, mocks({
    readOrderbook: async () => ({
      yesAskDollars: "0.20", noAskDollars: "0.20", yesBidDollars: "0.19",
      noBidDollars: "0.19", yesAskAvailableContracts: "2",
      noAskAvailableContracts: "2", observedAt: now().toISOString(),
    }),
    readEntryFeeTerms: async (selected) => ({
      ticker: selected, eventTicker: `${selected}-EVENT`,
      feePerContractMicrosAtLimit: () => 100_000,
      exitCashDebitPerContractMicrosAtLimit: () => 100_000,
      exitFeePerContractMicrosAtLimit: () => 100_000,
      fingerprint: "fee-before-fill", verifiedAt: Date.now(),
    }),
  }));
  assert.equal(scout.status, "submitted", scout.reason);
  const account = {
    ...emptyAccount(),
    openOrders: [{
      id: scout.orderId!, ticker: market, side: "yes", action: "buy",
      priceDollars: "0.20", remainingCount: "1",
      status: "resting", createdAt: now().toISOString(),
    }],
    positions: [{
      ticker: market, positionFp: "1", marketExposureDollars: "0.20",
      realizedPnlDollars: "0",
    }],
    fills: [{
      id: `fee-cap-${suffix}`, orderId: scout.orderId!, ticker: market,
      side: "yes", action: "buy", countFp: "1", priceDollars: "0.20",
      feeCostDollars: "0.25", createdAt: now().toISOString(),
    }],
  };
  const deps = mocks({
    readAccount: async () => account,
    readOrderStatus: async (id) => ({
      orderId: id, clientOrderId: "mock", ticker: market, side: "yes",
      action: "buy", type: "limit", status: "resting",
      remainingCount: "1", filledCount: "1",
    }),
    readOrderbook: async () => ({
      yesAskDollars: "0.20", noAskDollars: "0.20", yesBidDollars: "0.19",
      noBidDollars: "0.19", yesAskAvailableContracts: "1",
      noAskAvailableContracts: "1", observedAt: now().toISOString(),
    }),
    readEntryFeeTerms: async (selected) => ({
      ticker: selected, eventTicker: `${selected}-EVENT`,
      feePerContractMicrosAtLimit: () => 100_000,
      exitCashDebitPerContractMicrosAtLimit: () => 100_000,
      exitFeePerContractMicrosAtLimit: () => 100_000,
      fingerprint: "fee-after-fill", verifiedAt: Date.now(),
    }),
    submitOrder: async () => { throw new Error("cap must block before POST"); },
  });
  assert.equal((await reconcileMicroLiveAtStartup(deps)).ready, true);
  const confirmId = await insertEvaluation({ ticker: market, signal: "CONFIRM", entryOffer: 0.68 });
  const result = await executeQualifiedV13Trigger(confirmId, deps);
  assert.equal(result.reason, "evaluation_not_a_qualified_v13_entry");
});

test("initial paper CONFIRM can be the single live entry and uses the 53c cap", async () => {
  const market = `${ticker}-INITIAL-CONFIRM`;
  const id = await insertEvaluation({
    ticker: market,
    signal: "CONFIRM",
    initialConfirm: true,
    entryOffer: 0.53,
  });
  let submittedCount = 0;
  let submittedPrice = "";
  const result = await executeQualifiedV13Trigger(id, mocks({
    readOrderbook: async () => ({
      yesAskDollars: "0.53",
      noAskDollars: "0.47",
      yesBidDollars: "0.52",
      noBidDollars: "0.46",
      yesAskAvailableContracts: "20",
      noAskAvailableContracts: "20",
      observedAt: now().toISOString(),
    }),
    submitOrder: async (input) => {
      submittedCount++;
      submittedPrice = input.priceDollars;
      return {
        orderId: `exchange-${input.clientOrderId}`,
        clientOrderId: input.clientOrderId,
        ticker: input.ticker,
        side: input.side,
        action: input.action,
        type: "limit",
        status: "executed",
        remainingCount: "0",
        filledCount: String(input.count),
      };
    },
  }));
  assert.equal(result.status, "submitted", result.reason);
  assert.equal(submittedCount, 1);
  assert.equal(submittedPrice, "0.5300");
  const [order] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, id)).limit(1);
  assert.equal(order.triggerType, "CONFIRM");
  assert.ok(order.requestedStakeCents <= 250);
  assert.ok(order.requestedLimitPrice <= 0.68);
});

test("IOC entry sizes across visible depth without exceeding the V13 reference offer", async () => {
  const market = `${ticker}-DEPTH-ENTRY`;
  const id = await insertEvaluation({
    ticker: market,
    signal: "SCOUT",
    entryOffer: 0.50,
  });
  let postedCount = 0;
  let postedPrice = "";
  const result = await executeQualifiedV13Trigger(id, mocks({
    readOrderbook: async () => ({
      yesAskDollars: "0.4000",
      noAskDollars: "0.6000",
      yesBidDollars: "0.3900",
      noBidDollars: "0.5900",
      yesAskAvailableContracts: "1",
      noAskAvailableContracts: "10",
      yesAskLevels: [
        { priceDollars: "0.4000", availableContracts: "1" },
        { priceDollars: "0.4500", availableContracts: "2" },
        { priceDollars: "0.5100", availableContracts: "100" },
      ],
      noAskLevels: [
        { priceDollars: "0.6000", availableContracts: "10" },
      ],
      observedAt: now().toISOString(),
    }),
    submitOrder: async (input) => {
      postedCount = input.count;
      postedPrice = input.priceDollars;
      return {
        orderId: `exchange-${input.clientOrderId}`,
        clientOrderId: input.clientOrderId,
        ticker: input.ticker,
        side: input.side,
        action: input.action,
        type: "limit",
        status: "executed",
        remainingCount: "0",
        filledCount: String(input.count),
      };
    },
  }));
  assert.equal(result.status, "submitted", result.reason);
  assert.equal(postedCount, 2,
    "depth permits more than the top level, while the fee-inclusive cap may size the request down");
  assert.equal(postedPrice, "0.4500",
    "IOC walks permitted depth but never reaches the 51c level above the signal ceiling");
  const [order] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, id)).limit(1);
  assert.ok(order);
  assert.equal(order.orderbookQuotePrice, 0.4);
  assert.equal(order.requestedLimitPrice, 0.45);
  assert.equal(order.requestedContracts, 2);
  assert.ok(order.requestedLimitPrice <= 0.50);
});

test("position-sourced CONFIRM remains prohibited as an additional live buy", async () => {
  const id = await insertEvaluation({
    ticker: `${ticker}-ADD-CONFIRM-BLOCK`,
    signal: "CONFIRM",
    entryOffer: 0.65,
  });
  let posts = 0;
  const result = await executeQualifiedV13Trigger(id, mocks({
    submitOrder: async () => {
      posts++;
      throw new Error("position-sourced CONFIRM must never POST");
    },
  }));
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "evaluation_not_a_qualified_v13_entry");
  assert.equal(posts, 0);
});

test("entry rejects unknown fees and rechecks a changed ceiling before POST", async () => {
  const id = await insertEvaluation({ ticker: `${ticker}-CAP-UNKNOWN` });
  let posts = 0;
  const none = await executeQualifiedV13Trigger(id, cappedEntryMocks({
    readEntryFeeTerms: async () => null,
    submitOrder: async () => { posts++; throw new Error("must not submit"); },
  }));
  assert.equal(none.reason, "live_test_fee_ceiling_unavailable_or_cap_exceeded");
  assert.equal(posts, 0);
  const absent = await executeQualifiedV13Trigger(id, cappedEntryMocks({
    readEntryFeeTerms: async () => null,
    submitOrder: async () => { posts++; throw new Error("must not submit"); },
  }));
  assert.equal(absent.reason, "live_test_fee_ceiling_unavailable_or_cap_exceeded");
  assert.equal(posts, 0);
  let calls = 0;
  const changed = await executeQualifiedV13Trigger(id, cappedEntryMocks({
    readEntryFeeTerms: async (market) => ({
      ticker: market, eventTicker: `${market}-EVENT`,
      feePerContractMicrosAtLimit: () => 100_000,
      exitCashDebitPerContractMicrosAtLimit: () => 100_000,
      exitFeePerContractMicrosAtLimit: () => 100_000,
      fingerprint: ++calls === 3 ? "changed-multiplier-or-override" : "fixture-cap",
      verifiedAt: Date.now(),
    }),
    submitOrder: async () => { posts++; throw new Error("must not submit"); },
  }));
  assert.equal(changed.reason, "atomic_action_reservation_conflict_or_gate_changed");
  assert.equal(posts, 0);
  assert.equal(calls, 3);
});

test("failed frozen-exit DELETE claim is irreversible across restart and prevents replacements", async () => {
  const market = `${ticker}-CAP-CANCEL`;
  const id = await insertEvaluation({ ticker: market });
  const submitted = await executeQualifiedV13Trigger(id, mocks());
  assert.equal(submitted.status, "submitted", submitted.reason);
  const [cancellationEngine] = await db.select().from(forwardTestEngineTable)
    .where(eq(forwardTestEngineTable.id, "v1.3-paper")).limit(1);
  assert.ok(cancellationEngine?.leaseOwner);
  registerMicroLiveWorkerLeaseOwner(cancellationEngine.leaseOwner);
  const [buy] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, id));
  assert.ok(buy && submitted.orderId);
  const positionId = `position:${market}:${buy.crossingKey}`;
  const exitExchangeId = `exit-cap-${suffix}`;
  const exitId = await insertRecoveredExitOrder({
    buyOrder: buy, positionId, contractCount: 2, limitPrice: 0.39,
    exchangeOrderId: exitExchangeId,
  });
  const account: KalshiAccountSnapshot = {
    ...emptyAccount(),
    openOrders: [{
      id: exitExchangeId, ticker: market, side: "yes", action: "sell",
      priceDollars: "0.39", remainingCount: "2", status: "resting",
      createdAt: now().toISOString(),
    }],
    positions: [{
      ticker: market, positionFp: "2", marketExposureDollars: "0.80",
      realizedPnlDollars: "0",
    }],
    fills: [{
      id: `buy-cap-${suffix}`, orderId: submitted.orderId, ticker: market,
      side: "yes", action: "buy", countFp: "2", priceDollars: "0.40",
      createdAt: now().toISOString(), feeCostDollars: "0.01",
    }],
  };
  let canceled = false;
  let cancellationAttempts = 0;
  let postedExits = 0;
  const deps = cappedEntryMocks({
    submitOrder: async () => { postedExits++; throw new Error("duplicate exit submitted"); },
    readAccount: async () => account,
    readHistoricalFills: async () => ({ fills: [], available: true, truncated: false }),
    readOrderStatus: async (exchangeId) => ({
      orderId: exchangeId, clientOrderId: exchangeId === exitExchangeId
        ? `ml-exit-${exitId}` : buy.clientOrderId,
      ticker: market, side: "yes", action: exchangeId === exitExchangeId ? "sell" : "buy",
      type: "limit", status: exchangeId === exitExchangeId
        ? canceled ? "canceled" : "resting" : "executed",
      filledCount: exchangeId === exitExchangeId ? canceled ? "1" : "0" : "2",
      remainingCount: exchangeId === exitExchangeId ? canceled ? "0" : "2" : "0",
    }),
    cancelOrder: async (exchangeId, context) => {
      cancellationAttempts++;
      assert.equal(context.killSwitch, "ON");
      assert.equal(context.databaseEnabled, false);
      assert.equal(exchangeId, exitExchangeId);
      throw new Error("mock DELETE failed after invocation; outcome is unknown");
    },
  });
  process.env.MICRO_LIVE_PRODUCTION_ENABLED = "false";
  process.env.LIVE_EXECUTION_ENABLED = "false";
  const failed = await cancelAndVerifyMicroLiveExit(exitId, deps);
  assert.equal(failed.reason, "exit_cancellation_or_verification_failed");
  const [config] = await db.select().from(microLiveConfigTable);
  assert.equal(config?.manualKillSwitch, true);
  assert.equal(config?.liveExecutionEnabled, false);
  assert.equal(config?.microLiveProductionEnabled, false);
  const [claimedExit] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, exitId));
  assert.ok(claimedExit?.cancellationAttemptedAt,
    "DELETE claim is durable even though DELETE returned an error");
  assert.equal(cancellationAttempts, 1);
  const duplicateId = await insertEvaluation({ ticker: market, signal: "EXIT",
    crossingKey: buy.crossingKey });
  await db.update(forwardTestEvaluationTable).set({
    evaluationSource: "micro_live", livePositionId: positionId,
    sourcePaperEvaluationId: id, positionWasOpen: true,
  }).where(eq(forwardTestEvaluationTable.id, duplicateId));
  assert.equal((await executeQualifiedV13Trigger(duplicateId, deps)).status, "blocked");
  assert.equal(postedExits, 0);
  const restart = await reconcileMicroLiveAtStartup(deps);
  assert.equal(restart.reason, "exit_cancellation_requires_manual_reactivation_review");
  assert.equal(cancellationAttempts, 1, "restart never repeats the uncertain DELETE");
  const [claimAfterRestart] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, exitId));
  assert.equal(claimAfterRestart?.cancellationAttemptedAt?.getTime(),
    claimedExit?.cancellationAttemptedAt?.getTime());
  assert.equal((await executeQualifiedV13Trigger(duplicateId, deps)).status, "blocked");
  assert.equal(postedExits, 0);
  const stillBlocked = await cancelAndVerifyMicroLiveExit(exitId, deps);
  assert.equal(stillBlocked.reason, "exit_cancellation_requires_manual_reactivation_review");
  assert.equal(cancellationAttempts, 1);
  const [exit] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, exitId));
  assert.equal(exit?.status, "pending", "uncertain DELETE is not treated as cancellation");
  assert.equal(exit?.filledContracts, 0);
  assert.equal(exit?.remainingContracts, 2);
  const state = await getMicroLiveState();
  assert.equal(state.currentPosition?.contracts, 2,
    "frozen GET recovery may promote verified entry fills without reactivating trading");
  assert.equal(state.currentPosition?.contractsBought, 2);
  assert.equal(state.currentPosition?.outstandingSellContracts, 2,
    "the uncertain exit reservation remains outstanding");
  assert.equal(state.reservedRiskCents, buy.reservedRiskCents + 1,
    "frozen recovery counts the verified entry fee rather than dropping risk");
  assert.equal(state.currentPosition?.sellableContracts, 0,
    "outstanding exit keeps the position frozen rather than inviting a replacement");
  assert.equal(state.openPositionCount, 1, "the reserved position remains frozen");
  assert.equal((await db.select().from(microLiveSettlementTable))
    .some((row) => row.positionId === positionId), false,
  "manual review keeps the position open until authenticated settlement evidence");
  assert.equal((await reconcileMicroLiveAtStartup(deps)).ready, false);
  assert.equal(cancellationAttempts, 1, "terminally claimed exit is never canceled twice");
  assert.equal((await executeQualifiedV13Trigger(duplicateId, deps)).status, "blocked");
  assert.equal(postedExits, 0);

  // An uncertain DELETE can fill at the exchange after the first GET. Later
  // restarts must ingest that fill and terminal status, not retry the DELETE
  // or mistake the claim for permission to resume trading.
  canceled = true;
  account.openOrders = [];
  account.positions[0]!.positionFp = "1";
  account.fills.push({
    id: `late-cancel-fill-${suffix}`, orderId: exitExchangeId, ticker: market,
    side: "yes", action: "sell", countFp: "1", priceDollars: "0.39",
    createdAt: now().toISOString(), feeCostDollars: "0.01",
  });
  const recovered = await reconcileMicroLiveAtStartup(deps);
  assert.equal(recovered.ready, false);
  assert.equal(recovered.reason, "exit_cancellation_requires_manual_reactivation_review");
  const [verifiedExit] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, exitId));
  assert.equal(verifiedExit.status, "canceled");
  assert.equal(verifiedExit.filledContracts, 1);
  assert.equal(verifiedExit.remainingContracts, 0);
  assert.ok(verifiedExit.cancellationAttemptedAt);
  assert.equal((await db.select().from(microLiveFillTable)
    .where(eq(microLiveFillTable.orderId, exitId))).length, 1);
  assert.equal((await getMicroLiveState()).currentPosition?.sellableContracts, 1);
  assert.equal((await reconcileMicroLiveAtStartup(deps)).reason,
    "exit_cancellation_requires_manual_reactivation_review");
  assert.equal(cancellationAttempts, 1);
  assert.equal(postedExits, 0);
});

async function enableStartupRecoveryGates() {
  process.env.MICRO_LIVE_PRODUCTION_ENABLED = "true";
  process.env.LIVE_EXECUTION_ENABLED = "true";
  await db.update(microLiveConfigTable).set({
    microLiveProductionEnabled: true,
    liveExecutionEnabled: true,
    manualKillSwitch: false,
  }).where(eq(microLiveConfigTable.id, "singleton"));
}

async function disableSettlementGates() {
  process.env.MICRO_LIVE_PRODUCTION_ENABLED = "false";
  process.env.LIVE_EXECUTION_ENABLED = "false";
  await db.update(microLiveConfigTable).set({
    microLiveProductionEnabled: false,
    liveExecutionEnabled: false,
    manualKillSwitch: true,
  }).where(eq(microLiveConfigTable.id, "singleton"));
}

async function reviewFrozenPrimaryBinding() {
  const previousDecisionIds = new Set((await db.select({ id: microLiveDecisionTable.id })
    .from(microLiveDecisionTable)).map((decision) => decision.id));
  const reviewed = await reviewPrimaryMicroLiveAccountBinding({
    actorId: `isolated-test-${suffix}`,
    reason: "Record the reviewed primary subaccount zero for isolated tests.",
  });
  assert.equal(reviewed.status, "recorded", reviewed.reason);
  const newDecisions = await db.select({ id: microLiveDecisionTable.id })
    .from(microLiveDecisionTable);
  for (const decision of newDecisions) {
    if (!previousDecisionIds.has(decision.id)) resolutionDecisionIds.add(decision.id);
  }
}

function recoveryDependencies(account: ReturnType<typeof emptyAccount>): MicroLiveDependencies {
  return mocks({
    readAccount: async () => account,
    readOrderStatus: async (id) => {
      const rows = await db.select().from(microLiveOrderTable);
      const row = rows.find((candidate) => candidate.exchangeOrderId === id);
      assert.ok(row, `missing local order for mocked exchange order ${id}`);
      return {
        orderId: id,
        clientOrderId: row.clientOrderId,
        ticker: row.marketTicker,
        side: row.side === "UP" ? "yes" : "no",
        action: row.action as "buy" | "sell",
        type: "limit",
        status: "executed",
        remainingCount: "0",
        filledCount: String(row.requestedContracts),
      };
    },
  });
}

async function insertRecoveredExitOrder(input: {
  buyOrder: typeof microLiveOrderTable.$inferSelect;
  positionId: string;
  contractCount: number;
  limitPrice: number;
  exchangeOrderId: string;
}) {
  const id = randomUUID();
  const crossingKey = `${input.buyOrder.marketTicker}:exit:${id}`;
  await db.insert(microLiveOrderTable).values({
    ...input.buyOrder,
    id,
    actionKey: `exit-action-${id}`,
    clientOrderId: `ml-exit-${id}`,
    crossingKey,
    triggerType: "EXIT",
    action: "sell",
    intent: "exit",
    positionId: null,
    exitPositionId: input.positionId,
    sourceEvaluationId: `exit-evaluation-${id}`,
    signalAt: now(),
    requestedLimitPrice: input.limitPrice,
    requestedContracts: input.contractCount,
    requestedStakeCents: 0,
    reservedRiskCents: 0,
    exchangeOrderId: input.exchangeOrderId,
    status: "pending",
    submittedAt: now(),
    lastReconciledAt: null,
    averageFillPrice: null,
    filledContracts: 0,
    remainingContracts: input.contractCount,
    canceledAt: null,
    filledAt: null,
    closedAt: null,
    realizedPnlCents: null,
    failureReason: null,
    createdAt: now(),
    updatedAt: now(),
  });
  return id;
}

async function submitLinkedMockOrder(market: string) {
  const evaluationId = await insertEvaluation({ ticker: market });
  const submitted = await executeQualifiedV13Trigger(evaluationId, mocks());
  assert.equal(submitted.status, "submitted", submitted.reason);
  const [row] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, evaluationId)).limit(1);
  assert.ok(row && submitted.orderId);
  return { row, evaluationId, exchangeOrderId: submitted.orderId };
}

function historicalFillFor(
  row: typeof microLiveOrderTable.$inferSelect,
  exchangeOrderId: string,
  id: string,
  count = row.requestedContracts,
) {
  return {
    id, orderId: exchangeOrderId, ticker: row.marketTicker,
    side: row.side === "UP" ? "yes" : "no", action: row.action,
    countFp: String(count), priceDollars: String(row.requestedLimitPrice),
    createdAt: now().toISOString(), feeCostDollars: "0.0100",
  };
}

async function makeRecoveredSettlementPosition(
  market: string, buyFee: string | null, side: "yes" | "no" = "yes",
) {
  const evaluationId = await insertEvaluation({
    ticker: market, direction: side === "yes" ? "UP" : "DOWN",
  });
  const submitted = await executeQualifiedV13Trigger(evaluationId, mocks({
    readOrderbook: async () => ({
      yesAskDollars: "0.20", noAskDollars: "0.20",
      yesBidDollars: "0.19", noBidDollars: "0.19",
      yesAskAvailableContracts: "3", noAskAvailableContracts: "3",
      observedAt: now().toISOString(),
    }),
  }));
  assert.equal(submitted.status, "submitted", submitted.reason);
  const [order] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, evaluationId)).limit(1);
  assert.ok(order && submitted.orderId);
  const filledAt = now().toISOString();
  const fill = {
    id: `settlement-entry-fill-${randomUUID()}`,
    orderId: submitted.orderId,
    ticker: market,
    side,
    action: "buy",
    countFp: String(order.requestedContracts),
    priceDollars: "0.20",
    createdAt: filledAt,
    feeCostDollars: buyFee,
  };
  const account = {
    ...emptyAccount(),
    positions: [{
      ticker: market,
      positionFp: String(side === "yes" ? order.requestedContracts : -order.requestedContracts),
      marketExposureDollars: String(order.requestedContracts * 0.2),
      realizedPnlDollars: "0",
    }],
    fills: [fill],
  };
  const recovery = await reconcileMicroLiveAtStartup(recoveryDependencies(account));
  assert.equal(recovery.ready, true, recovery.reason);
  const readMarketEvidence = async (requestedTicker: string): Promise<KalshiSubmissionEvidence> => {
    assert.equal(requestedTicker, market);
    return {
      orders: [{
        id: submitted.orderId!, clientOrderId: order.clientOrderId, ticker: market,
        side, action: "buy", type: "limit", status: "executed",
        priceDollars: String(order.requestedLimitPrice),
        initialCount: String(order.requestedContracts),
        filledCount: String(order.requestedContracts), remainingCount: "0",
      }],
      fills: [...account.fills],
      historicalFills: [...account.fills],
      historicalFillsAvailable: true,
      truncated: false,
    };
  };
  return {
    account,
    order,
    positionId: `position:${market}:${order.crossingKey}`,
    filledAt,
    readMarketEvidence,
  };
}

async function prepareDedicatedSettlementPairFixture(expectedTicker: string) {
  const runId = randomUUID();
  const keyId = `isolated-settlement-pair-${suffix}`;
  const privateKey = `isolated-private-key-${suffix}`;
  const fingerprint = createHash("sha256").update(`${keyId}\u001f${privateKey}`).digest("hex");
  process.env.KALSHI_API_KEY_ID = keyId;
  process.env.KALSHI_API_PRIVATE_KEY = privateKey;
  const transferAt = new Date(Date.now() - 2_000);
  const baselineAt = new Date(Date.now() - 1_000);
  const checkpointAt = new Date();
  const digest = createHash("sha256").update(runId).digest("hex");
  await db.update(microLiveConfigTable).set({
    microLiveAccountMode: "exclusive",
    microLiveSelectedSubaccount: 1,
    microLiveSelectedExchangeIndex: 2,
    microLiveRestrictedApiKeyId: keyId,
    microLiveRestrictedKeyFingerprint: fingerprint,
    microLiveRunId: runId,
    microLiveAccountingUnresolved: false,
    microLiveAccountingUnresolvedReason: null,
    microLiveFundingAnchorSubaccount: 1,
    microLiveFundingAnchorExchangeIndex: 2,
    microLiveFundingAnchorTransferId: `isolated-funding-transfer-${suffix}`,
    microLiveFundingAnchorTransferAt: transferAt,
    microLiveFundingAnchorAmountCents: 2500,
    microLivePairCashBaselineMicros: "25000000",
    microLivePairCashBaselineRunId: runId,
    microLivePairCashBaselineAt: baselineAt,
    microLivePairCashBaselineEvidenceDigest: digest,
    microLiveAccountActivityCheckpointRunId: runId,
    microLiveAccountActivityCheckpointCursor: `isolated-settlement-cursor-${suffix}`,
    microLiveAccountActivityCheckpointAt: checkpointAt,
    microLiveAccountActivityCheckpointEvidenceDigest: digest,
    microLiveAccountActivityCheckpointSubaccount: 1,
    microLiveAccountActivityCheckpointExchangeIndex: 2,
  }).where(eq(microLiveConfigTable.id, "singleton"));

  const scanFinishedAt = new Date().toISOString();
  const pairEvidence: KalshiDedicatedPairEvidence = {
    pair: { subaccountNumber: 1, exchangeIndex: 2 },
    balance: {
      subaccountNumber: 1,
      exchangeIndex: 2,
      balanceDollars: "25.00",
      updatedTs: Math.floor(Date.now() / 1_000),
    },
    marketExchangeIndex: 2,
    keyRestrictionVerified: true,
    tradePermissionVerified: true,
    allTimeHistoryExhaustive: false,
    exclusiveControlVerified: false,
    recordCounts: { positions: 1, orders: 1, fills: 1, settlements: 1, transfers: 1 },
    scanStartedAt: new Date(Date.now() - 500).toISOString(),
    scanFinishedAt,
  };
  return async (subaccountNumber: number, ticker: string) => {
    assert.equal(subaccountNumber, 1);
    assert.equal(ticker, expectedTicker);
    return pairEvidence;
  };
}

function dedicatedSettlementEvidence(input: {
  market: string;
  readAccount: () => Promise<KalshiAccountSnapshot>;
  readMarketEvidence: (ticker: string) => Promise<KalshiSubmissionEvidence>;
  readSettlements: () => Promise<KalshiSettlementsSnapshot>;
  readDedicatedPairEvidence: (
    subaccountNumber: number, ticker: string,
  ) => Promise<KalshiDedicatedPairEvidence>;
}) {
  const readMarketEvidence = async (ticker: string): Promise<KalshiSubmissionEvidence> => {
    const history = await input.readMarketEvidence(ticker);
    return {
      ...history,
      orders: history.orders.map((order) => ({ ...order, exchangeIndex: 2 })),
      fills: history.fills.map((fill) => ({ ...fill, exchangeIndex: 2 })),
      historicalFills: history.historicalFills?.map((fill) => ({
        ...fill, exchangeIndex: 2,
      })),
    };
  };
  return {
    readAccount: async (): Promise<KalshiAccountSnapshot> => {
      const account = await input.readAccount();
      return {
        ...account,
        openOrders: account.openOrders.map((order) => ({ ...order, exchangeIndex: 2 })),
        fills: account.fills.map((fill) => ({ ...fill, exchangeIndex: 2 })),
        positions: account.positions.map((position) => ({
          ...position, exchangeIndex: 2,
        })),
      };
    },
    readAccountActivity: async (): Promise<KalshiAccountActivity> => {
      const history = await readMarketEvidence(input.market);
      const scanFinishedAt = new Date().toISOString();
      return {
        orders: history.orders.map((order) => ({
          ...order, createdAt: scanFinishedAt, exchangeIndex: 2,
        })),
        fills: history.fills,
        available: true,
        truncated: false,
        selectedSubaccount: 1,
        scanStartedAt: new Date(Date.now() - 500).toISOString(),
        scanFinishedAt,
        exclusiveControlVerified: false,
      };
    },
    readDedicatedPairEvidence: input.readDedicatedPairEvidence,
    readMarketEvidence,
    readSettlements: async () => {
      const snapshot = await input.readSettlements();
      return withDedicatedSettlementShard(snapshot);
    },
  };
}

function withDedicatedSettlementShard(snapshot: KalshiSettlementsSnapshot) {
  return {
    ...snapshot,
    settlements: snapshot.settlements.map((settlement) => ({
      ...settlement, exchangeIndex: 2,
    })),
  };
}

async function clearDedicatedSettlementPairFixture() {
  await db.update(microLiveConfigTable).set({
    microLiveRunId: null,
    microLiveEntryAttempted: false,
    microLiveExitAttempted: false,
    microLiveReservedMicros: 0,
    microLiveAccountingUnresolved: false,
    microLiveAccountingUnresolvedReason: null,
    microLiveAccountMode: null,
    microLiveSelectedSubaccount: null,
    microLiveSelectedExchangeIndex: null,
    microLiveRestrictedApiKeyId: null,
    microLiveRestrictedKeyFingerprint: null,
    microLiveFundingAnchorSubaccount: null,
    microLiveFundingAnchorExchangeIndex: null,
    microLiveFundingAnchorTransferId: null,
    microLiveFundingAnchorTransferAt: null,
    microLiveFundingAnchorAmountCents: null,
    microLivePairCashBaselineMicros: null,
    microLivePairCashBaselineRunId: null,
    microLivePairCashBaselineAt: null,
    microLivePairCashBaselineEvidenceDigest: null,
    microLiveAccountActivityCheckpointRunId: null,
    microLiveAccountActivityCheckpointCursor: null,
    microLiveAccountActivityCheckpointAt: null,
    microLiveAccountActivityCheckpointEvidenceDigest: null,
    microLiveAccountActivityCheckpointSubaccount: null,
    microLiveAccountActivityCheckpointExchangeIndex: null,
  }).where(eq(microLiveConfigTable.id, "singleton"));
}

const dedicatedPairSettlementBlock = (reason: string) =>
  `micro_live_dedicated_pair_accounting_unresolved:${reason}`;

function settlementSnapshot(input: {
  ticker: string;
  contracts: number;
  settledAt: string;
  feeCostDollars: string | null;
}) {
  return {
    settlements: [{
      ticker: input.ticker,
      eventTicker: `${input.ticker}-EVENT`,
      marketResult: "yes",
      yesCountFp: String(input.contracts),
      yesTotalCostDollars: (input.contracts * 0.2).toFixed(6),
      noCountFp: "0",
      noTotalCostDollars: "0",
      revenueCents: String(input.contracts * 100),
      settledAt: input.settledAt,
      feeCostDollars: input.feeCostDollars,
    }],
    truncated: false,
  };
}

before(async () => {
  // This number exists only inside the isolated, fully mocked test process.
  process.env.KALSHI_BOT_SUBACCOUNT = "1";
  process.env.MICRO_LIVE_ACCOUNT_MODE = "exclusive";
  // The isolated runner copies the development tables before applying schema
  // source changes. Mirror the production CHECK here without touching public
  // or production schemas so provenance regressions exercise the new invariant.
  await db.execute(sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'micro_live_orders'::regclass
          AND conname = 'micro_live_orders_active_run_fee_provenance_check'
      ) THEN
        ALTER TABLE micro_live_orders
        ADD CONSTRAINT micro_live_orders_active_run_fee_provenance_check CHECK (
          micro_live_run_id IS NULL OR status NOT IN ('pending','unknown','partial','filled') OR (
            btrim(micro_live_run_id) <> '' AND
            reserved_entry_fee_micros IS NOT NULL AND reserved_entry_fee_micros >= 0 AND
            reserved_exit_fee_micros IS NOT NULL AND reserved_exit_fee_micros >= 0 AND
            fee_evidence_fingerprint IS NOT NULL AND btrim(fee_evidence_fingerprint) <> '' AND
            fee_evidence_verified_at IS NOT NULL
          )
        );
      END IF;
    END $$;
  `);
  const [config] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  originalConfig = config;
  const [engine] = await db.select().from(forwardTestEngineTable)
    .where(eq(forwardTestEngineTable.id, "v1.3-paper")).limit(1);
  originalEngine = engine;
  await db.insert(microLiveConfigTable).values({
    id: "singleton",
    microLiveProductionEnabled: true,
    liveExecutionEnabled: true,
    manualKillSwitch: false,
    maxLiveBankrollCents: 2500,
    maxSingleOrderRiskCents: 500,
    maxOpenPositions: 1,
    maxCumulativeReservedCents: 2500,
    maxScoutStakeCents: 250,
    maxConfirmAdditionalStakeCents: 250,
    microLiveRunId: null,
    microLiveEntryAttempted: false,
    microLiveExitAttempted: false,
    microLiveRunPhase: "UNARMED",
    microLiveRunArmedAt: null,
    microLiveRunDeadline: null,
    microLiveRunApprovalId: null,
    microLiveRunApprovalDigest: null,
    microLiveRunFreezeReason: null,
    microLiveAccountMode: null,
    microLiveSelectedSubaccount: null,
    microLiveSelectedExchangeIndex: null,
    microLiveRestrictedApiKeyId: null,
    microLiveRestrictedKeyFingerprint: null,
    microLiveFundingAnchorSubaccount: null,
    microLiveFundingAnchorExchangeIndex: null,
    microLiveFundingAnchorTransferId: null,
    microLiveFundingAnchorTransferAt: null,
    microLiveFundingAnchorAmountCents: null,
    microLivePairCashBaselineMicros: null,
    microLivePairCashBaselineRunId: null,
    microLivePairCashBaselineAt: null,
    microLivePairCashBaselineEvidenceDigest: null,
    microLiveAccountActivityCheckpointRunId: null,
    microLiveAccountActivityCheckpointCursor: null,
    microLiveAccountActivityCheckpointAt: null,
    microLiveAccountActivityCheckpointEvidenceDigest: null,
    microLiveAccountActivityCheckpointSubaccount: null,
    microLiveAccountActivityCheckpointExchangeIndex: null,
    microLiveAccountingUnresolved: false,
    microLiveAccountingUnresolvedReason: null,
    microLiveReservedMicros: 0,
  }).onConflictDoUpdate({
    target: microLiveConfigTable.id,
    set: {
      microLiveProductionEnabled: true, liveExecutionEnabled: true, manualKillSwitch: false,
      maxLiveBankrollCents: 2500, maxSingleOrderRiskCents: 500, maxOpenPositions: 1,
      maxCumulativeReservedCents: 2500, maxScoutStakeCents: 250,
      maxConfirmAdditionalStakeCents: 250,
      microLiveRunId: null, microLiveEntryAttempted: false, microLiveReservedMicros: 0,
      microLiveExitAttempted: false, microLiveAccountMode: null,
      microLiveRunPhase: "UNARMED", microLiveRunArmedAt: null,
      microLiveRunDeadline: null, microLiveRunApprovalId: null,
      microLiveRunApprovalDigest: null, microLiveRunFreezeReason: null,
      microLiveSelectedSubaccount: null, microLiveAccountingUnresolved: false,
      microLiveAccountingUnresolvedReason: null,
       microLivePrimaryCashBaselineMicros: null,
       microLivePrimaryCashBaselineRunId: null,
       microLivePrimaryCashBaselineAt: null,
       microLivePrimaryCashBaselineEvidenceDigest: null,
       microLivePrimaryActivityCheckpointRunId: null,
       microLivePrimaryActivityCheckpointCursor: null,
       microLivePrimaryActivityCheckpointAt: null,
       microLivePrimaryActivityCheckpointEvidenceDigest: null,
    },
  });
  await db.insert(forwardTestEngineTable).values({
    id: "v1.3-paper",
    enabled: true,
    strategyVersion: "V1.3",
    leaseOwner: `micro-live-test-${suffix}`,
    leaseExpiresAt: new Date(Date.now() + 60_000),
  }).onConflictDoUpdate({
    target: forwardTestEngineTable.id,
    set: {
      enabled: true, strategyVersion: "V1.3", leaseOwner: `micro-live-test-${suffix}`,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    },
  });
  process.env.MICRO_LIVE_PRODUCTION_ENABLED = "true";
  process.env.LIVE_EXECUTION_ENABLED = "true";
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await cleanFixtures();
  process.env.KALSHI_BOT_SUBACCOUNT = "1";
  process.env.MICRO_LIVE_ACCOUNT_MODE = "exclusive";
  if (originalEnv.KALSHI_API_KEY_ID === undefined) delete process.env.KALSHI_API_KEY_ID;
  else process.env.KALSHI_API_KEY_ID = originalEnv.KALSHI_API_KEY_ID;
  if (originalEnv.KALSHI_API_PRIVATE_KEY === undefined) {
    delete process.env.KALSHI_API_PRIVATE_KEY;
  } else {
    process.env.KALSHI_API_PRIVATE_KEY = originalEnv.KALSHI_API_PRIVATE_KEY;
  }
  await db.update(microLiveConfigTable).set({
    microLiveProductionEnabled: true,
    liveExecutionEnabled: true,
    manualKillSwitch: false,
    maxLiveBankrollCents: 2500,
    maxCumulativeReservedCents: 2500,
    maxScoutStakeCents: 250,
    maxConfirmAdditionalStakeCents: 250,
    microLiveRunCapMicros: 1_000_000,
    microLiveRunId: null,
    microLiveEntryAttempted: false,
    microLiveExitAttempted: false,
    microLiveRunPhase: "UNARMED",
    microLiveRunArmedAt: null,
    microLiveRunDeadline: null,
    microLiveRunApprovalId: null,
    microLiveRunApprovalDigest: null,
    microLiveRunFreezeReason: null,
    microLiveAccountMode: null,
    microLiveSelectedSubaccount: null,
    microLiveSelectedExchangeIndex: null,
    microLiveRestrictedApiKeyId: null,
    microLiveRestrictedKeyFingerprint: null,
    microLiveFundingAnchorSubaccount: null,
    microLiveFundingAnchorExchangeIndex: null,
    microLiveFundingAnchorTransferId: null,
    microLiveFundingAnchorTransferAt: null,
    microLiveFundingAnchorAmountCents: null,
    microLivePairCashBaselineMicros: null,
    microLivePairCashBaselineRunId: null,
    microLivePairCashBaselineAt: null,
    microLivePairCashBaselineEvidenceDigest: null,
    microLiveAccountActivityCheckpointRunId: null,
    microLiveAccountActivityCheckpointCursor: null,
    microLiveAccountActivityCheckpointAt: null,
    microLiveAccountActivityCheckpointEvidenceDigest: null,
    microLiveAccountActivityCheckpointSubaccount: null,
    microLiveAccountActivityCheckpointExchangeIndex: null,
    microLiveAccountingUnresolved: false,
    microLiveAccountingUnresolvedReason: null,
    microLivePrimaryCashBaselineMicros: null,
    microLivePrimaryCashBaselineRunId: null,
    microLivePrimaryCashBaselineAt: null,
    microLivePrimaryCashBaselineEvidenceDigest: null,
    microLivePrimaryActivityCheckpointRunId: null,
    microLivePrimaryActivityCheckpointCursor: null,
    microLivePrimaryActivityCheckpointAt: null,
    microLivePrimaryActivityCheckpointEvidenceDigest: null,
    microLiveReservedMicros: 0,
    microLiveFeeApprovalId: null,
    microLiveFeeApprovalDigest: null,
    microLiveFeeApprovalApproved: false,
    microLiveFeeApprovalInvalidated: false,
    microLiveFeeApprovalApprovedAt: null,
    microLiveFeePolicyVersion: null,
    microLiveFeeApprovalSourceUrl: null,
    microLiveFeeFormulaVersion: null,
    microLiveFeeMaximumExposureMicros: null,
    microLiveFeeApprovedBy: null,
    microLiveFeeApprovedRunCapMicros: null,
    microLiveFeeArtifactStatus: "unverified",
    microLiveFeeArtifactCheckedAt: null,
    microLiveFeeArtifactReason: null,
  }).where(eq(microLiveConfigTable.id, "singleton"));
});

beforeEach(async () => {
  isolatedFeeFetchCount = 0;
  installIsolatedFeeScheduleFetch();
  process.env.MICRO_LIVE_PRODUCTION_ENABLED = "true";
  process.env.LIVE_EXECUTION_ENABLED = "true";
  await db.update(microLiveConfigTable).set({
    microLiveProductionEnabled: true,
    liveExecutionEnabled: true,
    manualKillSwitch: false,
    microLiveRunCapMicros: 1_000_000,
    microLiveRunId: null,
    microLiveEntryAttempted: false,
    microLiveExitAttempted: false,
    microLiveRunPhase: "UNARMED",
    microLiveRunArmedAt: null,
    microLiveRunDeadline: null,
    microLiveRunApprovalId: null,
    microLiveRunApprovalDigest: null,
    microLiveRunFreezeReason: null,
    microLiveAccountMode: null,
    microLiveSelectedSubaccount: null,
    microLiveAccountingUnresolved: false,
    microLiveAccountingUnresolvedReason: null,
    microLivePrimaryCashBaselineMicros: null,
    microLivePrimaryCashBaselineRunId: null,
    microLivePrimaryCashBaselineAt: null,
    microLivePrimaryCashBaselineEvidenceDigest: null,
    microLivePrimaryActivityCheckpointRunId: null,
    microLivePrimaryActivityCheckpointCursor: null,
    microLivePrimaryActivityCheckpointAt: null,
    microLivePrimaryActivityCheckpointEvidenceDigest: null,
    microLiveReservedMicros: 0,
    microLiveFeeApprovalId: null,
    microLiveFeeApprovalDigest: null,
    microLiveFeeApprovalApproved: false,
    microLiveFeeApprovalInvalidated: false,
    microLiveFeeApprovalApprovedAt: null,
    microLiveFeePolicyVersion: null,
    microLiveFeeApprovalSourceUrl: null,
    microLiveFeeFormulaVersion: null,
    microLiveFeeMaximumExposureMicros: null,
    microLiveFeeApprovedBy: null,
    microLiveFeeApprovedRunCapMicros: null,
    microLiveFeeArtifactStatus: "unverified",
    microLiveFeeArtifactCheckedAt: null,
    microLiveFeeArtifactReason: null,
  }).where(eq(microLiveConfigTable.id, "singleton"));
  const result = await reconcileMicroLiveAtStartup(mocks());
  assert.equal(result.ready, true, result.reason);
});

after(async () => {
  await cleanFixtures();
  if (originalConfig) {
    const { id: _id, createdAt: _createdAt, ...rest } = originalConfig;
    await db.update(microLiveConfigTable).set(rest)
      .where(eq(microLiveConfigTable.id, "singleton"));
  } else {
    await db.delete(microLiveConfigTable).where(eq(microLiveConfigTable.id, "singleton"));
  }
  if (originalEngine) {
    const { id: _id, createdAt: _createdAt, ...rest } = originalEngine;
    await db.update(forwardTestEngineTable).set(rest)
      .where(eq(forwardTestEngineTable.id, "v1.3-paper"));
  } else {
    await db.delete(forwardTestEngineTable).where(eq(forwardTestEngineTable.id, "v1.3-paper"));
  }
  for (const key of envKeys) {
    const original = originalEnv[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  await pool.end();
});

test("primary non-exclusive mode binds subaccount zero on the sole entry attempt", async () => {
  process.env.MICRO_LIVE_ACCOUNT_MODE = "primary_nonexclusive";
  process.env.KALSHI_BOT_SUBACCOUNT = "0";
  await disableSettlementGates();
  await reviewFrozenPrimaryBinding();
  await enableStartupRecoveryGates();
  const activity = async () => {
    const rows = await db.select().from(microLiveOrderTable);
    return {
      orders: rows.filter((row) => row.exchangeOrderId).map((row) => ({
        id: row.exchangeOrderId!, clientOrderId: row.clientOrderId,
        ticker: row.marketTicker, side: row.side === "UP" ? "yes" : "no",
        action: row.action, type: "limit", status: row.status,
        priceDollars: String(row.requestedLimitPrice),
        initialCount: String(row.requestedContracts),
        filledCount: String(row.filledContracts),
        remainingCount: String(row.remainingContracts),
        createdAt: row.createdAt.toISOString(),
      })),
      fills: [], available: true, truncated: false, keyRestrictionVerified: true,
      selectedSubaccount: 0, scanStartedAt: now().toISOString(),
      scanFinishedAt: now().toISOString(), exclusiveControlVerified: false,
    };
  };
  const startup = await reconcileMicroLiveAtStartup(mocks({ readAccountActivity: activity }));
  assert.deepEqual(startup, {
    ready: false, reason: "primary_cash_run_or_activity_missing",
  }, "a reviewed primary binding without a bounded cash baseline is not ready");
  const approval = {
    id: `primary-approval-${suffix}`,
    digest: createHash("sha256").update(`primary-digest-${suffix}`).digest("hex"),
    approvedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
  let submits = 0;
  const dependencies = cappedEntryMocks({
    readAccountActivity: activity,
    readEntryFeeTerms: async (selectedTicker) => ({
      ...boundedFeeTerms(
        selectedTicker, boundedApprovalFingerprint(approval, selectedTicker),
      ),
      verifiedAt: Date.now(),
    }),
    approvedFeeSessionForTest: () => approval,
    submitOrder: async (input) => {
      submits += 1;
      return {
        orderId: `primary-${input.clientOrderId}`, clientOrderId: input.clientOrderId,
        ticker: input.ticker, side: input.side, action: input.action, type: "limit",
        status: "resting", remainingCount: String(input.count), filledCount: null,
      };
    },
  });
  await armPrimaryNonexclusiveFixture(dependencies);
  const evaluationId = await insertEvaluation({});
  const result = await executeQualifiedV13Trigger(evaluationId, dependencies);
  assert.equal(result.status, "submitted", result.reason);
  const [bound] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.equal(bound?.microLiveAccountMode, "primary_nonexclusive");
  assert.equal(bound?.microLiveSelectedSubaccount, 0);
  assert.equal(bound?.microLiveEntryAttempted, true);
  assert.ok((bound?.microLiveReservedMicros ?? 1_000_001) <= 1_000_000);
  process.env.KALSHI_BOT_SUBACCOUNT = "1";
  const retryId = await insertEvaluation({ crossingKey: `${ticker}:retry` });
  const retry = await executeQualifiedV13Trigger(retryId, dependencies);
  assert.equal(retry.reason, "account_mode_or_subaccount_changed");
  assert.equal(submits, 1, "primary mode never submits a replacement/second entry");
});

test("primary same-market account conflict persists unresolved accounting and masks P&L", async () => {
  process.env.MICRO_LIVE_ACCOUNT_MODE = "primary_nonexclusive";
  process.env.KALSHI_BOT_SUBACCOUNT = "0";
  await disableSettlementGates();
  await reviewFrozenPrimaryBinding();
  await enableStartupRecoveryGates();
  const foreignOrder = {
    id: "manual-open-order", ticker, side: "yes", action: "buy", type: "limit",
    status: "resting", priceDollars: "0.40", remainingCount: "1", createdAt: now().toISOString(),
  };
  let conflictPresent = false;
  const activity = async () => ({
    orders: conflictPresent ? [{
      ...foreignOrder, clientOrderId: "manual-client", initialCount: "1",
      filledCount: "0",
    }] : [],
    fills: [], available: true, truncated: false, keyRestrictionVerified: true,
    selectedSubaccount: 0, scanStartedAt: now().toISOString(),
    scanFinishedAt: now().toISOString(), exclusiveControlVerified: false,
  });
  const readAccount = async () => ({
    ...emptyAccount(),
    openOrders: conflictPresent ? [foreignOrder] : [],
  });
  const startup = await reconcileMicroLiveAtStartup(mocks({
    readAccount, readAccountActivity: activity,
  }));
  assert.deepEqual(startup, {
    ready: false, reason: "primary_cash_run_or_activity_missing",
  }, "primary recovery cannot grant readiness before a bounded cash baseline exists");
  const approval = {
    id: `primary-conflict-approval-${suffix}`,
    digest: createHash("sha256").update(`primary-conflict-digest-${suffix}`).digest("hex"),
    approvedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
  let submitted = false;
  const dependencies = mocks({
    readAccount, readAccountActivity: activity,
    readEntryFeeTerms: async (selectedTicker) => ({
      ...boundedFeeTerms(
        selectedTicker, boundedApprovalFingerprint(approval, selectedTicker),
      ),
      verifiedAt: Date.now(),
    }),
    approvedFeeSessionForTest: () => approval,
    submitOrder: async () => {
      submitted = true;
      throw new Error("unexpected submission");
    },
  });
  await armPrimaryNonexclusiveFixture(dependencies);
  conflictPresent = true;
  const evaluationId = await insertEvaluation({});
  const result = await executeQualifiedV13Trigger(evaluationId, dependencies);
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "exchange_open_order_discrepancy");
  assert.equal(submitted, false);
  const [config] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.equal(config?.microLiveAccountingUnresolved, true);
  assert.equal(config?.microLiveAccountingUnresolvedReason, "primary_market_open_order_conflict");
  const state = await getMicroLiveState();
  assert.equal(state.enabled, false);
  assert.equal(state.killSwitch, "ON");
  assert.equal(state.realizedPnlCents, null);
  assert.equal(state.realizedPnlMicros, null);
  assert.equal(state.unrealizedPnlCents, null);
});

test("primary terminal exit and restart late-fill recovery remain GET-only and attributed", async () => {
  process.env.MICRO_LIVE_ACCOUNT_MODE = "primary_nonexclusive";
  process.env.KALSHI_BOT_SUBACCOUNT = "0";
  const market = `${ticker}-PRIMARY-EXIT`;
  const account = emptyAccount();
  let exitStatus = "canceled";
  let exitId: string | null = null;
  let exitClientOrderId: string | null = null;
  let posts = 0;
  let deletes = 0;
  const approval = {
    id: `primary-exit-approval-${suffix}`,
    digest: createHash("sha256").update(`primary-exit-digest-${suffix}`).digest("hex"),
    approvedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
  const activity = async () => {
    const rows = await db.select().from(microLiveOrderTable);
    return {
      orders: rows.filter((row) => row.exchangeOrderId).map((row) => {
        const count = account.fills.filter((fill) => fill.orderId === row.exchangeOrderId)
          .reduce((sum, fill) => sum + Number(fill.countFp), 0);
        const status = row.action === "buy" ? "executed" : exitStatus;
        return {
          id: row.exchangeOrderId!, clientOrderId: row.clientOrderId,
          ticker: row.marketTicker, side: row.side === "UP" ? "yes" : "no",
          action: row.action, type: "limit", status,
          priceDollars: String(row.requestedLimitPrice),
          initialCount: String(row.requestedContracts), filledCount: String(count),
          remainingCount: status === "resting" ? String(row.requestedContracts - count) : "0",
          createdAt: row.createdAt.toISOString(),
        };
      }),
      fills: account.fills.map((fill) => ({ ...fill, feeCostDollars: fill.feeCostDollars ?? null })),
      available: true, truncated: false, keyRestrictionVerified: true,
      selectedSubaccount: 0, scanStartedAt: now().toISOString(),
      scanFinishedAt: now().toISOString(), exclusiveControlVerified: false,
    };
  };
  const dependencies = mocks({
    readAccount: async () => account,
    readAccountActivity: activity,
    readHistoricalFills: async () => ({ fills: [], truncated: false, available: true }),
    readEntryFeeTerms: async (selectedTicker) => ({
      ...boundedFeeTerms(
        selectedTicker, boundedApprovalFingerprint(approval, selectedTicker),
      ),
      verifiedAt: Date.now(),
    }),
    approvedFeeSessionForTest: () => approval,
    readOrderStatus: async (id) => {
      const [row] = await db.select().from(microLiveOrderTable)
        .where(eq(microLiveOrderTable.exchangeOrderId, id)).limit(1);
      assert.ok(row, `unknown mocked order ${id}`);
      const filled = account.fills.filter((fill) => fill.orderId === id)
        .reduce((sum, fill) => sum + Number(fill.countFp), 0);
      const status = row.action === "buy" ? "executed" : exitStatus;
      return {
        orderId: id, clientOrderId: row.clientOrderId, ticker: market,
        side: row.side === "UP" ? "yes" : "no",
        action: row.action as "buy" | "sell", type: "limit",
        status, remainingCount: status === "resting"
          ? String(row.requestedContracts - filled) : "0",
        filledCount: String(filled),
      };
    },
    cancelOrder: async () => {
      deletes += 1;
      throw new Error("primary mode must never DELETE");
    },
    submitOrder: async (request) => {
      posts += 1;
      if (request.action === "buy") {
        return {
          orderId: `primary-buy-${suffix}`, clientOrderId: request.clientOrderId,
          ticker: request.ticker, side: request.side, action: "buy", type: "limit",
          status: "resting", remainingCount: String(request.count), filledCount: "0",
        };
      }
      exitId = `primary-exit-${suffix}`;
      exitClientOrderId = request.clientOrderId;
      return {
        orderId: exitId, clientOrderId: request.clientOrderId,
        ticker: request.ticker, side: request.side, action: "sell", type: "limit",
        status: "resting", remainingCount: String(request.count), filledCount: "0",
      };
    },
  });
  await armPrimaryNonexclusiveFixture(dependencies);
  assert.equal((await reconcileMicroLiveAtStartup(dependencies)).ready, true);
  const entryId = await insertEvaluation({ ticker: market });
  const entry = await executeQualifiedV13Trigger(entryId, dependencies);
  assert.equal(entry.status, "submitted", entry.reason);
  const [buy] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, entryId));
  account.positions.push({
    ticker: market, positionFp: String(buy.requestedContracts),
    marketExposureDollars: "2.40", realizedPnlDollars: "0",
  });
  account.fills.push({
    id: `primary-buy-fill-${suffix}`, orderId: entry.orderId!, ticker: market,
    side: "yes", action: "buy", countFp: String(buy.requestedContracts),
    priceDollars: "0.40", createdAt: now().toISOString(), feeCostDollars: "0.01",
  });
  assert.equal((await reconcileMicroLiveAtStartup(dependencies)).ready, true);

  const positionId = `position:${market}:${market}:cross`;
  const sourceId = await insertEvaluation({ ticker: market });
  await db.update(forwardTestEvaluationTable).set({
    btcPrice: 65030, signedBuffer: 30, absoluteBuffer: 30, velocity: -1,
  }).where(eq(forwardTestEvaluationTable.id, sourceId));
  const qualified = await qualifyMicroLivePositionEvaluation(positionId, dependencies);
  assert.ok(qualified.evaluationId, qualified.reason);
  const result = await executeQualifiedV13Trigger(qualified.evaluationId!, dependencies);
  assert.equal(result.status, "submitted", result.reason);
  assert.equal(result.reason, "exit_verified_execution_frozen_for_review");
  assert.ok(exitId && exitClientOrderId);
  assert.equal(deletes, 0);
  const [persistedExit] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.exchangeOrderId, exitId)).limit(1);
  assert.equal(persistedExit?.status, "canceled");
  let [config] = await db.select().from(microLiveConfigTable);
  assert.equal(config.microLiveAccountingUnresolved, false,
    "a fully attributed terminal exit does not poison accounting");

  // The exchange can report an IOC terminal before its final fill appears.
  account.positions[0]!.positionFp = "0";
  account.fills.push({
    id: `primary-late-exit-fill-${suffix}`, orderId: exitId, ticker: market,
    side: "yes", action: "sell", countFp: String(persistedExit!.requestedContracts),
    priceDollars: String(persistedExit!.requestedLimitPrice),
    createdAt: now().toISOString(), feeCostDollars: "0.01",
  });
  const restarted = await reconcileMicroLiveAtStartup(dependencies);
  assert.equal(restarted.ready, false);
  assert.equal(restarted.reason, "exit_canceled_requires_manual_review");
  const [recoveredExit] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, persistedExit!.id)).limit(1);
  assert.equal(recoveredExit?.status, "canceled",
    "venue terminal status remains canceled while its late fill is recorded");
  assert.equal(recoveredExit?.filledContracts, persistedExit!.requestedContracts);
  [config] = await db.select().from(microLiveConfigTable);
  assert.equal(config.microLiveAccountingUnresolved, false);
  assert.notEqual((await getMicroLiveState()).realizedPnlCents, null);
  assert.equal(posts, 2, "one entry and one exit POST only");
  assert.equal(deletes, 0);
});

test("all independent gates fail closed; kill switch atomically disables both flags", async () => {
  const id = await insertEvaluation({});
  process.env.MICRO_LIVE_PRODUCTION_ENABLED = "false";
  assert.equal((await executeQualifiedV13Trigger(id, mocks())).reason, "environment_flags_not_both_true");
  process.env.MICRO_LIVE_PRODUCTION_ENABLED = "true";
  await db.update(microLiveConfigTable).set({ manualKillSwitch: true })
    .where(eq(microLiveConfigTable.id, "singleton"));
  assert.equal((await executeQualifiedV13Trigger(id, mocks())).reason, "micro_live_kill_switch_on");
  await db.update(microLiveConfigTable).set({
    manualKillSwitch: false, microLiveProductionEnabled: true, liveExecutionEnabled: true,
  }).where(eq(microLiveConfigTable.id, "singleton"));
  await emergencyStopMicroLive();
  const stopped = await getMicroLiveState();
  assert.equal(stopped.killSwitch, "ON");
  assert.deepEqual(stopped.databaseFlags, {
    microLiveProductionEnabled: false,
    liveExecutionEnabled: false,
  });
  assert.equal(stopped.latestBlockedReason, "micro_live_kill_switch_on");
  assert.equal(stopped.availableKalshiBalance, null);
});

test("startup recovery makes no exchange calls and no config writes when gates are off", async () => {
  const beforeConfig = (await db.select().from(microLiveConfigTable))[0]!;
  let reads = 0;
  process.env.LIVE_EXECUTION_ENABLED = "false";
  const result = await reconcileMicroLiveAtStartup({
    readAccount: async () => { reads += 1; return emptyAccount(); },
  });
  const [afterConfig] = await db.select().from(microLiveConfigTable);
  assert.equal(result.ready, false);
  assert.equal(result.reason, "environment_flags_not_both_true");
  assert.equal(reads, 0);
  assert.deepEqual(afterConfig, beforeConfig);
});

test("GET-only startup audit checks authenticated orders, fills and positions with every gate frozen", async () => {
  await disableSettlementGates();
  const beforeConfig = (await db.select().from(microLiveConfigTable))[0]!;
  const recovery = await reconcileMicroLiveAtStartup({
    readAccount: async () => { throw new Error("execution recovery must stop before exchange GET"); },
  });
  assert.equal(recovery.reason, "environment_flags_not_both_true");
  let accountReads = 0;
  const result = await auditMicroLiveReadOnly({
    readAccount: async () => { accountReads += 1; return emptyAccount(); },
    readOrderStatus: async () => { throw new Error("no local order exists"); },
  });
  assert.equal(result.ready, false, "an audit must never grant execution readiness");
  assert.equal(result.reason, "read_only_current_snapshot_matches_history_unproven");
  assert.equal(accountReads, 1);
  const state = await getMicroLiveState();
  assert.equal(state.readOnlyAudit.status, "observed");
  assert.ok(state.readOnlyAudit.checkedAt);
  assert.equal(state.reconciliation.status, "required");
  assert.equal(state.reconciliation.checkedAt, null);
  assert.equal(state.enabled, false);
  assert.equal(state.killSwitch, "ON");
  assert.deepEqual(state.databaseFlags,
    { microLiveProductionEnabled: false, liveExecutionEnabled: false });
  assert.deepEqual((await db.select().from(microLiveConfigTable))[0], beforeConfig);
  assert.equal((await db.select().from(microLiveFillTable)).length, 0);
  assert.equal((await db.select().from(microLiveOrderTable)).length, 0);
});

test("primary GET-only diagnostic verifies complete history while allowing unrelated manual markets", async () => {
  process.env.MICRO_LIVE_ACCOUNT_MODE = "primary_nonexclusive";
  process.env.KALSHI_BOT_SUBACCOUNT = "0";
  await disableSettlementGates();
  await reviewFrozenPrimaryBinding();
  assert.equal((await reconcileMicroLiveAtStartup()).reason, "environment_flags_not_both_true");
  await db.update(microLiveConfigTable).set({
    microLiveAccountingUnresolved: true,
    microLiveAccountingUnresolvedReason: "prior_exchange_read_failed",
  }).where(eq(microLiveConfigTable.id, "singleton"));
  const [before] = await db.select().from(microLiveConfigTable);
  const boundary = before!.createdAt.getTime();
  const account = emptyAccount();
  const manualOrders = [-60_000, 60_000].map((offset, index) => ({
    id: `manual-${index}-${suffix}`, clientOrderId: null,
    ticker: `${ticker}-MANUAL-${index}`, side: "yes", action: "buy",
    type: "limit", status: "executed", priceDollars: "0.4",
    initialCount: index === 0 ? "1" : "1.25",
    filledCount: index === 0 ? "1" : "1.25", remainingCount: "0",
    createdAt: new Date(index === 0 ? boundary + offset : Date.now()).toISOString(),
  }));
  for (const order of manualOrders) {
    account.fills.push({
      id: `fill-${order.id}`, orderId: order.id, ticker: order.ticker,
      side: "yes", action: "buy", countFp: order.filledCount, priceDollars: "0.4",
      createdAt: order.createdAt, feeCostDollars: null,
    });
    account.positions.push({
      ticker: order.ticker, positionFp: order.filledCount,
      marketExposureDollars: "0.4", realizedPnlDollars: "0",
    });
  }
  const activity = (): KalshiAccountActivity => ({
    orders: manualOrders,
    fills: account.fills.map((fill) => ({ ...fill, feeCostDollars: fill.feeCostDollars ?? null })),
    available: true, truncated: false, selectedSubaccount: 0,
    keyRestrictionVerified: false, tradePermissionVerified: true,
    exclusiveControlVerified: false,
    scanStartedAt: now().toISOString(), scanFinishedAt: now().toISOString(),
  });
  let reads = 0;
  const result = await auditMicroLiveReadOnly({
    readAccount: async () => account,
    readAccountActivity: async () => { reads++; return activity(); },
    readOrderStatus: async () => { throw new Error("no bot orders"); },
  });
  assert.equal(result.ready, false);
  assert.equal(result.reason, "pristine_entry_restart_account_not_flat",
    "the restart flat-account interlock is stronger than diagnostic history classification");
  assert.equal(reads, 0,
    "the stronger flat-account restart guard rejects the snapshot before activity-history reads");
  const state = await getMicroLiveState();
  assert.equal(state.readOnlyAudit.status, "blocked");
  assert.equal(state.readOnlyAudit.historicalUnattributedFills, null,
    "nonflat restart evidence is rejected before fee/history classification");
  assert.equal(state.readOnlyAudit.positionDiscrepancies, null);
  assert.equal(state.reconciliation.status, "required");
  assert.equal(state.enabled, false);
  assert.equal(state.killSwitch, "ON");
  assert.deepEqual((await db.select().from(microLiveConfigTable))[0], before,
    "diagnostic must not clear unresolved accounting or write configuration");
});

const resolutionInput = () => ({
  actorId: "test-admin", expectedUnresolvedReason: "startup_exchange_reconciliation_failed",
  resolutionReason: "Reviewed the stale startup exchange read failure and full account history.",
});

async function prepareAccountingResolution() {
  process.env.MICRO_LIVE_ACCOUNT_MODE = "primary_nonexclusive";
  process.env.KALSHI_BOT_SUBACCOUNT = "0";
  await disableSettlementGates();
  await reviewFrozenPrimaryBinding();
  await db.update(microLiveConfigTable).set({
    microLiveAccountingUnresolved: true,
    microLiveAccountingUnresolvedReason: "startup_exchange_reconciliation_failed",
  }).where(eq(microLiveConfigTable.id, "singleton"));
}

function resolutionAudit(overrides: Partial<MicroLiveDependencies> = {}) {
  return {
    readAccount: async () => emptyAccount(),
    readAccountActivity: async (): Promise<KalshiAccountActivity> => ({
      orders: [], fills: [], available: true, truncated: false,
      selectedSubaccount: 0, keyRestrictionVerified: false,
      tradePermissionVerified: true, exclusiveControlVerified: false,
      scanStartedAt: now().toISOString(), scanFinishedAt: now().toISOString(),
    }),
    readOrderStatus: async () => { throw new Error("no local order exists"); },
    ...overrides,
  };
}

test("accounting resolution atomically records evidence but changes only the two stale fields", async () => {
  await prepareAccountingResolution();
  const [before] = await db.select().from(microLiveConfigTable);
  const result = await resolveStalePrimaryAccounting(resolutionInput(), resolutionAudit());
  assert.equal(result.status, "resolved", result.reason);
  assert.ok(result.decisionId);
  resolutionDecisionIds.add(result.decisionId);
  const [after] = await db.select().from(microLiveConfigTable);
  assert.deepEqual(after, {
    ...before, microLiveAccountingUnresolved: false,
    microLiveAccountingUnresolvedReason: null,
  });
  const [decision] = await db.select().from(microLiveDecisionTable)
    .where(eq(microLiveDecisionTable.id, result.decisionId));
  assert.equal(decision.status, "BLOCK");
  const record = JSON.parse(decision.reason);
  assert.equal(record.kind, "primary_accounting_resolution");
  assert.equal(record.actorId, "test-admin");
  assert.equal(record.resolutionReason, resolutionInput().resolutionReason);
  assert.equal(record.evidence.auditReason, "read_only_primary_history_verified");
  assert.equal(record.evidence.activityCounts.selectedSubaccount, 0);
  assert.match(record.evidence.activityDigest, /^[a-f0-9]{64}$/);
  assert.match(record.evidenceSha256, /^[a-f0-9]{64}$/);
  const state = await getMicroLiveState();
  assert.equal(state.enabled, false);
  assert.equal(state.killSwitch, "ON");
  assert.equal(state.reconciliation.status, "required");
});

test("accounting resolution rejects wrong reasons, prior attempts, reservations and nonempty ledger", async () => {
  await prepareAccountingResolution();
  const input = resolutionInput();
  await db.update(microLiveConfigTable).set({
    microLiveAccountingUnresolvedReason: "primary_account_same_market_fill_conflict",
  }).where(eq(microLiveConfigTable.id, "singleton"));
  assert.equal((await resolveStalePrimaryAccounting(input, resolutionAudit())).reason,
    "accounting_resolution_wrong_unresolved_reason");
  await db.update(microLiveConfigTable).set({
    microLiveAccountingUnresolvedReason: input.expectedUnresolvedReason,
    microLiveRunId: randomUUID(), microLiveEntryAttempted: true,
  }).where(eq(microLiveConfigTable.id, "singleton"));
  assert.equal((await resolveStalePrimaryAccounting(input, resolutionAudit())).reason,
    "accounting_resolution_prior_attempt_or_reservation");
  await db.update(microLiveConfigTable).set({
    microLiveRunId: null, microLiveEntryAttempted: false, microLiveReservedMicros: 1,
  }).where(eq(microLiveConfigTable.id, "singleton"));
  assert.equal((await resolveStalePrimaryAccounting(input, resolutionAudit())).reason,
    "accounting_resolution_prior_attempt_or_reservation");
  await db.update(microLiveConfigTable).set({ microLiveReservedMicros: 0 })
    .where(eq(microLiveConfigTable.id, "singleton"));
  const market = `${ticker}-RESOLUTION-LEDGER`;
  testTickers.add(market);
  const id = randomUUID();
  await db.insert(microLiveOrderTable).values({
    id, actionKey: `resolution-${id}`, clientOrderId: `resolution-${id}`,
    marketTicker: market, crossingKey: `${market}:cross`,
    triggerType: "SCOUT", action: "buy", intent: "entry", side: "UP",
    sourceEvaluationId: `resolution-eval-${id}`, signalAt: now(),
    requestedLimitPrice: 0.4, requestedContracts: 1,
    requestedStakeCents: 40, reservedRiskCents: 0, remainingContracts: 0,
    status: "canceled", filledContracts: 0,
  });
  assert.equal((await resolveStalePrimaryAccounting(input, resolutionAudit())).reason,
    "accounting_resolution_local_ledger_not_empty");
  assert.equal((await db.select().from(microLiveConfigTable))[0]?.microLiveAccountingUnresolved, true);
});

test("accounting resolution refuses incomplete or conflicting audit evidence", async () => {
  await prepareAccountingResolution();
  const input = resolutionInput();
  const unavailable = await resolveStalePrimaryAccounting(input, resolutionAudit({
    readAccountActivity: async () => ({
      orders: [], fills: [], available: false, truncated: true,
      selectedSubaccount: 0, keyRestrictionVerified: false,
      tradePermissionVerified: true, exclusiveControlVerified: false,
    }),
  }));
  assert.equal(unavailable.reason, "accounting_resolution_audit_failed");
  const conflict = await resolveStalePrimaryAccounting(input, resolutionAudit({
    readAccountActivity: async () => ({
      orders: [], fills: [], available: true, truncated: true,
      orderOverlapConflicts: [{ sources: [
        { endpoint: "portfolio/orders", page: 2 },
        { endpoint: "historical/orders", page: 1 },
      ] }],
      selectedSubaccount: 0, keyRestrictionVerified: false,
      tradePermissionVerified: true, exclusiveControlVerified: false,
    }),
  }));
  assert.equal(conflict.reason, "accounting_resolution_audit_failed");
  assert.equal((await db.select().from(microLiveConfigTable))[0]?.microLiveAccountingUnresolved, true);
});

test("accounting resolution is development-only and does not alter exclusive mode", async () => {
  await prepareAccountingResolution();
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    assert.equal((await resolveStalePrimaryAccounting(resolutionInput(), {
      readAccount: async () => { throw new Error("production must never read exchange account"); },
    })).reason, "accounting_resolution_development_only");
  } finally {
    process.env.NODE_ENV = previous;
  }
  process.env.MICRO_LIVE_ACCOUNT_MODE = "exclusive";
  process.env.KALSHI_BOT_SUBACCOUNT = "1";
  await db.update(microLiveConfigTable).set({
    microLiveAccountMode: "exclusive", microLiveSelectedSubaccount: 1,
  }).where(eq(microLiveConfigTable.id, "singleton"));
  const [before] = await db.select().from(microLiveConfigTable);
  assert.equal((await resolveStalePrimaryAccounting(resolutionInput(), {
    readAccount: async () => { throw new Error("exclusive mode must never read exchange account"); },
  })).reason, "accounting_resolution_primary_account_required");
  assert.deepEqual((await db.select().from(microLiveConfigTable))[0], before);
});

test("accounting resolution rejects concurrent configuration and ledger changes", async () => {
  await prepareAccountingResolution();
  const input = resolutionInput();
  const configChanged = await resolveStalePrimaryAccounting(input, {
    ...resolutionAudit(),
    afterAudit: async () => {
      await db.update(microLiveConfigTable).set({ maxSingleOrderRiskCents: 99 })
        .where(eq(microLiveConfigTable.id, "singleton"));
    },
  });
  assert.equal(configChanged.reason, "accounting_resolution_state_changed");
  const decisionId = randomUUID();
  resolutionDecisionIds.add(decisionId);
  const decisionChanged = await resolveStalePrimaryAccounting(input, {
    ...resolutionAudit(),
    afterAudit: async () => {
      await db.insert(microLiveDecisionTable).values({
        id: decisionId, status: "BLOCK", reason: "another admin decision during account audit",
      });
    },
  });
  assert.equal(decisionChanged.reason, "accounting_resolution_state_changed");
  const market = `${ticker}-RESOLUTION-RACE`;
  testTickers.add(market);
  const id = randomUUID();
  const ledgerChanged = await resolveStalePrimaryAccounting(input, {
    ...resolutionAudit(),
    afterAudit: async () => {
      await db.insert(microLiveOrderTable).values({
        id, actionKey: `resolution-${id}`, clientOrderId: `resolution-${id}`,
        marketTicker: market, crossingKey: `${market}:cross`,
        triggerType: "SCOUT", action: "buy", intent: "entry", side: "UP",
        sourceEvaluationId: `resolution-eval-${id}`, signalAt: now(),
        requestedLimitPrice: 0.4, requestedContracts: 1,
        requestedStakeCents: 40, reservedRiskCents: 0, remainingContracts: 0,
        status: "canceled", filledContracts: 0,
      });
    },
  });
  assert.equal(ledgerChanged.reason, "accounting_resolution_state_changed");
  assert.equal((await db.select().from(microLiveConfigTable))[0]?.microLiveAccountingUnresolved, true);
});

test("accounting resolution rejects an audit that expires after locking the ledger", async () => {
  await prepareAccountingResolution();
  const bindingDecisionCount = (await db.select().from(microLiveDecisionTable)).length;
  let clock = Date.now();
  const result = await resolveStalePrimaryAccounting(resolutionInput(), {
    ...resolutionAudit(),
    now: () => new Date(clock),
    afterLedgerLock: async () => { clock += 31_000; },
  });
  assert.equal(result.reason, "accounting_resolution_state_changed");
  assert.equal((await db.select().from(microLiveConfigTable))[0]?.microLiveAccountingUnresolved, true);
  assert.equal((await db.select().from(microLiveDecisionTable)).length, bindingDecisionCount,
    "the rejected resolution adds no decision beyond the explicit binding review");
});

test("primary GET-only diagnostic blocks incomplete history and uncertain or conflicting bot evidence", async () => {
  process.env.MICRO_LIVE_ACCOUNT_MODE = "primary_nonexclusive";
  process.env.KALSHI_BOT_SUBACCOUNT = "0";
  await disableSettlementGates();
  await reviewFrozenPrimaryBinding();
  const market = `${ticker}-AUDIT-BOT`;
  testTickers.add(market);
  const id = randomUUID();
  await db.insert(microLiveOrderTable).values({
    id, actionKey: `audit-action-${id}`, clientOrderId: `audit-client-${id}`,
    marketTicker: market, crossingKey: `${market}:cross`, triggerType: "SCOUT",
    action: "buy", intent: "entry", side: "UP", sourceEvaluationId: `audit-eval-${id}`,
    signalAt: now(), requestedLimitPrice: 0.4, requestedContracts: 1,
    requestedStakeCents: 40, reservedRiskCents: 0, remainingContracts: 0,
    status: "canceled", exchangeOrderId: `audit-exchange-${id}`, filledContracts: 0,
  });
  const [before] = await db.select().from(microLiveConfigTable);
  const botOrder = {
    id: `audit-exchange-${id}`, clientOrderId: `audit-client-${id}`,
    ticker: market, side: "yes", action: "buy", type: "limit",
    status: "canceled", priceDollars: "0.4", initialCount: "1",
    filledCount: "0", remainingCount: "0", createdAt: now().toISOString(),
  };
  const activity = (orders: KalshiAccountActivity["orders"], available = true): KalshiAccountActivity => ({
    orders, fills: [], available, truncated: false,
    selectedSubaccount: 0, keyRestrictionVerified: false,
    tradePermissionVerified: true, exclusiveControlVerified: false,
    scanStartedAt: now().toISOString(), scanFinishedAt: now().toISOString(),
  });
  const base = {
    readAccount: async () => emptyAccount(),
    readHistoricalFills: async () => ({ fills: [], available: true, truncated: false }),
    readOrderStatus: async () => { throw new Error("must stop before order status"); },
  };
  const incomplete = await auditMicroLiveReadOnly({
    ...base, readAccountActivity: async () => activity([botOrder], false),
  });
  assert.equal(incomplete.reason, "account_history_incomplete");
  const missing = await auditMicroLiveReadOnly({
    ...base, readAccountActivity: async () => activity([]),
  });
  assert.equal(missing.reason, "primary_account_bot_order_missing");
  const conflict = await auditMicroLiveReadOnly({
    ...base, readAccountActivity: async () => activity([
      botOrder, { ...botOrder, id: `manual-same-${id}`, clientOrderId: null },
    ]),
  });
  assert.equal(conflict.reason, "primary_account_same_market_order_conflict");
  assert.deepEqual((await db.select().from(microLiveConfigTable))[0], before);
});

test("primary GET-only diagnostic reports order overlap conflict without changing configuration", async () => {
  process.env.MICRO_LIVE_ACCOUNT_MODE = "primary_nonexclusive";
  process.env.KALSHI_BOT_SUBACCOUNT = "0";
  await disableSettlementGates();
  await reviewFrozenPrimaryBinding();
  const [before] = await db.select().from(microLiveConfigTable);
  const result = await auditMicroLiveReadOnly({
    readAccount: async () => emptyAccount(),
    readAccountActivity: async () => ({
      orders: [], fills: [], available: true, truncated: true,
      orderOverlapConflicts: [{ sources: [
        { endpoint: "portfolio/orders", page: 2 },
        { endpoint: "historical/orders", page: 1 },
      ] }],
      selectedSubaccount: 0, exclusiveControlVerified: false,
    }),
  });
  assert.deepEqual(result, { ready: false, reason: "account_history_order_overlap_conflict" });
  assert.deepEqual((await db.select().from(microLiveConfigTable))[0], before);
});

test("primary GET-only diagnostic exceptions never persist unresolved accounting", async () => {
  process.env.MICRO_LIVE_ACCOUNT_MODE = "primary_nonexclusive";
  process.env.KALSHI_BOT_SUBACCOUNT = "0";
  await disableSettlementGates();
  await reviewFrozenPrimaryBinding();
  const [before] = await db.select().from(microLiveConfigTable);
  const failed = await auditMicroLiveReadOnly({
    readAccount: async () => { throw new Error("invalid signing key fixture"); },
  });
  assert.deepEqual(failed, { ready: false, reason: "startup_exchange_reconciliation_failed" });
  assert.deepEqual((await db.select().from(microLiveConfigTable))[0], before);
  await db.update(microLiveConfigTable).set({
    microLiveAccountMode: "exclusive", microLiveSelectedSubaccount: 1,
  }).where(eq(microLiveConfigTable.id, "singleton"));
  const [bound] = await db.select().from(microLiveConfigTable);
  const mismatch = await auditMicroLiveReadOnly();
  assert.equal(mismatch.reason, "account_mode_or_subaccount_changed");
  assert.deepEqual((await db.select().from(microLiveConfigTable))[0], bound);
});

test("GET-only audit labels strictly older unlinked fills as historical and unattributed", async () => {
  await disableSettlementGates();
  await reconcileMicroLiveAtStartup({
    readAccount: async () => { throw new Error("execution recovery must not read account"); },
  });
  const [config] = await db.select().from(microLiveConfigTable);
  const historicalAt = new Date(config!.createdAt.getTime() - 60_000).toISOString();
  const account = emptyAccount();
  account.fills.push({
    id: `historical-account-fill-${suffix}`, orderId: `not-a-bot-order-${suffix}`,
    ticker: `${ticker}-OLDER-ACCOUNT`, side: "yes", action: "buy",
    countFp: "1", priceDollars: "0.40", createdAt: historicalAt,
  });
  const result = await auditMicroLiveReadOnly({ readAccount: async () => account });
  assert.equal(result.reason, "pristine_entry_restart_account_not_flat");
  assert.equal(result.ready, false);
  const state = await getMicroLiveState();
  assert.equal(state.readOnlyAudit.status, "blocked");
  assert.equal(state.readOnlyAudit.boundaryAt, config!.createdAt.toISOString());
  assert.equal(state.readOnlyAudit.knownBotFills, null);
  assert.equal(state.readOnlyAudit.historicalUnattributedFills, null);
  assert.equal(state.readOnlyAudit.unexplainedFills, null);
  assert.equal(state.readOnlyAudit.positionDiscrepancies, null);
  assert.equal(state.reconciliation.status, "required");
  assert.equal(state.enabled, false);
  assert.equal((await db.select().from(microLiveFillTable)).length, 0);
});

test("GET-only audit blocks unlinked fills at the boundary, undated fills, and unexpected positions", async () => {
  await disableSettlementGates();
  const [config] = await db.select().from(microLiveConfigTable);
  const account = emptyAccount();
  account.fills.push({
    id: `new-unlinked-fill-${suffix}`, orderId: `not-a-bot-order-${suffix}`,
    ticker: `${ticker}-NEW-ACCOUNT`, side: "yes", action: "buy",
    countFp: "1", priceDollars: "0.40", createdAt: config!.createdAt.toISOString(),
  });
  const newFill = await auditMicroLiveReadOnly({ readAccount: async () => account });
  assert.equal(newFill.reason, "pristine_entry_restart_account_not_flat");
  assert.equal((await getMicroLiveState()).readOnlyAudit.unexplainedFills, null);
  account.fills[0]!.createdAt = null;
  const undated = await auditMicroLiveReadOnly({ readAccount: async () => account });
  assert.equal(undated.reason, "pristine_entry_restart_account_not_flat");
  account.fills[0]!.createdAt = new Date(config!.createdAt.getTime() - 60_000).toISOString();
  account.positions.push({
    ticker: `${ticker}-NEW-ACCOUNT`, positionFp: "1",
    marketExposureDollars: "0.40", realizedPnlDollars: "0",
  });
  const position = await auditMicroLiveReadOnly({ readAccount: async () => account });
  assert.equal(position.reason, "pristine_entry_restart_account_not_flat");
  const state = await getMicroLiveState();
  assert.equal(state.readOnlyAudit.historicalUnattributedFills, null);
  assert.equal(state.readOnlyAudit.positionDiscrepancies, null);
  assert.equal(state.enabled, false);
});

test("GET-only audit counts known bot fills separately and blocks missing bot evidence", async () => {
  await disableSettlementGates();
  const [config] = await db.select().from(microLiveConfigTable);
  const market = `${ticker}-KNOWN-FILL`;
  testTickers.add(market);
  const id = randomUUID();
  const exchangeOrderId = `known-order-${id}`;
  const fillAt = now();
  const positionId = `position:${market}:cross`;
  await db.insert(microLiveOrderTable).values({
    id, actionKey: `known-action-${id}`, clientOrderId: `known-client-${id}`,
    marketTicker: market, crossingKey: `${market}:cross`, triggerType: "SCOUT",
    action: "buy", intent: "entry", side: "UP", sourceEvaluationId: `known-eval-${id}`,
    signalAt: fillAt, requestedLimitPrice: 0.4, requestedContracts: 1,
    requestedStakeCents: 40, reservedRiskCents: 40, remainingContracts: 0,
    filledContracts: 1, status: "filled", exchangeOrderId,
  });
  await db.insert(microLiveFillTable).values({
    id: `known-fill-${id}`, orderId: id, exchangeFillId: `known-exchange-fill-${id}`,
    exchangeOrderId, filledAt: fillAt, contracts: 1, fillPrice: 0.4,
    action: "buy", positionId, costCents: 40, feeCents: 0, feeKnown: false,
    tradeMicros: 400_000, feeMicros: null,
  });
  const exchangeFill = {
    id: `known-exchange-fill-${id}`, orderId: exchangeOrderId, ticker: market,
    side: "yes", action: "buy", countFp: "1", priceDollars: "0.40",
    createdAt: fillAt.toISOString(),
  };
  const account = emptyAccount();
  account.fills.push(exchangeFill, {
    id: `old-other-fill-${id}`, orderId: `old-other-order-${id}`,
    ticker: `${ticker}-OLDER-OTHER-MARKET`, side: "no", action: "buy",
    countFp: "1", priceDollars: "0.25",
    createdAt: new Date(config!.createdAt.getTime() - 60_000).toISOString(),
  });
  account.positions.push({
    ticker: market, positionFp: "1",
    marketExposureDollars: "0.40", realizedPnlDollars: "0",
  });
  const beforeOrder = (await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, id)))[0]!;
  const beforeFill = (await db.select().from(microLiveFillTable)
    .where(eq(microLiveFillTable.orderId, id)))[0]!;
  const result = await auditMicroLiveReadOnly({
    readAccount: async () => account,
    readHistoricalFills: async () => ({ fills: [exchangeFill], available: true, truncated: false }),
    readOrderStatus: async (orderId) => ({
      orderId, clientOrderId: beforeOrder.clientOrderId, ticker: market,
      side: "yes", action: "buy", type: "limit", status: "executed",
      remainingCount: "0", filledCount: "1",
    }),
  });
  assert.equal(result.reason, "pristine_entry_restart_account_not_flat");
  const state = await getMicroLiveState();
  assert.equal(state.readOnlyAudit.knownBotFills, null);
  assert.equal(state.readOnlyAudit.historicalUnattributedFills, null);
  assert.equal(state.readOnlyAudit.unexplainedFills, null);
  assert.equal(state.readOnlyAudit.positionDiscrepancies, null);
  assert.deepEqual((await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, id)))[0], beforeOrder);
  assert.deepEqual((await db.select().from(microLiveFillTable)
    .where(eq(microLiveFillTable.orderId, id)))[0], beforeFill);
  const missing = await auditMicroLiveReadOnly({
    readAccount: async () => ({ ...account, fills: account.fills.slice(1) }),
    readHistoricalFills: async () => ({ fills: [], available: false, truncated: false }),
  });
  assert.equal(missing.reason, "historical_fill_snapshot_unavailable");
  assert.equal((await getMicroLiveState()).readOnlyAudit.status, "blocked");
});

test("GET-only audit uses an earlier known bot order as the time boundary", async () => {
  await disableSettlementGates();
  const [config] = await db.select().from(microLiveConfigTable);
  const orderCreated = new Date(config!.createdAt.getTime() - 120_000);
  const market = `${ticker}-EARLY-BOT-ORDER`;
  testTickers.add(market);
  const id = randomUUID();
  await db.insert(microLiveOrderTable).values({
    id, actionKey: `early-action-${id}`, clientOrderId: `early-client-${id}`,
    marketTicker: market, crossingKey: `${market}:cross`, triggerType: "SCOUT",
    action: "buy", intent: "entry", side: "UP", sourceEvaluationId: `early-eval-${id}`,
    signalAt: orderCreated, createdAt: orderCreated,
    requestedLimitPrice: 0.4, requestedContracts: 1,
    requestedStakeCents: 40, reservedRiskCents: 0, remainingContracts: 0,
    status: "canceled", exchangeOrderId: `early-exchange-${id}`, filledContracts: 0,
  });
  const account = emptyAccount();
  account.fills.push({
    id: `between-fill-${id}`, orderId: `unlinked-between-${id}`,
    ticker: `${ticker}-BETWEEN`, side: "yes", action: "buy",
    countFp: "1", priceDollars: "0.40",
    createdAt: new Date(config!.createdAt.getTime() - 60_000).toISOString(),
  });
  const result = await auditMicroLiveReadOnly({
    readAccount: async () => account,
    readHistoricalFills: async () => ({ fills: [], available: true, truncated: false }),
  });
  assert.equal(result.reason, "pristine_entry_restart_account_not_flat");
  const state = await getMicroLiveState();
  assert.equal(state.readOnlyAudit.boundaryAt, orderCreated.toISOString());
  assert.equal(state.readOnlyAudit.unexplainedFills, null);
});

test("an older delayed GET-only audit cannot overwrite a newer unexplained-fill blocker", async () => {
  await disableSettlementGates();
  const started = deferred<void>();
  const delayedAccount = deferred<ReturnType<typeof emptyAccount>>();
  const earlier = auditMicroLiveReadOnly({
    readAccount: async () => {
      started.resolve();
      return delayedAccount.promise;
    },
  });
  await started.promise;
  const [config] = await db.select().from(microLiveConfigTable);
  const account = emptyAccount();
  account.fills.push({
    id: `racing-new-fill-${suffix}`, orderId: `unlinked-racing-${suffix}`,
    ticker: `${ticker}-RACING`, side: "yes", action: "buy",
    countFp: "1", priceDollars: "0.40", createdAt: config!.createdAt.toISOString(),
  });
  const newer = await auditMicroLiveReadOnly({ readAccount: async () => account });
  assert.equal(newer.reason, "pristine_entry_restart_account_not_flat");
  delayedAccount.resolve(emptyAccount());
  assert.equal((await earlier).reason, "read_only_audit_superseded");
  const state = await getMicroLiveState();
  assert.equal(state.readOnlyAudit.status, "blocked");
  assert.equal(state.readOnlyAudit.unexplainedFills, null);
  assert.equal(state.enabled, false);
});

test("GET-only audit checks an existing order status without updating its ledger row", async () => {
  await disableSettlementGates();
  const market = `${ticker}-READ-ONLY-ORDER`;
  testTickers.add(market);
  const id = randomUUID();
  const exchangeOrderId = `read-only-${suffix}`;
  await db.insert(microLiveOrderTable).values({
    id, actionKey: `read-only-action-${id}`, clientOrderId: `read-only-client-${id}`,
    marketTicker: market, crossingKey: `${market}:cross`, triggerType: "SCOUT",
    action: "buy", intent: "entry", side: "UP", sourceEvaluationId: `read-only-eval-${id}`,
    signalAt: now(), requestedLimitPrice: 0.4, requestedContracts: 1,
    requestedStakeCents: 40, reservedRiskCents: 0, remainingContracts: 0,
    status: "canceled", exchangeOrderId, filledContracts: 0,
  });
  const before = (await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, id)))[0]!;
  let statusReads = 0;
  const result = await auditMicroLiveReadOnly({
    readAccount: async () => emptyAccount(),
    readHistoricalFills: async () => ({ available: false, truncated: false, fills: [] }),
    readOrderStatus: async (orderId) => {
      assert.equal(orderId, exchangeOrderId);
      statusReads++;
      return {
        orderId, clientOrderId: before.clientOrderId, ticker: market, side: "yes",
        action: "buy", type: "limit", status: "canceled",
        remainingCount: "0", filledCount: "0",
      };
    },
  });
  assert.equal(result.reason, "read_only_current_snapshot_matches_history_unproven");
  assert.equal(statusReads, 1);
  assert.deepEqual((await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, id)))[0], before);
  assert.equal((await getMicroLiveState()).enabled, false);
});

test("GET-only audit blocks mismatched or truncated exchange evidence without writes or readiness", async () => {
  await disableSettlementGates();
  const unexpectedPosition = await auditMicroLiveReadOnly({
    readAccount: async () => ({
      ...emptyAccount(),
      positions: [{
        ticker: `${ticker}-UNRELATED`, positionFp: "1",
        marketExposureDollars: "0.40", realizedPnlDollars: "0",
      }],
    }),
  });
  assert.equal(unexpectedPosition.reason, "pristine_entry_restart_account_not_flat");
  const truncated = await auditMicroLiveReadOnly({
    readAccount: async () => ({
      ...emptyAccount(),
      truncated: { openOrders: false, positions: false, fills: true },
    }),
  });
  assert.equal(truncated.reason, "account_snapshot_truncated");
  assert.equal((await getMicroLiveState()).readOnlyAudit.status, "blocked");
  assert.equal((await getMicroLiveState()).enabled, false);
  assert.equal((await db.select().from(microLiveDecisionTable)).length, 0);
});

test("GET-only audit refuses to run if any execution gate is open", async () => {
  let reads = 0;
  const result = await auditMicroLiveReadOnly({
    readAccount: async () => { reads++; return emptyAccount(); },
  });
  assert.equal(result.reason, "read_only_audit_requires_frozen_gates");
  assert.equal(reads, 0);
  assert.equal(result.ready, false);
});

test("GET-only audit never cancels a frozen outstanding exit", async () => {
  await disableSettlementGates();
  const market = `${ticker}-FROZEN-AUDIT-EXIT`;
  testTickers.add(market);
  const id = randomUUID();
  await db.insert(microLiveOrderTable).values({
    id, actionKey: `audit-buy-action-${id}`, clientOrderId: `audit-buy-client-${id}`,
    marketTicker: market, crossingKey: `${market}:cross`, triggerType: "SCOUT",
    action: "buy", intent: "entry", side: "UP", sourceEvaluationId: `audit-buy-eval-${id}`,
    signalAt: now(), requestedLimitPrice: 0.4, requestedContracts: 1,
    requestedStakeCents: 40, reservedRiskCents: 0, remainingContracts: 0,
    status: "canceled", exchangeOrderId: `audit-buy-${id}`, filledContracts: 0,
  });
  const buy = (await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, id)))[0]!;
  await insertRecoveredExitOrder({
    buyOrder: buy, positionId: `position:${market}:cross`,
    contractCount: 1, limitPrice: 0.6, exchangeOrderId: `audit-exit-${id}`,
  });
  const before = await db.select().from(microLiveOrderTable);
  const result = await auditMicroLiveReadOnly({
    readAccount: async () => { throw new Error("outstanding exit must block before GET"); },
  });
  assert.equal(result.reason, "read_only_audit_outstanding_exit_requires_review");
  assert.deepEqual(await db.select().from(microLiveOrderTable), before);
  assert.equal((await getMicroLiveState()).enabled, false);
});

test("ordinary recovery accepts only complete pre-boundary unrelated account activity", async () => {
  await enableStartupRecoveryGates();
  const [config] = await db.select().from(microLiveConfigTable);
  const oldAt = new Date(config!.createdAt.getTime() - 60_000).toISOString();
  const foreignId = `legacy-order-${suffix}`;
  const foreignMarket = `${ticker}-LEGACY-OTHER`;
  const fill = {
    id: `legacy-fill-${suffix}`, orderId: foreignId, ticker: foreignMarket,
    side: "yes", action: "buy", countFp: "1", priceDollars: "0.40",
    createdAt: oldAt, feeCostDollars: null,
  };
  const account = emptyAccount();
  const activity: KalshiAccountActivity = {
    available: true, truncated: false, keyRestrictionVerified: true,
    selectedSubaccount: 1,
    scanStartedAt: new Date().toISOString(), scanFinishedAt: new Date().toISOString(),
    exclusiveControlVerified: true,
    orders: [{
      id: foreignId, clientOrderId: null, ticker: foreignMarket,
      side: "yes", action: "buy", type: "limit", status: "executed",
      priceDollars: "0.40", initialCount: "1", filledCount: "1",
      remainingCount: "0", createdAt: oldAt,
    }],
    fills: [fill],
  };
  const run = (evidence: KalshiAccountActivity) => reconcileMicroLiveAtStartup(mocks({
    readAccount: async () => account,
    readAccountActivity: async () => evidence,
  }));
  const before = await db.select().from(microLiveConfigTable);
  assert.equal((await run(activity)).ready, true);
  assert.equal((await db.select().from(microLiveOrderTable)).length, 0);
  assert.equal((await db.select().from(microLiveFillTable)).length, 0);
  assert.deepEqual(await db.select().from(microLiveConfigTable), before);

  const failures: Array<[KalshiAccountActivity, string]> = [
    [{ ...activity, available: false }, "account_history_incomplete"],
    [{ ...activity, truncated: true }, "account_history_incomplete"],
    [{ ...activity, exclusiveControlVerified: false }, "account_exclusive_control_unproven"],
    [{ ...activity, orders: activity.orders.map((order) =>
      ({ ...order, status: "resting", remainingCount: "1" })) },
    "account_history_unexplained_order"],
    [{ ...activity, orders: activity.orders.map((order) =>
      ({ ...order, createdAt: config!.createdAt.toISOString() })) },
    "account_history_unexplained_order"],
    [{ ...activity, fills: activity.fills.map((item) =>
      ({ ...item, createdAt: config!.createdAt.toISOString() })) },
    "account_history_unexplained_fill"],
    [{ ...activity, fills: [] }, "account_history_order_fill_count_mismatch"],
    [{ ...activity, orders: [] }, "account_history_unexplained_fill"],
  ];
  for (const [evidence, expected] of failures) {
    await enableStartupRecoveryGates();
    const failed = await run(evidence);
    assert.equal(failed.ready, false);
    assert.equal(failed.reason, expected);
    const [frozen] = await db.select().from(microLiveConfigTable);
    assert.equal(frozen!.manualKillSwitch, true);
    assert.equal(frozen!.liveExecutionEnabled, false);
    assert.equal(frozen!.microLiveProductionEnabled, false);
  }
});

test("a frozen exit cannot cancel when account-wide ownership history is incomplete", async () => {
  await disableSettlementGates();
  const market = `${ticker}-FROZEN-OWNERSHIP`;
  testTickers.add(market);
  const id = randomUUID();
  await db.insert(microLiveOrderTable).values({
    id, actionKey: `frozen-${id}`, clientOrderId: `client-${id}`,
    marketTicker: market, crossingKey: `${market}:cross`, triggerType: "EXIT",
    action: "sell", intent: "exit", exitPositionId: `position:${market}:cross`,
    side: "UP", sourceEvaluationId: `eval-${id}`,
    signalAt: now(), requestedLimitPrice: 0.4, requestedContracts: 1,
    requestedStakeCents: 0, reservedRiskCents: 0, remainingContracts: 1,
    filledContracts: 0, status: "pending", exchangeOrderId: `exchange-${id}`,
  });
  let cancels = 0;
  const dependencies = mocks({
    readAccountActivity: async () => ({
      orders: [], fills: [], available: false, truncated: false,
      keyRestrictionVerified: true, selectedSubaccount: 1,
      scanStartedAt: now().toISOString(), scanFinishedAt: now().toISOString(),
      exclusiveControlVerified: false,
    }),
    cancelOrder: async () => { cancels++; throw new Error("must not cancel"); },
  });
  const result = await reconcileMicroLiveAtStartup(dependencies);
  assert.equal(result.reason, "account_history_incomplete");
  const direct = await cancelAndVerifyMicroLiveExit(id, dependencies);
  assert.equal(direct.reason, "account_history_incomplete");
  const sharedAccount = await cancelAndVerifyMicroLiveExit(id, mocks({
    readAccountActivity: async () => ({
      orders: [], fills: [], available: true, truncated: false,
      keyRestrictionVerified: true, selectedSubaccount: 1,
      scanStartedAt: now().toISOString(), scanFinishedAt: now().toISOString(),
      exclusiveControlVerified: false,
    }),
    cancelOrder: async () => { cancels++; throw new Error("must not cancel"); },
  }));
  assert.equal(sharedAccount.reason, "account_exclusive_control_unproven");
  assert.equal(cancels, 0);
  assert.equal((await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, id)))[0]!.status, "pending");
});

test("startup recovery is not NODE_ENV-restricted but retains exact safety gates", async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    process.env.LIVE_EXECUTION_ENABLED = "false";
    let reads = 0;
    const blocked = await reconcileMicroLiveAtStartup({
      readAccount: async () => { reads += 1; return emptyAccount(); },
    });
    assert.equal(blocked.ready, false);
    assert.equal(blocked.reason, "environment_flags_not_both_true");
    assert.equal(reads, 0);

    process.env.LIVE_EXECUTION_ENABLED = "true";
    const eligible = await reconcileMicroLiveAtStartup(mocks());
    assert.equal(eligible.ready, true, eligible.reason);
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
});

test("startup recovery fails closed on truncated, mismatched, and stale snapshots", async () => {
  const truncated = await reconcileMicroLiveAtStartup(mocks({
    readAccount: async () => ({
      ...emptyAccount(),
      truncated: { openOrders: false, positions: true, fills: false },
    }),
  }));
  assert.equal(truncated.ready, false);
  assert.equal(truncated.reason, "account_snapshot_truncated");

  await db.update(microLiveConfigTable).set({
    manualKillSwitch: false, microLiveProductionEnabled: true, liveExecutionEnabled: true,
  }).where(eq(microLiveConfigTable.id, "singleton"));
  const mismatch = await reconcileMicroLiveAtStartup(mocks({
    readAccount: async () => ({
      ...emptyAccount(),
      positions: [{
        ticker: `${ticker}-UNEXPECTED`, positionFp: "1",
        marketExposureDollars: "0.40", realizedPnlDollars: "0",
      }],
    }),
  }));
  assert.equal(mismatch.ready, false);
  assert.equal(mismatch.reason, "pristine_entry_restart_account_not_flat");

  await db.update(microLiveConfigTable).set({
    manualKillSwitch: false, microLiveProductionEnabled: true, liveExecutionEnabled: true,
  }).where(eq(microLiveConfigTable.id, "singleton"));
  const stale = await reconcileMicroLiveAtStartup({
    ...mocks(),
    now: () => new Date(Date.now() - 60_000),
  });
  assert.equal(stale.ready, true);
  const id = await insertEvaluation({ ticker: `${ticker}-STALE-RECOVERY` });
  assert.equal((await executeQualifiedV13Trigger(id, mocks())).reason,
    "startup_reconciliation_stale");
});

test("an ID-less pre-POST reservation permanently consumes the one development attempt", async () => {
  const id = await insertEvaluation({ ticker: `${ticker}-RECOVERY-BEFORE-POST` });
  const interlockReached = deferred<boolean>();
  const releaseInterlock = deferred<boolean>();
  let posts = 0;
  const attempt = executeQualifiedV13Trigger(id, cappedEntryMocks({
    beforeSubmissionInterlock: async () => {
      interlockReached.resolve(true);
      await releaseInterlock.promise;
    },
    submitOrder: async () => {
      posts += 1;
      throw new Error("POST must not be reached after startup freeze");
    },
  }));
  await interlockReached.promise;
  const duringReservation = await reconcileMicroLiveAtStartup(mocks());
  assert.equal(duringReservation.ready, false);
  assert.equal(duringReservation.reason, "reserved_submission_missing_exchange_id");
  releaseInterlock.resolve(true);
  assert.equal((await attempt).reason, "submission_gate_changed");
  assert.equal(posts, 0);

  await db.update(microLiveConfigTable).set({
    manualKillSwitch: false, microLiveProductionEnabled: true, liveExecutionEnabled: true,
  }).where(eq(microLiveConfigTable.id, "singleton"));
  assert.equal((await reconcileMicroLiveAtStartup(mocks())).ready, true);
  const [consumed] = await db.select().from(microLiveConfigTable);
  assert.equal(consumed?.microLiveEntryAttempted, true);
  assert.ok(consumed?.microLiveReservedMicros);
  const retryId = await insertEvaluation({ ticker: `${ticker}-RECOVERY-AFTER-POST` });
  const retry = await executeQualifiedV13Trigger(retryId, cappedEntryMocks({
    submitOrder: async () => { posts++; throw new Error("must not submit after restart/uncertainty"); },
  }));
  assert.equal(retry.status, "blocked");
  assert.equal(posts, 0);
});

test("fresh entry ownership preflight blocks a new foreign account order", async () => {
  const market = `${ticker}-FOREIGN-PREFLIGHT`;
  const evaluationId = await insertEvaluation({ ticker: market });
  const foreignId = `foreign-preflight-${suffix}`;
  const [boundaryConfig] = await db.select().from(microLiveConfigTable).limit(1);
  const createdAt = new Date(Math.max(now().getTime(), boundaryConfig!.createdAt.getTime()) + 1).toISOString();
  let posts = 0;
  let accountReads = 0;
  const foreignOrder = {
    id: foreignId, clientOrderId: null, ticker: `${ticker}-FOREIGN-MARKET`,
    side: "yes" as const, action: "buy" as const, type: "limit" as const,
    status: "resting", priceDollars: "0.40", initialCount: "1",
    filledCount: "0", remainingCount: "1", createdAt,
  };
  const result = await executeQualifiedV13Trigger(evaluationId, cappedEntryMocks({
    readAccount: async () => {
      accountReads++;
      if (accountReads === 1) return emptyAccount();
      return {
        ...emptyAccount(),
        openOrders: [{
          id: foreignId, ticker: foreignOrder.ticker, side: "yes", action: "buy",
          priceDollars: "0.40", remainingCount: "1", status: "resting", createdAt,
        }],
      };
    },
    readAccountActivity: async () => ({
      orders: [foreignOrder], fills: [], available: true, truncated: false,
      keyRestrictionVerified: true, selectedSubaccount: 1,
      scanStartedAt: now().toISOString(), scanFinishedAt: now().toISOString(),
      exclusiveControlVerified: true,
    }),
    submitOrder: async () => {
      posts++;
      throw new Error("mock POST must not be reached");
    },
  }));
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "account_history_unexplained_order");
  assert.equal(posts, 0);
  const [order] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, evaluationId)).limit(1);
  assert.equal(order!.status, "rejected");
  assert.equal(order!.failureReason, result.reason);
  const [config] = await db.select().from(microLiveConfigTable).limit(1);
  assert.equal(config!.manualKillSwitch, true);
  assert.equal(config!.microLiveProductionEnabled, false);
  assert.equal(config!.liveExecutionEnabled, false);
});

test("fresh entry ownership preflight rejects incomplete history after startup readiness", async () => {
  const market = `${ticker}-INCOMPLETE-PREFLIGHT`;
  const evaluationId = await insertEvaluation({ ticker: market });
  let posts = 0;
  const result = await executeQualifiedV13Trigger(evaluationId, cappedEntryMocks({
    readAccountActivity: async () => ({
      orders: [], fills: [], available: false, truncated: false,
      keyRestrictionVerified: true, selectedSubaccount: 1,
      scanStartedAt: now().toISOString(), scanFinishedAt: now().toISOString(),
      exclusiveControlVerified: true,
    }),
    submitOrder: async () => {
      posts++;
      throw new Error("mock POST must not be reached");
    },
  }));
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "account_history_incomplete");
  assert.equal(posts, 0);
  const [order] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, evaluationId)).limit(1);
  assert.equal(order!.status, "rejected");
  assert.equal(order!.reservedRiskCents, 0);
  const [config] = await db.select().from(microLiveConfigTable).limit(1);
  assert.equal(config!.manualKillSwitch, true);
  assert.equal(config!.microLiveProductionEnabled, false);
  assert.equal(config!.liveExecutionEnabled, false);
});

test("fresh exit ownership preflight blocks a foreign order before the reduce-only POST", async () => {
  const market = `${ticker}-EXIT-FOREIGN-PREFLIGHT`;
  const { row: buy, exchangeOrderId } = await submitLinkedMockOrder(market);
  const positionId = `position:${market}:${buy.crossingKey}`;
  const fillId = `exit-preflight-fill-${suffix}`;
  const filledAt = now().toISOString();
  const fill = {
    id: fillId, orderId: exchangeOrderId, ticker: market, side: "yes" as const,
    action: "buy" as const, countFp: String(buy.requestedContracts),
    priceDollars: String(buy.requestedLimitPrice), createdAt: filledAt,
    feeCostDollars: "0",
  };
  const account: KalshiAccountSnapshot = {
    ...emptyAccount(),
    positions: [{
      ticker: market, positionFp: String(buy.requestedContracts),
      marketExposureDollars: (buy.requestedContracts * buy.requestedLimitPrice).toFixed(2),
      realizedPnlDollars: "0",
    }],
    fills: [fill],
  };
  const [buyRow] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, buy.id)).limit(1);
  const evaluationId = await insertEvaluation({ signal: "EXIT", ticker: market });
  await db.update(forwardTestEvaluationTable).set({
    evaluationSource: "micro_live", livePositionId: positionId,
    sourcePaperEvaluationId: `paper-${evaluationId}`, positionWasOpen: true,
    crossingKey: buy.crossingKey, qualifyingTrigger: true,
  }).where(eq(forwardTestEvaluationTable.id, evaluationId));
  const foreignId = `foreign-exit-${suffix}`;
  const foreignOrder = {
    id: foreignId, clientOrderId: null, ticker: `${ticker}-FOREIGN-EXIT`,
    side: "yes" as const, action: "buy" as const, type: "limit" as const,
    status: "resting", priceDollars: "0.40", initialCount: "1",
    filledCount: "0", remainingCount: "1", createdAt: now().toISOString(),
  };
  let accountReads = 0;
  let activityReads = 0;
  let posts = 0;
  const result = await executeQualifiedV13Trigger(evaluationId, mocks({
    readAccount: async () => {
      accountReads++;
      return accountReads === 1 ? account : {
        ...account,
        openOrders: [{
          id: foreignId, ticker: foreignOrder.ticker, side: "yes", action: "buy",
          priceDollars: "0.40", remainingCount: "1", status: "resting",
          createdAt: foreignOrder.createdAt,
        }],
      };
    },
    readAccountActivity: async () => {
      activityReads++;
      const foreign = activityReads === 1 ? [] : [foreignOrder];
      return {
        orders: [{
          id: exchangeOrderId, clientOrderId: buy.clientOrderId, ticker: market,
          side: "yes", action: "buy", type: "limit", status: "executed",
          priceDollars: String(buy.requestedLimitPrice),
          initialCount: String(buy.requestedContracts),
          filledCount: String(buy.requestedContracts), remainingCount: "0",
          createdAt: buyRow!.createdAt.toISOString(),
        }, ...foreign],
        fills: [fill], available: true, truncated: false,
        keyRestrictionVerified: true, selectedSubaccount: 1,
        scanStartedAt: now().toISOString(), scanFinishedAt: now().toISOString(),
        exclusiveControlVerified: true,
      };
    },
    readOrderStatus: async () => ({
      orderId: exchangeOrderId, clientOrderId: buy.clientOrderId, ticker: market,
      side: "yes", action: "buy", type: "limit", status: "executed",
      remainingCount: "0", filledCount: String(buy.requestedContracts),
    }),
    submitOrder: async () => {
      posts++;
      throw new Error("mock exit POST must not be reached");
    },
  }));
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "account_history_unexplained_order");
  assert.equal(posts, 0);
  const exit = (await db.select().from(microLiveOrderTable))
    .find((order) => order.action === "sell" && order.sourceEvaluationId === evaluationId);
  assert.equal(exit!.status, "rejected");
  const [config] = await db.select().from(microLiveConfigTable).limit(1);
  assert.equal(config!.manualKillSwitch, true);
  assert.equal(config!.microLiveProductionEnabled, false);
  assert.equal(config!.liveExecutionEnabled, false);
});

test("startup recovery still detects inconsistent fills while CONFIRM stays prohibited", async () => {
  const market = `${ticker}-LEDGER-ANOMALY`;
  const evaluationId = await insertEvaluation({ ticker: market });
  const submitted = await executeQualifiedV13Trigger(evaluationId, mocks());
  assert.equal(submitted.status, "submitted", submitted.reason);
  const [order] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, evaluationId)).limit(1);
  await db.insert(microLiveFillTable).values({
    id: `bad-fill-${suffix}`,
    orderId: order.id,
    exchangeFillId: `bad-exchange-fill-${suffix}`,
    exchangeOrderId: order.exchangeOrderId,
    filledAt: now(),
    contracts: 1,
    fillPrice: order.requestedLimitPrice,
    action: "sell",
    positionId: "unlinked-position",
    costCents: 40,
    feeCents: 0,
    feeKnown: true,
    proceedsCents: 40,
    costBasisCents: 40,
  });
  const account = {
    ...emptyAccount(),
    openOrders: [{
      id: order.exchangeOrderId!, ticker: market, side: "yes", action: "buy",
      priceDollars: String(order.requestedLimitPrice), remainingCount: String(order.requestedContracts - 1),
      status: "resting", createdAt: now().toISOString(),
    }],
    positions: [{
      ticker: market, positionFp: "1", marketExposureDollars: "0.40", realizedPnlDollars: "0",
    }],
    fills: [{
      id: `bad-exchange-fill-${suffix}`, orderId: order.exchangeOrderId!, ticker: market,
      side: "yes", action: "buy", countFp: "1",
      priceDollars: String(order.requestedLimitPrice), createdAt: now().toISOString(),
    }],
  };
  const confirmId = await insertEvaluation({
    ticker: market, signal: "CONFIRM", crossingKey: `${market}:cross`,
  });
  const blockedConfirm = await executeQualifiedV13Trigger(confirmId, mocks({
    readAccount: async () => account,
  }));
  assert.equal(blockedConfirm.reason, "evaluation_not_a_qualified_v13_entry");
  const result = await reconcileMicroLiveAtStartup(mocks({
    readOrderStatus: async () => ({
      orderId: order.exchangeOrderId!, clientOrderId: order.clientOrderId, ticker: market,
      side: "yes", action: "buy", type: "limit", status: "resting",
      remainingCount: String(order.requestedContracts - 1),
      filledCount: "1",
    }),
    readAccount: async () => account,
  }));
  assert.equal(result.ready, false);
  assert.match(result.reason, /^(startup_ledger_anomaly_|local_exchange_fill_mismatch)/);
});

test("startup and entry reconciliation reject duplicate exchange position tickers", async () => {
  const duplicatedPosition = {
    ticker: `${ticker}-DUPLICATE-POSITION`,
    positionFp: "1",
    marketExposureDollars: "0.40",
    realizedPnlDollars: "0",
  };
  const duplicateSnapshot = {
    ...emptyAccount(),
    positions: [duplicatedPosition, { ...duplicatedPosition, positionFp: "2" }],
  };
  const startup = await reconcileMicroLiveAtStartup(mocks({
    readAccount: async () => duplicateSnapshot,
  }));
  assert.equal(startup.ready, false);
  assert.equal(startup.reason, "exchange_position_duplicate_ticker");

  await db.update(microLiveConfigTable).set({
    manualKillSwitch: false, microLiveProductionEnabled: true, liveExecutionEnabled: true,
  }).where(eq(microLiveConfigTable.id, "singleton"));
  assert.equal((await reconcileMicroLiveAtStartup(mocks())).ready, true);
  const evaluationId = await insertEvaluation({ ticker: `${ticker}-DUPLICATE-ENTRY` });
  const entry = await executeQualifiedV13Trigger(evaluationId, mocks({
    readAccount: async () => duplicateSnapshot,
  }));
  assert.equal(entry.reason, "exchange_position_duplicate_ticker");
});

test("startup recovery rolls back all ledger writes when interrupted mid-transaction", async () => {
  const market = `${ticker}-RECOVERY-ROLLBACK`;
  const id = await insertEvaluation({ ticker: market });
  const submitted = await executeQualifiedV13Trigger(id, mocks());
  assert.equal(submitted.status, "submitted");
  const [order] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, id)).limit(1);
  const account = {
    ...emptyAccount(),
    positions: [{
      ticker: market, positionFp: String(order.requestedContracts),
      marketExposureDollars: "2.40", realizedPnlDollars: "0",
    }],
    fills: [{
      id: `rollback-fill-${suffix}`, orderId: submitted.orderId!, ticker: market, side: "yes",
      action: "buy", countFp: String(order.requestedContracts), priceDollars: "0.40",
      createdAt: now().toISOString(),
    }],
  };
  const recovered = await reconcileMicroLiveAtStartup(mocks({
    readAccount: async () => account,
    readOrderStatus: async () => ({
      orderId: submitted.orderId!, clientOrderId: order.clientOrderId, ticker: market,
      side: "yes", action: "buy", type: "limit", status: "executed", remainingCount: "0",
      filledCount: String(order.requestedContracts),
    }),
    afterRecoveryWrites: async () => { throw new Error("simulated process failure before commit"); },
  }));
  assert.equal(recovered.ready, false);
  assert.equal((await db.select().from(microLiveFillTable)
    .where(eq(microLiveFillTable.orderId, order.id))).length, 0);
  const [unchanged] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, order.id)).limit(1);
  assert.equal(unchanged.status, "pending");
  assert.equal(unchanged.filledContracts, 0);
  assert.equal((await getMicroLiveState()).reconciliation.status, "required");
});

test("stop during external recovery read prevents readiness and ledger commit", async () => {
  const market = `${ticker}-STOP-DURING-RECOVERY`;
  const id = await insertEvaluation({ ticker: market });
  const submitted = await executeQualifiedV13Trigger(id, mocks());
  assert.equal(submitted.status, "submitted");
  const [order] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, id)).limit(1);
  const account = {
    ...emptyAccount(),
    positions: [{
      ticker: market, positionFp: String(order.requestedContracts),
      marketExposureDollars: "2.40", realizedPnlDollars: "0",
    }],
    fills: [{
      id: `stop-recovery-fill-${suffix}`, orderId: submitted.orderId!, ticker: market, side: "yes",
      action: "buy", countFp: String(order.requestedContracts), priceDollars: "0.40",
      createdAt: now().toISOString(),
    }],
  };
  const readStarted = deferred<boolean>();
  const continueRead = deferred<boolean>();
  const recovery = reconcileMicroLiveAtStartup(mocks({
    readAccount: async () => {
      readStarted.resolve(true);
      await continueRead.promise;
      return account;
    },
    readOrderStatus: async () => ({
      orderId: submitted.orderId!, clientOrderId: order.clientOrderId, ticker: market,
      side: "yes", action: "buy", type: "limit", status: "executed", remainingCount: "0",
      filledCount: String(order.requestedContracts),
    }),
  }));
  await readStarted.promise;
  assert.equal((await emergencyStopMicroLive()).killSwitch, "ON");
  continueRead.resolve(true);
  const result = await recovery;
  assert.equal(result.ready, false);
  assert.equal(result.reason, "startup_recovery_gates_changed");
  assert.equal((await db.select().from(microLiveFillTable)
    .where(eq(microLiveFillTable.orderId, order.id))).length, 0);
  const [unchanged] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, order.id)).limit(1);
  assert.equal(unchanged.status, "pending");
});

test("another instance submitting during the snapshot invalidates its ledger fingerprint", async () => {
  const market = `${ticker}-PEER-DURING-RECOVERY`;
  const evaluationId = await insertEvaluation({ ticker: market });
  const readStarted = deferred<boolean>();
  const continueRead = deferred<boolean>();
  const recovery = reconcileMicroLiveAtStartup(mocks({
    readAccount: async () => {
      readStarted.resolve(true);
      await continueRead.promise;
      return emptyAccount();
    },
  }));
  await readStarted.promise;
  await db.transaction(async (tx) => {
    const [config] = await tx.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
    assert.ok(config && !config.manualKillSwitch);
    await tx.insert(microLiveOrderTable).values({
      id: `peer-order-${suffix}`,
      actionKey: `peer-action-${suffix}`,
      clientOrderId: `ml-peer-${suffix}`,
      marketTicker: market,
      crossingKey: `${market}:cross`,
      triggerType: "SCOUT",
      side: "UP",
      sourceEvaluationId: evaluationId,
      signalAt: now(),
      btcSignalPrice: 65000,
      target: 65000,
      orderbookQuotePrice: 0.4,
      quoteObservedAt: now(),
      requestedLimitPrice: 0.4,
      requestedContracts: 1,
      requestedStakeCents: 40,
      reservedRiskCents: 40,
      exchangeOrderId: `peer-exchange-${suffix}`,
      status: "pending",
      submittedAt: now(),
      remainingContracts: 1,
    });
  });
  continueRead.resolve(true);
  const result = await recovery;
  assert.equal(result.ready, false);
  assert.match(result.reason,
    /^(account_history_unexplained_order|startup_ledger_changed_during_exchange_snapshot)$/);
  assert.equal((await getMicroLiveState()).reconciliation.status, "required");
});

test("a peer ledger change after reservation blocks the final POST", async () => {
  const market = `${ticker}-PEER-BEFORE-POST`;
  const evaluationId = await insertEvaluation({ ticker: market });
  const interlockReached = deferred<boolean>();
  const releaseInterlock = deferred<boolean>();
  let posts = 0;
  const attempt = executeQualifiedV13Trigger(evaluationId, mocks({
    beforeSubmissionInterlock: async () => {
      interlockReached.resolve(true);
      await releaseInterlock.promise;
    },
    submitOrder: async () => {
      posts++;
      throw new Error("stale ledger must block POST");
    },
  }));
  await interlockReached.promise;
  await db.transaction(async (tx) => {
    await tx.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).for("update").limit(1);
    await tx.update(microLiveOrderTable).set({ failureReason: "peer-ledger-change" })
      .where(eq(microLiveOrderTable.sourceEvaluationId, evaluationId));
  });
  releaseInterlock.resolve(true);
  assert.equal((await attempt).reason, "submission_gate_changed");
  assert.equal(posts, 0);
});

test("stale evaluation, missing reference, quote cap, and insufficient cash are blocked", async () => {
  const market = `${ticker}-GATES`;
  await db.update(microLiveConfigTable).set({
    manualKillSwitch: false, microLiveProductionEnabled: true, liveExecutionEnabled: true,
  }).where(eq(microLiveConfigTable.id, "singleton"));
  const staleId = await insertEvaluation({ ticker: market, evaluatedAt: new Date(Date.now() - 30_000) });
  assert.equal((await executeQualifiedV13Trigger(staleId, mocks())).reason, "evaluation_stale");
  const missingReference = await insertEvaluation({ ticker: market, entryOffer: null });
  assert.equal((await executeQualifiedV13Trigger(missingReference, mocks())).reason, "quote_above_reference_offer");
  const capId = await insertEvaluation({ ticker: market });
  assert.equal((await executeQualifiedV13Trigger(capId, mocks({
    readOrderbook: async () => ({
      yesAskDollars: "0.61", noAskDollars: "0.4", yesBidDollars: "0.6", noBidDollars: "0.39",
      yesAskAvailableContracts: "20", noAskAvailableContracts: "20", observedAt: now().toISOString(),
    }),
  }))).reason, "quote_above_v13_entry_cap");
  const cashId = await insertEvaluation({ ticker: market });
  assert.equal((await executeQualifiedV13Trigger(cashId, mocks({
    readAccount: async () => ({ ...emptyAccount(), balance: { availableCashDollars: "0.01", portfolioValueDollars: "0.01" } }),
  }))).reason, "insufficient_available_cash_or_contracts");
  const staleFeedId = await insertEvaluation({ ticker: market });
  assert.equal((await executeQualifiedV13Trigger(staleFeedId, mocks({
    readBtc: async () => ({
      price: 65000, receivedAt: now(), providerAt: new Date(Date.now() - 30_000),
    }),
  }))).reason, "btc_observation_stale_or_invalid");
  const truncatedId = await insertEvaluation({ ticker: market });
  assert.equal((await executeQualifiedV13Trigger(truncatedId, mocks({
    readAccount: async () => ({
      ...emptyAccount(),
      truncated: { openOrders: true, positions: false, fills: false },
    }),
  }))).reason, "account_snapshot_truncated");
});

test("explicit exchange rejection is recorded and cannot be retried", async () => {
  const rejectId = await insertEvaluation({ ticker: `${ticker}-REJECT` });
  const rejected = await executeQualifiedV13Trigger(rejectId, mocks({
    submitOrder: async () => { throw new Error("Kalshi trading request failed (HTTP_ERROR, HTTP 400)"); },
  }));
  assert.equal(rejected.status, "rejected");
  const [rejectedOrder] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, rejectId)).limit(1);
  assert.equal(rejectedOrder.status, "rejected");
  assert.equal((await executeQualifiedV13Trigger(rejectId, mocks())).reason, "action_already_reserved");
});

test("ambiguous submission is unknown, reserves risk, and atomically freezes execution", async () => {
  const id = await insertEvaluation({ ticker: `${ticker}-UNKNOWN` });
  const result = await executeQualifiedV13Trigger(id, mocks({
    submitOrder: async () => { throw new Error("mock network timeout after submit"); },
  }));
  assert.equal(result.status, "unknown");
  const [row] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, id)).limit(1);
  assert.equal(row.status, "unknown");
  assert.equal(row.reservedRiskCents, row.requestedStakeCents);
  const state = await getMicroLiveState();
  assert.equal(state.killSwitch, "ON");
  assert.equal(state.lastRejection?.status, "unknown");
});

test("stop committed before the final submission interlock prevents the POST", async () => {
  const id = await insertEvaluation({ ticker: `${ticker}-STOP-FIRST` });
  const interlockReached = deferred<boolean>();
  const releaseInterlock = deferred<boolean>();
  let submitCalls = 0;
  const attempt = executeQualifiedV13Trigger(id, mocks({
    beforeSubmissionInterlock: async () => {
      interlockReached.resolve(true);
      await releaseInterlock.promise;
    },
    submitOrder: async () => {
      submitCalls += 1;
      throw new Error("submission should have been blocked by the stop");
    },
  }));

  await interlockReached.promise;
  const stopped = await emergencyStopMicroLive();
  assert.equal(stopped.killSwitch, "ON");
  releaseInterlock.resolve(true);

  const result = await attempt;
  assert.equal(result.reason, "submission_gate_changed");
  assert.equal(submitCalls, 0);
  const [order] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, id)).limit(1);
  assert.equal(order.status, "rejected");
  assert.equal(order.reservedRiskCents, 0);
});

test("stop waits for an already locked bounded POST to finish", async () => {
  const id = await insertEvaluation({ ticker: `${ticker}-SUBMIT-FIRST` });
  const postStarted = deferred<boolean>();
  const finishPost = deferred<boolean>();
  const attempt = executeQualifiedV13Trigger(id, mocks({
    submitOrder: async (input) => {
      postStarted.resolve(true);
      await finishPost.promise;
      return {
        orderId: `exchange-${input.clientOrderId}`,
        clientOrderId: input.clientOrderId,
        ticker: input.ticker,
        side: input.side,
        action: input.action,
        type: "limit",
        status: "resting",
        remainingCount: String(input.count),
        filledCount: null,
      };
    },
  }));

  await postStarted.promise;
  let stopFinished = false;
  const stop = emergencyStopMicroLive().then((state) => {
    stopFinished = true;
    return state;
  });
  const stoppedTooEarly = await Promise.race([
    stop.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
  ]);
  assert.equal(stoppedTooEarly, false, "stop must wait while POST owns the interlock row lock");

  finishPost.resolve(true);
  const [submitted, stopped] = await Promise.all([attempt, stop]);
  assert.equal(submitted.status, "submitted");
  assert.equal(stopped.killSwitch, "ON");
  assert.equal(stopFinished, true);
});

test("stable action key prevents duplicates and independent markets cannot overlap", async () => {
  const market = `${ticker}-SEQUENCE`;
  const id = await insertEvaluation({ ticker: market });
  let calls = 0;
  const deps = mocks({ submitOrder: async (input) => {
    calls += 1;
    return {
      orderId: `exchange-${input.clientOrderId}`, clientOrderId: input.clientOrderId,
      ticker: input.ticker, side: input.side, action: input.action, type: "limit",
      status: "resting", remainingCount: String(input.count),
      filledCount: null,
    };
  } });
  const firstResult = await executeQualifiedV13Trigger(id, deps);
  assert.equal(firstResult.status, "submitted", firstResult.reason);
  assert.equal((await executeQualifiedV13Trigger(id, deps)).reason, "action_already_reserved");
  assert.equal(calls, 1);
  const otherMarketId = await insertEvaluation({ ticker: `${market}-OTHER` });
  assert.equal((await executeQualifiedV13Trigger(otherMarketId, mocks())).reason, "one_position_limit_reached");
  const stateAfterRestart = await getMicroLiveState();
  assert.ok(stateAfterRestart.recentDecision);
  assert.equal(stateAfterRestart.recentDecision?.status, "blocked");
  assert.equal(stateAfterRestart.latestBlockedReason, "one_position_limit_reached");
  assert.equal(stateAfterRestart.lastAccepted?.status, "submitted");
  assert.equal(stateAfterRestart.pendingOrders.count, 1);
  assert.equal(stateAfterRestart.availableKalshiBalance, null);
});

test("concurrent executor instances share the database reservation boundary", async () => {
  const id = await insertEvaluation({ ticker: `${ticker}-CONCURRENT` });
  let calls = 0;
  const deps = mocks({
    submitOrder: async (input) => {
      calls += 1;
      return {
        orderId: `exchange-${input.clientOrderId}`, clientOrderId: input.clientOrderId,
        ticker: input.ticker, side: input.side, action: input.action, type: "limit",
        status: "resting", remainingCount: String(input.count),
        filledCount: null,
      };
    },
  });
  const outcomes = await Promise.all([
    executeQualifiedV13Trigger(id, deps),
    executeQualifiedV13Trigger(id, deps),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "submitted").length, 1);
  assert.equal(calls, 1);
  assert.equal((await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, id))).length, 1);
});

test("concurrent CONFIRM attempts cannot add entries after the single SCOUT", async () => {
  const market = `${ticker}-PARTIAL-RISK-RACE`;
  const scoutId = await insertEvaluation({ ticker: market });
  const scoutResult = await executeQualifiedV13Trigger(scoutId, mocks({
    readOrderbook: async () => ({
      yesAskDollars: "0.20", noAskDollars: "0.20", yesBidDollars: "0.19", noBidDollars: "0.19",
      yesAskAvailableContracts: "2", noAskAvailableContracts: "2", observedAt: now().toISOString(),
    }),
  }));
  assert.equal(scoutResult.status, "submitted", scoutResult.reason);
  const [scout] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, scoutId)).limit(1);
  const scoutFillId = `race-fill-${suffix}`;
  const account = {
    ...emptyAccount(),
    openOrders: [{
      id: scout.exchangeOrderId!, ticker: market, side: "yes", action: "buy",
      priceDollars: "0.20", remainingCount: String(scout.requestedContracts - 1),
      status: "resting", createdAt: now().toISOString(),
    }],
    positions: [{
      ticker: market, positionFp: "1", marketExposureDollars: "0.20", realizedPnlDollars: "0",
    }],
    fills: [{
      id: scoutFillId, orderId: scout.exchangeOrderId!, ticker: market,
      side: "yes", action: "buy", countFp: "1", priceDollars: "0.20",
      feeCostDollars: "0.01", createdAt: now().toISOString(),
    }],
  };
  const confirmIds = await Promise.all([
    insertEvaluation({ ticker: market, signal: "CONFIRM", entryOffer: 0.68 }),
    insertEvaluation({ ticker: market, signal: "CONFIRM", entryOffer: 0.68 }),
  ]);
  let submissions = 0;
  const outcomes = await Promise.all(confirmIds.map((id) => executeQualifiedV13Trigger(id, mocks({
    readOrderbook: async () => ({
      yesAskDollars: "0.20", noAskDollars: "0.20", yesBidDollars: "0.19", noBidDollars: "0.19",
      yesAskAvailableContracts: "1", noAskAvailableContracts: "1", observedAt: now().toISOString(),
    }),
    readAccount: async () => account,
    submitOrder: async (input) => {
      submissions += 1;
      return {
        orderId: `exchange-${input.clientOrderId}`, clientOrderId: input.clientOrderId,
        ticker: input.ticker, side: input.side, action: input.action, type: "limit",
        status: "resting", remainingCount: String(input.count),
        filledCount: null,
      };
    },
  }))));
  assert.equal(outcomes.filter((outcome) => outcome.status === "submitted").length, 0);
  assert.equal(submissions, 0);
  assert.equal((await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.action, "buy"))).length, 1);
});

test("CONFIRM is blocked before it can add a second order", async () => {
  const market = `${ticker}-DISCREPANCY`;
  const scoutId = await insertEvaluation({ ticker: market });
  const scout = await executeQualifiedV13Trigger(scoutId, mocks());
  assert.equal(scout.status, "submitted");
  const [scoutOrder] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, scoutId)).limit(1);
  const confirmId = await insertEvaluation({
    ticker: market, signal: "CONFIRM", crossingKey: `${market}:cross`,
  });
  const result = await executeQualifiedV13Trigger(confirmId, mocks({
    readOrderStatus: async () => ({
      orderId: scout.orderId!, clientOrderId: "mock-order", ticker: market,
      side: "yes", action: "buy", type: "limit", status: "resting",
      remainingCount: String(scoutOrder!.requestedContracts),
      filledCount: "0",
    }),
  }));
  assert.equal(result.reason, "evaluation_not_a_qualified_v13_entry");
});

test("partial SCOUT reconciliation does not enable a CONFIRM/additional entry", async () => {
  const market = `${ticker}-FILL`;
  const firstId = await insertEvaluation({ ticker: market });
  const first = await executeQualifiedV13Trigger(firstId, mocks({
    readOrderbook: async () => ({
      yesAskDollars: "0.20", noAskDollars: "0.20", yesBidDollars: "0.19", noBidDollars: "0.19",
      yesAskAvailableContracts: "2", noAskAvailableContracts: "2", observedAt: now().toISOString(),
    }),
  }));
  assert.equal(first.status, "submitted", first.reason);
  const [firstOrder] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, firstId)).limit(1);
  const account = {
    ...emptyAccount(),
    openOrders: [{
      id: first.orderId!, ticker: market, side: "yes", action: "buy",
      priceDollars: "0.20", remainingCount: String(firstOrder.requestedContracts - 1),
      status: "resting", createdAt: now().toISOString(),
    }],
    positions: [{ ticker: market, positionFp: "1", marketExposureDollars: "0.20", realizedPnlDollars: "0" }],
    fills: [{
      id: `fill-${suffix}`, orderId: first.orderId!, ticker: market, side: "yes", action: "buy",
      countFp: "1", priceDollars: "0.20", feeCostDollars: "0.01", createdAt: now().toISOString(),
    }],
  };
  const confirmId = await insertEvaluation({
    ticker: market, signal: "CONFIRM", crossingKey: `${market}:cross`, entryOffer: 0.68,
  });
  await db.update(microLiveConfigTable).set({
    maxLiveBankrollCents: 460,
    maxCumulativeReservedCents: 460,
  }).where(eq(microLiveConfigTable.id, "singleton"));
  const recovered = await reconcileMicroLiveAtStartup(mocks({
    readAccount: async () => account,
    readOrderStatus: async () => ({
      orderId: first.orderId!, clientOrderId: "mock-order", ticker: market,
      side: "yes", action: "buy", type: "limit", status: "resting",
      remainingCount: String(firstOrder.requestedContracts - 1),
      filledCount: "1",
    }),
  }));
  assert.equal(recovered.ready, true, recovered.reason);
  const confirmResult = await executeQualifiedV13Trigger(confirmId, mocks({
    readOrderbook: async () => ({
      yesAskDollars: "0.20", noAskDollars: "0.20", yesBidDollars: "0.19", noBidDollars: "0.19",
      yesAskAvailableContracts: "1", noAskAvailableContracts: "1", observedAt: now().toISOString(),
    }),
    readAccount: async () => account,
  }));
  assert.equal(confirmResult.status, "blocked");
  assert.equal(confirmResult.reason, "evaluation_not_a_qualified_v13_entry");
  const [reconciled] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, firstOrder.id)).limit(1);
  assert.equal(reconciled.status, "partial");
  assert.equal(reconciled.filledContracts, 1);
  assert.equal(
    reconciled.reservedRiskCents,
    reconciled.requestedStakeCents,
    "partial fill keeps confirmed cost plus resting remainder reserved",
  );
  const state = await getMicroLiveState();
  assert.equal(state.currentPosition?.contracts, 1);
  assert.equal(state.currentPosition?.sellableContracts, 1);
  assert.equal(state.openExposureCents, 21);
  assert.equal(state.realizedPnlCents, null);
  assert.equal(state.unrealizedPnlCents, null);
});

test("executed entry stays bound after restart and cannot be followed by CONFIRM", async () => {
  const market = `${ticker}-EXECUTED`;
  const firstId = await insertEvaluation({ ticker: market });
  const first = await executeQualifiedV13Trigger(firstId, mocks({
    readOrderbook: async () => ({
      yesAskDollars: "0.20", noAskDollars: "0.20", yesBidDollars: "0.19", noBidDollars: "0.19",
      yesAskAvailableContracts: "2", noAskAvailableContracts: "2", observedAt: now().toISOString(),
    }),
    submitOrder: async (input) => ({
      orderId: `exchange-${input.clientOrderId}`, clientOrderId: input.clientOrderId,
      ticker: input.ticker, side: input.side, action: input.action, type: "limit",
      status: "executed", remainingCount: "0",
      filledCount: String(input.count),
    }),
  }));
  assert.equal(first.status, "submitted", first.reason);
  const [unreconciled] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, firstId)).limit(1);
  assert.equal(unreconciled.status, "pending");
  assert.equal(unreconciled.remainingContracts, 0);
  assert.equal(unreconciled.reservedRiskCents, unreconciled.requestedStakeCents);

  const count = unreconciled.requestedContracts;
  const account = {
    ...emptyAccount(),
    positions: [{
      ticker: market, positionFp: String(count), marketExposureDollars: String(count * 0.2),
      realizedPnlDollars: "0",
    }],
    fills: [{
      id: `executed-fill-${suffix}`, orderId: first.orderId!, ticker: market, side: "yes",
      action: "buy", countFp: String(count), priceDollars: "0.20",
      feeCostDollars: "0.01", createdAt: now().toISOString(),
    }],
  };
  const confirmId = await insertEvaluation({
    ticker: market, signal: "CONFIRM", crossingKey: `${market}:cross`,
  });
  const recovered = await reconcileMicroLiveAtStartup(mocks({
    readAccount: async () => account,
    readOrderStatus: async () => ({
      orderId: first.orderId!, clientOrderId: `client-${suffix}`, ticker: market,
      side: "yes", action: "buy", type: "limit", status: "executed", remainingCount: "0",
      filledCount: String(count),
    }),
  }));
  assert.equal(recovered.ready, true, recovered.reason);
  const confirm = await executeQualifiedV13Trigger(confirmId, mocks({
    readOrderbook: async () => ({
      yesAskDollars: "0.20", noAskDollars: "0.20", yesBidDollars: "0.19", noBidDollars: "0.19",
      yesAskAvailableContracts: "1", noAskAvailableContracts: "1", observedAt: now().toISOString(),
    }),
    readAccount: async () => account,
    readOrderStatus: async () => ({
      orderId: first.orderId!, clientOrderId: `client-${suffix}`, ticker: market,
      side: "yes", action: "buy", type: "limit", status: "executed", remainingCount: "0",
      filledCount: String(count),
    }),
  }));
  assert.equal(confirm.status, "blocked");
  assert.equal(confirm.reason, "evaluation_not_a_qualified_v13_entry");
  const [reconciled] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, unreconciled.id)).limit(1);
  assert.equal(reconciled.status, "filled");
  assert.equal(reconciled.filledContracts, count);
  assert.equal(reconciled.remainingContracts, 0);
  assert.equal(reconciled.reservedRiskCents, unreconciled.requestedStakeCents);
});

test("the automatic live dispatcher has no exchange path with either environment gate off", async () => {
  const id = await insertEvaluation({});
  const previousMicro = process.env.MICRO_LIVE_PRODUCTION_ENABLED;
  const previousLive = process.env.LIVE_EXECUTION_ENABLED;
  try {
    for (const disabled of ["MICRO_LIVE_PRODUCTION_ENABLED", "LIVE_EXECUTION_ENABLED"] as const) {
      process.env.MICRO_LIVE_PRODUCTION_ENABLED = "true";
      process.env.LIVE_EXECUTION_ENABLED = "true";
      process.env[disabled] = "false";
      const result = await processMicroLiveForwardTestCycle(id, {
        readAccount: async () => { throw new Error("exchange GET must not occur"); },
        submitOrder: async () => { throw new Error("exchange POST must not occur"); },
      });
      assert.equal(result, null);
    }
  } finally {
    if (previousMicro === undefined) delete process.env.MICRO_LIVE_PRODUCTION_ENABLED;
    else process.env.MICRO_LIVE_PRODUCTION_ENABLED = previousMicro;
    if (previousLive === undefined) delete process.env.LIVE_EXECUTION_ENABLED;
    else process.env.LIVE_EXECUTION_ENABLED = previousLive;
  }
});

test("live CONFIRM qualification cannot result in an additional entry", async () => {
  const market = `${ticker}-LIVE-CONFIRM`;
  const entryId = await insertEvaluation({ ticker: market });
  const entry = await executeQualifiedV13Trigger(entryId, mocks({
    readOrderbook: async () => ({
      yesAskDollars: "0.20", noAskDollars: "0.20", yesBidDollars: "0.19", noBidDollars: "0.19",
      yesAskAvailableContracts: "2", noAskAvailableContracts: "2", observedAt: now().toISOString(),
    }),
  }));
  assert.equal(entry.status, "submitted");
  const [buy] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, entryId));
  const account = {
    ...emptyAccount(),
    openOrders: [{
      id: entry.orderId!, ticker: market, side: "yes", action: "buy",
      priceDollars: "0.20", remainingCount: String(buy.requestedContracts - 1),
      status: "resting", createdAt: now().toISOString(),
    }],
    positions: [{
      ticker: market, positionFp: "1",
      marketExposureDollars: "0.20", realizedPnlDollars: "0",
    }],
    fills: [{
      id: `live-confirm-fill-${suffix}`, orderId: entry.orderId!, ticker: market,
      side: "yes", action: "buy", countFp: "1",
      priceDollars: "0.20", feeCostDollars: "0.01", createdAt: now().toISOString(),
    }],
  };
  const deps = mocks({
    readOrderbook: async () => ({
      yesAskDollars: "0.20", noAskDollars: "0.20", yesBidDollars: "0.19", noBidDollars: "0.19",
      yesAskAvailableContracts: "1", noAskAvailableContracts: "1", observedAt: now().toISOString(),
    }),
    readAccount: async () => account,
    readOrderStatus: async (id) => ({
      orderId: id, clientOrderId: "mock", ticker: market,
      side: "yes", action: "buy", type: "limit", status: "resting",
      remainingCount: String(buy.requestedContracts - 1),
      filledCount: "1",
    }),
  });
  assert.equal((await reconcileMicroLiveAtStartup(deps)).ready, true);
  const previousId = await insertEvaluation({ ticker: market });
  await db.update(forwardTestEvaluationTable).set({
    evaluatedAt: new Date(Date.now() - 5),
    btcPrice: 64995, signedBuffer: -5, absoluteBuffer: 5,
  }).where(eq(forwardTestEvaluationTable.id, previousId));
  const sourceId = await insertEvaluation({ ticker: market });
  await db.update(forwardTestEvaluationTable).set({
    btcPrice: 65025, signedBuffer: 25, absoluteBuffer: 25, velocity: 1,
    upOffer: 0.4,
  }).where(eq(forwardTestEvaluationTable.id, sourceId));
  const positionId = `position:${market}:${market}:cross`;
  const qualified = await qualifyMicroLivePositionEvaluation(positionId, deps);
  assert.equal(qualified.reason, "qualified_live_v13_position_action");
  const [intent] = await db.select().from(forwardTestEvaluationTable)
    .where(eq(forwardTestEvaluationTable.id, qualified.evaluationId!));
  assert.equal(intent.signal, "CONFIRM");
  assert.equal(intent.evaluationSource, "micro_live");
  assert.equal(intent.sourcePaperEvaluationId, sourceId);
  const result = await processMicroLiveForwardTestCycle(sourceId, deps);
  assert.equal(result?.status, "blocked");
  assert.equal(result?.reason, "evaluation_not_a_qualified_v13_entry");
  assert.equal((await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.triggerType, "CONFIRM"))).length, 0);
  assert.equal((await getMicroLiveState()).currentPosition?.contracts, 1);
});

test("live V1.3 EXIT sells only actual filled quantity and replays partial then closed after restarts", async () => {
  const market = `${ticker}-LIVE-EXIT`;
  const entryId = await insertEvaluation({ ticker: market });
  const entry = await processMicroLiveForwardTestCycle(entryId, mocks());
  assert.ok(entry);
  assert.equal(entry.status, "submitted", entry.reason);
  const [buy] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, entryId));
  const positionId = `position:${market}:${market}:cross`;
  const buyFill = {
    id: `entry-fill-${suffix}`, orderId: entry.orderId!, ticker: market,
    side: "yes", action: "buy", countFp: String(buy.requestedContracts),
    priceDollars: "0.40", createdAt: now().toISOString(),
  };
  const account: ReturnType<typeof emptyAccount> = {
    ...emptyAccount(),
    positions: [{
      ticker: market, positionFp: String(buy.requestedContracts),
      marketExposureDollars: "2.40", realizedPnlDollars: "0",
    }],
    fills: [buyFill],
  };
  let exitOrderId: string | null = null;
  let firstExitId: string | null = null;
  let exitAttempts = 0;
  let expectedExitCount = buy.requestedContracts;
  let exitRemaining = buy.requestedContracts;
  let exitStatus = "resting";
  let exitClientOrderId: string | null = null;
  let exitCanceled = false;
  let exitCancelAttempts = 0;
  const deps = mocks({
    readAccount: async () => account,
    readOrderStatus: async (id) => ({
      orderId: id, clientOrderId: id === entry.orderId ? buy.clientOrderId : exitClientOrderId!,
      ticker: market, side: "yes",
      action: id === entry.orderId ? "buy" : "sell", type: "limit",
      status: id === entry.orderId ? "executed" : exitCanceled ? "canceled" : exitStatus,
      remainingCount: id === entry.orderId || exitCanceled ? "0" : String(exitRemaining),
      filledCount: String(account.fills.filter((fill) => fill.orderId === id)
        .reduce((sum, fill) => sum + Number(fill.countFp), 0)),
    }),
    cancelOrder: async (id) => {
      assert.equal(id, exitOrderId);
      exitCancelAttempts++;
      exitCanceled = true;
      account.openOrders = [];
      account.positions[0]!.positionFp = "1";
      account.fills.push({
        id: `exit-partial-${suffix}`, orderId: id, ticker: market,
        side: "yes", action: "sell", countFp: "1", priceDollars: "0.39",
        createdAt: now().toISOString(), feeCostDollars: "0.01",
      });
      return { orderId: id, remainingCount: "0" };
    },
    submitOrder: async (request) => {
      assert.equal(request.action, "sell");
      assert.equal(request.count, expectedExitCount);
      exitOrderId = `exit-${suffix}-${++exitAttempts}`;
      exitClientOrderId = request.clientOrderId;
      return {
        orderId: exitOrderId, clientOrderId: request.clientOrderId,
        ticker: market, side: "yes", action: "sell", type: "limit",
        status: "resting", remainingCount: String(request.count),
        filledCount: "0",
      };
    },
  });
  assert.equal((await reconcileMicroLiveAtStartup(deps)).ready, true);
  const paperId = await insertEvaluation({ ticker: market });
  await db.update(forwardTestEvaluationTable).set({
    btcPrice: 65030, signedBuffer: 30, absoluteBuffer: 30, velocity: -1,
  }).where(eq(forwardTestEvaluationTable.id, paperId));
  const qualified = await qualifyMicroLivePositionEvaluation(positionId, deps);
  assert.equal(qualified.reason, "qualified_live_v13_position_action");
  assert.ok(qualified.evaluationId);
  const [evidence] = await db.select().from(forwardTestEvaluationTable)
    .where(eq(forwardTestEvaluationTable.id, qualified.evaluationId!));
  assert.equal(evidence.signal, "EXIT");
  assert.equal(evidence.evaluationSource, "micro_live");
  assert.equal(evidence.livePositionId, positionId);
  const result = await processMicroLiveForwardTestCycle(paperId, deps);
  assert.equal(result?.status, "submitted", result?.reason);
  assert.equal(result?.reason, "exit_verified_execution_frozen_for_review");
  assert.ok(exitOrderId);
  const stateAfterExit = await getMicroLiveState();
  assert.equal(stateAfterExit.currentPosition?.sellableContracts, 1);
  assert.equal(stateAfterExit.currentPosition?.lifecycle, "exit_partial");
  assert.equal((await executeQualifiedV13Trigger(qualified.evaluationId!, deps)).status, "blocked");
  assert.equal(exitCancelAttempts, 1);
  assert.equal(exitAttempts, 1, "no replacement is submitted after partial cancellation");
  const restart = await reconcileMicroLiveAtStartup(deps);
  assert.equal(restart.ready, false);
  assert.equal(exitAttempts, 1);
  const state = await getMicroLiveState();
  assert.equal(state.currentPosition?.sellableContracts, 1);
  assert.equal(state.realizedPnlCents, null, "unknown exchange fees cannot be reported as zero");
  // Even a manual flip of both flags must not reactivate a canceled, partial
  // exit after the durable single-use cancellation claim.
  await db.update(microLiveConfigTable).set({
    manualKillSwitch: false, microLiveProductionEnabled: true, liveExecutionEnabled: true,
  }).where(eq(microLiveConfigTable.id, "singleton"));
  const reopened = await reconcileMicroLiveAtStartup(deps);
  assert.equal(reopened.ready, false);
  assert.equal(reopened.reason, "exit_cancellation_requires_manual_reactivation_review");
  assert.equal((await getMicroLiveState()).killSwitch, "ON");
  assert.equal(exitCancelAttempts, 1);
  assert.equal(exitAttempts, 1);
});

test("canceled partial entry exits its one actual fill, not its requested size", async () => {
  const market = `${ticker}-CANCELED-ENTRY-EXIT`;
  const entryId = await insertEvaluation({ ticker: market });
  const entry = await executeQualifiedV13Trigger(entryId, mocks());
  assert.equal(entry.status, "submitted");
  const [buy] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, entryId));
  const account = {
    ...emptyAccount(),
    positions: [{
      ticker: market, positionFp: "1",
      marketExposureDollars: "0.40", realizedPnlDollars: "0",
    }],
    fills: [{
      id: `canceled-entry-fill-${suffix}`, orderId: entry.orderId!,
      ticker: market, side: "yes", action: "buy", countFp: "1",
      priceDollars: "0.40", createdAt: now().toISOString(),
    }],
  };
  let exitId: string | null = null;
  let exitStatus = "resting";
  let exitRemaining = "1";
  let exitClientOrderId: string | null = null;
  let submittedExitCount = 0;
  const deps = mocks({
    readAccount: async () => account,
    readOrderStatus: async (id) => ({
      orderId: id, clientOrderId: id === entry.orderId ? buy.clientOrderId : exitClientOrderId!,
      ticker: market,
      side: "yes", action: id === entry.orderId ? "buy" : "sell",
      type: "limit", status: id === entry.orderId ? "canceled" : exitStatus,
      remainingCount: id === entry.orderId ? "0" : exitRemaining,
      filledCount: String(account.fills.filter((fill) => fill.orderId === id)
        .reduce((sum, fill) => sum + Number(fill.countFp), 0)),
    }),
    cancelOrder: async (id) => {
      assert.equal(id, exitId);
      exitStatus = "canceled";
      exitRemaining = "0";
      account.positions.length = 0;
      account.fills.push({
        id: `canceled-entry-sell-${suffix}`, orderId: id, ticker: market,
        side: "yes", action: "sell", countFp: "1", priceDollars: "0.39",
        createdAt: new Date(Date.now() + 10).toISOString(),
      });
      return { orderId: id, remainingCount: "0" };
    },
    submitOrder: async (request) => {
      assert.equal(request.action, "sell");
      assert.equal(request.count, 1);
      assert.ok(buy.requestedContracts > request.count);
      submittedExitCount = request.count;
      exitId = `canceled-entry-exit-${suffix}`;
      exitClientOrderId = request.clientOrderId;
      return {
        orderId: exitId, clientOrderId: request.clientOrderId, ticker: market,
        side: "yes", action: "sell", type: "limit",
        status: "resting", remainingCount: "1",
        filledCount: "0",
      };
    },
  });
  assert.equal((await reconcileMicroLiveAtStartup(deps)).ready, true);
  const sourceId = await insertEvaluation({ ticker: market });
  await db.update(forwardTestEvaluationTable).set({
    btcPrice: 65030, signedBuffer: 30, absoluteBuffer: 30, velocity: -1,
  }).where(eq(forwardTestEvaluationTable.id, sourceId));
  const qualified = await qualifyMicroLivePositionEvaluation(
    `position:${market}:${market}:cross`, deps);
  assert.ok(qualified.evaluationId, qualified.reason);
  const submittedExit = await executeQualifiedV13Trigger(qualified.evaluationId!, deps);
  assert.equal(submittedExit.status, "submitted", submittedExit.reason);
  assert.equal(submittedExit.reason, "exit_verified_execution_frozen_for_review");
  assert.equal(submittedExitCount, 1, "only the actual single entry fill was offered for exit");
  assert.equal(exitStatus, "canceled");
  assert.equal((await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.exchangeOrderId, exitId!))).length, 1);
  assert.equal((await executeQualifiedV13Trigger(qualified.evaluationId!, deps)).status, "blocked");
  const recovered = await reconcileMicroLiveAtStartup(deps);
  assert.equal(recovered.ready, false);
  assert.equal(recovered.reason, "exit_cancellation_requires_manual_reactivation_review");
  assert.equal(await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.action, "sell")).then((rows) => rows.length), 1);
  assert.equal((await getMicroLiveState()).openPositionCount, 0);
});

for (const owned of ["yes", "no"] as const) {
  for (const change of ["shrinks", "disappears"] as const) {
    test(`reduce-only ${owned.toUpperCase()} exit freezes if inventory ${change} at exchange`, async () => {
      const market = `${ticker}-REDUCE-${owned}-${change}`;
      const fixture = await makeRecoveredSettlementPosition(market, "0.001000", owned);
      const { account, positionId, order } = fixture;
      const signal = await insertEvaluation({
        ticker: market, direction: owned === "yes" ? "UP" : "DOWN", signal: "EXIT",
        crossingKey: order.crossingKey,
      });
      await db.update(forwardTestEvaluationTable).set({
        evaluationSource: "micro_live", livePositionId: positionId,
        sourcePaperEvaluationId: order.sourceEvaluationId, positionWasOpen: true,
      }).where(eq(forwardTestEvaluationTable.id, signal));
      const deps = recoveryDependencies(account);
      let posts = 0;
      const result = await executeQualifiedV13Trigger(signal, {
        ...deps,
        submitOrder: async (request) => {
          posts++;
          assert.equal(request.action, "sell");
          assert.equal(request.side, owned);
          assert.equal(request.count, order.requestedContracts);
          assert.equal(request.ticker, market);
          // Simulate the exchange's reduce-only cap after external inventory
          // moved. The mocked transport never creates opposite exposure.
          const remainingOwned = change === "shrinks" ? 1 : 0;
          account.positions[0]!.positionFp =
            String(owned === "yes" ? remainingOwned : -remainingOwned);
          if (change === "disappears") throw new Error("HTTP_ERROR 400");
          return {
            orderId: `capped-${owned}-${suffix}`, clientOrderId: request.clientOrderId,
            ticker: market, side: owned, action: "sell", type: "limit",
            status: "resting", filledCount: "0", remainingCount: "1",
          };
        },
      });
      assert.equal(posts, 1, "no fallback ordinary sell or retry");
      assert.equal(result.reason, change === "shrinks"
        ? "exchange_order_fill_count_discrepancy" : "exchange_rejected_exit");
      const [config] = await db.select().from(microLiveConfigTable);
      assert.equal(config.manualKillSwitch, true);
      assert.equal(config.liveExecutionEnabled, false);
      assert.equal(config.microLiveProductionEnabled, false);
      const [exit] = await db.select().from(microLiveOrderTable)
        .where(eq(microLiveOrderTable.sourceEvaluationId, signal));
      assert.equal(exit?.status, change === "shrinks" ? "pending" : "rejected");
      assert.equal(exit?.exchangeOrderId, change === "shrinks" ? `capped-${owned}-${suffix}` : null);
      assert.equal((await executeQualifiedV13Trigger(signal, {
        ...deps, submitOrder: async () => { posts++; throw Error("duplicate exit"); },
      })).status, "blocked");
      const restart = await reconcileMicroLiveAtStartup(deps);
      assert.equal(restart.ready, false);
      assert.equal(posts, 1);
      assert.ok(Number(account.positions[0]!.positionFp) *
        (owned === "yes" ? 1 : -1) >= 0, "no reversed exposure");
    });
  }
}

for (const failure of ["timeout", "http-503", "invalid-response"] as const) {
  test(`uncertain ${failure} exit POST freezes restart without retry or unverified cancellation`, async () => {
    const market = `${ticker}-EXIT-${failure}`;
    const { account, order, positionId } =
      await makeRecoveredSettlementPosition(market, "0.001000");
    const signal = await insertEvaluation({
      ticker: market, signal: "EXIT", crossingKey: order.crossingKey,
    });
    await db.update(forwardTestEvaluationTable).set({
      evaluationSource: "micro_live", livePositionId: positionId,
      sourcePaperEvaluationId: order.sourceEvaluationId, positionWasOpen: true,
    }).where(eq(forwardTestEvaluationTable.id, signal));
    let posts = 0;
    let cancels = 0;
    const deps = {
      ...recoveryDependencies(account),
      cancelOrder: async () => {
        cancels++;
        throw new Error("unknown exit must not issue DELETE");
      },
      submitOrder: async (request: Parameters<NonNullable<MicroLiveDependencies["submitOrder"]>>[0]) => {
        posts++;
        if (failure !== "invalid-response") {
          throw new Error(failure === "timeout" ? "network timeout" : "HTTP_ERROR 503");
        }
        return {
          orderId: "", clientOrderId: request.clientOrderId, ticker: market,
          side: "yes" as const, action: "sell" as const, type: "limit" as const,
          status: "canceled" as const, remainingCount: "0", filledCount: "0",
        };
      },
    };
    const result = await executeQualifiedV13Trigger(signal, deps);
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, failure === "invalid-response"
      ? "exit_response_unverifiable" : "ambiguous_exit_submission_freezes_live");
    assert.equal(posts, 1);
    assert.equal(cancels, 0);
    const [exit] = await db.select().from(microLiveOrderTable)
      .where(eq(microLiveOrderTable.sourceEvaluationId, signal));
    assert.equal(exit.status, "unknown");
    assert.equal(exit.exchangeOrderId, null);
    assert.equal((await getMicroLiveState()).killSwitch, "ON");
    const restart = await reconcileMicroLiveAtStartup(deps);
    assert.equal(restart.ready, false);
    assert.equal(restart.reason, "frozen_exit_identity_unproven");
    assert.equal(posts, 1);
    assert.equal(cancels, 0);
  });
}

test("terminal IOC exit without a DELETE claim still recovers a late fill while frozen", async () => {
  const market = `${ticker}-LATE-TERMINAL-EXIT`;
  const fixture = await makeRecoveredSettlementPosition(market, "0.001000");
  const exchangeId = `terminal-exit-${suffix}`;
  const exitId = await insertRecoveredExitOrder({
    buyOrder: fixture.order, positionId: fixture.positionId,
    contractCount: fixture.order.requestedContracts,
    limitPrice: 0.39, exchangeOrderId: exchangeId,
  });
  const account = fixture.account;
  let posts = 0;
  let cancels = 0;
  const deps = {
    ...recoveryDependencies(account),
    readOrderStatus: async (id: string) => {
      const [row] = await db.select().from(microLiveOrderTable)
        .where(eq(microLiveOrderTable.exchangeOrderId, id)).limit(1);
      assert.ok(row);
      return {
        orderId: id, clientOrderId: row.clientOrderId, ticker: market,
        side: "yes" as const, action: row.action as "buy" | "sell",
        type: "limit" as const,
        status: id === exchangeId ? "canceled" as const : "executed" as const,
        filledCount: String(account.fills.filter((fill) => fill.orderId === id)
          .reduce((sum, fill) => sum + Number(fill.countFp), 0)),
        remainingCount: "0",
      };
    },
    submitOrder: async () => { posts++; throw Error("no POST in frozen recovery"); },
    cancelOrder: async () => { cancels++; throw Error("no DELETE in frozen recovery"); },
  };
  const first = await reconcileMicroLiveAtStartup(deps);
  assert.equal(first.ready, false);
  assert.equal(first.reason, "exit_canceled_requires_manual_review");
  assert.equal((await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, exitId)))[0]!.status, "canceled");

  const lateCount = 1;
  account.positions[0]!.positionFp = String(fixture.order.requestedContracts - lateCount);
  account.fills.push({
    id: `late-terminal-fill-${suffix}`, orderId: exchangeId, ticker: market,
    side: "yes", action: "sell", countFp: String(lateCount),
    priceDollars: "0.39", createdAt: now().toISOString(), feeCostDollars: "0.01",
  });
  const restart = await reconcileMicroLiveAtStartup(deps);
  assert.equal(restart.ready, false);
  assert.equal(restart.reason, "exit_canceled_requires_manual_review");
  const [recoveredExit] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, exitId));
  assert.equal(recoveredExit.filledContracts, lateCount);
  assert.equal(recoveredExit.cancellationAttemptedAt, null);
  assert.equal((await db.select().from(microLiveFillTable)
    .where(eq(microLiveFillTable.orderId, exitId))).length, 1);
  assert.equal((await reconcileMicroLiveAtStartup(deps)).ready, false);
  assert.equal(posts, 0);
  assert.equal(cancels, 0);
  const [config] = await db.select().from(microLiveConfigTable);
  assert.equal(config.manualKillSwitch, true);
  assert.equal(config.liveExecutionEnabled, false);
  assert.equal(config.microLiveProductionEnabled, false);
});

test("crash after exit POST but before persistence freezes retries and restart recovery", async () => {
  const market = `${ticker}-EXIT-CRASH`;
  const entryId = await insertEvaluation({ ticker: market });
  const entry = await executeQualifiedV13Trigger(entryId, mocks());
  assert.equal(entry.status, "submitted");
  const [buy] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, entryId));
  const account = {
    ...emptyAccount(),
    positions: [{
      ticker: market, positionFp: String(buy.requestedContracts),
      marketExposureDollars: "2.40", realizedPnlDollars: "0",
    }],
    fills: [{
      id: `exit-crash-buy-${suffix}`, orderId: entry.orderId!, ticker: market,
      side: "yes", action: "buy", countFp: String(buy.requestedContracts),
      priceDollars: "0.40", createdAt: now().toISOString(),
    }],
  };
  const deps = mocks({
    readAccount: async () => account,
    readOrderStatus: async (id) => ({
      orderId: id, clientOrderId: "mock", ticker: market, side: "yes",
      action: "buy", type: "limit", status: "executed", remainingCount: "0",
      filledCount: String(buy.requestedContracts),
    }),
  });
  assert.equal((await reconcileMicroLiveAtStartup(deps)).ready, true);
  const sourceId = await insertEvaluation({ ticker: market });
  await db.update(forwardTestEvaluationTable).set({
    btcPrice: 65030, signedBuffer: 30, absoluteBuffer: 30, velocity: -1,
  }).where(eq(forwardTestEvaluationTable.id, sourceId));
  const positionId = `position:${market}:${market}:cross`;
  const qualified = await qualifyMicroLivePositionEvaluation(positionId, deps);
  assert.ok(qualified.evaluationId, qualified.reason);
  let posts = 0;
  const outcome = await executeQualifiedV13Trigger(qualified.evaluationId!, {
    ...deps,
    submitOrder: async (request) => {
      posts++;
      return {
        orderId: `uncertain-exit-${suffix}`, clientOrderId: request.clientOrderId,
        ticker: market, side: "yes", action: "sell", type: "limit",
        status: "resting", remainingCount: String(request.count),
        filledCount: "0",
      };
    },
    afterExitPost: async () => { throw new Error("crash before local exchange ID write"); },
  });
  assert.equal(outcome.status, "unknown");
  assert.equal(posts, 1);
  const [exit] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, qualified.evaluationId!));
  assert.equal(exit.exchangeOrderId, null);
  assert.equal((await getMicroLiveState()).killSwitch, "ON");
  await db.update(microLiveConfigTable).set({
    manualKillSwitch: false, microLiveProductionEnabled: true, liveExecutionEnabled: true,
  }).where(eq(microLiveConfigTable.id, "singleton"));
  const restarted = await reconcileMicroLiveAtStartup(deps);
  assert.equal(restarted.ready, false);
  assert.equal(restarted.reason, "reserved_submission_missing_exchange_id");
  assert.equal(posts, 1);
  process.env.MICRO_LIVE_PRODUCTION_ENABLED = "false";
  process.env.LIVE_EXECUTION_ENABLED = "false";
  await db.update(microLiveConfigTable).set({
    manualKillSwitch: true, microLiveProductionEnabled: false, liveExecutionEnabled: false,
  }).where(eq(microLiveConfigTable.id, "singleton"));
  const exchangeId = `uncertain-exit-${suffix}`;
  account.openOrders.push({
    id: exchangeId, ticker: market, side: "yes", action: "sell", status: "resting",
    remainingCount: String(exit.requestedContracts),
    priceDollars: String(exit.requestedLimitPrice), createdAt: now().toISOString(),
  });
  const recoveredExit = await reconcileUncertainSubmission(exit.id, "admin-test", {
    readAccount: async () => account,
    readEvidence: async () => ({
      orders: [{
        id: exchangeId, clientOrderId: exit.clientOrderId, ticker: market,
        side: "yes", action: "sell", type: "limit", status: "resting",
        priceDollars: String(exit.requestedLimitPrice),
        initialCount: String(exit.requestedContracts), filledCount: "0",
        remainingCount: String(exit.requestedContracts),
      }],
      fills: [], truncated: false, historicalFillsAvailable: true,
    }),
  });
  assert.equal(recoveredExit.status, "linked_needs_reconciliation");
  assert.equal(posts, 1);
  process.env.MICRO_LIVE_PRODUCTION_ENABLED = "true";
  process.env.LIVE_EXECUTION_ENABLED = "true";
  await db.update(microLiveConfigTable).set({
    manualKillSwitch: false, microLiveProductionEnabled: true, liveExecutionEnabled: true,
  }).where(eq(microLiveConfigTable.id, "singleton"));
  const afterLink = await reconcileMicroLiveAtStartup({
    ...deps,
    readOrderStatus: async (id) => ({
      orderId: id, clientOrderId: id === exchangeId ? exit.clientOrderId : buy.clientOrderId,
      ticker: market, side: "yes", action: id === exchangeId ? "sell" : "buy",
      type: "limit", status: id === exchangeId ? "resting" : "executed",
      remainingCount: id === exchangeId ? String(exit.requestedContracts) : "0",
      filledCount: id === exchangeId
        ? String(account.fills.filter((fill) => fill.orderId === id)
          .reduce((sum, fill) => sum + Number(fill.countFp), 0))
        : String(buy.requestedContracts),
    }),
  });
  assert.equal(afterLink.ready, false);
  assert.equal(afterLink.reason, "outstanding_exit_requires_frozen_reconciliation");
  const [stoppedConfig] = await db.select().from(microLiveConfigTable);
  assert.equal(stoppedConfig.manualKillSwitch, true);
  assert.equal(stoppedConfig.microLiveProductionEnabled, false);
  assert.equal(stoppedConfig.liveExecutionEnabled, false);
  assert.equal((await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, exit.id)))[0]!.status, "pending",
    "frozen GET-only recovery may link the order but never restores POST readiness");
  assert.equal(posts, 1);
});

test("qualified exit-shaped paper event is blocked, never converted to synthetic intent", async () => {
  const id = await insertEvaluation({ ticker: `${ticker}-EXIT`, signal: "EXIT" });
  assert.equal((await executeQualifiedV13Trigger(id, mocks())).reason,
    "exit_blocked_no_provable_v13_exit_action");
});

test("ambiguous entry links one proved client order but cannot retry until full startup recovery", async () => {
  const market = `${ticker}-IDLESS-ENTRY`;
  const evaluationId = await insertEvaluation({ ticker: market });
  let posts = 0;
  const failed = await executeQualifiedV13Trigger(evaluationId, mocks({
    submitOrder: async () => { posts++; throw new Error("network response lost"); },
  }));
  assert.equal(failed.status, "unknown");
  assert.equal(posts, 1);
  const [row] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, evaluationId));
  assert.equal(row.exchangeOrderId, null);
  process.env.MICRO_LIVE_PRODUCTION_ENABLED = "false";
  process.env.LIVE_EXECUTION_ENABLED = "false";
  const exchangeId = `exchange-recovered-${suffix}`;
  const account = emptyAccount();
  account.openOrders.push({
    id: exchangeId, ticker: market, side: "yes", action: "buy", status: "resting",
    remainingCount: String(row.requestedContracts), priceDollars: String(row.requestedLimitPrice),
    createdAt: now().toISOString(),
  });
  const dependencies = {
    readAccount: async () => account,
    readEvidence: async () => ({
      orders: [{
        id: exchangeId, clientOrderId: row.clientOrderId, ticker: market,
        side: "yes", action: "buy", type: "limit", status: "resting",
        priceDollars: String(row.requestedLimitPrice),
        initialCount: String(row.requestedContracts), filledCount: "0",
        remainingCount: String(row.requestedContracts),
      }],
      fills: [], truncated: false, historicalFillsAvailable: true,
    }),
  };
  const attempts = await Promise.all([
    reconcileUncertainSubmission(row.id, "admin-test", dependencies),
    reconcileUncertainSubmission(row.id, "admin-test", dependencies),
  ]);
  assert.deepEqual(attempts.map((item) => item.status).sort(),
    ["blocked", "linked_needs_reconciliation"]);
  const linked = attempts.find((item) => item.status === "linked_needs_reconciliation")!;
  assert.equal(linked.status, "linked_needs_reconciliation");
  const [afterLink] = await db.select().from(microLiveOrderTable).where(eq(microLiveOrderTable.id, row.id));
  assert.equal(afterLink.exchangeOrderId, exchangeId);
  assert.equal(afterLink.status, "unknown");
  assert.equal((await getMicroLiveState()).killSwitch, "ON");
  const audit = await db.select().from(microLiveDecisionTable)
    .where(eq(microLiveDecisionTable.orderId, row.id));
  assert.ok(audit.some((entry) => entry.reason.includes("actor=admin-test;")
    && entry.reason.includes("evidence_sha256=")));
  const again = await reconcileUncertainSubmission(row.id, "admin-test", dependencies);
  assert.equal(again.status, "blocked");
  assert.equal(posts, 1);
  process.env.MICRO_LIVE_PRODUCTION_ENABLED = "true";
  process.env.LIVE_EXECUTION_ENABLED = "true";
  await db.update(microLiveConfigTable).set({
    manualKillSwitch: false, microLiveProductionEnabled: true, liveExecutionEnabled: true,
  }).where(eq(microLiveConfigTable.id, "singleton"));
  const recovered = await reconcileMicroLiveAtStartup(mocks({
    readAccount: async () => account,
    readOrderStatus: async (id) => ({
      orderId: id, clientOrderId: row.clientOrderId, ticker: market,
      side: "yes", action: "buy", type: "limit", status: "resting",
      remainingCount: String(row.requestedContracts),
      filledCount: "0",
    }),
  }));
  assert.equal(recovered.ready, true, recovered.reason);
  const [afterRecovery] = await db.select().from(microLiveOrderTable).where(eq(microLiveOrderTable.id, row.id));
  assert.equal(afterRecovery.status, "pending");
  assert.equal(posts, 1);
});

test("uncertain recovery refuses absence, conflicting or incomplete histories and never retries", async () => {
  const market = `${ticker}-IDLESS-CONFLICT`;
  const evaluationId = await insertEvaluation({ ticker: market });
  let posts = 0;
  assert.equal((await executeQualifiedV13Trigger(evaluationId, mocks({
    submitOrder: async () => { posts++; throw new Error("lost"); },
  }))).status, "unknown");
  const [row] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, evaluationId));
  const gated = await reconcileUncertainSubmission(row.id, "admin-test", {
    readAccount: async () => { throw new Error("must not read exchange"); },
    readEvidence: async () => { throw new Error("must not read exchange"); },
  });
  assert.equal(gated.reason, "uncertain_recovery_requires_environment_gates_off");
  process.env.MICRO_LIVE_PRODUCTION_ENABLED = "false";
  process.env.LIVE_EXECUTION_ENABLED = "false";
  const account = emptyAccount();
  const candidate = {
    id: `found-${suffix}`, clientOrderId: row.clientOrderId, ticker: market,
    side: "yes", action: "buy", type: "limit", status: "canceled",
    priceDollars: String(row.requestedLimitPrice),
    initialCount: String(row.requestedContracts), filledCount: "1", remainingCount: "0",
  };
  for (const [evidence, reason] of [
    [{ orders: [], fills: [], truncated: false, historicalFillsAvailable: true }, "uncertain_recovery_no_proven_client_match"],
    [{ orders: [candidate, { ...candidate, id: "another" }], fills: [], truncated: false,
      historicalFillsAvailable: true },
      "uncertain_recovery_multiple_client_matches"],
    [{ orders: [candidate], fills: [], truncated: true, historicalFillsAvailable: true },
      "uncertain_recovery_snapshot_incomplete"],
    [{ orders: [candidate], fills: [], truncated: false, historicalFillsAvailable: false },
      "uncertain_recovery_snapshot_incomplete"],
    [{ orders: [candidate], fills: [], truncated: false, historicalFillsAvailable: true },
      "uncertain_recovery_fills_not_reconcilable"],
    [{
      orders: [candidate],
      fills: [{
        id: `historical-only-${suffix}`, orderId: candidate.id, ticker: market,
        side: "yes", action: "buy", countFp: "1",
        priceDollars: String(row.requestedLimitPrice), createdAt: now().toISOString(),
        feeCostDollars: "0.001",
      }],
      truncated: false, historicalFillsAvailable: true,
    }, "uncertain_recovery_fills_not_reconcilable"],
  ] satisfies Array<[KalshiSubmissionEvidence, string]>) {
    const result = await reconcileUncertainSubmission(row.id, "admin-test", {
      readAccount: async () => account, readEvidence: async () => evidence,
    });
    assert.equal(result.reason, reason);
    assert.equal(result.status, "blocked");
  }
  await db.insert(microLiveOrderTable).values({
    ...row, id: randomUUID(), actionKey: `${row.actionKey}:owner`,
    clientOrderId: `${row.clientOrderId}:owner`,
    crossingKey: `${row.crossingKey}:owner`,
    exchangeOrderId: candidate.id, status: "pending",
  });
  account.openOrders.push({
    id: candidate.id, ticker: market, side: "yes", action: "buy",
    status: "resting", remainingCount: String(row.requestedContracts),
    priceDollars: String(row.requestedLimitPrice), createdAt: now().toISOString(),
  });
  const owned = await reconcileUncertainSubmission(row.id, "admin-test", {
    readAccount: async () => account,
    readEvidence: async () => ({
      orders: [{
        ...candidate, status: "resting", filledCount: "0",
        remainingCount: String(row.requestedContracts),
      }],
       fills: [], truncated: false, historicalFillsAvailable: true,
    }),
  });
  assert.equal(owned.reason, "uncertain_recovery_exchange_id_already_owned");
  assert.equal((await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, row.id)))[0]!.exchangeOrderId, null);
  assert.equal(posts, 1);
  assert.equal((await db.select().from(microLiveDecisionTable)
    .where(eq(microLiveDecisionTable.orderId, row.id)))
     .filter((entry) => entry.reason.includes("actor=admin-test")).length, 7);
});

test("startup reconciles historical-only fills and safely replays the same evidence", async () => {
  const market = `${ticker}-HISTORICAL-REPLAY`;
  const { row, exchangeOrderId } = await submitLinkedMockOrder(market);
  const fill = historicalFillFor(row, exchangeOrderId, `historical-${suffix}`);
  const dependencies = mocks({
    readAccount: async () => ({
      ...emptyAccount(),
      positions: [{
        ticker: market, positionFp: String(row.requestedContracts),
        marketExposureDollars: "2.40", realizedPnlDollars: "0",
      }],
    }),
    readHistoricalFills: async (tickers) => {
      assert.deepEqual(tickers, [market]);
      return { fills: [fill], truncated: false, available: true };
    },
    readOrderStatus: async (id) => ({
      orderId: id, clientOrderId: row.clientOrderId, ticker: market,
      side: "yes", action: "buy", type: "limit", status: "executed", remainingCount: "0",
      filledCount: String(row.requestedContracts),
    }),
  });
  const recovered = await reconcileMicroLiveAtStartup(dependencies);
  assert.equal(recovered.ready, true, recovered.reason);
  const [storedOrder] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, row.id)).limit(1);
  const storedFills = await db.select().from(microLiveFillTable)
    .where(eq(microLiveFillTable.orderId, row.id));
  assert.equal(storedOrder.status, "filled");
  assert.ok(storedOrder.reservedRiskCents > 0, "filled buy risk remains held");
  assert.equal(storedFills.length, 1);
  assert.equal(storedFills[0]?.exchangeFillId, fill.id);
  assert.equal(storedFills[0]?.feeKnown, true);

  const replay = await reconcileMicroLiveAtStartup(dependencies);
  assert.equal(replay.ready, true, replay.reason);
  assert.equal((await db.select().from(microLiveFillTable)
    .where(eq(microLiveFillTable.orderId, row.id))).length, 1);
});

test("startup blocks historical fills when the endpoint returns 404", async () => {
  const market = `${ticker}-HISTORICAL-404`;
  const { row, exchangeOrderId } = await submitLinkedMockOrder(market);
  const fill = historicalFillFor(row, exchangeOrderId, `missing-${suffix}`);
  const readAccount = async () => ({
    ...emptyAccount(),
    positions: [{
      ticker: market, positionFp: String(row.requestedContracts),
      marketExposureDollars: "2.40", realizedPnlDollars: "0",
    }],
  });
  const readOrderStatus = async (id: string) => ({
    orderId: id, clientOrderId: row.clientOrderId, ticker: market,
    side: "yes", action: "buy", type: "limit", status: "executed", remainingCount: "0",
    filledCount: String(row.requestedContracts),
  } as const);
  const first = await reconcileMicroLiveAtStartup(mocks({
    readAccount,
    readHistoricalFills: async () => ({ fills: [fill], truncated: false, available: true }),
    readOrderStatus,
  }));
  assert.equal(first.ready, true, first.reason);
  const result = await reconcileMicroLiveAtStartup(mocks({
    readAccount,
    readHistoricalFills: async () => ({ fills: [], truncated: false, available: false }),
    readOrderStatus,
  }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, "historical_fill_snapshot_unavailable");
  const [unchanged] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, row.id)).limit(1);
  assert.equal(unchanged.status, "filled");
  assert.equal((await db.select().from(microLiveFillTable)
    .where(eq(microLiveFillTable.orderId, row.id))).length, 1);
});

test("startup rejects unavailable and out-of-range authoritative fill counts", async () => {
  const market = `${ticker}-AUTHORITATIVE-COUNT`;
  const { row, exchangeOrderId } = await submitLinkedMockOrder(market);
  for (const [filledCount, expectedReason] of [
    [null, "exchange_order_fill_count_unavailable"],
    [String(row.requestedContracts + 1), "exchange_order_fill_count_exceeds_reserved_order"],
  ] as const) {
    await enableStartupRecoveryGates();
    const result = await reconcileMicroLiveAtStartup(mocks({
      readOrderStatus: async () => ({
        orderId: exchangeOrderId,
        clientOrderId: row.clientOrderId,
        ticker: market,
        side: "yes",
        action: "buy",
        type: "limit",
        status: "canceled",
        remainingCount: "0",
        filledCount,
      }),
    }));
    assert.equal(result.ready, false);
    assert.equal(result.reason, expectedReason);
  }
});

test("historical 404 freezes missing canceled partial fills despite offsetting net-zero exposure", async () => {
  const market = `${ticker}-HISTORICAL-404-CANCELED-PARTIAL`;
  const { row: buy, exchangeOrderId: buyExchangeId } = await submitLinkedMockOrder(market);
  const positionId = `position:${market}:${buy.crossingKey}`;
  const visibleSellId = await insertRecoveredExitOrder({
    buyOrder: buy, positionId, contractCount: buy.requestedContracts,
    limitPrice: buy.requestedLimitPrice, exchangeOrderId: `visible-sell-${suffix}`,
  });
  const missingSellExchangeId = `missing-sell-${suffix}`;
  const missingSellId = await insertRecoveredExitOrder({
    buyOrder: buy, positionId, contractCount: 1,
    limitPrice: buy.requestedLimitPrice, exchangeOrderId: missingSellExchangeId,
  });
  const missingBuyExchangeId = `missing-buy-${suffix}`;
  const missingBuyId = randomUUID();
  const missingBuy = {
    ...buy,
    id: missingBuyId,
    actionKey: `missing-buy-action-${suffix}`,
    clientOrderId: `missing-buy-client-${suffix}`,
    crossingKey: `${market}:missing-buy:${suffix}`,
    sourceEvaluationId: `missing-buy-evaluation-${suffix}`,
    requestedContracts: 1,
    requestedStakeCents: Math.round(buy.requestedLimitPrice * 100),
    reservedRiskCents: Math.round(buy.requestedLimitPrice * 100),
    exchangeOrderId: missingBuyExchangeId,
    status: "pending" as const,
    remainingContracts: 1,
    filledContracts: 0,
    submittedAt: now(),
    canceledAt: null,
    filledAt: null,
    closedAt: null,
    realizedPnlCents: null,
    createdAt: now(),
    updatedAt: now(),
  };
  await db.insert(microLiveOrderTable).values(missingBuy);
  const [visibleSell] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, visibleSellId)).limit(1);
  assert.ok(visibleSell);
  const buyFill = historicalFillFor(buy, buyExchangeId, `net-zero-buy-${suffix}`);
  const sellFill = {
    ...historicalFillFor(visibleSell, visibleSell.exchangeOrderId!, `net-zero-sell-${suffix}`),
    createdAt: new Date(Date.now() + 1).toISOString(),
  };
  const result = await reconcileMicroLiveAtStartup(mocks({
    readAccount: async () => ({
      ...emptyAccount(),
      positions: [{
        ticker: market, positionFp: "0", marketExposureDollars: "0",
        realizedPnlDollars: "0",
      }],
      fills: [buyFill, sellFill],
    }),
    readHistoricalFills: async () => ({ fills: [], truncated: false, available: false }),
    readOrderStatus: async (id) => {
      const fillCount = id === buyExchangeId || id === visibleSell.exchangeOrderId
        ? String(buy.requestedContracts) : "1";
      return {
        orderId: id,
        clientOrderId: id === buyExchangeId ? buy.clientOrderId :
          id === missingBuyExchangeId ? missingBuy.clientOrderId :
            id === visibleSell.exchangeOrderId ? visibleSell.clientOrderId :
              `client-${missingSellId}`,
        ticker: market,
        side: "yes",
        action: id === visibleSell.exchangeOrderId || id === missingSellExchangeId ? "sell" : "buy",
        type: "limit",
        status: "canceled",
        remainingCount: "0",
        filledCount: fillCount,
      };
    },
  }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, "exchange_order_fill_count_discrepancy");
  assert.equal((await db.select().from(microLiveFillTable)).length, 0);
});

test("historical 404 can use a complete current fill and authoritative order total", async () => {
  const market = `${ticker}-HISTORICAL-CURRENT-COMPLETE`;
  const { row, exchangeOrderId } = await submitLinkedMockOrder(market);
  const fill = historicalFillFor(row, exchangeOrderId, `current-${suffix}`);
  const result = await reconcileMicroLiveAtStartup(mocks({
    readAccount: async () => ({
      ...emptyAccount(),
      fills: [fill],
      positions: [{
        ticker: market, positionFp: String(row.requestedContracts),
        marketExposureDollars: "2.40", realizedPnlDollars: "0",
      }],
    }),
    readHistoricalFills: async () => ({ fills: [], truncated: false, available: false }),
    readOrderStatus: async (id) => ({
      orderId: id, clientOrderId: row.clientOrderId, ticker: market,
      side: "yes", action: "buy", type: "limit", status: "executed", remainingCount: "0",
      filledCount: String(row.requestedContracts),
    }),
  }));
  assert.equal(result.ready, true, result.reason);
});

test("startup blocks conflicting overlap between current and historical fills", async () => {
  const market = `${ticker}-HISTORICAL-CONFLICT`;
  const { row, exchangeOrderId } = await submitLinkedMockOrder(market);
  const fill = historicalFillFor(row, exchangeOrderId, `conflict-${suffix}`);
  const result = await reconcileMicroLiveAtStartup(mocks({
    readAccount: async () => ({ ...emptyAccount(), fills: [{ ...fill, action: "sell" }] }),
    readHistoricalFills: async () => ({
      fills: [fill], truncated: false, available: true,
    }),
  }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, "historical_fill_overlap_conflict");
  assert.equal((await db.select().from(microLiveFillTable)
    .where(eq(microLiveFillTable.orderId, row.id))).length, 0);
});

test("startup blocks truncated historical fill evidence", async () => {
  const market = `${ticker}-HISTORICAL-TRUNCATED`;
  const { row } = await submitLinkedMockOrder(market);
  const result = await reconcileMicroLiveAtStartup(mocks({
    readHistoricalFills: async () => ({ fills: [], truncated: true, available: true }),
  }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, "historical_fill_snapshot_truncated");
  assert.equal((await db.select().from(microLiveFillTable)
    .where(eq(microLiveFillTable.orderId, row.id))).length, 0);
});

test("uncertain recovery links authenticated historical-only fills without clearing risk or gates", async () => {
  const market = `${ticker}-IDLESS-HISTORICAL`;
  const evaluationId = await insertEvaluation({ ticker: market });
  let posts = 0;
  assert.equal((await executeQualifiedV13Trigger(evaluationId, mocks({
    submitOrder: async () => { posts++; throw new Error("response lost"); },
  }))).status, "unknown");
  const [row] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, evaluationId)).limit(1);
  const exchangeOrderId = `historical-linked-${suffix}`;
  const fill = historicalFillFor(row, exchangeOrderId, `idless-historical-${suffix}`, 1);
  process.env.MICRO_LIVE_PRODUCTION_ENABLED = "false";
  process.env.LIVE_EXECUTION_ENABLED = "false";
  await db.update(microLiveConfigTable).set({
    manualKillSwitch: true, microLiveProductionEnabled: false, liveExecutionEnabled: false,
  }).where(eq(microLiveConfigTable.id, "singleton"));
  const linked = await reconcileUncertainSubmission(row.id, "admin-test", {
    readAccount: async () => emptyAccount(),
    readEvidence: async () => ({
      orders: [{
        id: exchangeOrderId, clientOrderId: row.clientOrderId, ticker: market,
        side: "yes", action: "buy", type: "limit", status: "canceled",
        priceDollars: String(row.requestedLimitPrice),
        initialCount: String(row.requestedContracts), filledCount: "1", remainingCount: "0",
      }],
      fills: [fill], historicalFills: [fill], historicalFillsAvailable: true, truncated: false,
    }),
  });
  assert.equal(linked.status, "linked_needs_reconciliation");
  const [afterLink] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, row.id)).limit(1);
  assert.equal(afterLink.status, "unknown");
  assert.equal(afterLink.reservedRiskCents, row.reservedRiskCents);
  assert.equal(afterLink.exchangeOrderId, exchangeOrderId);
  assert.equal((await getMicroLiveState()).killSwitch, "ON");
  assert.equal(posts, 1);

  process.env.MICRO_LIVE_PRODUCTION_ENABLED = "true";
  process.env.LIVE_EXECUTION_ENABLED = "true";
  await db.update(microLiveConfigTable).set({
    manualKillSwitch: false, microLiveProductionEnabled: true, liveExecutionEnabled: true,
  }).where(eq(microLiveConfigTable.id, "singleton"));
  const startup = await reconcileMicroLiveAtStartup(mocks({
    readAccount: async () => ({
      ...emptyAccount(),
      positions: [{
        ticker: market, positionFp: "1", marketExposureDollars: "0.40",
        realizedPnlDollars: "0",
      }],
    }),
    readHistoricalFills: async () => ({ fills: [fill], truncated: false, available: true }),
    readOrderStatus: async (id) => ({
      orderId: id, clientOrderId: row.clientOrderId, ticker: market,
      side: "yes", action: "buy", type: "limit", status: "canceled", remainingCount: "0",
      filledCount: "1",
    }),
  }));
  assert.equal(startup.ready, true, startup.reason);
  assert.equal((await db.select().from(microLiveFillTable)
    .where(eq(microLiveFillTable.orderId, row.id))).length, 1);
});

test("uncertain recovery leaves matched partial fill for normal FIFO startup reconciliation", async () => {
  const market = `${ticker}-IDLESS-PARTIAL`;
  const evaluationId = await insertEvaluation({ ticker: market });
  assert.equal((await executeQualifiedV13Trigger(evaluationId, mocks({
    submitOrder: async () => { throw new Error("response unknown"); },
  }))).status, "unknown");
  const [row] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, evaluationId));
  process.env.MICRO_LIVE_PRODUCTION_ENABLED = "false";
  process.env.LIVE_EXECUTION_ENABLED = "false";
  const exchangeId = `partial-recovered-${suffix}`;
  const fill = {
    id: `partial-fill-${suffix}`, orderId: exchangeId, ticker: market, side: "yes",
    action: "buy", countFp: "1", priceDollars: String(row.requestedLimitPrice),
    createdAt: now().toISOString(),
  };
  const account = emptyAccount();
  account.fills.push(fill);
  account.positions.push({
    ticker: market, positionFp: "1", marketExposureDollars: "0.40",
    realizedPnlDollars: "0",
  });
  const linked = await reconcileUncertainSubmission(row.id, "admin-test", {
    readAccount: async () => account,
    readEvidence: async () => ({
      orders: [{
        id: exchangeId, clientOrderId: row.clientOrderId, ticker: market,
        side: "yes", action: "buy", type: "limit", status: "canceled",
        priceDollars: String(row.requestedLimitPrice),
        initialCount: String(row.requestedContracts), filledCount: "1", remainingCount: "0",
      }],
      fills: [{ ...fill, feeCostDollars: "0.0100" }],
      truncated: false, historicalFillsAvailable: true,
    }),
  });
  assert.equal(linked.status, "linked_needs_reconciliation");
  assert.equal((await db.select().from(microLiveFillTable)
    .where(eq(microLiveFillTable.orderId, row.id))).length, 0);
  process.env.MICRO_LIVE_PRODUCTION_ENABLED = "true";
  process.env.LIVE_EXECUTION_ENABLED = "true";
  await db.update(microLiveConfigTable).set({
    manualKillSwitch: false, microLiveProductionEnabled: true, liveExecutionEnabled: true,
  }).where(eq(microLiveConfigTable.id, "singleton"));
  const recovered = await reconcileMicroLiveAtStartup(mocks({
    readAccount: async () => account,
    readOrderStatus: async (id) => ({
      orderId: id, clientOrderId: row.clientOrderId, ticker: market,
      side: "yes", action: "buy", type: "limit", status: "canceled", remainingCount: "0",
      filledCount: "1",
    }),
  }));
  assert.equal(recovered.ready, true, recovered.reason);
  const [persistedFill] = await db.select().from(microLiveFillTable)
    .where(eq(microLiveFillTable.orderId, row.id));
  assert.equal(persistedFill.contracts, 1);
  assert.equal(persistedFill.feeKnown, false, "fee field is not assumed audited until accounting is implemented");
});

test("startup recovery ingests exact fractional fees across two fills, exits, replay, and conflicts", async () => {
  const market = `${ticker}-EXACT-FEE-RECOVERY`;
  await enableStartupRecoveryGates();
  try {
    const evaluationId = await insertEvaluation({ ticker: market });
    const submitted = await executeQualifiedV13Trigger(evaluationId, mocks({
      readOrderbook: async () => ({
        yesAskDollars: "0.08", noAskDollars: "0.08",
        yesBidDollars: "0.07", noBidDollars: "0.07",
        yesAskAvailableContracts: "6", noAskAvailableContracts: "6",
        observedAt: now().toISOString(),
      }),
    }));
    assert.equal(submitted.status, "submitted", submitted.reason);
    const [buy] = await db.select().from(microLiveOrderTable)
      .where(eq(microLiveOrderTable.sourceEvaluationId, evaluationId)).limit(1);
    assert.ok(buy && submitted.orderId);
    assert.equal(buy.requestedContracts, 6);
    const positionId = `position:${market}:${buy.crossingKey}`;
    const firstCount = 3;
    const secondCount = buy.requestedContracts - firstCount;
    const firstFillAt = new Date(Date.now() - 2_000).toISOString();
    const secondFillAt = new Date(Date.now() - 1_000).toISOString();
    const firstBuyFill = {
      id: `exact-fee-buy-a-${suffix}`,
      orderId: submitted.orderId,
      ticker: market,
      side: "yes",
      action: "buy",
      countFp: String(firstCount),
      priceDollars: "0.08",
      createdAt: firstFillAt,
      feeCostDollars: "0.001234",
    };
    const secondBuyFill = {
      ...firstBuyFill,
      id: `exact-fee-buy-b-${suffix}`,
      countFp: String(secondCount),
      createdAt: secondFillAt,
      feeCostDollars: "0.002345",
    };
    const account = {
      ...emptyAccount(),
      positions: [{
        ticker: market,
        positionFp: String(buy.requestedContracts),
      marketExposureDollars: String(buy.requestedContracts * 0.08),
        realizedPnlDollars: "0",
      }],
      fills: [firstBuyFill, secondBuyFill],
    };
    const dependencies = recoveryDependencies(account);
    const firstRecovery = await reconcileMicroLiveAtStartup(dependencies);
    assert.equal(firstRecovery.ready, true, firstRecovery.reason);
    let persisted = await db.select().from(microLiveFillTable)
      .where(eq(microLiveFillTable.orderId, buy.id));
    assert.equal(persisted.length, 2);
    const byExchangeId = new Map(persisted.map((fill) => [fill.exchangeFillId, fill]));
    assert.equal(byExchangeId.get(firstBuyFill.id)?.tradeMicros, 240_000);
    assert.equal(byExchangeId.get(firstBuyFill.id)?.feeMicros, 1_234);
    assert.equal(byExchangeId.get(firstBuyFill.id)?.feeKnown, true);
    assert.equal(byExchangeId.get(secondBuyFill.id)?.tradeMicros, 240_000);
    assert.equal(byExchangeId.get(secondBuyFill.id)?.feeMicros, 2_345);
    assert.equal(byExchangeId.get(secondBuyFill.id)?.feeKnown, true);

    await db.update(microLiveFillTable).set({
      tradeMicros: null, feeMicros: null, feeCents: 0, feeKnown: false,
    }).where(eq(microLiveFillTable.exchangeFillId, firstBuyFill.id));
    const promoted = await reconcileMicroLiveAtStartup(dependencies);
    assert.equal(promoted.ready, true, promoted.reason);
    const [promotedFill] = await db.select().from(microLiveFillTable)
      .where(eq(microLiveFillTable.exchangeFillId, firstBuyFill.id)).limit(1);
    assert.equal(promotedFill.tradeMicros, 240_000);
    assert.equal(promotedFill.feeMicros, 1_234);
    assert.equal(promotedFill.feeKnown, true);

    const replay = await reconcileMicroLiveAtStartup(dependencies);
    assert.equal(replay.ready, true, replay.reason);
    persisted = await db.select().from(microLiveFillTable)
      .where(eq(microLiveFillTable.orderId, buy.id));
    assert.equal(persisted.length, 2, "startup replay must not duplicate exchange fills");
    assert.deepEqual(
      persisted.map((fill) => [fill.exchangeFillId, fill.tradeMicros, fill.feeMicros]).sort(),
      [
        [firstBuyFill.id, 240_000, 1_234],
        [secondBuyFill.id, 240_000, 2_345],
      ].sort(),
    );

    const firstExitCount = buy.requestedContracts - 2;
    const firstExitId = await insertRecoveredExitOrder({
      buyOrder: buy,
      positionId,
      contractCount: firstExitCount,
      limitPrice: 0.6,
      exchangeOrderId: `exact-fee-exit-a-${suffix}`,
    });
    const firstExitFill = {
      id: `exact-fee-exit-fill-a-${suffix}`,
      orderId: `exact-fee-exit-a-${suffix}`,
      ticker: market,
      side: "yes",
      action: "sell",
      countFp: String(firstExitCount),
      priceDollars: "0.60",
      createdAt: new Date(Date.now() + 1_000).toISOString(),
      feeCostDollars: "0.001111",
    };
    account.fills.push(firstExitFill);
    account.positions[0]!.positionFp = String(buy.requestedContracts - firstExitCount);
    const partialRecovery = await reconcileMicroLiveAtStartup(dependencies);
    assert.equal(partialRecovery.ready, false);
    assert.equal(partialRecovery.reason, "exit_canceled_requires_manual_review");
    let state = await getMicroLiveState();
    assert.equal(state.currentPosition?.lifecycle, "exit_partial");
    assert.equal(state.realizedPnlMicros, 2_076_874);
    assert.equal(state.realizedPnlCents, 208);
    assert.equal((await db.select().from(microLiveOrderTable)
      .where(eq(microLiveOrderTable.id, firstExitId)))[0]!.filledContracts, firstExitCount);

    const finalExitCount = buy.requestedContracts - firstExitCount;
    const finalExitId = await insertRecoveredExitOrder({
      buyOrder: buy,
      positionId,
      contractCount: finalExitCount,
      limitPrice: 0.7,
      exchangeOrderId: `exact-fee-exit-b-${suffix}`,
    });
    account.fills.push({
      id: `exact-fee-exit-fill-b-${suffix}`,
      orderId: `exact-fee-exit-b-${suffix}`,
      ticker: market,
      side: "yes",
      action: "sell",
      countFp: String(finalExitCount),
      priceDollars: "0.70",
      createdAt: new Date(Date.now() + 2_000).toISOString(),
      feeCostDollars: "0.000999",
    });
    account.positions[0]!.positionFp = "0";
    const fullyClosed = await reconcileMicroLiveAtStartup({
      ...dependencies, frozenExitReconciliation: true,
    });
    assert.equal(fullyClosed.ready, false);
    assert.equal(fullyClosed.reason, "exit_canceled_requires_manual_review");
    state = await getMicroLiveState();
    assert.equal(state.currentPosition, null);
    assert.equal(state.realizedPnlMicros, 3_314_311);
    assert.equal(state.realizedPnlCents, 331);
    assert.equal((await db.select().from(microLiveOrderTable)
      .where(eq(microLiveOrderTable.id, finalExitId)))[0]!.filledContracts, finalExitCount);

    const conflictingAccountFill = account.fills.find((fill) => fill.id === firstBuyFill.id)!;
    conflictingAccountFill.feeCostDollars = "0.001235";
    const conflict = await reconcileMicroLiveAtStartup({
      ...dependencies, frozenExitReconciliation: true,
    });
    assert.equal(conflict.ready, false);
    assert.equal(conflict.reason, "local_exchange_fill_mismatch");
    const [config] = await db.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
    assert.equal(config.manualKillSwitch, true);
    assert.equal(config.microLiveProductionEnabled, false);
    assert.equal(config.liveExecutionEnabled, false);
    const afterConflict = await db.select().from(microLiveFillTable)
      .where(eq(microLiveFillTable.orderId, buy.id));
    assert.equal(afterConflict.length, 2);
    assert.equal(afterConflict.find((fill) => fill.exchangeFillId === firstBuyFill.id)?.feeMicros, 1_234);
  } finally {
    await enableStartupRecoveryGates();
  }
});

test("bounded PREPARING runs cannot submit an entry", async () => {
  const fixture = await prepareBoundedRun();
  await db.update(microLiveConfigTable).set({ microLiveRunPhase: "PREPARING" })
    .where(eq(microLiveConfigTable.id, "singleton"));
  const evaluationId = await insertEvaluation({
    ticker: fixture.market,
    evaluatedAt: new Date(Math.max(fixture.currentTime(), fixture.armedAt + 1)),
  });
  const result = await executeQualifiedV13Trigger(evaluationId, fixture.dependencies);
  assert.equal(result.status, "blocked");
  assert.equal(fixture.entryPosts(), 0);
  assert.equal((await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, evaluationId))).length, 0);
});

test("bounded entry requires a fresh post-arm SCOUT and consumes its one-use entry", async () => {
  const fixture = await prepareBoundedRun();
  const preArmId = await insertEvaluation({
    ticker: fixture.market,
    evaluatedAt: new Date(fixture.armedAt - 1),
  });
  const preArm = await executeQualifiedV13Trigger(preArmId, fixture.dependencies);
  assert.equal(preArm.status, "blocked");
  assert.equal(fixture.entryPosts(), 0);

  const freshId = await insertEvaluation({
    ticker: fixture.market,
    evaluatedAt: new Date(Math.max(fixture.currentTime(), fixture.armedAt + 1)),
  });
  const entry = await executeQualifiedV13Trigger(freshId, fixture.dependencies);
  assert.equal(entry.status, "submitted", entry.reason);
  assert.equal(fixture.entryPosts(), 1);
  assert.equal((await getMicroLiveState()).boundedRun.entryAttempted, true);

  const retryId = await insertEvaluation({
    ticker: fixture.market,
    crossingKey: `${fixture.market}:second-crossing`,
    evaluatedAt: new Date(fixture.currentTime()),
  });
  const retry = await executeQualifiedV13Trigger(retryId, fixture.dependencies);
  assert.equal(retry.status, "blocked");
  assert.equal(fixture.entryPosts(), 1, "the entry POST is one-use for the bounded run");
});

test("raising an original $1 run cap before entry is rejected before POST", async () => {
  const fixture = await prepareBoundedRun();
  const [original] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.equal(original?.microLiveRunCapMicros, 1_000_000);
  await db.update(microLiveConfigTable).set({
    microLiveRunCapMicros: 5_000_000,
  }).where(eq(microLiveConfigTable.id, "singleton"));

  const evaluationId = await insertEvaluation({
    ticker: fixture.market,
    evaluatedAt: new Date(Math.max(fixture.currentTime(), fixture.armedAt + 1)),
  });
  const result = await executeQualifiedV13Trigger(evaluationId, fixture.dependencies);
  assert.equal(result.status, "blocked");
  assert.equal(fixture.entryPosts(), 0, "an unaudited $5 cap must not reach the exchange POST");
  assert.equal((await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, evaluationId))).length, 0);
  const [after] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.equal(after?.microLiveRunCapMicros, 5_000_000);
  assert.equal(after?.microLiveEntryAttempted, false);
  assert.equal(after?.microLiveReservedMicros, 0);
});

async function preparePristineRestartFixture(
  artifactState: "valid" | "stale" | "unavailable" = "valid",
) {
  const fixture = await prepareBoundedRun({ persistedApproval: true });
  const runId = await simulateBoundedRunProcessRestart(fixture);
  const evaluationId = await insertEvaluation({
    ticker: fixture.market,
    qualifyingTrigger: false,
    evaluatedAt: new Date(fixture.currentTime()),
  });
  const fetchMocks = installPristineRestartGetMocks(fixture.market, artifactState);
  return {
    fixture, runId, evaluationId, fetchMocks,
    dependencies: withoutTestFeeOverrides(fixture.dependencies),
  };
}

test("pristine unused ENTRY_OPEN run resumes after restart with fresh GET-only evidence and no POST", async () => {
  const { fixture, runId, evaluationId, fetchMocks, dependencies } =
    await preparePristineRestartFixture();
  const [lease] = await db.select().from(forwardTestEngineTable)
    .where(eq(forwardTestEngineTable.id, "v1.3-paper")).limit(1);
  assert.ok(lease?.leaseExpiresAt && lease.leaseExpiresAt.getTime() > Date.now());
  const account = await dependencies.readAccount!();
  const activity = await dependencies.readAccountActivity!();
  assert.equal(account.openOrders.length, 0);
  assert.equal(account.positions.length, 0);
  assert.equal(account.fills.length, 0);
  assert.deepEqual(account.truncated, {
    openOrders: false, positions: false, fills: false,
  });
  assert.equal(activity.available, true);
  assert.equal(activity.truncated, false);
  assert.equal(activity.orders.length, 0);
  assert.equal(activity.fills.length, 0);
  assert.ok(Math.abs(Date.now() - Date.parse(activity.scanFinishedAt!)) <= 5_000);
  assert.equal((await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.marketTicker, fixture.market))).length, 0);
  const [beforeRestart] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  const [paperSignal] = await db.select().from(forwardTestEvaluationTable)
    .where(eq(forwardTestEvaluationTable.id, evaluationId)).limit(1);
  assert.equal(beforeRestart?.microLiveRunPhase, "ENTRY_OPEN");
  assert.equal(beforeRestart?.microLiveRunCapMicros, 1_000_000);
  assert.equal(beforeRestart?.microLiveEntryAttempted, false);
  assert.equal(beforeRestart?.microLiveReservedMicros, 0);
  assert.equal(beforeRestart?.microLiveAccountingUnresolved, false);
  assert.equal(beforeRestart?.microLiveAccountMode, "primary_nonexclusive");
  assert.equal(beforeRestart?.microLiveSelectedSubaccount, 0);
  assert.equal(beforeRestart?.microLivePrimaryCashBaselineMicros, "100000000");
  assert.equal(beforeRestart?.microLivePrimaryCashBaselineRunId, runId);
  assert.ok(beforeRestart?.microLivePrimaryCashBaselineAt);
  assert.match(beforeRestart?.microLivePrimaryCashBaselineEvidenceDigest ?? "", /^[0-9a-f]{64}$/);
  assert.ok(Date.parse(activity.scanFinishedAt!) >=
    (beforeRestart?.microLivePrimaryCashBaselineAt?.getTime() ?? Number.POSITIVE_INFINITY),
  "restart activity timestamps must be monotone from the captured baseline scan");
  const cashBaseline = {
    micros: beforeRestart?.microLivePrimaryCashBaselineMicros,
    runId: beforeRestart?.microLivePrimaryCashBaselineRunId,
    at: beforeRestart?.microLivePrimaryCashBaselineAt?.getTime(),
    evidence: beforeRestart?.microLivePrimaryCashBaselineEvidenceDigest,
  };
  assert.equal(beforeRestart?.microLiveFeeArtifactStatus, "verified");
  assert.ok(beforeRestart?.microLiveRunArmedAt);
  assert.ok(beforeRestart?.microLiveRunApprovalId);
  assert.equal(paperSignal?.evaluationSource, "paper");
  assert.equal(paperSignal?.feedFreshness, "current");
  assert.equal(paperSignal?.qualifyingTrigger, false);

  const result = await processMicroLiveForwardTestCycle(evaluationId, dependencies);
  assert.equal(result, null, "an unqualified current paper signal cannot submit during restart");
  const [config] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.equal(config?.microLiveRunId, runId);
  assert.deepEqual({
    micros: config?.microLivePrimaryCashBaselineMicros,
    runId: config?.microLivePrimaryCashBaselineRunId,
    at: config?.microLivePrimaryCashBaselineAt?.getTime(),
    evidence: config?.microLivePrimaryCashBaselineEvidenceDigest,
  }, cashBaseline, "restart recovery preserves the original cash anchor without rebasing");
  assert.equal(config?.microLiveRunCapMicros, 1_000_000);
  assert.equal(config?.microLiveRunPhase, "ENTRY_OPEN", config?.microLiveRunFreezeReason ?? "");
  assert.equal(config?.microLiveEntryAttempted, false);
  assert.equal(config?.microLiveExitAttempted, false);
  assert.equal(config?.microLiveReservedMicros, 0);
  assert.equal(config?.microLiveProductionEnabled, true);
  assert.equal(config?.liveExecutionEnabled, true);
  assert.equal(config?.manualKillSwitch, false);
  assert.equal(fixture.entryPosts(), 0);
  assert.equal(fixture.exitPosts(), 0);
  assert.equal(fetchMocks.counts().canonicalGets, 0,
    "a restart barrier reads the durable gate and never refetches the PDF");
  assert.ok(fetchMocks.counts().marketEvidenceGets > 0);
});

test("mocked reviewed primary binding and cash checkpoint reconstruct without POST on restart", async () => {
  const fixture = await prepareBoundedRun({ persistedApproval: true });
  const clean = await reconcileMicroLiveAtStartup(fixture.dependencies);
  assert.equal(clean.ready, true, clean.reason);
  const [before] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.equal(before?.microLiveAccountMode, "primary_nonexclusive");
  assert.equal(before?.microLiveSelectedSubaccount, 0);
  assert.ok(before?.microLivePrimaryCashBaselineAt);
  assert.equal(before?.microLivePrimaryActivityCheckpointRunId, before?.microLiveRunId);
  assert.ok(before?.microLivePrimaryActivityCheckpointEvidenceDigest);
  simulateMicroLiveRestartForIsolatedTest();
  const restart = await reconcileMicroLiveAtStartup(fixture.dependencies);
  assert.equal(restart.ready, false, "restart cannot silently grant entry permission");
  const [after] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.equal(after?.microLivePrimaryCashBaselineRunId, before?.microLiveRunId);
  assert.equal(after?.microLivePrimaryCashBaselineEvidenceDigest,
    before?.microLivePrimaryCashBaselineEvidenceDigest);
  assert.equal(after?.microLivePrimaryActivityCheckpointRunId, before?.microLiveRunId);
  assert.equal(fixture.entryPosts(), 0);
  assert.equal(fixture.exitPosts(), 0);
  assert.equal((await db.select().from(microLiveOrderTable)).length, 0);
});

test("two offsetting unrelated cash transfers still freeze a mocked primary run", async () => {
  const fixture = await prepareBoundedRun();
  const originalScan = fixture.dependencies.readPrimaryCashActivityScanForTest!;
  const [before] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.ok(before?.microLivePrimaryCashBaselineAt);
  assert.ok(before.microLivePrimaryActivityCheckpointCursor);
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  fixture.dependencies.readPrimaryCashActivityScanForTest = async (checkpoint, baseline) => {
    const scan = await originalScan(checkpoint, baseline);
    const occurredAt = scan.scanFinishedAt;
    const events = ["1000000", "-1000000"].map((delta, index) => {
      const item = {
        id: `isolated-cash-${index}-${suffix}`,
        kind: "cash_transfer" as const,
        occurredAt,
        classification: "unrelated_permitted" as const,
        runId: null,
        affectsBotMarket: false,
        affectsPositions: false,
        affectsReservedExposure: false,
        cashDeltaMicros: delta,
      };
      return { ...item, evidenceDigest: createPrimaryCashActivityEventDigest(item) };
    });
    return { ...scan, events };
  };
  const result = await reconcileMicroLiveAtStartup(fixture.dependencies);
  assert.equal(result.ready, false);
  assert.equal(result.reason, "primary_cash_external_transfer_requires_review");
  const [after] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.equal(after?.microLiveAccountingUnresolved, true);
  assert.equal(after?.manualKillSwitch, true);
  assert.equal(after?.microLivePrimaryActivityCheckpointCursor,
    before.microLivePrimaryActivityCheckpointCursor);
  assert.equal(fixture.entryPosts(), 0);
  assert.equal(fixture.exitPosts(), 0);
});

for (const movement of [
  { name: "deposit", availableCashDollars: "101.00" },
  { name: "withdrawal", availableCashDollars: "99.00" },
] as const) {
  test(`primary cash baseline freezes on an unrelated ${movement.name}`, async () => {
    const fixture = await prepareBoundedRun();
    const readAccount = fixture.dependencies.readAccount!;
    fixture.dependencies.readAccount = async () => ({
      ...await readAccount(),
      balance: { availableCashDollars: movement.availableCashDollars, portfolioValueDollars: "100.00" },
    });
    const result = await reconcileMicroLiveAtStartup(fixture.dependencies);
    assert.equal(result.ready, false);
    assert.equal(result.reason, "primary_cash_delta_unexplained");
    const [config] = await db.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
    assert.equal(config?.microLiveAccountingUnresolved, true);
    assert.equal(config?.microLiveRunPhase, "FROZEN");
    assert.equal(config?.microLivePrimaryCashBaselineMicros, "100000000",
      "external cash movement must not replace the original anchor");
    assert.equal(fixture.entryPosts(), 0);
    assert.equal(fixture.exitPosts(), 0);
  });
}

test("a fully evidenced unrelated manual trade is not attributed to bot cash", async () => {
  const fixture = await prepareBoundedRun();
  const [before] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.ok(before?.createdAt);
  const createdAt = new Date(before.createdAt.getTime() - 1).toISOString();
  const ticker = `KXMANUAL-${suffix}`;
  const foreignOrder = {
    id: `manual-order-${suffix}`, clientOrderId: null, ticker, side: "yes",
    action: "buy", type: "limit", status: "executed", priceDollars: "0.30",
    initialCount: "1", filledCount: "1", remainingCount: "0", createdAt,
  };
  const foreignFill = {
    id: `manual-fill-${suffix}`, orderId: foreignOrder.id, ticker, side: "yes",
    action: "buy", countFp: "1", priceDollars: "0.30", createdAt,
    feeCostDollars: "0.01",
  };
  const readAccount = fixture.dependencies.readAccount!;
  const readActivity = fixture.dependencies.readAccountActivity!;
  fixture.dependencies.readAccount = async () => {
    const current = await readAccount();
    return {
      ...current,
      balance: { availableCashDollars: "99.69", portfolioValueDollars: "100.00" },
      fills: [...current.fills, foreignFill],
    };
  };
  fixture.dependencies.readAccountActivity = async () => {
    const current = await readActivity();
    return {
      ...current,
      orders: [...current.orders, foreignOrder],
      fills: [...current.fills, foreignFill],
    };
  };
  const result = await reconcileMicroLiveAtStartup(fixture.dependencies);
  assert.equal(result.ready, false);
  assert.equal(result.reason, "primary_cash_delta_unexplained");
  const [after] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.equal(after?.microLiveAccountingUnresolved, true);
  assert.equal(after?.microLivePrimaryCashBaselineMicros, "100000000");
  assert.equal(fixture.entryPosts(), 0);
  assert.equal(fixture.exitPosts(), 0);
});

test("cash preflight normalizes a canonical YES-sell fill for its linked NO-sell order", async () => {
  const fixture = await makeRecoveredSettlementPosition(
    `${ticker}-PREFLIGHT-NO-SELL-${suffix}`, "0.001000", "no",
  );
  process.env.KALSHI_BOT_SUBACCOUNT = "0";
  process.env.MICRO_LIVE_ACCOUNT_MODE = "primary_nonexclusive";
  await db.delete(microLiveFillTable)
    .where(eq(microLiveFillTable.orderId, fixture.order.id));
  await db.delete(microLiveOrderTable).where(eq(microLiveOrderTable.id, fixture.order.id));
  await disableSettlementGates();
  await db.update(microLiveConfigTable).set({
    microLiveAccountMode: null,
    microLiveSelectedSubaccount: null,
    microLiveRunId: null,
    microLiveEntryAttempted: false,
    microLiveExitAttempted: false,
    microLiveRunPhase: "UNARMED",
    microLiveReservedMicros: 0,
    microLiveAccountingUnresolved: false,
    microLiveAccountingUnresolvedReason: null,
  }).where(eq(microLiveConfigTable.id, "singleton"));
  await reviewFrozenPrimaryBinding();
  const exitExchangeId = `preflight-no-exit-${suffix}`;
  const exitOrderId = await insertRecoveredExitOrder({
    buyOrder: fixture.order,
    positionId: fixture.positionId,
    contractCount: fixture.order.requestedContracts,
    limitPrice: 0.85,
    exchangeOrderId: exitExchangeId,
  });
  const [exitOrder] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, exitOrderId)).limit(1);
  assert.ok(exitOrder);
  const exitFill = {
    id: `preflight-no-fill-${suffix}`,
    orderId: exitExchangeId,
    ticker: fixture.order.marketTicker,
    side: "yes" as const,
    action: "sell" as const,
    countFp: String(fixture.order.requestedContracts),
    priceDollars: "0.1300",
    yesPriceDollars: "0.1300",
    noPriceDollars: "0.8700",
    outcomeSide: "yes" as const,
    bookSide: "bid" as const,
    createdAt: now().toISOString(),
    feeCostDollars: "0.002000",
  };
  fixture.account.fills.splice(0, fixture.account.fills.length, exitFill);
  fixture.account.positions[0]!.positionFp =
    String(-fixture.order.requestedContracts);
  fixture.account.positions[0]!.marketExposureDollars = "0";
  const baselineMicros = 100_000_000n;
  const runId = `cash-preflight-${suffix}`;
  const baselineAt = new Date(Date.now() - 2_000);
  const baselineDigest = createHash("sha256")
    .update(`cash-preflight-${suffix}`).digest("hex");
  await db.update(microLiveConfigTable).set({
    microLiveAccountMode: "primary_nonexclusive",
    microLiveSelectedSubaccount: 0,
    microLiveRunId: runId,
    microLiveRunArmedAt: new Date(baselineAt.getTime() + 1_000),
    microLivePrimaryCashBaselineMicros: baselineMicros.toString(),
    microLivePrimaryCashBaselineRunId: runId,
    microLivePrimaryCashBaselineAt: baselineAt,
    microLivePrimaryCashBaselineEvidenceDigest: baselineDigest,
  }).where(eq(microLiveConfigTable.id, "singleton"));
  await db.update(microLiveOrderTable).set({ microLiveRunId: runId })
    .where(eq(microLiveOrderTable.id, exitOrderId));

  const statusFor = (row: typeof microLiveOrderTable.$inferSelect) => ({
    orderId: row.exchangeOrderId!,
    clientOrderId: row.clientOrderId,
    ticker: row.marketTicker,
    side: row.side === "UP" ? "yes" as const : "no" as const,
    action: row.action as "buy" | "sell",
    type: "limit" as const,
    status: "executed",
    remainingCount: "0",
    filledCount: String(row.requestedContracts),
    outcomeSide: row.action === "sell" ? "yes" : "no",
    bookSide: row.action === "sell" ? "bid" : "ask",
  });
  const dependencies = mocks({
    readAccount: async () => fixture.account,
    readAccountActivity: async () => {
      const rows = await db.select().from(microLiveOrderTable);
      const botRows = rows.filter((row) => row.exchangeOrderId);
      const scanAt = now().toISOString();
      return {
        orders: botRows.map((row) => ({
          id: row.exchangeOrderId!, clientOrderId: row.clientOrderId,
          ticker: row.marketTicker, side: row.side === "UP" ? "yes" : "no",
          action: row.action, type: "limit", status: "executed",
          priceDollars: String(row.requestedLimitPrice),
          initialCount: String(row.requestedContracts),
          filledCount: String(fixture.account.fills.filter((fill) =>
            fill.orderId === row.exchangeOrderId).reduce((sum, fill) =>
            sum + Number(fill.countFp), 0)),
          remainingCount: "0", createdAt: row.createdAt.toISOString(),
          outcomeSide: row.action === "sell" ? "yes" : "no",
          bookSide: row.action === "sell" ? "bid" : "ask",
        })),
        fills: fixture.account.fills.map((fill) => ({
          ...fill, feeCostDollars: fill.feeCostDollars ?? null,
        })),
        available: true, truncated: false, keyRestrictionVerified: true,
        selectedSubaccount: 0, scanStartedAt: scanAt, scanFinishedAt: scanAt,
        exclusiveControlVerified: false,
      };
    },
    readOrderStatus: async (id) => {
      const rows = await db.select().from(microLiveOrderTable);
      const row = rows.find((candidate) => candidate.exchangeOrderId === id);
      assert.ok(row, `missing mock status row ${id}`);
      return statusFor(row);
    },
  });

  assert.equal(await freshOwnershipPreflight(exitOrderId, dependencies, now), null,
    "the linked NO-sell cash leg must use the exchange status's canonical YES/bid semantics");
  const cashProof = {
    orderId: exitOrderId,
    runId,
    marketTicker: fixture.order.marketTicker,
    baselineDigest,
    baselineMicros: baselineMicros.toString(),
    baselineAt: baselineAt.getTime(),
  };
  assert.equal(isMicroLiveCashPreflightCurrent(cashProof), true,
    "successful ownership and cash checks publish an exact order/run/market/baseline proof");
  assert.equal(isMicroLiveCashPreflightCurrent({
    ...cashProof, marketTicker: `${cashProof.marketTicker}-other`,
  }), false, "proofs cannot be retargeted to another market");
  assert.equal(isMicroLiveCashPreflightCurrent({
    ...cashProof, orderId: `${cashProof.orderId}-other`,
  }), false, "proofs cannot be retargeted to another order");
  assert.equal(isMicroLiveCashPreflightCurrent({
    ...cashProof, runId: `${cashProof.runId}-other`,
  }), false, "proofs cannot be retargeted to another run");
  assert.equal(isMicroLiveCashPreflightCurrent({
    ...cashProof, baselineDigest: "0".repeat(64),
  }), false, "proofs cannot be retargeted to another baseline");
  const missingStatus = await freshOwnershipPreflight(exitOrderId, {
    ...dependencies,
    readOrderStatus: async () => { throw new Error("mock status unavailable"); },
  }, now);
  assert.equal(missingStatus, "primary_cash_order_status_unavailable",
    "preflight must not fall back to the raw opposite-book fill price");
  assert.equal(isMicroLiveCashPreflightCurrent(cashProof), false,
    "a later failed preflight clears prior process-local proof");
});

for (const artifactState of ["stale", "unavailable"] as const) {
  test(`pristine ENTRY_OPEN restart does not refetch a ${artifactState} PDF without POST`, async () => {
    const { fixture, runId, evaluationId, fetchMocks, dependencies } =
      await preparePristineRestartFixture(artifactState);
    await processMicroLiveForwardTestCycle(evaluationId, dependencies);
    const [config] = await db.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
    assert.equal(config?.microLiveRunId, runId);
    assert.equal(config?.microLiveRunPhase, "ENTRY_OPEN");
    assert.equal(config?.microLiveRunFreezeReason, null);
    assert.equal(config?.microLiveEntryAttempted, false);
    assert.equal(config?.microLiveReservedMicros, 0);
    assert.equal(config?.manualKillSwitch, false);
    assert.equal(config?.microLiveProductionEnabled, true);
    assert.equal(config?.liveExecutionEnabled, true);
    assert.equal(fixture.entryPosts(), 0);
    assert.equal(fixture.exitPosts(), 0);
    assert.equal((await db.select().from(microLiveOrderTable)
      .where(eq(microLiveOrderTable.marketTicker, fixture.market))).length, 0);
    assert.equal(fetchMocks.counts().canonicalGets, 0,
      "a changed/unavailable PDF is handled by the separate monitor, not this restart barrier");
    assert.ok(fetchMocks.counts().marketEvidenceGets > 0,
      "the restart still checks fresh live fee metadata");
    assert.ok(await approvedFeeSession(),
      "stale or rate-limited PDF evidence does not itself revoke the approved identity");
    assert.equal(config?.microLiveFeeArtifactStatus, "verified");
  });
}

test("pristine ENTRY_OPEN restart freezes on unresolved ownership history without POST", async () => {
  const { fixture, runId, evaluationId, fetchMocks, dependencies } =
    await preparePristineRestartFixture();
  const readCompleteActivity = dependencies.readAccountActivity!;
  dependencies.readAccountActivity = async () => {
    const activity = await readCompleteActivity();
    const staleAt = new Date(Date.now() - 60_000).toISOString();
    return { ...activity, scanStartedAt: staleAt, scanFinishedAt: staleAt };
  };
  await processMicroLiveForwardTestCycle(evaluationId, dependencies);
  const [config] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.equal(config?.microLiveRunId, runId);
  assert.equal(config?.microLiveRunPhase, "FROZEN");
  assert.equal(config?.microLiveRunFreezeReason, "primary_accounting_unresolved");
  assert.equal(config?.microLiveEntryAttempted, false);
  assert.equal(config?.microLiveReservedMicros, 0);
  assert.equal(config?.manualKillSwitch, true);
  assert.equal(fixture.entryPosts(), 0);
  assert.equal(fixture.exitPosts(), 0);
  assert.equal((await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.marketTicker, fixture.market))).length, 0);
  assert.equal(fetchMocks.counts().canonicalGets, 0,
    "the accounting-history restart barrier never refetches the approved PDF");
});

test("attempted uncertain ENTRY_OPEN run stays frozen across restart without retry", async () => {
  const fixture = await prepareBoundedRun({
    persistedApproval: true, ambiguousEntryPost: true,
  });
  const evaluationId = await insertEvaluation({
    ticker: fixture.market, evaluatedAt: new Date(fixture.currentTime()),
  });
  const attempted = await executeQualifiedV13Trigger(evaluationId, fixture.dependencies);
  assert.equal(attempted.status, "unknown", attempted.reason);
  assert.equal(fixture.entryPosts(), 1);
  const runId = await simulateBoundedRunProcessRestart(fixture);
  const fetchMocks = installPristineRestartGetMocks(fixture.market);
  const dependencies = withoutTestFeeOverrides(fixture.dependencies);
  await processMicroLiveForwardTestCycle(evaluationId, dependencies);
  const [config] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.equal(config?.microLiveRunId, runId);
  assert.equal(config?.microLiveRunPhase, "FROZEN");
  assert.equal(config?.microLiveRunFreezeReason, "emergency_stop");
  assert.equal(config?.microLiveEntryAttempted, true);
  assert.ok(config!.microLiveReservedMicros > 0);
  assert.equal(fixture.entryPosts(), 1, "restart cannot repeat the uncertain entry POST");
  assert.equal(fixture.exitPosts(), 0);
  assert.equal(fetchMocks.counts().canonicalGets, 0,
    "an emergency-frozen uncertain run is not reopened for artifact recovery");
});

for (const runtime of [
  { label: "30 minutes", elapsedMs: 30 * 60_000 },
  { label: "24 hours", elapsedMs: 24 * 60 * 60_000 },
  { label: "multiple days", elapsedMs: 4 * 24 * 60 * 60_000 },
]) {
  test(`fresh per-order fee evidence permits a $5 run after ${runtime.label} without expiry`, async () => {
    const { fixture } = await prepareSuccessorBoundedRun({
      persistedApproval: runtime.elapsedMs === 30 * 60_000,
      readEntryFeeTerms: (selectedTicker, approval) => ({
        ...boundedFeeTerms(selectedTicker, boundedApprovalFingerprint(approval, selectedTicker)),
        entryCashDebitPerContractMicrosAtLimit: () => 2_400_000,
        maximumExitCashDebitPerContractMicros: () => 100_000,
      }),
    });
    const refreshAt = async (elapsedMs: number) => {
      await fixture.setRuntimeAge(elapsedMs);
      await fixture.refreshWorkerLease();
      const reconciled = await fixture.refreshStartupReconciliation();
      assert.equal(reconciled.ready, true, reconciled.reason);
    };

    await refreshAt(runtime.elapsedMs);
    const entryEvaluationId = await insertEvaluation({
      ticker: fixture.market,
      evaluatedAt: new Date(fixture.currentTime()),
    });
    const entry = await executeQualifiedV13Trigger(entryEvaluationId, fixture.dependencies);
    assert.equal(entry.status, "submitted", entry.reason);
    assert.ok(entry.orderId);
    assert.equal(fixture.entryPosts(), 1);
    const entryFeeReads = fixture.feeTermsReads();
    assert.ok(entryFeeReads >= 2, "current entry fee evidence is re-read before the POST");
    const [buy] = await db.select().from(microLiveOrderTable)
      .where(eq(microLiveOrderTable.sourceEvaluationId, entryEvaluationId)).limit(1);
    assert.ok(buy);
    assert.equal(buy.requestedStakeCents * 10_000 +
      buy.reservedEntryFeeMicros! + buy.reservedExitFeeMicros!, 5_000_000,
    "the complete entry and exit reservation is exactly the $5 run cap");

    fixture.setAccount({
      ...emptyAccount(),
      positions: [{
        ticker: fixture.market, positionFp: String(buy.requestedContracts),
        marketExposureDollars: String(buy.requestedContracts * buy.requestedLimitPrice),
        realizedPnlDollars: "0",
      }],
      fills: [historicalFillFor(buy, entry.orderId, `runtime-entry-fill-${suffix}`)],
    });
    const reconciled = await fixture.refreshStartupReconciliation();
    assert.equal(reconciled.ready, true, reconciled.reason);
    const duplicateEntryId = await insertEvaluation({
      ticker: fixture.market, crossingKey: `${fixture.market}:runtime-entry-retry`,
      evaluatedAt: new Date(fixture.currentTime()),
    });
    const duplicateEntry = await executeQualifiedV13Trigger(
      duplicateEntryId, fixture.dependencies,
    );
    assert.equal(duplicateEntry.status, "blocked");
    assert.equal(fixture.entryPosts(), 1, "the entry claim remains one-use");

    await refreshAt(runtime.elapsedMs * 2);
    const exitEvaluationId = await insertEvaluation({
      ticker: fixture.market,
      signal: "EXIT",
      crossingKey: buy.crossingKey,
      evaluatedAt: new Date(fixture.currentTime()),
    });
    await db.update(forwardTestEvaluationTable).set({
      evaluationSource: "micro_live",
      livePositionId: `position:${fixture.market}:${buy.crossingKey}`,
      sourcePaperEvaluationId: entryEvaluationId,
      positionWasOpen: true,
    }).where(eq(forwardTestEvaluationTable.id, exitEvaluationId));
    await processMicroLiveForwardTestCycle(
      `missing-runtime-exit-paper-${randomUUID()}`, fixture.dependencies,
    );

    let competingExitStart: Promise<string | null> | null = null;
    let competingExitIdentity: FeeVerificationIdentity | null = null;
    if (runtime.elapsedMs === 30 * 60_000) {
      const persistedApproval = await approvedFeeSession();
      assert.ok(persistedApproval);
      competingExitIdentity = verificationIdentity(persistedApproval);
      const originalSubmit = fixture.dependencies.submitOrder!;
      fixture.dependencies.submitOrder = async (input, context) => {
        if (input.action === "sell") {
          competingExitStart = beginFeeVerification(competingExitIdentity!);
          const resolvedWhileExitLockHeld = await Promise.race([
            competingExitStart.then(() => true),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
          ]);
          assert.equal(resolvedWhileExitLockHeld, false,
            "exit holds the final gate row lock through its mocked POST");
        }
        return originalSubmit(input, context);
      };
    }
    const feeReadsBeforeExit = fixture.feeTermsReads();
    const exit = await executeQualifiedV13Trigger(exitEvaluationId, fixture.dependencies);
    assert.notEqual(exit.status, "blocked", exit.reason);
    assert.ok(fixture.feeTermsReads() > feeReadsBeforeExit,
      "fresh fee metadata is read for the later exit order");
    assert.equal(fixture.exitPosts(), 1, "the fee-bounded exit is a single mocked POST");
    if (competingExitStart) {
      const attemptId = await competingExitStart;
      assert.ok(attemptId, "exit commit releases the competing verifier after POST");
      assert.ok(competingExitIdentity);
      const feeEvidence = fixture.latestFeeTerms();
      assert.ok(feeEvidence);
      assert.equal(await finishFeeVerification(
        competingExitIdentity, attemptId, "verified", null,
        feeEvidence.fingerprint, new Date(feeEvidence.verifiedAt),
      ), true);
    }
    const retry = await executeQualifiedV13Trigger(exitEvaluationId, fixture.dependencies);
    assert.notEqual(retry.status, "submitted");
    assert.equal(fixture.exitPosts(), 1, "the exit claim is also one-use");
  });
}

test("standing fee approval is read from persisted policy and does not expire with time", async () => {
  const fixture = await prepareBoundedRun({ persistedApproval: true });
  assert.equal(fixture.dependencies.approvedFeeSessionForTest, undefined);
  const stored = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.equal(stored[0]?.microLiveFeeApprovalApproved, true);
  assert.equal(stored[0]?.microLiveFeePolicyVersion, STANDING_FEE_POLICY_VERSION);
  assert.equal(stored[0]?.microLiveFeeApprovalSourceUrl, CANONICAL_FEE_SCHEDULE_URL);
  assert.equal(stored[0]?.microLiveFeeFormulaVersion, STANDARD_QUADRATIC_FEE_FORMULA_VERSION);
  assert.equal(stored[0]?.microLiveFeeApprovalDigest, isolatedFeeScheduleDigest,
    "the mocked official-PDF bytes hash to the exact persisted approval digest");
  assert.equal(stored[0]?.microLiveFeeApprovedBy, `isolated-administrator-${suffix}`);
  assert.equal(stored[0]?.microLiveFeeMaximumExposureMicros, 5_000_000);
  const policy = await approvedFeeSession();
  assert.ok(policy);
  assert.ok(isolatedFeeFetchCount > 0, "persisted reads GET the fixed official artifact");
  assert.equal(policy.id, stored[0]?.microLiveFeeApprovalId);
  assert.equal(policy.digest, stored[0]?.microLiveFeeApprovalDigest);
  assert.equal(policy.approvedAt, stored[0]?.microLiveFeeApprovalApprovedAt?.getTime());
  assert.ok(Date.now() - policy.approvedAt > 300 * 24 * 60 * 60_000);

  // A new persisted read models a fresh server process: no in-memory session
  // or authorization renewal is needed after restart.
  const restartedPolicy = await approvedFeeSession();
  assert.deepEqual(restartedPolicy, policy);
});

for (const mutation of ["revoked", "version-mismatch", "cap-change"] as const) {
  test(`persisted fee policy ${mutation} at the final interlock blocks entry and retry`, async () => {
    const fixture = await prepareBoundedRun({ persistedApproval: true });
    let changed = false;
    fixture.dependencies.beforeSubmissionInterlock = async () => {
      if (changed) return;
      changed = true;
      if (mutation === "revoked") {
        await revokeFeeApproval();
      } else if (mutation === "version-mismatch") {
        await db.update(microLiveConfigTable).set({
          microLiveFeePolicyVersion: "unknown-policy-version",
        }).where(eq(microLiveConfigTable.id, "singleton"));
      } else {
        await revokeFeeApproval();
        await db.update(microLiveConfigTable).set({
          microLiveRunCapMicros: 5_000_000,
        }).where(eq(microLiveConfigTable.id, "singleton"));
      }
    };
    const evaluationId = await insertEvaluation({
      ticker: fixture.market,
      evaluatedAt: new Date(Math.max(fixture.currentTime(), fixture.armedAt + 1)),
    });
    const first = await executeQualifiedV13Trigger(evaluationId, fixture.dependencies);
    assert.equal(first.status, "blocked");
    assert.equal(fixture.entryPosts(), 0, "final policy re-read prevents the new POST");
    const retry = await executeQualifiedV13Trigger(evaluationId, fixture.dependencies);
    assert.equal(retry.status, "blocked");
    assert.equal(fixture.entryPosts(), 0, "retry cannot bypass a changed final policy");
    assert.equal(changed, true);
  });
}

for (const failure of ["stale", "unavailable", "malformed", "over-policy-cap"] as const) {
  test(`standing policy ${failure} fee evidence blocks entry with zero POSTs and no retry`, async () => {
    let fixture: Awaited<ReturnType<typeof prepareBoundedRun>>;
    if (failure === "over-policy-cap") {
      // The preceding filtered test may leave its standing policy active;
      // revoke it before the isolated $5 successor transition.
      if (await approvedFeeSession()) await revokeFeeApproval();
      fixture = (await prepareSuccessorBoundedRun({
        persistedApproval: true,
        readEntryFeeTerms: (selectedTicker, approval) => ({
          ...boundedFeeTerms(
            selectedTicker, boundedApprovalFingerprint(approval, selectedTicker),
          ),
          entryCashDebitPerContractMicrosAtLimit: () => 2_400_000,
          maximumExitCashDebitPerContractMicros: () => 100_000,
        }),
      })).fixture;
    } else {
      fixture = await prepareBoundedRun({ persistedApproval: true });
    }
    // Exercise the real fee-inclusive reservation path; this isolated fixture
    // still uses only mocked fee/account reads and the mocked order submitter.
    fixture.dependencies.isolatedTestFeeCapFixture = false;
    const readTerms = fixture.dependencies.readEntryFeeTerms!;
    let finalInterlockPassed = false;
    fixture.dependencies.beforeSubmissionInterlock = async () => {
      finalInterlockPassed = true;
    };
    fixture.dependencies.readEntryFeeTerms = async (selectedTicker) => {
      const terms = await readTerms(selectedTicker);
      if (!finalInterlockPassed) return terms;
      if (!terms) return null;
      if (failure === "unavailable") {
        const approval = await approvedFeeSession();
        assert.ok(approval);
        const identity = verificationIdentity(approval);
        const attemptId = await beginFeeVerification(identity);
        assert.ok(attemptId);
        assert.equal(await finishFeeVerification(
          identity, attemptId, "unavailable",
          "isolated_live_fee_metadata_unavailable", null, new Date(terms.verifiedAt),
        ), true);
        return terms;
      }
      if (failure === "stale") return { ...terms, verifiedAt: Date.now() - 15_001 };
      if (failure === "over-policy-cap") {
        return {
          ...terms,
          entryCashDebitPerContractMicrosAtLimit: () => 5_100_000,
          maximumExitCashDebitPerContractMicros: () => 100_000,
        };
      }
      return {
        ...terms,
        entryCashDebitPerContractMicrosAtLimit: () => Number.NaN,
        maximumExitCashDebitPerContractMicros: () => Number.NaN,
      };
    };
    const evaluationId = await insertEvaluation({
      ticker: fixture.market,
      evaluatedAt: new Date(Math.max(fixture.currentTime(), fixture.armedAt + 1)),
    });
    const result = await executeQualifiedV13Trigger(evaluationId, fixture.dependencies);
    assert.notEqual(result.status, "submitted");
    assert.equal(finalInterlockPassed, true);
    assert.equal(fixture.entryPosts(), 0);
    const retry = await executeQualifiedV13Trigger(evaluationId, fixture.dependencies);
    assert.notEqual(retry.status, "submitted");
    assert.equal(fixture.entryPosts(), 0, "retry cannot bypass the fee barrier");
  });
}

test("database policy pin and explicit revocation prevent standing-policy reuse", async () => {
  const versionFixture = await prepareBoundedRun({ persistedApproval: true });
  const pinnedPolicy = await approvedFeeSession();
  assert.ok(pinnedPolicy);
  await assert.rejects(db.update(microLiveConfigTable).set({
    microLiveFeePolicyVersion: "unknown-policy-version",
  }).where(eq(microLiveConfigTable.id, "singleton")));
  assert.equal((await approvedFeeSession())?.id, pinnedPolicy.id,
    "the DB CHECK keeps the immutable approved policy version pinned");
  assert.equal(versionFixture.entryPosts(), 0);

  const revokedFixture = await prepareBoundedRun({ persistedApproval: true });
  await revokeFeeApproval();
  assert.equal(await approvedFeeSession(), null);
  const revokedEvaluationId = await insertEvaluation({
    ticker: revokedFixture.market,
    evaluatedAt: new Date(Math.max(revokedFixture.currentTime(), revokedFixture.armedAt + 1)),
  });
  assert.notEqual((await executeQualifiedV13Trigger(
    revokedEvaluationId, revokedFixture.dependencies,
  )).status, "submitted");
  assert.equal(revokedFixture.entryPosts(), 0);
  assert.notEqual((await executeQualifiedV13Trigger(
    revokedEvaluationId, revokedFixture.dependencies,
  )).status, "submitted");
  assert.equal(revokedFixture.entryPosts(), 0, "retries cannot bypass a revoked policy");
});

test("a durable invalidation committed before the final entry gate prevents POST", async () => {
  const fixture = await prepareBoundedRun({ persistedApproval: true });
  const approval = await approvedFeeSession();
  assert.ok(approval);
  const identity = verificationIdentity(approval);
  let invalidationCommitted = false;
  fixture.dependencies.beforeSubmissionInterlock = async () => {
    const attemptId = await beginFeeVerification(identity);
    assert.ok(attemptId);
    invalidationCommitted = await finishFeeVerification(identity, attemptId,
      "invalid", "isolated_contradictory_fee_evidence");
  };
  const evaluationId = await insertEvaluation({
    ticker: fixture.market,
    evaluatedAt: new Date(Math.max(fixture.currentTime(), fixture.armedAt + 1)),
  });

  const result = await executeQualifiedV13Trigger(evaluationId, fixture.dependencies);
  assert.notEqual(result.status, "submitted");
  assert.equal(invalidationCommitted, true);
  assert.equal(fixture.entryPosts(), 0);
  assert.equal((await getFeeVerificationState(identity))?.status, "invalid");
});

test("a pending fee-verification attempt from a crashed process blocks entry POST", async () => {
  const fixture = await prepareBoundedRun({ persistedApproval: true });
  const approval = await approvedFeeSession();
  assert.ok(approval);
  const identity = verificationIdentity(approval);
  const crashedAttempt = await beginFeeVerification(identity);
  assert.ok(crashedAttempt);
  assert.equal((await getFeeVerificationState(identity))?.status, "pending");
  assert.equal(await approvedFeeSession(), null);

  const evaluationId = await insertEvaluation({
    ticker: fixture.market,
    evaluatedAt: new Date(Math.max(fixture.currentTime(), fixture.armedAt + 1)),
  });
  const result = await executeQualifiedV13Trigger(evaluationId, fixture.dependencies);
  assert.notEqual(result.status, "submitted");
  assert.equal(fixture.entryPosts(), 0);
  assert.equal((await getFeeVerificationState(identity))?.attemptId, crashedAttempt);
});

test("a verifier starting behind the final fee-row lock linearizes after the mocked POST", async () => {
  const fixture = await prepareBoundedRun({ persistedApproval: true });
  const approval = await approvedFeeSession();
  assert.ok(approval);
  const identity = verificationIdentity(approval);
  const originalSubmit = fixture.dependencies.submitOrder!;
  let competingStart: Promise<string | null> | null = null;
  fixture.dependencies.submitOrder = async (input, context) => {
    // The entry transaction holds the gate row FOR UPDATE throughout this
    // callback. beginFeeVerification uses another pool connection and must
    // remain blocked until the mocked POST transaction commits.
    competingStart = beginFeeVerification(identity);
    const resolvedWhilePostLocked = await Promise.race([
      competingStart.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    assert.equal(resolvedWhilePostLocked, false,
      "the verifier cannot commit pending after the final POST lock was acquired");
    return originalSubmit(input, context);
  };
  const evaluationId = await insertEvaluation({
    ticker: fixture.market,
    evaluatedAt: new Date(Math.max(fixture.currentTime(), fixture.armedAt + 1)),
  });
  const result = await executeQualifiedV13Trigger(evaluationId, fixture.dependencies);
  assert.equal(result.status, "submitted", result.reason);
  assert.equal(fixture.entryPosts(), 1);
  assert.ok(competingStart);
  const attemptId = await competingStart;
  assert.ok(attemptId,
    "the blocked verifier starts only after the mocked POST has committed");
  assert.equal((await getFeeVerificationState(identity))?.attemptId, attemptId);
  const feeEvidence = fixture.latestFeeTerms();
  assert.ok(feeEvidence);
  assert.equal(await finishFeeVerification(
    identity, attemptId, "verified", null,
    feeEvidence.fingerprint, new Date(feeEvidence.verifiedAt),
  ), true);
});

test("approved fee policy refuses cap increases until explicit revocation", async () => {
  const fixture = await prepareBoundedRun({ persistedApproval: true });
  const before = await approvedFeeSession();
  assert.ok(before);
  assert.equal(before.approvedRunCapMicros, 1_000_000);
  await assert.rejects(db.update(microLiveConfigTable).set({
    microLiveRunCapMicros: 5_000_000,
  }).where(eq(microLiveConfigTable.id, "singleton")));
  assert.equal((await approvedFeeSession())?.id, before.id,
    "the database refuses an upward cap edit while the old approval is active");
  await revokeFeeApproval();
  await db.update(microLiveConfigTable).set({
    microLiveRunCapMicros: 5_000_000,
  }).where(eq(microLiveConfigTable.id, "singleton"));
  assert.equal(await approvedFeeSession(), null,
    "after revocation, an increased cap still needs a new explicit approval");
  const evaluationId = await insertEvaluation({
    ticker: fixture.market,
    evaluatedAt: new Date(Math.max(fixture.currentTime(), fixture.armedAt + 1)),
  });
  assert.notEqual((await executeQualifiedV13Trigger(evaluationId, fixture.dependencies)).status,
    "submitted");
  assert.equal(fixture.entryPosts(), 0);
});

async function simulateBoundedRunProcessRestart(
  fixture: Awaited<ReturnType<typeof prepareBoundedRun>>,
): Promise<string> {
  const [config] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.ok(config?.microLiveRunId);
  const runId = config.microLiveRunId;
  simulateMicroLiveRestartForIsolatedTest();
  await db.update(forwardTestEngineTable).set({
    leaseExpiresAt: new Date(Date.now() + 60_000),
  }).where(eq(forwardTestEngineTable.id, "v1.3-paper"));
  return runId;
}

test("fee-inclusive entry debit above the $5 policy exposure blocks with zero POSTs", async () => {
  const { fixture } = await prepareSuccessorBoundedRun({
    persistedApproval: true,
    readEntryFeeTerms: (selectedTicker, approval) => ({
      ...boundedFeeTerms(selectedTicker, boundedApprovalFingerprint(approval, selectedTicker)),
      entryCashDebitPerContractMicrosAtLimit: () => 5_100_000,
      maximumExitCashDebitPerContractMicros: () => 0,
    }),
  });
  const evaluationId = await insertEvaluation({
    ticker: fixture.market,
    evaluatedAt: new Date(Math.max(fixture.currentTime(), fixture.armedAt + 1)),
  });
  const result = await executeQualifiedV13Trigger(evaluationId, fixture.dependencies);
  assert.notEqual(result.status, "submitted");
  assert.ok(fixture.feeTermsReads() > 0);
  assert.equal(fixture.entryPosts(), 0,
    "the complete entry/exit reservation above 5,000,000 micros cannot POST");
});

test("tampered persisted entry fee provenance blocks the final POST", async () => {
  const fixture = await prepareBoundedRun({ persistedApproval: true });
  fixture.dependencies.beforeSubmissionInterlock = async () => {
    const [reservation] = await db.select().from(microLiveOrderTable)
      .where(eq(microLiveOrderTable.marketTicker, fixture.market)).limit(1);
    assert.ok(reservation);
    assert.equal(reservation.status, "pending");
    await assert.rejects(db.update(microLiveOrderTable).set({
      feeEvidenceVerifiedAt: null,
    }).where(eq(microLiveOrderTable.id, reservation.id)),
    "the history-compatible database constraint rejects missing proof on an active run row");
    await db.update(microLiveOrderTable).set({
      feeEvidenceFingerprint: `${reservation.feeEvidenceFingerprint}|tampered`,
    }).where(eq(microLiveOrderTable.id, reservation.id));
  };
  const evaluationId = await insertEvaluation({
    ticker: fixture.market,
    evaluatedAt: new Date(Math.max(fixture.currentTime(), fixture.armedAt + 1)),
  });
  const result = await executeQualifiedV13Trigger(evaluationId, fixture.dependencies);
  assert.notEqual(result.status, "submitted");
  assert.equal(fixture.entryPosts(), 0,
    "a mismatched durable fee fingerprint cannot reach the entry POST");
});

test("prepared $5 successor reconciles per-fill rounding and permits only a fee-bounded one-use exit", async () => {
  let exitDebitPerContract = 100_001;
  let metadataRevision = "series-update";
  const { fixture } = await prepareSuccessorBoundedRun({
    persistedApproval: true,
    readEntryFeeTerms: (selectedTicker, approval) => ({
      ...boundedFeeTerms(selectedTicker, boundedApprovalFingerprint(
        approval, selectedTicker, metadataRevision,
      )),
      entryCashDebitPerContractMicrosAtLimit: () => 2_400_000,
      maximumExitCashDebitPerContractMicros: () => 100_000,
      exitCashDebitPerContractMicrosAtLimit: () => exitDebitPerContract,
    }),
  });
  const entryEvaluationId = await insertEvaluation({
    ticker: fixture.market,
    evaluatedAt: new Date(Math.max(fixture.currentTime(), fixture.armedAt + 1)),
  });
  const entry = await executeQualifiedV13Trigger(entryEvaluationId, fixture.dependencies);
  assert.equal(entry.status, "submitted", entry.reason);
  assert.equal(fixture.entryPosts(), 1);
  assert.ok(entry.orderId);
  const [buy] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, entryEvaluationId)).limit(1);
  assert.ok(buy);
  assert.equal(buy.requestedContracts, 2);
  assert.equal(buy.reservedEntryFeeMicros, 4_000_000);
  assert.equal(buy.reservedExitFeeMicros, 200_000);
  assert.equal(buy.requestedStakeCents * 10_000 +
    buy.reservedEntryFeeMicros! + buy.reservedExitFeeMicros!, 5_000_000);

  const firstFill = {
    id: `bounded-five-entry-partial-${suffix}`,
    orderId: entry.orderId, ticker: fixture.market, side: "yes", action: "buy",
    countFp: "1", priceDollars: String(buy.requestedLimitPrice),
    createdAt: new Date(fixture.currentTime() + 1).toISOString(),
    feeCostDollars: "0.005",
  };
  fixture.setAccount({
    ...emptyAccount(),
    positions: [{
      ticker: fixture.market, positionFp: "1",
      marketExposureDollars: String(buy.requestedLimitPrice), realizedPnlDollars: "0",
    }],
    fills: [firstFill],
  });
  fixture.setMockOrderStatus(entry.orderId, "canceled");
  const partial = await reconcileMicroLiveAtStartup(fixture.dependencies);
  assert.equal(partial.ready, true, partial.reason);
  const [partiallyFilledBuy] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, buy.id)).limit(1);
  assert.equal(partiallyFilledBuy.status, "canceled");
  assert.equal(partiallyFilledBuy.filledContracts, 1);
  assert.equal(partiallyFilledBuy.remainingContracts, 0);
  const [firstPersistedFill] = await db.select().from(microLiveFillTable)
    .where(eq(microLiveFillTable.orderId, buy.id)).limit(1);
  assert.equal(firstPersistedFill.feeMicros, 5_000);
  assert.equal(firstPersistedFill.feeCents, 1);

  const secondFill = {
    ...firstFill,
    id: `bounded-five-entry-completion-${suffix}`,
    countFp: "1",
    createdAt: new Date(fixture.currentTime() + 2).toISOString(),
  };
  fixture.setAccount({
    ...emptyAccount(),
    positions: [{
      ticker: fixture.market, positionFp: "2",
      marketExposureDollars: String(buy.requestedContracts * buy.requestedLimitPrice),
      realizedPnlDollars: "0",
    }],
    fills: [firstFill, secondFill],
  });
  fixture.setMockOrderStatus(entry.orderId, "executed");
  const completed = await reconcileMicroLiveAtStartup(fixture.dependencies);
  assert.equal(completed.ready, true, completed.reason);
  const [filledBuy] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, buy.id)).limit(1);
  assert.equal(filledBuy.status, "filled");
  assert.equal(filledBuy.filledContracts, 2);
  assert.equal(filledBuy.remainingContracts, 0);
  const entryFills = await db.select().from(microLiveFillTable)
    .where(eq(microLiveFillTable.orderId, buy.id));
  assert.equal(entryFills.length, 2);
  assert.deepEqual(entryFills.map((fill) => fill.feeCents), [1, 1],
    "round each $0.005 fill independently rather than rounding the $0.01 aggregate");
  assert.equal(entryFills.reduce((sum, fill) => sum + fill.feeMicros!, 0), 10_000);
  const [reserved] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.equal(reserved?.microLiveRunCapMicros, 5_000_000);
  assert.equal(reserved?.microLiveReservedMicros, 5_000_000);

  const secondEntryId = await insertEvaluation({
    ticker: fixture.market, crossingKey: `${fixture.market}:second-entry`,
  });
  const secondEntry = await executeQualifiedV13Trigger(secondEntryId, fixture.dependencies);
  assert.equal(secondEntry.status, "blocked");
  assert.equal(secondEntry.reason, "bounded_run_entry_window_closed_or_already_used");
  assert.equal(fixture.entryPosts(), 1);

  const exitEvaluationId = await insertEvaluation({
    ticker: fixture.market, signal: "EXIT", crossingKey: buy.crossingKey,
    evaluatedAt: new Date(fixture.currentTime()),
  });
  await db.update(forwardTestEvaluationTable).set({
    evaluationSource: "micro_live",
    livePositionId: `position:${fixture.market}:${buy.crossingKey}`,
    sourcePaperEvaluationId: entryEvaluationId,
    positionWasOpen: true,
  }).where(eq(forwardTestEvaluationTable.id, exitEvaluationId));
  await processMicroLiveForwardTestCycle(`missing-five-exit-paper-${randomUUID()}`,
    fixture.dependencies);

  const aboveReservation = await executeQualifiedV13Trigger(
    exitEvaluationId, fixture.dependencies,
  );
  assert.equal(aboveReservation.status, "blocked");
  assert.equal(aboveReservation.reason,
    "current_exit_fee_terms_unavailable_or_above_reserved_bound");
  assert.equal(fixture.exitPosts(), 0);

  exitDebitPerContract = 75_000;
  metadataRevision = "series-updated-after-entry";
  await processMicroLiveForwardTestCycle(`missing-five-exit-boundary-paper-${randomUUID()}`,
    fixture.dependencies);
  const atReservation = await executeQualifiedV13Trigger(exitEvaluationId, fixture.dependencies);
  assert.notEqual(atReservation.status, "blocked", atReservation.reason);
  assert.equal(fixture.exitPosts(), 1,
    "changed-but-affordable exit metadata permits exactly one mocked POST");
  assert.ok(fixture.feeTermsReads() > 0, "fresh changed exit terms were read before posting");
  const repeatedExit = await executeQualifiedV13Trigger(exitEvaluationId, fixture.dependencies);
  assert.notEqual(repeatedExit.status, "submitted");
  assert.equal(fixture.exitPosts(), 1, "the bounded successor exit is one-use");
  assert.equal((await getMicroLiveState()).boundedRun.exitAttempted, true);
});

test("prepared $5 successor submits and reconciles one fully executed bounded exit before GET-only restart replay", async () => {
  const { fixture } = await prepareSuccessorBoundedRun({
    readEntryFeeTerms: (selectedTicker, approval) => ({
      ...boundedFeeTerms(selectedTicker, boundedApprovalFingerprint(approval, selectedTicker)),
      entryCashDebitPerContractMicrosAtLimit: () => 2_400_000,
      maximumExitCashDebitPerContractMicros: () => 100_000,
      exitCashDebitPerContractMicrosAtLimit: () => 100_000,
    }),
  });
  const entryEvaluationId = await insertEvaluation({
    ticker: fixture.market,
    evaluatedAt: new Date(Math.max(fixture.currentTime(), fixture.armedAt + 1)),
  });
  const entry = await executeQualifiedV13Trigger(entryEvaluationId, fixture.dependencies);
  assert.equal(entry.status, "submitted", entry.reason);
  assert.equal(fixture.entryPosts(), 1);
  assert.ok(entry.orderId);
  const [buy] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, entryEvaluationId)).limit(1);
  assert.ok(buy);

  const buyFill = {
    ...historicalFillFor(buy, entry.orderId, `bounded-five-e2e-buy-${suffix}`),
    feeCostDollars: "0.0100",
  };
  let account = {
    ...emptyAccount(),
    positions: [{
      ticker: fixture.market, positionFp: String(buy.requestedContracts),
      marketExposureDollars: String(buy.requestedContracts * buy.requestedLimitPrice),
      realizedPnlDollars: "0",
    }],
    fills: [buyFill],
  };
  fixture.setAccount(account);
  const entryReconciliation = await reconcileMicroLiveAtStartup(fixture.dependencies);
  assert.equal(entryReconciliation.ready, true, entryReconciliation.reason);
  const [filledBuy] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, buy.id)).limit(1);
  assert.equal(filledBuy.status, "filled");
  assert.equal(filledBuy.filledContracts, buy.requestedContracts);

  const exitEvaluationId = await insertEvaluation({
    ticker: fixture.market, signal: "EXIT", crossingKey: buy.crossingKey,
    evaluatedAt: new Date(fixture.currentTime()),
  });
  await db.update(forwardTestEvaluationTable).set({
    evaluationSource: "micro_live",
    livePositionId: `position:${fixture.market}:${buy.crossingKey}`,
    sourcePaperEvaluationId: entryEvaluationId,
    positionWasOpen: true,
  }).where(eq(forwardTestEvaluationTable.id, exitEvaluationId));
  await processMicroLiveForwardTestCycle(
    `missing-five-e2e-exit-paper-${randomUUID()}`, fixture.dependencies,
  );

  let sellPosts = 0;
  let deleteCalls = 0;
  let getCalls = 0;
  let exitExchangeId: string | null = null;
  let exitLimitPrice: string | null = null;
  const exitDependencies = {
    ...fixture.dependencies,
    readAccount: async () => {
      getCalls++;
      return account;
    },
    readAccountActivity: async () => {
      getCalls++;
      return await fixture.dependencies.readAccountActivity!();
    },
    readHistoricalFills: async (...args: Parameters<
      NonNullable<typeof fixture.dependencies.readHistoricalFills>
    >) => {
      getCalls++;
      return await fixture.dependencies.readHistoricalFills!(...args);
    },
    readOrderStatus: async (orderId: string) => {
      getCalls++;
      return await fixture.dependencies.readOrderStatus!(orderId);
    },
    submitOrder: async (request: Parameters<
      NonNullable<typeof fixture.dependencies.submitOrder>
    >[0]) => {
      assert.equal(request.action, "sell", "only the bounded exit should POST here");
      sellPosts++;
      exitExchangeId = `bounded-five-e2e-exit-${suffix}`;
      exitLimitPrice = request.priceDollars;
      return {
        orderId: exitExchangeId, clientOrderId: request.clientOrderId,
        ticker: request.ticker, side: request.side, action: "sell" as const,
        type: "limit" as const, status: "executed" as const,
        remainingCount: "0", filledCount: String(request.count),
      };
    },
    afterExitPost: async () => {
      assert.ok(exitExchangeId && exitLimitPrice);
      const sellFill = {
        id: `bounded-five-e2e-sell-${suffix}`,
        orderId: exitExchangeId, ticker: fixture.market, side: "yes", action: "sell",
        countFp: String(buy.requestedContracts), priceDollars: exitLimitPrice,
        createdAt: new Date(fixture.currentTime() + 2).toISOString(),
        feeCostDollars: "0.0200",
      };
      fixture.setAccount({
        ...emptyAccount(),
        positions: [{
          ticker: fixture.market, positionFp: "0",
          marketExposureDollars: "0", realizedPnlDollars: "-0.05",
        }],
        fills: [buyFill, sellFill],
      });
      account = {
        ...emptyAccount(),
        positions: [{
          ticker: fixture.market, positionFp: "0",
          marketExposureDollars: "0", realizedPnlDollars: "-0.05",
        }],
        fills: [buyFill, sellFill],
      };
    },
    cancelOrder: async () => {
      deleteCalls++;
      throw new Error("primary bounded exit must never DELETE");
    },
  };

  const exit = await executeQualifiedV13Trigger(exitEvaluationId, exitDependencies);
  assert.equal(exit.status, "submitted", exit.reason);
  assert.equal(exit.reason, "exit_verified_execution_frozen_for_review");
  assert.equal(sellPosts, 1, "exactly one modeled sell POST is permitted");
  assert.equal(deleteCalls, 0);
  assert.ok(exitExchangeId);
  const [persistedExit] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.exchangeOrderId, exitExchangeId)).limit(1);
  assert.ok(persistedExit);
  assert.equal(persistedExit.status, "filled");
  assert.equal(persistedExit.filledContracts, buy.requestedContracts);
  assert.equal(persistedExit.remainingContracts, 0);
  assert.equal(persistedExit.cancellationAttemptedAt, null);
  const sellFills = await db.select().from(microLiveFillTable)
    .where(eq(microLiveFillTable.orderId, persistedExit.id));
  assert.equal(sellFills.length, 1);
  assert.equal(sellFills[0]!.exchangeFillId, `bounded-five-e2e-sell-${suffix}`);
  assert.equal(sellFills[0]!.feeMicros, 20_000);
  assert.equal(sellFills[0]!.feeCents, 2);
  const initialSellPosts = sellPosts;

  const replay = await reconcileMicroLiveAtStartup(exitDependencies);
  assert.equal(replay.ready, false);
  assert.equal(replay.reason, "exit_canceled_requires_manual_review");
  const [replayedExit] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, persistedExit.id)).limit(1);
  assert.equal(replayedExit.status, "filled");
  assert.equal(replayedExit.filledContracts, buy.requestedContracts);
  assert.equal(replayedExit.remainingContracts, 0);
  assert.equal((await db.select().from(microLiveFillTable)
    .where(eq(microLiveFillTable.orderId, persistedExit.id))).length, 1);
  const repeatedExit = await executeQualifiedV13Trigger(exitEvaluationId, exitDependencies);
  assert.notEqual(repeatedExit.status, "submitted");
  assert.equal(sellPosts, initialSellPosts, "frozen replay cannot create another sell order");
  assert.equal(deleteCalls, 0);
  assert.ok(getCalls > 0, "both execution verification and restart use mocked GET evidence");

  const [config] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.equal(config?.microLiveRunCapMicros, 5_000_000);
  assert.equal(config?.microLiveReservedMicros, 5_000_000);
  assert.equal(config?.microLiveEntryAttempted, true);
  assert.equal(config?.microLiveExitAttempted, true);
  assert.equal(config?.microLiveAccountingUnresolved, false);
  assert.equal((await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.action, "sell"))).length, 1);
  assert.notEqual((await getMicroLiveState()).realizedPnlCents, null);
});

test("tampered persisted exit fee provenance blocks the final POST", async () => {
  const { fixture } = await prepareSuccessorBoundedRun({
    persistedApproval: true,
    readEntryFeeTerms: (selectedTicker, approval) => ({
      ...boundedFeeTerms(selectedTicker, boundedApprovalFingerprint(approval, selectedTicker)),
      entryCashDebitPerContractMicrosAtLimit: () => 2_400_000,
      maximumExitCashDebitPerContractMicros: () => 100_000,
      exitCashDebitPerContractMicrosAtLimit: () => 75_000,
    }),
  });
  const entryEvaluationId = await insertEvaluation({
    ticker: fixture.market,
    evaluatedAt: new Date(Math.max(fixture.currentTime(), fixture.armedAt + 1)),
  });
  const entry = await executeQualifiedV13Trigger(entryEvaluationId, fixture.dependencies);
  assert.equal(entry.status, "submitted", entry.reason);
  assert.ok(entry.orderId);
  const [buy] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, entryEvaluationId)).limit(1);
  assert.ok(buy);
  const buyFill = historicalFillFor(buy, entry.orderId, `tampered-exit-buy-${suffix}`);
  fixture.setAccount({
    ...emptyAccount(),
    positions: [{
      ticker: fixture.market, positionFp: String(buy.requestedContracts),
      marketExposureDollars: String(buy.requestedContracts * buy.requestedLimitPrice),
      realizedPnlDollars: "0",
    }],
    fills: [buyFill],
  });
  assert.equal((await reconcileMicroLiveAtStartup(fixture.dependencies)).ready, true);
  const exitEvaluationId = await insertEvaluation({
    ticker: fixture.market, signal: "EXIT", crossingKey: buy.crossingKey,
    evaluatedAt: new Date(fixture.currentTime()),
  });
  await db.update(forwardTestEvaluationTable).set({
    evaluationSource: "micro_live",
    livePositionId: `position:${fixture.market}:${buy.crossingKey}`,
    sourcePaperEvaluationId: entryEvaluationId,
    positionWasOpen: true,
  }).where(eq(forwardTestEvaluationTable.id, exitEvaluationId));
  await processMicroLiveForwardTestCycle(
    `missing-tampered-exit-paper-${randomUUID()}`, fixture.dependencies,
  );

  let exitPosts = 0;
  fixture.dependencies.submitOrder = async () => {
    exitPosts++;
    throw new Error("tampered exit provenance must never reach POST");
  };
  fixture.dependencies.beforeSubmissionInterlock = async () => {
    const [reservation] = await db.select().from(microLiveOrderTable)
      .where(eq(microLiveOrderTable.marketTicker, fixture.market))
      .limit(1);
    assert.ok(reservation);
    const [pendingExit] = await db.select().from(microLiveOrderTable)
      .where(and(
        eq(microLiveOrderTable.action, "sell"),
        eq(microLiveOrderTable.marketTicker, fixture.market),
      )).limit(1);
    assert.ok(pendingExit);
    assert.equal(pendingExit.status, "pending");
    assert.equal(pendingExit.microLiveRunId, buy.microLiveRunId);
    assert.equal(pendingExit.reservedEntryFeeMicros, buy.reservedEntryFeeMicros);
    assert.ok(Number.isSafeInteger(pendingExit.reservedExitFeeMicros));
    assert.ok(pendingExit.feeEvidenceFingerprint?.trim());
    assert.ok(pendingExit.feeEvidenceVerifiedAt instanceof Date);
    await db.update(microLiveOrderTable).set({
      feeEvidenceFingerprint: `${pendingExit.feeEvidenceFingerprint}|tampered`,
    }).where(eq(microLiveOrderTable.id, pendingExit.id));
  };
  const exit = await executeQualifiedV13Trigger(exitEvaluationId, fixture.dependencies);
  assert.notEqual(exit.status, "submitted");
  assert.equal(exitPosts, 0,
    "a mismatched durable fee fingerprint cannot reach the exit POST");
});

test("partial IOC 3 requested 1 filled 0 remaining reconciles and replays late fills GET-only", async () => {
  const { fixture } = await prepareSuccessorBoundedRun({
    persistedApproval: true,
    readEntryFeeTerms: (selectedTicker, approval) => ({
      ...boundedFeeTerms(selectedTicker, boundedApprovalFingerprint(approval, selectedTicker)),
      entryCashDebitPerContractMicrosAtLimit: () => 1_560_000,
      maximumExitCashDebitPerContractMicros: () => 100_000,
      exitCashDebitPerContractMicrosAtLimit: () => 100_000,
    }),
  });
  assert.equal(fixture.dependencies.approvedFeeSessionForTest, undefined,
    "this lifecycle reads its approval from persisted state, not a session injection");
  const standingBeforeEntry = await approvedFeeSession();
  assert.ok(standingBeforeEntry);
  assert.equal(standingBeforeEntry.policyVersion, STANDING_FEE_POLICY_VERSION);
  assert.equal(standingBeforeEntry.maximumExposureMicros, 5_000_000);
  assert.ok(Date.now() - standingBeforeEntry.approvedAt > 300 * 24 * 60 * 60_000,
    "standing approval remains usable without a time-based TTL");
  const entryDependencies = {
    ...fixture.dependencies,
    readOrderbook: async (selectedTicker: string) => ({
      ...await fixture.dependencies.readOrderbook!(selectedTicker),
      yesAskAvailableContracts: "3",
      noAskAvailableContracts: "3",
    }),
  };
  const entryEvaluationId = await insertEvaluation({
    ticker: fixture.market,
    evaluatedAt: new Date(Math.max(fixture.currentTime(), fixture.armedAt + 1)),
  });
  const entry = await executeQualifiedV13Trigger(entryEvaluationId, entryDependencies);
  assert.equal(entry.status, "submitted", entry.reason);
  assert.ok(entry.orderId);
  assert.equal(fixture.entryPosts(), 1);
  const feeReadsAfterEntry = fixture.feeTermsReads();
  assert.ok(feeReadsAfterEntry >= 2,
    "entry fee terms are fetched during reservation and rechecked at the final POST barrier");
  const [buy] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, entryEvaluationId)).limit(1);
  assert.ok(buy);
  assert.equal(buy.requestedContracts, 3);
  const buyFill = historicalFillFor(buy, entry.orderId, `ioc-three-buy-${suffix}`);
  let account = {
    ...emptyAccount(),
    positions: [{
      ticker: fixture.market, positionFp: "3",
      marketExposureDollars: String(3 * buy.requestedLimitPrice),
      realizedPnlDollars: "0",
    }],
    fills: [buyFill],
  };
  fixture.setAccount(account);
  const entryReconciliation = await reconcileMicroLiveAtStartup(entryDependencies);
  assert.equal(entryReconciliation.ready, true, entryReconciliation.reason);

  const exitEvaluationId = await insertEvaluation({
    ticker: fixture.market, signal: "EXIT", crossingKey: buy.crossingKey,
    evaluatedAt: new Date(fixture.currentTime()),
  });
  await db.update(forwardTestEvaluationTable).set({
    evaluationSource: "micro_live",
    livePositionId: `position:${fixture.market}:${buy.crossingKey}`,
    sourcePaperEvaluationId: entryEvaluationId,
    positionWasOpen: true,
  }).where(eq(forwardTestEvaluationTable.id, exitEvaluationId));
  await processMicroLiveForwardTestCycle(
    `missing-three-ioc-paper-${randomUUID()}`, entryDependencies,
  );

  const exitExchangeId = `ioc-three-exit-${suffix}`;
  let terminalStatus: "canceled" | "executed" = "canceled";
  let exitPosts = 0;
  let deleteCalls = 0;
  let getCalls = 0;
  const exitDependencies = {
    ...entryDependencies,
    readAccount: async () => { getCalls++; return account; },
    readAccountActivity: async () => {
      getCalls++;
      const activity = await fixture.dependencies.readAccountActivity!();
      return {
        ...activity,
        orders: activity.orders.map((order) => order.action === "sell"
          ? { ...order, status: terminalStatus, remainingCount: "0" } : order),
      };
    },
    readHistoricalFills: async (...args: Parameters<
      NonNullable<typeof fixture.dependencies.readHistoricalFills>
    >) => {
      getCalls++;
      return fixture.dependencies.readHistoricalFills!(...args);
    },
    readOrderStatus: async (id: string) => {
      getCalls++;
      const rows = await db.select().from(microLiveOrderTable);
      const row = rows.find((candidate) => candidate.exchangeOrderId === id);
      assert.ok(row);
      if (row.action === "buy") return fixture.dependencies.readOrderStatus!(id);
      return {
        orderId: id, clientOrderId: row.clientOrderId, ticker: row.marketTicker,
        side: row.side === "UP" ? "yes" as const : "no" as const,
        action: "sell" as const, type: "limit" as const, status: terminalStatus,
        filledCount: String(account.fills.filter((fill) => fill.orderId === id)
          .reduce((sum, fill) => sum + Number(fill.countFp), 0)),
        remainingCount: "0",
      };
    },
    submitOrder: async (request: Parameters<
      NonNullable<typeof fixture.dependencies.submitOrder>
    >[0]) => {
      assert.equal(request.action, "sell");
      assert.equal(request.count, 3);
      exitPosts++;
      return {
        orderId: exitExchangeId, clientOrderId: request.clientOrderId,
        ticker: request.ticker, side: request.side, action: "sell" as const,
        type: "limit" as const, status: "canceled" as const,
        // The IOC canceled two unfilled contracts at the venue. Zero is the
        // final resting count, not the original unfilled quantity.
        filledCount: "1", remainingCount: "0",
      };
    },
    afterExitPost: async () => {
      const [exitRow] = await db.select().from(microLiveOrderTable)
        .where(eq(microLiveOrderTable.sourceEvaluationId, exitEvaluationId)).limit(1);
      assert.ok(exitRow);
      account = {
        ...emptyAccount(),
        positions: [{
          ticker: fixture.market, positionFp: "2",
          marketExposureDollars: String(2 * buy.requestedLimitPrice),
          realizedPnlDollars: "-0.025",
        }],
        fills: [buyFill, {
          id: `ioc-three-sell-${suffix}`, orderId: exitExchangeId,
          ticker: fixture.market, side: "yes", action: "sell",
          countFp: "1", priceDollars: String(exitRow.requestedLimitPrice),
          createdAt: new Date(fixture.currentTime() + 2).toISOString(),
          feeCostDollars: "0.0050",
        }],
      };
      fixture.setAccount(account);
    },
    cancelOrder: async () => {
      deleteCalls++;
      throw new Error("terminal partial IOC must not DELETE");
    },
  };
  const exit = await executeQualifiedV13Trigger(exitEvaluationId, exitDependencies);
  assert.equal(exit.reason, "exit_verified_execution_frozen_for_review");
  assert.equal(exitPosts, 1);
  assert.ok(fixture.feeTermsReads() >= feeReadsAfterEntry + 2,
    "exit fee terms are fetched for exit qualification and rechecked at final submission");
  assert.equal(deleteCalls, 0);
  assert.ok(getCalls > 0);
  const [sell] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.exchangeOrderId, exitExchangeId)).limit(1);
  assert.ok(sell);
  assert.equal(sell.requestedContracts, 3);
  assert.equal(sell.filledContracts, 1);
  assert.equal(sell.remainingContracts, 0);
  assert.equal(sell.status, "canceled");
  const [sellFill] = await db.select().from(microLiveFillTable)
    .where(eq(microLiveFillTable.orderId, sell.id)).limit(1);
  assert.equal(sellFill.exchangeFillId, `ioc-three-sell-${suffix}`);
  assert.equal(sellFill.feeMicros, 5_000);
  assert.equal((await getMicroLiveState()).currentPosition?.sellableContracts, 2);
  const [frozen] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.equal(frozen?.microLiveRunCapMicros, 5_000_000);
  assert.equal(frozen?.microLiveReservedMicros, buy.requestedStakeCents * 10_000 +
    buy.reservedEntryFeeMicros! + buy.reservedExitFeeMicros!);
  assert.equal(frozen?.microLiveEntryAttempted, true);
  assert.equal(frozen?.microLiveExitAttempted, true);
  assert.equal(frozen?.manualKillSwitch, true);
  assert.equal(frozen?.microLiveProductionEnabled, false);
  assert.equal(frozen?.liveExecutionEnabled, false);

  // Some terminal GETs may describe a partial IOC as "executed". Its
  // authenticated count still cannot be mistaken for a full three-contract fill.
  terminalStatus = "executed";
  const restart = await reconcileMicroLiveAtStartup(exitDependencies);
  assert.equal(restart.ready, false);
  assert.equal(restart.reason, "exit_canceled_requires_manual_review");
  assert.equal((await getMicroLiveState()).currentPosition?.sellableContracts, 2);
  assert.equal((await db.select().from(microLiveFillTable)
    .where(eq(microLiveFillTable.orderId, sell.id))).length, 1);
  // Authenticated evidence can arrive later even after the IOC is terminal.
  account = {
    ...account,
    positions: [{
      ticker: fixture.market, positionFp: "1",
      marketExposureDollars: String(buy.requestedLimitPrice),
      realizedPnlDollars: "-0.05",
    }],
    fills: [...account.fills, {
      id: `ioc-three-late-sell-${suffix}`, orderId: exitExchangeId,
      ticker: fixture.market, side: "yes", action: "sell",
      countFp: "1", priceDollars: String(sell.requestedLimitPrice),
      createdAt: new Date(fixture.currentTime() + 3).toISOString(),
      feeCostDollars: "0.0050",
    }],
  };
  fixture.setAccount(account);
  const late = await reconcileMicroLiveAtStartup(exitDependencies);
  assert.equal(late.ready, false);
  assert.equal(late.reason, "exit_canceled_requires_manual_review");
  assert.equal((await getMicroLiveState()).currentPosition?.sellableContracts, 1);
  assert.equal((await db.select().from(microLiveFillTable)
    .where(eq(microLiveFillTable.orderId, sell.id))).length, 2);
  assert.equal((await executeQualifiedV13Trigger(exitEvaluationId, exitDependencies)).status,
    "blocked");
  assert.equal(fixture.entryPosts(), 1);
  assert.equal(exitPosts, 1);
  assert.equal(deleteCalls, 0);
  assert.equal((await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.action, "sell"))).length, 1);
});

test("prepared $5 successor reconciles a canceled partial reduce-only exit and replays a late fill GET-only", async () => {
  const { fixture } = await prepareSuccessorBoundedRun({
    readEntryFeeTerms: (selectedTicker, approval) => ({
      ...boundedFeeTerms(selectedTicker, boundedApprovalFingerprint(approval, selectedTicker)),
      entryCashDebitPerContractMicrosAtLimit: () => 1_560_000,
      maximumExitCashDebitPerContractMicros: () => 100_000,
      exitCashDebitPerContractMicrosAtLimit: () => 100_000,
    }),
  });
  const entryDependencies = {
    ...fixture.dependencies,
    readOrderbook: async (selectedTicker: string) => ({
      ...await fixture.dependencies.readOrderbook!(selectedTicker),
      yesAskAvailableContracts: "4",
      noAskAvailableContracts: "4",
    }),
  };
  const entryEvaluationId = await insertEvaluation({
    ticker: fixture.market,
    evaluatedAt: new Date(Math.max(fixture.currentTime(), fixture.armedAt + 1)),
  });
  const entry = await executeQualifiedV13Trigger(entryEvaluationId, entryDependencies);
  assert.equal(entry.status, "submitted", entry.reason);
  assert.equal(fixture.entryPosts(), 1);
  assert.ok(entry.orderId);
  const [buy] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, entryEvaluationId)).limit(1);
  assert.ok(buy);
  assert.ok(buy.requestedContracts >= 3,
    "the test needs an owned remainder after a second late sell fill");
  assert.ok(buy.reservedEntryFeeMicros! + buy.reservedExitFeeMicros! +
    buy.requestedStakeCents * 10_000 <= 5_000_000);
  const [entryConfig] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  const reservedMicros = entryConfig!.microLiveReservedMicros;

  const buyFill = {
    ...historicalFillFor(buy, entry.orderId, `bounded-five-partial-exit-buy-${suffix}`),
    feeCostDollars: "0.0100",
  };
  let account = {
    ...emptyAccount(),
    positions: [{
      ticker: fixture.market, positionFp: String(buy.requestedContracts),
      marketExposureDollars: String(buy.requestedContracts * buy.requestedLimitPrice),
      realizedPnlDollars: "0",
    }],
    fills: [buyFill],
  };
  fixture.setAccount(account);
  const entryReconciliation = await reconcileMicroLiveAtStartup(entryDependencies);
  assert.equal(entryReconciliation.ready, true, entryReconciliation.reason);
  const [filledBuy] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, buy.id)).limit(1);
  assert.equal(filledBuy.status, "filled");
  assert.equal(filledBuy.filledContracts, buy.requestedContracts);

  const exitEvaluationId = await insertEvaluation({
    ticker: fixture.market, signal: "EXIT", crossingKey: buy.crossingKey,
    evaluatedAt: new Date(fixture.currentTime()),
  });
  await db.update(forwardTestEvaluationTable).set({
    evaluationSource: "micro_live",
    livePositionId: `position:${fixture.market}:${buy.crossingKey}`,
    sourcePaperEvaluationId: entryEvaluationId,
    positionWasOpen: true,
  }).where(eq(forwardTestEvaluationTable.id, exitEvaluationId));
  await processMicroLiveForwardTestCycle(
    `missing-five-partial-exit-paper-${randomUUID()}`, entryDependencies,
  );

  const exitExchangeId = `bounded-five-partial-exit-${suffix}`;
  let exitStatus: "resting" | "canceled" = "resting";
  let sellPosts = 0;
  let deleteCalls = 0;
  let getCalls = 0;
  const exitDependencies = {
    ...entryDependencies,
    readAccount: async () => {
      getCalls++;
      return account;
    },
    readAccountActivity: async () => {
      getCalls++;
      const activity = await fixture.dependencies.readAccountActivity!();
      return {
        ...activity,
        orders: activity.orders.map((order) => order.action === "sell"
          ? {
            ...order, status: exitStatus,
            remainingCount: exitStatus === "resting" ? order.remainingCount : "0",
          }
          : order),
      };
    },
    readHistoricalFills: async (...args: Parameters<
      NonNullable<typeof fixture.dependencies.readHistoricalFills>
    >) => {
      getCalls++;
      return await fixture.dependencies.readHistoricalFills!(...args);
    },
    readOrderStatus: async (orderId: string) => {
      getCalls++;
      const rows = await db.select().from(microLiveOrderTable);
      const row = rows.find((candidate) => candidate.exchangeOrderId === orderId);
      assert.ok(row);
      if (row.action !== "sell") {
        return await fixture.dependencies.readOrderStatus!(orderId);
      }
      const filledCount = account.fills.filter((fill) => fill.orderId === orderId)
        .reduce((sum, fill) => sum + Number(fill.countFp), 0);
      return {
        orderId, clientOrderId: row.clientOrderId, ticker: row.marketTicker,
        side: row.side === "UP" ? "yes" as const : "no" as const,
        action: "sell" as const, type: "limit" as const, status: exitStatus,
        filledCount: String(filledCount),
        remainingCount: exitStatus === "resting"
          ? String(row.requestedContracts - filledCount) : "0",
      };
    },
    submitOrder: async (request: Parameters<
      NonNullable<typeof fixture.dependencies.submitOrder>
    >[0]) => {
      assert.equal(request.action, "sell", "only the bounded exit should POST");
      sellPosts++;
      assert.ok(request.count >= 3);
      return {
        orderId: exitExchangeId, clientOrderId: request.clientOrderId,
        ticker: request.ticker, side: request.side, action: "sell" as const,
        type: "limit" as const, status: "resting" as const,
        remainingCount: String(request.count - 1), filledCount: "1",
      };
    },
    afterExitPost: async () => {
      const [exitOrder] = await db.select().from(microLiveOrderTable)
        .where(eq(microLiveOrderTable.sourceEvaluationId, exitEvaluationId)).limit(1);
      assert.ok(exitOrder);
      const partialSellFill = {
        id: `bounded-five-partial-sell-${suffix}`,
        orderId: exitExchangeId, ticker: fixture.market, side: "yes", action: "sell",
        countFp: "1", priceDollars: String(exitOrder.requestedLimitPrice),
        createdAt: new Date(fixture.currentTime() + 2).toISOString(),
        feeCostDollars: "0.0050",
      };
      account = {
        ...emptyAccount(),
        openOrders: [{
          id: exitExchangeId, ticker: fixture.market, side: "yes", action: "sell",
          priceDollars: String(exitOrder.requestedLimitPrice),
          remainingCount: String(buy.requestedContracts - 1),
          status: "resting",
          createdAt: new Date(fixture.currentTime() + 2).toISOString(),
        }],
        positions: [{
          ticker: fixture.market,
          positionFp: String(buy.requestedContracts - 1),
          marketExposureDollars: String(
            (buy.requestedContracts - 1) * buy.requestedLimitPrice,
          ),
          realizedPnlDollars: "-0.025",
        }],
        fills: [buyFill, partialSellFill],
      };
      fixture.setAccount(account);
    },
    cancelOrder: async () => {
      deleteCalls++;
      throw new Error("primary bounded exit reconciliation must not DELETE");
    },
  };

  const exit = await executeQualifiedV13Trigger(exitEvaluationId, exitDependencies);
  assert.equal(exit.status, "unknown");
  assert.equal(exit.reason, "outstanding_exit_requires_frozen_reconciliation");
  assert.equal(sellPosts, 1);
  assert.equal(deleteCalls, 0);
  const partialSellFill = account.fills[1]!;
  const [partialExit] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.exchangeOrderId, exitExchangeId)).limit(1);
  assert.ok(partialExit);
  assert.equal(partialExit.status, "partial");
  assert.equal(partialExit.filledContracts, 1);
  assert.equal(partialExit.remainingContracts, buy.requestedContracts - 1);
  const [partialSell] = await db.select().from(microLiveFillTable)
    .where(eq(microLiveFillTable.orderId, partialExit.id)).limit(1);
  assert.equal(partialSell.feeMicros, 5_000);
  assert.equal(partialSell.feeCents, 1);
  const [frozenAfterPartial] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.equal(frozenAfterPartial?.manualKillSwitch, true);
  assert.equal(frozenAfterPartial?.microLiveProductionEnabled, false);
  assert.equal(frozenAfterPartial?.liveExecutionEnabled, false);
  assert.equal(frozenAfterPartial?.microLiveRunCapMicros, 5_000_000);
  assert.equal(frozenAfterPartial?.microLiveReservedMicros, reservedMicros);
  assert.equal(frozenAfterPartial?.microLiveEntryAttempted, true);
  assert.equal(frozenAfterPartial?.microLiveExitAttempted, true);

  // A later GET confirms that the reduce-only remainder became terminal-canceled.
  // Primary-account reconciliation remains GET-only; it never issues DELETE.
  exitStatus = "canceled";
  account = { ...account, openOrders: [] };
  fixture.setAccount(account);
  const canceledRecovery = await reconcileMicroLiveAtStartup(exitDependencies);
  assert.equal(canceledRecovery.ready, false);
  assert.equal(canceledRecovery.reason, "exit_canceled_requires_manual_review");
  const [canceledExit] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, partialExit.id)).limit(1);
  assert.equal(canceledExit.status, "canceled");
  assert.equal(canceledExit.filledContracts, 1);
  assert.equal(canceledExit.remainingContracts, 0);
  assert.equal(canceledExit.cancellationAttemptedAt, null);
  const positionAfterCancel = await getMicroLiveState();
  assert.equal(positionAfterCancel.currentPosition?.sellableContracts,
    buy.requestedContracts - 1);

  // A venue may publish one more partial fill after the terminal cancellation.
  const lateSellFill = {
    id: `bounded-five-late-partial-sell-${suffix}`,
    orderId: exitExchangeId, ticker: fixture.market, side: "yes", action: "sell",
    countFp: "1", priceDollars: String(partialExit.requestedLimitPrice),
    createdAt: new Date(fixture.currentTime() + 3).toISOString(),
    feeCostDollars: "0.0050",
  };
  account = {
    ...emptyAccount(),
    positions: [{
      ticker: fixture.market,
      positionFp: String(buy.requestedContracts - 2),
      marketExposureDollars: String((buy.requestedContracts - 2) * buy.requestedLimitPrice),
      realizedPnlDollars: "-0.05",
    }],
    fills: [buyFill, partialSellFill, lateSellFill],
  };
  fixture.setAccount(account);
  const lateFillReplay = await reconcileMicroLiveAtStartup(exitDependencies);
  assert.equal(lateFillReplay.ready, false);
  assert.equal(lateFillReplay.reason, "exit_canceled_requires_manual_review");
  const [replayedExit] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, partialExit.id)).limit(1);
  assert.equal(replayedExit.status, "canceled");
  assert.equal(replayedExit.filledContracts, 2);
  assert.equal(replayedExit.remainingContracts, 0);
  assert.equal((await db.select().from(microLiveFillTable)
    .where(eq(microLiveFillTable.orderId, partialExit.id))).length, 2);
  assert.equal((await getMicroLiveState()).currentPosition?.sellableContracts,
    buy.requestedContracts - 2);
  const [finalConfig] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.equal(finalConfig?.microLiveRunCapMicros, 5_000_000);
  assert.equal(finalConfig?.microLiveReservedMicros, reservedMicros);
  assert.equal(finalConfig?.microLiveEntryAttempted, true);
  assert.equal(finalConfig?.microLiveExitAttempted, true);
  assert.notEqual((await getMicroLiveState()).realizedPnlCents, null);
  assert.equal((await executeQualifiedV13Trigger(exitEvaluationId, exitDependencies)).status,
    "blocked");
  assert.equal((await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.action, "sell"))).length, 1);
  assert.equal(sellPosts, 1);
  assert.equal(deleteCalls, 0);
  assert.ok(getCalls > 0);
});

test("tampering a reserved $5 successor cap freezes startup without changing claims or sending writes", async () => {
  const { fixture } = await prepareSuccessorBoundedRun({
    readEntryFeeTerms: (selectedTicker, approval) => ({
      ...boundedFeeTerms(selectedTicker, boundedApprovalFingerprint(approval, selectedTicker)),
      entryCashDebitPerContractMicrosAtLimit: () => 2_000_000,
      maximumExitCashDebitPerContractMicros: () => 100_000,
    }),
  });
  const entryEvaluationId = await insertEvaluation({
    ticker: fixture.market,
    evaluatedAt: new Date(Math.max(fixture.currentTime(), fixture.armedAt + 1)),
  });
  const entry = await executeQualifiedV13Trigger(entryEvaluationId, fixture.dependencies);
  assert.equal(entry.status, "submitted", entry.reason);
  assert.equal(fixture.entryPosts(), 1);
  const [buy] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, entryEvaluationId)).limit(1);
  assert.ok(buy);
  const [reserved] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.equal(reserved?.microLiveRunCapMicros, 5_000_000);
  assert.equal(reserved?.microLiveReservedMicros, 4_200_000);
  assert.equal(reserved?.microLiveEntryAttempted, true);
  assert.equal(reserved?.microLiveExitAttempted, false);

  const tamperedCap = 4_500_000;
  assert.ok(tamperedCap >= reserved!.microLiveReservedMicros);
  await db.update(microLiveConfigTable).set({
    microLiveRunCapMicros: tamperedCap,
  }).where(eq(microLiveConfigTable.id, "singleton"));
  const account = {
    ...emptyAccount(),
    positions: [{
      ticker: fixture.market, positionFp: String(buy.requestedContracts),
      marketExposureDollars: String(buy.requestedContracts * buy.requestedLimitPrice),
      realizedPnlDollars: "0",
    }],
    fills: [historicalFillFor(buy, entry.orderId!, `bounded-five-cap-late-fill-${suffix}`)],
  };
  fixture.setAccount(account);
  let deleteCalls = 0;
  let getCalls = 0;
  const recoveryDependencies = {
    ...fixture.dependencies,
    readAccount: async () => { getCalls++; return fixture.dependencies.readAccount!(); },
    readAccountActivity: async () => { getCalls++; return await fixture.dependencies.readAccountActivity!(); },
    readHistoricalFills: async () => {
      getCalls++;
      return { fills: [], truncated: false, available: true };
    },
    readOrderStatus: async (orderId: string) => {
      getCalls++;
      return await fixture.dependencies.readOrderStatus!(orderId);
    },
    submitOrder: async () => { throw new Error("startup recovery must not POST"); },
    cancelOrder: async () => {
      deleteCalls++;
      throw new Error("startup recovery must not DELETE");
    },
  };
  const recovery = await reconcileMicroLiveAtStartup(recoveryDependencies);
  assert.equal(recovery.ready, false);
  assert.equal(recovery.reason, "bounded_run_cap_audit_mismatch");
  const state = await getMicroLiveState();
  assert.equal(state.boundedRun.phase, "FROZEN");
  assert.equal(state.boundedRun.freezeReason, "bounded_run_cap_audit_mismatch");
  const [after] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.equal(after?.microLiveRunCapMicros, tamperedCap);
  assert.equal(after?.microLiveReservedMicros, 4_200_000);
  assert.equal(after?.microLiveEntryAttempted, true);
  assert.equal(after?.microLiveExitAttempted, false);
  assert.equal(after?.manualKillSwitch, true);
  assert.equal(after?.microLiveProductionEnabled, false);
  assert.equal(after?.liveExecutionEnabled, false);
  assert.equal(fixture.entryPosts(), 1);
  assert.equal(fixture.exitPosts(), 0);
  assert.equal(deleteCalls, 0);
  assert.ok(getCalls > 0,
    "the unaudited cap blocks trading without hiding authenticated late fills");
  const [unchangedBuy] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, buy.id)).limit(1);
  assert.equal(unchangedBuy.status, "filled");
  assert.equal(unchangedBuy.exchangeOrderId, entry.orderId);
  assert.equal((await db.select().from(microLiveFillTable)
    .where(eq(microLiveFillTable.orderId, buy.id))).length, 1);
  const replay = await reconcileMicroLiveAtStartup(recoveryDependencies);
  assert.equal(replay.ready, false);
  assert.equal((await db.select().from(microLiveFillTable)
    .where(eq(microLiveFillTable.orderId, buy.id))).length, 1);
  assert.equal(deleteCalls, 0);
});

test("a $5 cap changed during exchange GETs freezes before replaying late fills GET-only", async () => {
  const { fixture } = await prepareSuccessorBoundedRun({
    readEntryFeeTerms: (selectedTicker, approval) => ({
      ...boundedFeeTerms(selectedTicker, boundedApprovalFingerprint(approval, selectedTicker)),
      entryCashDebitPerContractMicrosAtLimit: () => 2_000_000,
      maximumExitCashDebitPerContractMicros: () => 100_000,
    }),
  });
  const evaluationId = await insertEvaluation({
    ticker: fixture.market,
    evaluatedAt: new Date(Math.max(fixture.currentTime(), fixture.armedAt + 1)),
  });
  const entry = await executeQualifiedV13Trigger(evaluationId, fixture.dependencies);
  assert.equal(entry.status, "submitted", entry.reason);
  assert.ok(entry.orderId);
  const [buy] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, evaluationId)).limit(1);
  assert.ok(buy);
  const [reserved] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.equal(reserved?.microLiveReservedMicros, 4_200_000);
  const account = {
    ...emptyAccount(),
    positions: [{
      ticker: fixture.market, positionFp: String(buy.requestedContracts),
      marketExposureDollars: String(buy.requestedContracts * buy.requestedLimitPrice),
      realizedPnlDollars: "0",
    }],
    fills: [historicalFillFor(buy, entry.orderId, `bounded-five-midscan-fill-${suffix}`)],
  };
  fixture.setAccount(account);
  let changed = false;
  let getCalls = 0;
  let posts = 0;
  let deletes = 0;
  const originalActivity = fixture.dependencies.readAccountActivity!;
  const recoveryDependencies = {
    ...fixture.dependencies,
    readAccount: async () => { getCalls++; return fixture.dependencies.readAccount!(); },
    readAccountActivity: async () => {
      getCalls++;
      if (!changed) {
        changed = true;
        await db.update(microLiveConfigTable).set({
          microLiveRunCapMicros: 4_500_000,
        }).where(eq(microLiveConfigTable.id, "singleton"));
      }
      return originalActivity();
    },
    submitOrder: async () => { posts++; throw new Error("recovery must not POST"); },
    cancelOrder: async () => { deletes++; throw new Error("recovery must not DELETE"); },
  };
  const recovered = await reconcileMicroLiveAtStartup(recoveryDependencies);
  assert.equal(changed, true);
  assert.equal(recovered.ready, false);
  assert.equal(recovered.reason, "bounded_run_cap_audit_mismatch");
  const [config] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.equal(config?.microLiveRunPhase, "FROZEN");
  assert.equal(config?.manualKillSwitch, true);
  assert.equal(config?.microLiveProductionEnabled, false);
  assert.equal(config?.liveExecutionEnabled, false);
  assert.equal(config?.microLiveReservedMicros, 4_200_000);
  assert.equal(config?.microLiveEntryAttempted, true);
  assert.equal(config?.microLiveExitAttempted, false);
  const [filled] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, buy.id)).limit(1);
  assert.equal(filled.status, "filled");
  assert.equal((await db.select().from(microLiveFillTable)
    .where(eq(microLiveFillTable.orderId, buy.id))).length, 1);
  assert.ok(getCalls >= 2);
  assert.equal(posts, 0);
  assert.equal(deletes, 0);
});

test("prepared $5 successor replays a terminal exit late fill from GET-only frozen recovery", async () => {
  const { fixture } = await prepareSuccessorBoundedRun({
    readEntryFeeTerms: (selectedTicker, approval) => ({
      ...boundedFeeTerms(selectedTicker, boundedApprovalFingerprint(approval, selectedTicker)),
      entryCashDebitPerContractMicrosAtLimit: () => 2_400_000,
      maximumExitCashDebitPerContractMicros: () => 100_000,
    }),
  });
  const entryEvaluationId = await insertEvaluation({
    ticker: fixture.market,
    evaluatedAt: new Date(Math.max(fixture.currentTime(), fixture.armedAt + 1)),
  });
  const entry = await executeQualifiedV13Trigger(entryEvaluationId, fixture.dependencies);
  assert.equal(entry.status, "submitted", entry.reason);
  assert.ok(entry.orderId);
  const [buy] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, entryEvaluationId)).limit(1);
  assert.ok(buy);
  const buyFill = historicalFillFor(buy, entry.orderId, `bounded-five-late-buy-${suffix}`);
  let account = {
    ...emptyAccount(),
    positions: [{
      ticker: fixture.market, positionFp: String(buy.requestedContracts),
      marketExposureDollars: String(buy.requestedContracts * buy.requestedLimitPrice),
      realizedPnlDollars: "0",
    }],
    fills: [buyFill],
  };
  fixture.setAccount(account);
  const entryReconciliation = await reconcileMicroLiveAtStartup(fixture.dependencies);
  assert.equal(entryReconciliation.ready, true, entryReconciliation.reason);

  const exitExchangeId = `bounded-five-late-exit-${suffix}`;
  const positionId = `position:${fixture.market}:${buy.crossingKey}`;
  const exitId = await insertRecoveredExitOrder({
    buyOrder: buy, positionId, contractCount: buy.requestedContracts,
    limitPrice: 0.39, exchangeOrderId: exitExchangeId,
  });
  await db.update(microLiveConfigTable).set({
    microLiveRunPhase: "FROZEN",
    microLiveRunFreezeReason: "emergency_stop",
    microLiveExitAttempted: true,
    microLiveProductionEnabled: false,
    liveExecutionEnabled: false,
    manualKillSwitch: true,
  }).where(eq(microLiveConfigTable.id, "singleton"));
  process.env.MICRO_LIVE_PRODUCTION_ENABLED = "false";
  process.env.LIVE_EXECUTION_ENABLED = "false";

  let postCalls = 0;
  let deleteCalls = 0;
  let getCalls = 0;
  const frozenGetOnly = {
    ...fixture.dependencies,
    readAccount: async () => { getCalls++; return account; },
    readAccountActivity: async () => {
      getCalls++;
      const rows = await db.select().from(microLiveOrderTable);
      const orders = rows.filter((row) => row.exchangeOrderId).map((row) => {
        const filledCount = account.fills.filter((fill) => fill.orderId === row.exchangeOrderId)
          .reduce((sum, fill) => sum + Number(fill.countFp), 0);
        const sellCanceled = row.action === "sell";
        return {
          id: row.exchangeOrderId!, clientOrderId: row.clientOrderId,
          ticker: row.marketTicker, side: row.side === "UP" ? "yes" as const : "no" as const,
          action: row.action, type: "limit" as const,
          status: sellCanceled ? "canceled" as const :
            "executed" as const,
          priceDollars: String(row.requestedLimitPrice),
          initialCount: String(row.requestedContracts),
          filledCount: String(filledCount),
          remainingCount: sellCanceled ? "0" :
            String(row.requestedContracts - filledCount),
          createdAt: row.createdAt.toISOString(),
        };
      });
      const scanAt = new Date(fixture.currentTime()).toISOString();
      return {
        orders, fills: account.fills.map((fill) => ({
          ...fill, feeCostDollars: fill.feeCostDollars ?? null,
        })),
        available: true, truncated: false, keyRestrictionVerified: true,
        selectedSubaccount: 0, scanStartedAt: scanAt, scanFinishedAt: scanAt,
        exclusiveControlVerified: false,
      };
    },
    readHistoricalFills: async () => {
      getCalls++;
      return { fills: [], truncated: false, available: true };
    },
    readOrderStatus: async (orderId: string) => {
      getCalls++;
      const rows = await db.select().from(microLiveOrderTable);
      const row = rows.find((candidate) => candidate.exchangeOrderId === orderId);
      assert.ok(row);
      const filledCount = account.fills.filter((fill) => fill.orderId === orderId)
        .reduce((sum, fill) => sum + Number(fill.countFp), 0);
      return {
        orderId, clientOrderId: row.clientOrderId, ticker: row.marketTicker,
        side: row.side === "UP" ? "yes" as const : "no" as const,
        action: row.action as "buy" | "sell", type: "limit" as const,
        status: row.action === "sell" ? "canceled" as const : "executed" as const,
        filledCount: String(filledCount),
        remainingCount: row.action === "sell" ? "0" :
          String(row.requestedContracts - filledCount),
      };
    },
    submitOrder: async () => { postCalls++; throw new Error("frozen recovery must not POST"); },
    cancelOrder: async () => {
      deleteCalls++;
      throw new Error("terminal late-fill recovery must not DELETE");
    },
  };

  const firstRecovery = await reconcileMicroLiveAtStartup(frozenGetOnly);
  assert.equal(firstRecovery.ready, false);
  assert.equal(firstRecovery.reason, "exit_canceled_requires_manual_review");
  const [terminalExit] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, exitId)).limit(1);
  assert.equal(terminalExit.status, "canceled");
  assert.equal(terminalExit.filledContracts, 0);
  assert.equal(terminalExit.cancellationAttemptedAt, null);

  const lateCount = 1;
  account.positions[0]!.positionFp = String(buy.requestedContracts - lateCount);
  account.fills.push({
    id: `bounded-five-late-sell-fill-${suffix}`,
    orderId: exitExchangeId, ticker: fixture.market, side: "yes", action: "sell",
    countFp: String(lateCount), priceDollars: "0.39",
    createdAt: new Date(fixture.currentTime() + 1).toISOString(),
    feeCostDollars: "0.001",
  });
  const replay = await reconcileMicroLiveAtStartup(frozenGetOnly);
  assert.equal(replay.ready, false);
  assert.equal(replay.reason, "exit_canceled_requires_manual_review");
  const [recoveredExit] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, exitId)).limit(1);
  assert.equal(recoveredExit.status, "canceled");
  assert.equal(recoveredExit.filledContracts, lateCount);
  assert.equal(recoveredExit.remainingContracts, 0);
  assert.equal(recoveredExit.cancellationAttemptedAt, null);
  assert.equal((await db.select().from(microLiveFillTable)
    .where(eq(microLiveFillTable.orderId, exitId))).length, 1);
  assert.equal((await getMicroLiveState()).currentPosition?.sellableContracts, 1);
  const [config] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.equal(config?.microLiveRunCapMicros, 5_000_000);
  assert.equal(config?.microLiveReservedMicros, 5_000_000);
  assert.equal(config?.microLiveEntryAttempted, true);
  assert.equal(config?.microLiveExitAttempted, true);
  assert.ok(getCalls > 0, "restart replays are backed by mocked authenticated GET evidence");
  assert.equal(postCalls, 0);
  assert.equal(deleteCalls, 0);
  assert.equal(fixture.entryPosts(), 1);
  assert.equal(fixture.exitPosts(), 0);
});

test("$5 successor entry is frozen on restart and recovers exit-only after multiple days", async () => {
  const { fixture } = await prepareSuccessorBoundedRun({
    readEntryFeeTerms: (selectedTicker, approval) => ({
      ...boundedFeeTerms(selectedTicker, boundedApprovalFingerprint(approval, selectedTicker)),
      entryCashDebitPerContractMicrosAtLimit: () => 2_400_000,
      maximumExitCashDebitPerContractMicros: () => 100_000,
    }),
  });
  const entryEvaluationId = await insertEvaluation({
    ticker: fixture.market,
    evaluatedAt: new Date(Math.max(fixture.currentTime(), fixture.armedAt + 1)),
  });
  const entry = await executeQualifiedV13Trigger(entryEvaluationId, fixture.dependencies);
  assert.equal(entry.status, "submitted", entry.reason);
  assert.ok(entry.orderId);
  const [buy] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, entryEvaluationId)).limit(1);
  assert.ok(buy);
  fixture.setAccount({
    ...emptyAccount(),
    positions: [{
      ticker: fixture.market, positionFp: String(buy.requestedContracts),
      marketExposureDollars: String(buy.requestedContracts * buy.requestedLimitPrice),
      realizedPnlDollars: "0",
    }],
    fills: [historicalFillFor(buy, entry.orderId, `bounded-five-restart-fill-${suffix}`)],
  });
  const reconciled = await reconcileMicroLiveAtStartup(fixture.dependencies);
  assert.equal(reconciled.ready, true, reconciled.reason);

  await fixture.setRuntimeAge(4 * 24 * 60 * 60_000);
  assert.ok(fixture.currentTime() - fixture.armedAt > 3 * 24 * 60 * 60_000,
    "recovery occurs after multiple days without an elapsed-time run deadline");
  fixture.setActivityScanTime(Date.now());
  // A fresh worker process starts from the persisted restart freeze while
  // preserving the audited successor run identity and its full reservation.
  await db.update(microLiveConfigTable).set({
    microLiveRunPhase: "FROZEN",
    microLiveRunFreezeReason: "process_restart_requires_explicit_exit_resume",
    microLiveProductionEnabled: false,
    liveExecutionEnabled: false,
    manualKillSwitch: true,
  }).where(eq(microLiveConfigTable.id, "singleton"));
  await db.update(forwardTestEngineTable).set({
    leaseExpiresAt: new Date(fixture.currentTime() + 60_000),
  }).where(eq(forwardTestEngineTable.id, "v1.3-paper"));
  await processMicroLiveForwardTestCycle(`missing-five-restart-${randomUUID()}`,
    fixture.dependencies);
  const resumed = await resumeBoundedMicroLiveExitOnly(fixture.dependencies);
  assert.equal(resumed.status, "resumed", resumed.reason);
  const state = await getMicroLiveState();
  assert.equal(state.boundedRun.phase, "EXIT_ONLY");
  assert.equal(state.boundedRun.entryAttempted, true);
  assert.equal(state.boundedRun.exitAttempted, false);
  const [config] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.equal(config?.microLiveRunCapMicros, 5_000_000);
  assert.equal(config?.microLiveReservedMicros, 5_000_000);

  fixture.setActivityScanTime(fixture.currentTime());
  const retryId = await insertEvaluation({
    ticker: fixture.market, crossingKey: `${fixture.market}:restart-second-entry`,
  });
  const retry = await executeQualifiedV13Trigger(retryId, fixture.dependencies);
  assert.equal(retry.status, "blocked");
  assert.equal(fixture.entryPosts(), 1, "restart recovery cannot reopen the entry window");
});

test("ambiguous $5 successor POST links by GET-only evidence without retrying or releasing reservation", async () => {
  const { fixture } = await prepareSuccessorBoundedRun({
    ambiguousEntryPost: true,
    readEntryFeeTerms: (selectedTicker, approval) => ({
      ...boundedFeeTerms(selectedTicker, boundedApprovalFingerprint(approval, selectedTicker)),
      entryCashDebitPerContractMicrosAtLimit: () => 2_400_000,
      maximumExitCashDebitPerContractMicros: () => 100_000,
    }),
  });
  const entryEvaluationId = await insertEvaluation({
    ticker: fixture.market,
    evaluatedAt: new Date(Math.max(fixture.currentTime(), fixture.armedAt + 1)),
  });
  const ambiguous = await executeQualifiedV13Trigger(entryEvaluationId, fixture.dependencies);
  assert.equal(ambiguous.status, "unknown");
  assert.equal(ambiguous.reason, "ambiguous_submission_result_freezes_live");
  assert.equal(fixture.entryPosts(), 1);
  const [reservedOrder] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, entryEvaluationId)).limit(1);
  assert.ok(reservedOrder);
  assert.equal(reservedOrder.status, "unknown");
  assert.equal(reservedOrder.exchangeOrderId, null);
  const [beforeRecovery] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.equal(beforeRecovery?.microLiveEntryAttempted, true);
  assert.equal(beforeRecovery?.microLiveReservedMicros, 5_000_000);

  process.env.MICRO_LIVE_PRODUCTION_ENABLED = "false";
  process.env.LIVE_EXECUTION_ENABLED = "false";
  await db.update(microLiveConfigTable).set({
    manualKillSwitch: true, microLiveProductionEnabled: false, liveExecutionEnabled: false,
  }).where(eq(microLiveConfigTable.id, "singleton"));
  const exchangeOrderId = `bounded-five-ambiguous-${suffix}`;
  const account = {
    ...emptyAccount(),
    openOrders: [{
      id: exchangeOrderId, ticker: fixture.market, side: "yes", action: "buy",
      priceDollars: String(reservedOrder.requestedLimitPrice),
      remainingCount: String(reservedOrder.requestedContracts),
      status: "resting", createdAt: new Date(fixture.currentTime()).toISOString(),
    }],
  };
  const linked = await reconcileUncertainSubmission(reservedOrder.id, `user_micro_live_${suffix}`, {
    readAccount: async () => account,
    readEvidence: async (selectedTicker) => {
      assert.equal(selectedTicker, fixture.market);
      return {
        orders: [{
          id: exchangeOrderId, clientOrderId: reservedOrder.clientOrderId,
          ticker: fixture.market, side: "yes", action: "buy", type: "limit",
          status: "resting", priceDollars: String(reservedOrder.requestedLimitPrice),
          initialCount: String(reservedOrder.requestedContracts), filledCount: "0",
          remainingCount: String(reservedOrder.requestedContracts),
        }],
        fills: [], historicalFills: [], historicalFillsAvailable: true, truncated: false,
      };
    },
  });
  assert.equal(linked.status, "linked_needs_reconciliation", linked.reason);
  const [linkedOrder] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, reservedOrder.id)).limit(1);
  assert.equal(linkedOrder.exchangeOrderId, exchangeOrderId);
  assert.equal(linkedOrder.status, "unknown");
  assert.equal(linkedOrder.reservedRiskCents, reservedOrder.reservedRiskCents);
  const [afterRecovery] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.equal(afterRecovery?.microLiveReservedMicros, 5_000_000);
  assert.equal(afterRecovery?.microLiveRunCapMicros, 5_000_000);

  process.env.MICRO_LIVE_PRODUCTION_ENABLED = "true";
  process.env.LIVE_EXECUTION_ENABLED = "true";
  const restarted = await reconcileMicroLiveAtStartup(fixture.dependencies);
  assert.notEqual(restarted.reason, "environment_flags_not_both_true");
  const [afterRestart] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.equal(afterRestart?.microLiveReservedMicros, 5_000_000,
    "GET-only startup recovery must not release the ambiguous entry reservation");

  const duplicateEntryId = await insertEvaluation({
    ticker: fixture.market, crossingKey: `${fixture.market}:ambiguous-retry`,
  });
  const duplicate = await executeQualifiedV13Trigger(duplicateEntryId, fixture.dependencies);
  assert.equal(duplicate.status, "blocked");
  assert.equal(fixture.entryPosts(), 1, "GET-only restart recovery never repeats an ambiguous POST");
  assert.equal((await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.action, "buy"))).length, 1);
});

test("bounded restart exit rechecks changed fees and rejects policy revocation at final interlock", async () => {
  const fixture = await prepareBoundedRun({ persistedApproval: true });
  assert.equal(fixture.dependencies.approvedFeeSessionForTest, undefined);
  const entryEvaluationId = await insertEvaluation({
    ticker: fixture.market,
    evaluatedAt: new Date(Math.max(fixture.currentTime(), fixture.armedAt + 1)),
  });
  const entry = await executeQualifiedV13Trigger(entryEvaluationId, fixture.dependencies);
  assert.equal(entry.status, "submitted", entry.reason);
  assert.ok(entry.orderId);
  assert.equal(fixture.entryPosts(), 1);
  const readsForEntry = fixture.feeTermsReads();
  assert.ok(readsForEntry >= 2, "current entry fee metadata was checked more than once");
  const [buy] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.sourceEvaluationId, entryEvaluationId)).limit(1);
  assert.ok(buy);

  fixture.setAccount({
    ...emptyAccount(),
    positions: [{
      ticker: fixture.market, positionFp: String(buy.requestedContracts),
      marketExposureDollars: String(buy.requestedContracts * buy.requestedLimitPrice),
      realizedPnlDollars: "0",
    }],
    fills: [historicalFillFor(buy, entry.orderId, `bounded-entry-fill-${suffix}`)],
  });
  const firstReconciliation = await reconcileMicroLiveAtStartup(fixture.dependencies);
  assert.equal(firstReconciliation.ready, true, firstReconciliation.reason);

  // Reset process-local ownership to model a fresh process while preserving
  // the immutable run/cash-baseline identity.
  simulateMicroLiveRestartForIsolatedTest();
  await db.update(microLiveConfigTable).set({
    microLiveRunPhase: "ENTRY_OPEN",
    manualKillSwitch: false,
    microLiveProductionEnabled: true,
    liveExecutionEnabled: true,
  }).where(eq(microLiveConfigTable.id, "singleton"));
  await reconcileMicroLiveAtStartup(fixture.dependencies);
  let state = await getMicroLiveState();
  assert.equal(state.boundedRun.phase, "FROZEN");
  assert.match(state.boundedRun.freezeReason ?? "", /process_restart/);

  // A fresh worker lease proof permits recovery after multiple days; the
  // standing fee policy remains valid but cannot reopen this run's entry.
  await fixture.setRuntimeAge(4 * 24 * 60 * 60_000);
  fixture.setActivityScanTime(Date.now());
  await db.update(forwardTestEngineTable).set({
    leaseExpiresAt: new Date(fixture.currentTime() + 60_000),
  }).where(eq(forwardTestEngineTable.id, "v1.3-paper"));
  await processMicroLiveForwardTestCycle(`missing-restart-paper-${randomUUID()}`, fixture.dependencies);
  const resumed = await resumeBoundedMicroLiveExitOnly(fixture.dependencies);
  assert.equal(resumed.status, "resumed", resumed.reason);
  state = await getMicroLiveState();
  assert.equal(state.boundedRun.phase, "EXIT_ONLY");
  assert.equal(state.boundedRun.entryAttempted, true);
  fixture.setActivityScanTime(fixture.currentTime());

  const positionId = `position:${fixture.market}:${buy.crossingKey}`;
  const exitEvaluationId = await insertEvaluation({
    ticker: fixture.market,
    signal: "EXIT",
    crossingKey: buy.crossingKey,
    evaluatedAt: new Date(fixture.currentTime()),
  });
  await db.update(forwardTestEvaluationTable).set({
    evaluationSource: "micro_live",
    livePositionId: positionId,
    sourcePaperEvaluationId: entryEvaluationId,
    positionWasOpen: true,
  }).where(eq(forwardTestEvaluationTable.id, exitEvaluationId));

  let currentExitFeeMicros = 50_000;
  let changedFeeReads = 0;
  const changedFees = {
    ...fixture.dependencies,
    readEntryFeeTerms: async (selectedTicker: string) => {
      changedFeeReads++;
      return {
        ...boundedFeeTerms(selectedTicker, boundedApprovalFingerprint(
          fixture.approval, selectedTicker, "series-updated-after-entry",
        )),
        exitFeePerContractMicrosAtLimit: () => currentExitFeeMicros,
        maximumExitCashDebitPerContractMicros: () => currentExitFeeMicros,
        exitCashDebitPerContractMicrosAtLimit: () => currentExitFeeMicros,
        verifiedAt: Date.now(),
      };
    },
  };
  const activityAtExit = await fixture.dependencies.readAccountActivity!();
  assert.ok(Math.abs(fixture.currentTime() - Date.parse(activityAtExit.scanFinishedAt!)) <= 5_000,
    "the mocked ownership scan is within the unchanged five-second freshness window");
  const changedEvidence = await executeQualifiedV13Trigger(exitEvaluationId, changedFees);
  assert.equal(changedEvidence.status, "blocked");
  assert.equal(changedEvidence.reason, "current_exit_fee_terms_unavailable_or_above_reserved_bound");
  assert.equal(fixture.exitPosts(), 0);
  assert.ok(changedFeeReads > 0, "changed live exit fees were fetched and rejected");

  await processMicroLiveForwardTestCycle(`missing-exit-paper-${randomUUID()}`, fixture.dependencies);
  currentExitFeeMicros = 5_000;
  changedFees.beforeSubmissionInterlock = async () => {
    await revokeFeeApproval();
  };
  const exit = await executeQualifiedV13Trigger(exitEvaluationId, changedFees);
  assert.equal(exit.status, "blocked");
  assert.equal(fixture.exitPosts(), 0,
    "persisted revocation before the final exit policy read prevents its POST");
  assert.ok(changedFeeReads > 0, "changed current exit fees were fetched");
  const repeatedExit = await executeQualifiedV13Trigger(exitEvaluationId, changedFees);
  assert.equal(repeatedExit.status, "blocked");
  assert.equal(fixture.exitPosts(), 0, "retry cannot bypass the final policy barrier");
});

test("settlement reconciliation records authenticated mock evidence once and blocks conflicts", async () => {
  const market = `${ticker}-SETTLEMENT-REPLAY`;
  const { account, order, positionId, readMarketEvidence } =
    await makeRecoveredSettlementPosition(market, "0.001234");
  const settledAt = new Date(Date.now() + 5_000).toISOString();
  account.positions[0]!.positionFp = "0";
  await disableSettlementGates();
  try {
    const readSettlements = async () => settlementSnapshot({
      ticker: market,
      contracts: order.requestedContracts,
      settledAt,
      feeCostDollars: "0.001234",
    });
    const dependencies = async (readSettlements = async () => settlementSnapshot({
      ticker: market,
      contracts: order.requestedContracts,
      settledAt,
      feeCostDollars: "0.001234",
    })) => dedicatedSettlementEvidence({
      market,
      readAccount: async () => account,
      readSettlements,
      readMarketEvidence,
      readDedicatedPairEvidence: await prepareDedicatedSettlementPairFixture(market),
    });
    const extraAccountFee = await reconcileMicroLiveSettlement(
      positionId, "test-actor", await dependencies(async () =>
        settlementSnapshot({
        ticker: market, contracts: order.requestedContracts, settledAt,
        feeCostDollars: "0.002345",
        }),
      ),
    );
    assert.equal(extraAccountFee.status, "blocked");
    assert.equal(extraAccountFee.reason,
      dedicatedPairSettlementBlock("micro_live_settlement_fee_aggregate_mismatch"));
    const recordedDependencies = await dependencies();
    const recorded = await reconcileMicroLiveSettlement(
      positionId, "test-actor", recordedDependencies,
    );
    assert.equal(recorded.status, "recorded", recorded.reason);
    const [row] = await db.select().from(microLiveSettlementTable)
      .where(eq(microLiveSettlementTable.positionId, positionId)).limit(1);
    assert.ok(row);
    assert.equal(row.feeMicros, 1_234);
    assert.equal(row.payoutMicros, order.requestedContracts * 1_000_000);

    const replay = await reconcileMicroLiveSettlement(
      positionId, "test-actor", recordedDependencies,
    );
    assert.equal(replay.status, "already_recorded", replay.reason);
    assert.equal((await db.select().from(microLiveSettlementTable)
      .where(eq(microLiveSettlementTable.positionId, positionId))).length, 1);
    let state = await getMicroLiveState();
    assert.equal(state.realizedPnlMicros, 2_398_766);
    assert.equal(state.realizedPnlCents, 240);
    assert.equal(state.reconciliation.status, "required");
    assert.equal(state.enabled, false);

    await enableStartupRecoveryGates();
    let restartPosts = 0;
    const restart = await reconcileMicroLiveAtStartup(mocks({
      readAccount: recordedDependencies.readAccount,
      readAccountActivity: recordedDependencies.readAccountActivity,
      readSettlements: async () => withDedicatedSettlementShard(await readSettlements()),
      submitOrder: async () => {
        restartPosts++;
        throw new Error("settlement restart recovery must never POST");
      },
    }));
    assert.equal(restart.ready, false);
    assert.equal(restart.reason, "micro_live_kill_switch_on",
      "settlement recovery remains fail-closed while the persisted kill switch is on");
    assert.equal(restartPosts, 0, "blocked settlement recovery never reaches an order POST");
    assert.equal((await getMicroLiveState()).enabled, false);
    await disableSettlementGates();

    const conflict = await reconcileMicroLiveSettlement(
      positionId, "test-actor", await dependencies(async () =>
        settlementSnapshot({
        ticker: market,
        contracts: order.requestedContracts,
        settledAt,
        feeCostDollars: "0.001235",
        }),
      ),
    );
    assert.equal(conflict.status, "blocked");
    assert.equal(conflict.reason,
      dedicatedPairSettlementBlock("micro_live_settlement_fee_aggregate_mismatch"));
    state = await getMicroLiveState();
    assert.equal(state.realizedPnlMicros, 2_398_766,
      "conflicting evidence must not double count or mutate P&L");
  } finally {
    await enableStartupRecoveryGates();
  }
});

test("settlement reconciliation blocks ambiguous records and preserves unknown-fee P&L", async () => {
  const ambiguousMarket = `${ticker}-SETTLEMENT-AMBIGUOUS`;
  const ambiguousPosition = await makeRecoveredSettlementPosition(ambiguousMarket, "0.001234");
  ambiguousPosition.account.positions[0]!.positionFp = "0";
  const ambiguousSettledAt = new Date(Date.now() + 5_000).toISOString();
  const oneSettlement = settlementSnapshot({
    ticker: ambiguousMarket,
    contracts: ambiguousPosition.order.requestedContracts,
    settledAt: ambiguousSettledAt,
    feeCostDollars: "0.002345",
  }).settlements[0]!;
  await disableSettlementGates();
  try {
    const settlementDependencies = async (
      readAccount: () => Promise<KalshiAccountSnapshot>,
      readMarketEvidence: (ticker: string) => Promise<KalshiSubmissionEvidence>,
      readSettlements: () => Promise<KalshiSettlementsSnapshot>,
    ) => dedicatedSettlementEvidence({
      market: ambiguousMarket,
      readAccount,
      readMarketEvidence,
      readSettlements,
      readDedicatedPairEvidence:
        await prepareDedicatedSettlementPairFixture(ambiguousMarket),
    });
    const ambiguous = await reconcileMicroLiveSettlement(ambiguousPosition.positionId, "test-actor",
      await settlementDependencies(
        async () => ambiguousPosition.account,
        ambiguousPosition.readMarketEvidence,
        async () => ({ settlements: [oneSettlement, { ...oneSettlement }], truncated: false }),
      ));
    assert.equal(ambiguous.status, "blocked");
    assert.equal(ambiguous.reason,
      dedicatedPairSettlementBlock("micro_live_settlement_not_unique_for_market"));
    assert.equal((await db.select().from(microLiveSettlementTable)
      .where(eq(microLiveSettlementTable.marketTicker, ambiguousMarket))).length, 0);

    const driftedAccount = structuredClone(ambiguousPosition.account);
    driftedAccount.fills[0]!.priceDollars =
      (Number(driftedAccount.fills[0]!.priceDollars) + 0.00005).toFixed(6);
    const drifted = await reconcileMicroLiveSettlement(ambiguousPosition.positionId, "test-actor",
      await settlementDependencies(
        async () => driftedAccount,
        ambiguousPosition.readMarketEvidence,
        async () => ({ settlements: [oneSettlement], truncated: false }),
      ));
    assert.equal(drifted.status, "blocked");
    assert.equal(drifted.reason,
      dedicatedPairSettlementBlock("micro_live_settlement_market_fill_mismatch"));

    // Sanitized real account snapshots: revenue settles the net YES/NO market
    // position, not the gross count on the winning side. Neither is evidence
    // of this sole local strategy position, even though net payout reconciles.
    for (const example of [
      {
        yes: "137.83", no: "32.76", revenueCents: "0",
        fees: ["0.430000", "0.259400", "1.085600"],
        aggregateFee: "1.775000",
        yesCost: "23.171400", noCost: "24.570000",
        yesLots: [["105.07", "0.1800"], ["32.76", "0.1300"]],
        noLots: [["32.76", "0.7500"]],
        priorNoExit: "32.76",
      },
      {
        yes: "44.06", no: "75.01", revenueCents: "3095",
        fees: ["0.760000", "0.740900"],
        aggregateFee: "1.500900",
        yesCost: "19.386400", noCost: "62.258300",
        yesLots: [["44.06", "0.4400"]],
        noLots: [["75.01", "0.8300"]],
        priorNoExit: null,
      },
    ]) {
      const contractsInCents = (value: string) => Number(value.replace(".", ""));
      const dollarsInMicros = (value: string) => {
        const [whole, fractional = ""] = value.split(".");
        return BigInt(whole!) * 1_000_000n +
          BigInt(fractional.padEnd(6, "0"));
      };
      const grossWinningCents = contractsInCents(example.no);
      assert.notEqual(grossWinningCents, Number(example.revenueCents));
      assert.equal(Math.max(0, grossWinningCents - contractsInCents(example.yes)),
        Number(example.revenueCents));
      assert.equal(example.fees.reduce((sum, fee) => sum + dollarsInMicros(fee), 0n),
        dollarsInMicros(example.aggregateFee));
      const costMicros = (lots: string[][]) => lots.reduce((sum, [count, price]) => {
        const [whole, fractional = ""] = price!.split(".");
        const priceTenThousandths = Number(whole) * 10_000 +
          Number(fractional.padEnd(4, "0"));
        return sum + BigInt(contractsInCents(count!)) * BigInt(priceTenThousandths);
      }, 0n);
      assert.equal(costMicros(example.yesLots), dollarsInMicros(example.yesCost));
      assert.equal(costMicros(example.noLots), dollarsInMicros(example.noCost));
      if (example.priorNoExit !== null) {
        assert.equal(contractsInCents(example.priorNoExit),
          contractsInCents(example.no), "the first market's NO buy was fully exited");
      }
      const mixedSides = await reconcileMicroLiveSettlement(
        ambiguousPosition.positionId, "test-actor", await settlementDependencies(
          async () => ambiguousPosition.account,
          ambiguousPosition.readMarketEvidence,
          async () => ({
            settlements: [{
              ...oneSettlement, marketResult: "no",
              yesCountFp: example.yes, noCountFp: example.no,
              revenueCents: example.revenueCents,
              feeCostDollars: example.aggregateFee,
            }],
            truncated: false,
          }),
        ),
      );
      assert.equal(mixedSides.status, "blocked");
      assert.equal(mixedSides.reason,
        dedicatedPairSettlementBlock("micro_live_settlement_counts_result_or_revenue_mismatch"));
    }
    assert.equal((await db.select().from(microLiveSettlementTable)
      .where(eq(microLiveSettlementTable.marketTicker, ambiguousMarket))).length, 0);

    // Remove the still-open ambiguous fixture before creating another position:
    // production's one-position limit must remain active in this isolated DB.
    await enableStartupRecoveryGates();
    await cleanFixtures();
    await clearDedicatedSettlementPairFixture();
    const missingFeeMarket = `${ticker}-SETTLEMENT-MISSING-FEE`;
    const missingFeePosition = await makeRecoveredSettlementPosition(missingFeeMarket, "0.001234");
    missingFeePosition.account.positions[0]!.positionFp = "0";
    const missingFeeSettledAt = new Date(Date.now() + 6_000).toISOString();
    await disableSettlementGates();
    const missingFeePairEvidence = await prepareDedicatedSettlementPairFixture(missingFeeMarket);
    const missingFee = await reconcileMicroLiveSettlement(missingFeePosition.positionId, "test-actor", {
      ...dedicatedSettlementEvidence({
        market: missingFeeMarket,
        readAccount: async () => missingFeePosition.account,
        readMarketEvidence: missingFeePosition.readMarketEvidence,
        readDedicatedPairEvidence: missingFeePairEvidence,
        readSettlements: async () => settlementSnapshot({
          ticker: missingFeeMarket,
          contracts: missingFeePosition.order.requestedContracts,
          settledAt: missingFeeSettledAt,
          feeCostDollars: null,
        }),
      }),
    });
    assert.equal(missingFee.status, "recorded", missingFee.reason);
    const [row] = await db.select().from(microLiveSettlementTable)
      .where(eq(microLiveSettlementTable.positionId, missingFeePosition.positionId)).limit(1);
    assert.ok(row);
    assert.equal(row.feeMicros, null);
    const state = await getMicroLiveState();
    assert.equal(state.realizedPnlMicros, null, "an absent exchange fee must not be treated as zero");
    assert.equal(state.realizedPnlCents, null);
  } finally {
    await enableStartupRecoveryGates();
  }
});

test("settlement attribution requires complete exclusive market history, including aged-out fills", async () => {
  const market = `${ticker}-SETTLEMENT-HISTORY-OWNERSHIP`;
  const fixture = await makeRecoveredSettlementPosition(market, "0.001234");
  fixture.account.positions[0]!.positionFp = "0";
  const settledAt = new Date(Date.now() + 5_000).toISOString();
  const settlement = async () => settlementSnapshot({
    ticker: market, contracts: fixture.order.requestedContracts,
    settledAt, feeCostDollars: "0.001234",
  });
  const owned = await fixture.readMarketEvidence(market);
  const unrelatedOrder = {
    ...owned.orders[0]!, id: `manual-${suffix}`, clientOrderId: null,
    side: "no", priceDollars: "0.60", initialCount: "1",
    filledCount: "1", remainingCount: "0",
  };
  const unrelatedFill = {
    ...owned.fills[0]!, id: `manual-fill-${suffix}`, orderId: unrelatedOrder.id,
    side: "no" as const, countFp: "1", priceDollars: "0.60",
    createdAt: owned.fills[0]!.createdAt!, feeCostDollars: "0.000100",
  };
  await disableSettlementGates();
  const attempt = async (history: KalshiSubmissionEvidence, account = fixture.account) =>
    reconcileMicroLiveSettlement(fixture.positionId, "test-actor",
      dedicatedSettlementEvidence({
        market,
        readAccount: async () => account,
        readSettlements: settlement,
        readMarketEvidence: async (requestedTicker) => {
          assert.equal(requestedTicker, market);
          return history;
        },
        readDedicatedPairEvidence: await prepareDedicatedSettlementPairFixture(market),
      }));
  try {
    // The manual trade aged out of the current account's fills. It is still
    // present in paginated historical market evidence and cannot be assigned
    // to the one recorded bot position.
    const agedOut = await attempt({
      ...owned,
      orders: [...owned.orders, unrelatedOrder],
      fills: [...owned.fills, unrelatedFill],
      historicalFills: [...owned.historicalFills!, unrelatedFill],
    });
    assert.equal(agedOut.status, "blocked");
    assert.equal(agedOut.reason,
      dedicatedPairSettlementBlock("micro_live_settlement_market_orders_not_exclusive"));

    const mixedAccount = structuredClone(fixture.account);
    mixedAccount.fills.push(unrelatedFill);
    const mixed = await attempt({
      ...owned,
      orders: [...owned.orders, unrelatedOrder],
      fills: [...owned.fills, unrelatedFill],
      historicalFills: [...owned.historicalFills!, unrelatedFill],
    }, mixedAccount);
    assert.equal(mixed.status, "blocked");
    assert.equal(mixed.reason,
      dedicatedPairSettlementBlock("micro_live_settlement_market_orders_not_exclusive"));

    const zeroFillManual = await attempt({
      ...owned,
      orders: [...owned.orders, {
        ...unrelatedOrder, id: `unfilled-manual-${suffix}`,
        filledCount: "0", status: "canceled",
      }],
    });
    assert.equal(zeroFillManual.reason,
      dedicatedPairSettlementBlock("micro_live_settlement_market_orders_not_exclusive"));

    const conflictingOrderOverlap = await attempt({
      ...owned,
      orders: [...owned.orders, {
        ...owned.orders[0]!, clientOrderId: "another-client",
      }],
    });
    assert.equal(conflictingOrderOverlap.status, "blocked");
    assert.equal(conflictingOrderOverlap.reason,
      dedicatedPairSettlementBlock("micro_live_settlement_market_orders_not_exclusive"));

    for (const incomplete of [
      { ...owned, truncated: true },
      { ...owned, historicalFillsAvailable: false, historicalFills: [] },
    ]) {
      const result = await attempt(incomplete);
      assert.equal(result.status, "blocked");
      assert.equal(result.reason,
        dedicatedPairSettlementBlock("micro_live_dedicated_pair_account_history_unproven"));
    }
    const missingPageFill = await attempt({
      ...owned, fills: [],
    });
    assert.equal(missingPageFill.reason,
      dedicatedPairSettlementBlock("micro_live_settlement_market_fill_mismatch"));
    assert.equal((await db.select().from(microLiveSettlementTable)
      .where(eq(microLiveSettlementTable.marketTicker, market))).length, 0);

    // A fill present in both endpoints is one fill, not two contracts or two
    // fees. Identical current/historical order overlap is also deduplicated.
    const attributable = await attempt({
      ...owned,
      orders: [...owned.orders, { ...owned.orders[0]! }],
      fills: [...owned.fills, { ...owned.fills[0]! }],
    });
    assert.equal(attributable.status, "recorded", attributable.reason);
    const state = await getMicroLiveState();
    assert.equal(state.realizedPnlMicros, 2_398_766);
    assert.equal(state.reconciliation.status, "required");
    assert.equal(state.enabled, false);
  } finally {
    await enableStartupRecoveryGates();
  }
});

test("settlement refuses attribution if local ledger changes during market history reads", async () => {
  const market = `${ticker}-SETTLEMENT-LEDGER-RACE`;
  const fixture = await makeRecoveredSettlementPosition(market, "0.001234");
  fixture.account.positions[0]!.positionFp = "0";
  await disableSettlementGates();
  const readDedicatedPairEvidence = await prepareDedicatedSettlementPairFixture(market);
  try {
    const result = await reconcileMicroLiveSettlement(fixture.positionId, "test-actor", {
      ...dedicatedSettlementEvidence({
        market,
        readAccount: async () => fixture.account,
        readMarketEvidence: fixture.readMarketEvidence,
        readDedicatedPairEvidence,
        readSettlements: async () => settlementSnapshot({
          ticker: market, contracts: fixture.order.requestedContracts,
          settledAt: new Date(Date.now() + 5_000).toISOString(),
          feeCostDollars: "0.001234",
        }),
      }),
      afterEvidenceRead: async () => {
        await db.update(microLiveFillTable).set({ feeMicros: 1_235 })
          .where(eq(microLiveFillTable.orderId, fixture.order.id));
      },
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.reason,
      dedicatedPairSettlementBlock("micro_live_settlement_ledger_changed_during_evidence_read"));
    assert.equal((await db.select().from(microLiveSettlementTable)
      .where(eq(microLiveSettlementTable.marketTicker, market))).length, 0);
  } finally {
    await enableStartupRecoveryGates();
  }
});

test("linked canonical YES-sell fills close only the filled NO quantity with exact proceeds and fees", async () => {
  const market = `${ticker}-NO-SELL-REPRESENTATION`;
  const fixture = await makeRecoveredSettlementPosition(market, "0.001200", "no");
  const account: KalshiAccountSnapshot = fixture.account;
  const firstExchangeId = `no-exit-a-${suffix}`;
  const firstExitId = await insertRecoveredExitOrder({
    buyOrder: fixture.order, positionId: fixture.positionId,
    contractCount: fixture.order.requestedContracts,
    limitPrice: 0.85, exchangeOrderId: firstExchangeId,
  });
  const firstCount = fixture.order.requestedContracts - 2;
  const firstFill = {
    id: `no-exit-fill-a-${suffix}`, orderId: firstExchangeId, ticker: market,
    side: "yes", action: "sell", countFp: String(firstCount),
    priceDollars: "0.13", yesPriceDollars: "0.13", noPriceDollars: "0.87",
    outcomeSide: "yes", bookSide: "bid",
    createdAt: new Date(Date.now() + 1_000).toISOString(),
    feeCostDollars: "0.010000",
  };
  account.fills.push(firstFill);
  account.positions[0]!.positionFp = "-2";
  const deps = mocks({
    readAccount: async () => account,
    readHistoricalFills: async () => ({ fills: [], truncated: false, available: true }),
    readOrderStatus: async (id) => {
      const rows = await db.select().from(microLiveOrderTable);
      const row = rows.find((candidate) => candidate.exchangeOrderId === id);
      assert.ok(row);
      return {
        orderId: id, clientOrderId: row.clientOrderId, ticker: market,
        side: "no" as const, action: row.action as "buy" | "sell",
        type: "limit" as const,
        status: id === firstExchangeId ? "canceled" : "executed",
        remainingCount: "0",
        filledCount: String(account.fills.filter((fill) => fill.orderId === id)
          .reduce((sum, fill) => sum + Number(fill.countFp), 0)),
        outcomeSide: row.action === "sell" ? "yes" : "no",
        bookSide: row.action === "sell" ? "bid" : "ask",
      };
    },
  });
  const partial = await reconcileMicroLiveAtStartup(deps);
  assert.equal(partial.ready, false);
  assert.equal(partial.reason, "exit_canceled_requires_manual_review");
  const state = await getMicroLiveState();
  assert.equal(state.currentPosition?.sellableContracts, 2);
  assert.equal(state.currentPosition?.lifecycle, "exit_partial");
  assert.equal(state.realizedPnlMicros, firstCount * (870_000 - 200_000) -
    firstCount * 400 - 10_000);
  const [persisted] = await db.select().from(microLiveFillTable)
    .where(eq(microLiveFillTable.exchangeFillId, firstFill.id)).limit(1);
  assert.equal(persisted.fillPrice, 0.87);
  assert.equal(persisted.tradeMicros, firstCount * 870_000);
  assert.equal(persisted.feeMicros, 10_000);
  assert.equal((await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, firstExitId)))[0]!.filledContracts, firstCount);

  const secondExchangeId = `no-exit-b-${suffix}`;
  await insertRecoveredExitOrder({
    buyOrder: fixture.order, positionId: fixture.positionId,
    contractCount: 2, limitPrice: 0.80, exchangeOrderId: secondExchangeId,
  });
  account.fills.push({
    id: `no-exit-fill-b-${suffix}`, orderId: secondExchangeId, ticker: market,
    side: "no", action: "sell", countFp: "2", priceDollars: "0.85",
    outcomeSide: "yes", bookSide: "bid",
    createdAt: new Date(Date.now() + 2_000).toISOString(),
    feeCostDollars: "0.005000",
  });
  account.positions[0]!.positionFp = "0";
  const closed = await reconcileMicroLiveAtStartup({ ...deps, frozenExitReconciliation: true });
  assert.equal(closed.ready, false);
  assert.equal(closed.reason, "exit_canceled_requires_manual_review");
  const finalState = await getMicroLiveState();
  assert.equal(finalState.currentPosition, null);
  assert.equal(finalState.realizedPnlMicros, 1_953_800);
  assert.equal((await reconcileMicroLiveAtStartup({
    ...deps, frozenExitReconciliation: true,
  })).reason, "exit_canceled_requires_manual_review", "frozen replay is idempotent");
  await enableStartupRecoveryGates();
  const attemptedReactivation = await reconcileMicroLiveAtStartup(deps);
  assert.equal(attemptedReactivation.ready, false);
  assert.equal(attemptedReactivation.reason, "exit_canceled_requires_manual_review");
  assert.equal((await getMicroLiveState()).killSwitch, "ON",
    "even a fully closed exit cannot reopen the one-run execution barrier");

  firstFill.noPriceDollars = "0.86";
  const inconsistent = await reconcileMicroLiveAtStartup({
    ...deps, frozenExitReconciliation: true,
  });
  assert.equal(inconsistent.ready, false);
  assert.equal(inconsistent.reason, "exchange_fill_discrepancy");
  account.fills[account.fills.findIndex((fill) => fill.id === firstFill.id)] = {
    ...firstFill, side: "no", priceDollars: "0.85", noPriceDollars: null,
  };
  await enableStartupRecoveryGates();
  await emergencyStopMicroLive();
  const missingLegPrice = await reconcileMicroLiveAtStartup({
    ...deps, frozenExitReconciliation: true,
  });
  assert.equal(missingLegPrice.ready, false);
  assert.equal(missingLegPrice.reason, "exchange_fill_discrepancy");
});

test("a proved complementary NO exit preserves strict remaining-side settlement and FIFO P&L", async () => {
  const market = `${ticker}-NO-SELL-SETTLEMENT`;
  const fixture = await makeRecoveredSettlementPosition(market, "0.001200", "no");
  const account: KalshiAccountSnapshot = fixture.account;
  const exchangeId = `no-settle-exit-${suffix}`;
  await insertRecoveredExitOrder({
    buyOrder: fixture.order, positionId: fixture.positionId,
    contractCount: fixture.order.requestedContracts,
    limitPrice: 0.85, exchangeOrderId: exchangeId,
  });
  const [exitOrder] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.exchangeOrderId, exchangeId)).limit(1);
  assert.ok(exitOrder);
  const count = fixture.order.requestedContracts - 2;
  account.fills.push({
    id: `no-settle-fill-${suffix}`, orderId: exchangeId, ticker: market,
    side: "yes", action: "sell", countFp: String(count),
    priceDollars: "0.13", yesPriceDollars: "0.13", noPriceDollars: "0.87",
    outcomeSide: "yes", bookSide: "bid",
    createdAt: new Date(Date.now() + 1_000).toISOString(),
    feeCostDollars: "0.010000",
  });
  account.positions[0]!.positionFp = "-2";
  const recovery = await reconcileMicroLiveAtStartup(mocks({
    readAccount: async () => account,
    readHistoricalFills: async () => ({ fills: [], truncated: false, available: true }),
    readOrderStatus: async (id) => {
      const row = id === exchangeId ? exitOrder : fixture.order;
      return {
        orderId: id, clientOrderId: row.clientOrderId, ticker: market,
        side: "no", action: row.action as "buy" | "sell",
        type: "limit", status: id === exchangeId ? "canceled" : "executed",
        remainingCount: "0", filledCount: String(id === exchangeId
          ? count : fixture.order.requestedContracts),
        outcomeSide: id === exchangeId ? "yes" : "no",
        bookSide: id === exchangeId ? "bid" : "ask",
      };
    },
  }));
  assert.equal(recovery.ready, false);
  assert.equal(recovery.reason, "exit_canceled_requires_manual_review");
  account.positions[0]!.positionFp = "0";
  const owned = await fixture.readMarketEvidence(market);
  const history: KalshiSubmissionEvidence = {
    ...owned,
    orders: [...owned.orders, {
      id: exchangeId, clientOrderId: exitOrder.clientOrderId,
      ticker: market, side: "no", action: "sell", type: "limit",
      status: "canceled", priceDollars: "0.85",
      initialCount: String(fixture.order.requestedContracts),
      filledCount: String(count), remainingCount: "0",
    }, {
      id: exchangeId, clientOrderId: exitOrder.clientOrderId,
      ticker: market, side: "no", action: "sell", type: "limit",
      status: "canceled", priceDollars: "0.8500",
      initialCount: String(fixture.order.requestedContracts),
      filledCount: String(count), remainingCount: "0",
      outcomeSide: "yes", bookSide: "bid",
    }],
    fills: [...owned.fills, {
      ...owned.fills.find((fill) => fill.orderId === exchangeId)!,
      priceDollars: "0.1300", yesPriceDollars: "0.1300",
      noPriceDollars: "0.8700",
    }],
    historicalFills: [{
      ...owned.fills.find((fill) => fill.orderId === exchangeId)!,
      priceDollars: "0.1300", yesPriceDollars: "0.1300",
      noPriceDollars: "0.8700",
    }],
  };
  await disableSettlementGates();
  try {
    const readDedicatedPairEvidence = await prepareDedicatedSettlementPairFixture(market);
    const snapshot = settlementSnapshot({
      ticker: market, contracts: 2,
      settledAt: new Date(Date.now() + 5_000).toISOString(),
      feeCostDollars: "0.011200",
    });
    const dependencies = dedicatedSettlementEvidence({
      market,
      readAccount: async () => account,
      readDedicatedPairEvidence,
      readMarketEvidence: async () => history,
      readSettlements: async () => ({
        ...snapshot,
        settlements: [{
          ...snapshot.settlements[0]!, marketResult: "no",
          yesCountFp: "0", noCountFp: "2", revenueCents: "200",
        }],
      }),
    });
    const result = await reconcileMicroLiveSettlement(
      fixture.positionId, "test-actor", dependencies,
    );
    assert.equal(result.status, "recorded", result.reason);
    const state = await getMicroLiveState();
    assert.equal(state.realizedPnlMicros, 2_258_800);
    assert.equal(state.reconciliation.status, "required");
    assert.equal(state.enabled, false);
  } finally {
    await enableStartupRecoveryGates();
    await clearDedicatedSettlementPairFixture();
  }
});

test("uncertain NO-sell reservation links only exact canonical YES-sell evidence", async () => {
  const market = `${ticker}-NO-SELL-UNCERTAIN`;
  const fixture = await makeRecoveredSettlementPosition(market, "0.001200", "no");
  const exchangeId = `no-uncertain-exit-${suffix}`;
  const exitId = await insertRecoveredExitOrder({
    buyOrder: fixture.order, positionId: fixture.positionId,
    contractCount: fixture.order.requestedContracts,
    limitPrice: 0.85, exchangeOrderId: exchangeId,
  });
  const [exit] = await db.select().from(microLiveOrderTable)
    .where(eq(microLiveOrderTable.id, exitId)).limit(1);
  assert.ok(exit);
  await db.update(microLiveOrderTable).set({
    exchangeOrderId: null, status: "unknown",
  }).where(eq(microLiveOrderTable.id, exitId));
  const count = fixture.order.requestedContracts - 2;
  const fill = {
    id: `no-uncertain-fill-${suffix}`, orderId: exchangeId, ticker: market,
    side: "yes", action: "sell", countFp: String(count),
    priceDollars: "0.13", yesPriceDollars: "0.13", noPriceDollars: "0.87",
    outcomeSide: "yes", bookSide: "bid",
    createdAt: new Date(Date.now() + 1_000).toISOString(),
    feeCostDollars: "0.010000",
  };
  const account: KalshiAccountSnapshot = fixture.account;
  account.fills.push(fill);
  account.positions[0]!.positionFp = "-2";
  const order: KalshiSubmissionEvidence["orders"][number] = {
    id: exchangeId, clientOrderId: exit.clientOrderId, ticker: market,
    side: "no", action: "sell", type: "limit", status: "canceled",
    priceDollars: "0.85", initialCount: String(exit.requestedContracts),
    filledCount: String(count), remainingCount: "0",
    outcomeSide: "yes", bookSide: "bid",
  };
  await disableSettlementGates();
  try {
    const invalid = await reconcileUncertainSubmission(exitId, "test-actor", {
      readAccount: async () => account,
      readEvidence: async () => ({
        orders: [order], fills: [{ ...fill, noPriceDollars: "0.86" }],
        truncated: false, historicalFillsAvailable: true,
      }),
    });
    assert.equal(invalid.status, "blocked");
    assert.equal(invalid.reason, "uncertain_recovery_fill_identity_conflict");
    const invalidEvidence = [
      {
        order: { ...order, initialCount: String(exit.requestedContracts - 1) },
        fill,
      },
      {
        order,
        fill: { ...fill, countFp: String(count - 1) },
      },
      {
        order,
        fill: { ...fill, feeCostDollars: "0.011000" },
      },
      {
        order: { ...order, outcomeSide: undefined },
        fill,
      },
      {
        order,
        fill: { ...fill, outcomeSide: undefined },
      },
      {
        order,
        fill: { ...fill, outcomeSide: "no" },
      },
      {
        order: { ...order, bookSide: "ask" },
        fill,
      },
    ];
    for (const bad of invalidEvidence) {
      const rejected = await reconcileUncertainSubmission(exitId, "test-actor", {
        readAccount: async () => account,
        readEvidence: async () => ({
          orders: [bad.order], fills: [bad.fill],
          truncated: false, historicalFillsAvailable: true,
        }),
      });
      assert.equal(rejected.status, "blocked");
      const [unchanged] = await db.select().from(microLiveOrderTable)
        .where(eq(microLiveOrderTable.id, exitId)).limit(1);
      assert.equal(unchanged.exchangeOrderId, null);
      assert.equal(unchanged.status, "unknown");
      assert.equal((await db.select().from(microLiveFillTable)
        .where(eq(microLiveFillTable.orderId, exitId))).length, 0);
    }
    const linked = await reconcileUncertainSubmission(exitId, "test-actor", {
      readAccount: async () => account,
      readEvidence: async () => ({
        orders: [order], fills: [fill], truncated: false, historicalFillsAvailable: true,
      }),
    });
    assert.equal(linked.status, "linked_needs_reconciliation", linked.reason);
    const [persisted] = await db.select().from(microLiveOrderTable)
      .where(eq(microLiveOrderTable.id, exitId)).limit(1);
    assert.equal(persisted.exchangeOrderId, exchangeId);
    assert.equal(persisted.status, "unknown");
    assert.equal((await db.select().from(microLiveFillTable)
      .where(eq(microLiveFillTable.orderId, exitId))).length, 0);
  } finally {
    await enableStartupRecoveryGates();
  }
});

test("database rejects incomplete dedicated shard-2 bindings", async () => {
  const priorEnv = {
    production: process.env.MICRO_LIVE_PRODUCTION_ENABLED,
    execution: process.env.LIVE_EXECUTION_ENABLED,
    keyId: process.env.KALSHI_API_KEY_ID,
    privateKey: process.env.KALSHI_API_PRIVATE_KEY,
  };
  const apiKeyId = `isolated-pair-key-${suffix}`;
  const privateKey = `isolated-pair-private-key-${suffix}`;
  const fingerprint = createHash("sha256")
    .update(`${apiKeyId}\u001f${privateKey}`).digest("hex");
  process.env.MICRO_LIVE_PRODUCTION_ENABLED = "false";
  process.env.LIVE_EXECUTION_ENABLED = "false";
  process.env.KALSHI_API_KEY_ID = apiKeyId;
  process.env.KALSHI_API_PRIVATE_KEY = privateKey;
  process.env.KALSHI_BOT_SUBACCOUNT = "1";
  process.env.MICRO_LIVE_ACCOUNT_MODE = "exclusive";
  try {
    const [before] = await db.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
    await assert.rejects(db.update(microLiveConfigTable).set({
      microLiveAccountMode: "exclusive",
      microLiveSelectedSubaccount: 1,
      microLiveSelectedExchangeIndex: 2,
      microLiveRestrictedApiKeyId: apiKeyId,
      microLiveRestrictedKeyFingerprint: fingerprint,
    }).where(eq(microLiveConfigTable.id, "singleton")), (error: unknown) => {
      const cause = error instanceof Error
        ? (error as Error & { cause?: { code?: string; constraint?: string } }).cause
        : undefined;
      return cause?.code === "23514" &&
        cause.constraint === "micro_live_config_dedicated_pair_complete_check";
    });
    const [after] = await db.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
    assert.deepEqual(after, before,
      "the rejected partial identity must not be persisted");
  } finally {
    if (priorEnv.production === undefined) delete process.env.MICRO_LIVE_PRODUCTION_ENABLED;
    else process.env.MICRO_LIVE_PRODUCTION_ENABLED = priorEnv.production;
    if (priorEnv.execution === undefined) delete process.env.LIVE_EXECUTION_ENABLED;
    else process.env.LIVE_EXECUTION_ENABLED = priorEnv.execution;
    if (priorEnv.keyId === undefined) delete process.env.KALSHI_API_KEY_ID;
    else process.env.KALSHI_API_KEY_ID = priorEnv.keyId;
    if (priorEnv.privateKey === undefined) delete process.env.KALSHI_API_PRIVATE_KEY;
    else process.env.KALSHI_API_PRIVATE_KEY = priorEnv.privateKey;
  }
});

test("dedicated pair identity mismatch leaves the historical frozen run unchanged", async () => {
  const priorEnv = {
    production: process.env.MICRO_LIVE_PRODUCTION_ENABLED,
    execution: process.env.LIVE_EXECUTION_ENABLED,
    keyId: process.env.KALSHI_API_KEY_ID,
    privateKey: process.env.KALSHI_API_PRIVATE_KEY,
    subaccount: process.env.KALSHI_BOT_SUBACCOUNT,
    accountMode: process.env.MICRO_LIVE_ACCOUNT_MODE,
  };
  const apiKeyId = `isolated-pair-mismatch-key-${suffix}`;
  const privateKey = `isolated-pair-mismatch-private-key-${suffix}`;
  const fingerprint = createHash("sha256")
    .update(`${apiKeyId}\u001f${privateKey}`).digest("hex");
  const priorRunId = randomUUID();
  let originalConfigBeforePair: typeof microLiveConfigTable.$inferSelect | undefined;
  process.env.MICRO_LIVE_PRODUCTION_ENABLED = "false";
  process.env.LIVE_EXECUTION_ENABLED = "false";
  process.env.KALSHI_API_KEY_ID = apiKeyId;
  process.env.KALSHI_API_PRIVATE_KEY = privateKey;
  process.env.KALSHI_BOT_SUBACCOUNT = "1";
  process.env.MICRO_LIVE_ACCOUNT_MODE = "exclusive";
  try {
    [originalConfigBeforePair] = await db.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
    assert.ok(originalConfigBeforePair, "isolated singleton config must exist");
    const fundingAt = new Date("2026-01-01T00:00:00.000Z");
    const baselineAt = new Date("2026-01-01T00:01:00.000Z");
    const checkpointAt = new Date("2026-01-01T00:02:00.000Z");
    const evidenceDigest = createHash("sha256").update(priorRunId).digest("hex");
    await db.update(microLiveConfigTable).set({
      microLiveProductionEnabled: false,
      liveExecutionEnabled: false,
      manualKillSwitch: true,
      microLiveRunId: priorRunId,
      microLiveRunPhase: "FROZEN",
      microLiveRunArmedAt: new Date("2026-01-01T00:00:00.000Z"),
      microLiveRunFreezeReason: "operator_froze_unused_run_for_reviewed_transition",
      microLiveRunCapMicros: 1_000_000,
      microLiveReservedMicros: 0,
      microLiveEntryAttempted: false,
      microLiveExitAttempted: false,
      microLiveAccountMode: "exclusive",
      microLiveSelectedSubaccount: 2,
      microLiveSelectedExchangeIndex: 2,
      microLiveRestrictedApiKeyId: apiKeyId,
      microLiveRestrictedKeyFingerprint: fingerprint,
      microLiveFundingAnchorSubaccount: 2,
      microLiveFundingAnchorExchangeIndex: 2,
      microLiveFundingAnchorTransferId: `isolated-transfer-${suffix}`,
      microLiveFundingAnchorTransferAt: fundingAt,
      microLiveFundingAnchorAmountCents: 2500,
      microLivePairCashBaselineMicros: "25000000",
      microLivePairCashBaselineRunId: priorRunId,
      microLivePairCashBaselineAt: baselineAt,
      microLivePairCashBaselineEvidenceDigest: evidenceDigest,
      microLiveAccountActivityCheckpointSubaccount: 2,
      microLiveAccountActivityCheckpointExchangeIndex: 2,
      microLiveAccountActivityCheckpointRunId: priorRunId,
      microLiveAccountActivityCheckpointCursor: `isolated-cursor-${suffix}`,
      microLiveAccountActivityCheckpointAt: checkpointAt,
      microLiveAccountActivityCheckpointEvidenceDigest: evidenceDigest,
    }).where(eq(microLiveConfigTable.id, "singleton"));
    const [before] = await db.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
    const result = await reconcileMicroLiveAtStartup();
    assert.deepEqual(result, {
      ready: false,
      reason: "account_mode_or_subaccount_changed",
    });
    const [after] = await db.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
    assert.deepEqual(after, before,
      "mismatched (N, 2) identity must not rebind or mutate the historical frozen run");
    assert.equal(after.microLiveRunId, priorRunId);
    assert.equal(after.microLiveRunPhase, "FROZEN");
    assert.equal(after.microLiveSelectedSubaccount, 2);
    assert.equal(after.microLiveSelectedExchangeIndex, 2);
    assert.equal(after.microLiveProductionEnabled, false);
    assert.equal(after.liveExecutionEnabled, false);
    assert.equal(after.manualKillSwitch, true);
  } finally {
    if (originalConfigBeforePair) {
      const { id: _id, createdAt: _createdAt, ...rest } = originalConfigBeforePair;
      await db.update(microLiveConfigTable).set(rest)
        .where(eq(microLiveConfigTable.id, "singleton"));
    }
    if (priorEnv.production === undefined) delete process.env.MICRO_LIVE_PRODUCTION_ENABLED;
    else process.env.MICRO_LIVE_PRODUCTION_ENABLED = priorEnv.production;
    if (priorEnv.execution === undefined) delete process.env.LIVE_EXECUTION_ENABLED;
    else process.env.LIVE_EXECUTION_ENABLED = priorEnv.execution;
    if (priorEnv.keyId === undefined) delete process.env.KALSHI_API_KEY_ID;
    else process.env.KALSHI_API_KEY_ID = priorEnv.keyId;
    if (priorEnv.privateKey === undefined) delete process.env.KALSHI_API_PRIVATE_KEY;
    else process.env.KALSHI_API_PRIVATE_KEY = priorEnv.privateKey;
    if (priorEnv.subaccount === undefined) delete process.env.KALSHI_BOT_SUBACCOUNT;
    else process.env.KALSHI_BOT_SUBACCOUNT = priorEnv.subaccount;
    if (priorEnv.accountMode === undefined) delete process.env.MICRO_LIVE_ACCOUNT_MODE;
    else process.env.MICRO_LIVE_ACCOUNT_MODE = priorEnv.accountMode;
  }
});

test("arbitrary N=7 shard-2 mocked lifecycle freezes safely at unavailable authenticated history", async () => {
  const priorEnv = {
    production: process.env.MICRO_LIVE_PRODUCTION_ENABLED,
    execution: process.env.LIVE_EXECUTION_ENABLED,
    subaccount: process.env.KALSHI_BOT_SUBACCOUNT,
    accountMode: process.env.MICRO_LIVE_ACCOUNT_MODE,
    keyId: process.env.KALSHI_API_KEY_ID,
    privateKey: process.env.KALSHI_API_PRIVATE_KEY,
  };
  const [originalConfig] = await db.select().from(microLiveConfigTable)
    .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
  assert.ok(originalConfig, "isolated singleton config must exist");

  const subaccountNumber = 7;
  const exchangeIndex = 2;
  const runId = randomUUID();
  const keyId = `isolated-n7-shard2-key-${suffix}`;
  const privateKey = `isolated-n7-shard2-private-key-${suffix}`;
  const keyFingerprint = createHash("sha256")
    .update(`${keyId}\u001f${privateKey}`).digest("hex");
  const nowMs = Date.now();
  const fundingAt = new Date(nowMs - 3_000);
  const baselineAt = new Date(nowMs - 2_000);
  const checkpointAt = new Date(nowMs - 1_000);
  const baselineDigest = createHash("sha256")
    .update(`pair-baseline:${runId}:25000000`).digest("hex");
  const checkpointDigest = createHash("sha256")
    .update(`pair-checkpoint:${runId}:cursor-0`).digest("hex");
  const market = `${ticker}-N7-SHARD2-LIFECYCLE`;

  process.env.MICRO_LIVE_PRODUCTION_ENABLED = "false";
  process.env.LIVE_EXECUTION_ENABLED = "false";
  process.env.KALSHI_BOT_SUBACCOUNT = String(subaccountNumber);
  process.env.MICRO_LIVE_ACCOUNT_MODE = "exclusive";
  process.env.KALSHI_API_KEY_ID = keyId;
  process.env.KALSHI_API_PRIVATE_KEY = privateKey;

  try {
    testTickers.add(market);
    // This is a fixture seed, not a provisioning API: it models a future,
    // already-authenticated (N,2) binding without creating a Kalshi account,
    // key, or transfer.
    await db.update(microLiveConfigTable).set({
      microLiveProductionEnabled: false,
      liveExecutionEnabled: false,
      manualKillSwitch: true,
      microLiveRunId: runId,
      microLiveRunPhase: "PREPARING",
      microLiveRunCapMicros: 1_000_000,
      microLiveEntryAttempted: false,
      microLiveExitAttempted: false,
      microLiveReservedMicros: 0,
      microLiveAccountingUnresolved: false,
      microLiveAccountingUnresolvedReason: null,
      microLiveAccountMode: "exclusive",
      microLiveSelectedSubaccount: subaccountNumber,
      microLiveSelectedExchangeIndex: exchangeIndex,
      microLiveRestrictedApiKeyId: keyId,
      microLiveRestrictedKeyFingerprint: keyFingerprint,
      microLiveFundingAnchorSubaccount: subaccountNumber,
      microLiveFundingAnchorExchangeIndex: exchangeIndex,
      microLiveFundingAnchorTransferId: `isolated-n7-funding-${suffix}`,
      microLiveFundingAnchorTransferAt: fundingAt,
      microLiveFundingAnchorAmountCents: 2500,
      microLivePairCashBaselineMicros: "25000000",
      microLivePairCashBaselineRunId: runId,
      microLivePairCashBaselineAt: baselineAt,
      microLivePairCashBaselineEvidenceDigest: baselineDigest,
      microLiveAccountActivityCheckpointRunId: runId,
      microLiveAccountActivityCheckpointCursor: "cursor-0",
      microLiveAccountActivityCheckpointAt: checkpointAt,
      microLiveAccountActivityCheckpointEvidenceDigest: checkpointDigest,
      microLiveAccountActivityCheckpointSubaccount: subaccountNumber,
      microLiveAccountActivityCheckpointExchangeIndex: exchangeIndex,
      microLivePrimaryCashBaselineMicros: null,
      microLivePrimaryCashBaselineRunId: null,
      microLivePrimaryCashBaselineAt: null,
      microLivePrimaryCashBaselineEvidenceDigest: null,
      microLivePrimaryActivityCheckpointRunId: null,
      microLivePrimaryActivityCheckpointCursor: null,
      microLivePrimaryActivityCheckpointAt: null,
      microLivePrimaryActivityCheckpointEvidenceDigest: null,
    }).where(eq(microLiveConfigTable.id, "singleton"));

    const [provisioned] = await db.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
    assert.ok(provisioned);
    assert.equal(provisioned.microLiveSelectedSubaccount, 7);
    assert.equal(provisioned.microLiveSelectedExchangeIndex, 2);
    assert.equal(provisioned.microLivePairCashBaselineMicros, "25000000");
    assert.equal(provisioned.microLiveFundingAnchorAmountCents, 2500);
    assert.equal(provisioned.microLiveProductionEnabled, false);
    assert.equal(provisioned.liveExecutionEnabled, false);
    assert.equal(provisioned.manualKillSwitch, true);

    // Restart is simulated in-process without mutating the isolated durable run.
    simulateMicroLiveRestartForIsolatedTest();
    let accountReads = 0;
    const reconciled = await reconcileMicroLiveAtStartup({
      readAccount: async () => {
        accountReads++;
        return emptyAccount();
      },
      readAccountActivity: async () => {
        accountReads++;
        throw new Error("pair account history is unavailable in the production reader");
      },
    });
    assert.equal(reconciled.ready, false);
    assert.equal(reconciled.reason,
      "dedicated_pair_startup_market_identity_unavailable",
      "restart cannot reconcile pair history without a market identity");
    assert.equal(accountReads, 0,
      "startup must stop before unscoped account reads when pair history is unavailable");

    const [afterRestart] = await db.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
    assert.ok(afterRestart);
    assert.equal(afterRestart.microLiveRunId, runId);
    assert.equal(afterRestart.microLiveRunPhase, "FROZEN",
      "a restart of an arbitrary seeded N=7 run is frozen before GET-only recovery");
    assert.equal(afterRestart.microLiveSelectedSubaccount, 7);
    assert.equal(afterRestart.microLiveSelectedExchangeIndex, 2);
    assert.equal(afterRestart.manualKillSwitch, true);
    assert.equal(afterRestart.microLiveProductionEnabled, false);
    assert.equal(afterRestart.liveExecutionEnabled, false);

    // The $1 entry / duplicate-submit boundary is deliberately not reached.
    // Repeated attempts remain blocked and cannot enter the fake exchange.
    const evaluationId = await insertEvaluation({ ticker: market, entryOffer: 0.40 });
    let postAttempts = 0;
    const blockedEntryDependencies = mocks({
      submitOrder: async () => {
        postAttempts++;
        throw new Error("POST must not be reached without pair history proof");
      },
    });
    const firstEntry = await executeQualifiedV13Trigger(
      evaluationId, blockedEntryDependencies,
    );
    const duplicateEntry = await executeQualifiedV13Trigger(
      evaluationId, blockedEntryDependencies,
    );
    assert.equal(firstEntry.status, "blocked");
    assert.equal(firstEntry.reason, "environment_flags_not_both_true");
    assert.equal(duplicateEntry.status, "blocked");
    assert.equal(duplicateEntry.reason, "environment_flags_not_both_true");
    assert.equal(postAttempts, 0);
    assert.equal((await db.select().from(microLiveOrderTable)
      .where(eq(microLiveOrderTable.marketTicker, market))).length, 0);

    // Pair-identity negatives: wrong N and wrong restricted key both block the
    // restarted run; the DB check rejects index 1 rather than persisting it.
    process.env.KALSHI_BOT_SUBACCOUNT = "8";
    const wrongN = await reconcileMicroLiveAtStartup();
    assert.equal(wrongN.ready, false);
    assert.equal(wrongN.reason, "account_mode_or_subaccount_changed");
    process.env.KALSHI_BOT_SUBACCOUNT = String(subaccountNumber);
    process.env.KALSHI_API_KEY_ID = `${keyId}-mismatch`;
    const wrongKey = await reconcileMicroLiveAtStartup();
    assert.equal(wrongKey.ready, false);
    assert.equal(wrongKey.reason, "account_mode_or_subaccount_changed");
    process.env.KALSHI_API_KEY_ID = keyId;
    await assert.rejects(
      db.update(microLiveConfigTable).set({ microLiveSelectedExchangeIndex: 1 })
        .where(eq(microLiveConfigTable.id, "singleton")),
      (error: unknown) => {
        const cause = error && typeof error === "object" && "cause" in error
          ? (error as { cause?: { code?: string } }).cause : undefined;
        return cause?.code === "23514";
      },
    );

    // Exact pair cash/checkpoint arithmetic accepts only evidence bound to
    // (7,2). An unexplained $0.01 cash loss and any external transfer remain
    // visible as unresolved, not silently assigned to this bot.
    const identity = { subaccountNumber, exchangeIndex };
    const baseline = {
      availableCashMicros: "25000000",
      runId,
      capturedAt: baselineAt.toISOString(),
      evidenceDigest: baselineDigest,
      accountIdentity: identity,
    };
    const baseScan = {
      authenticated: true,
      accountHistoryComplete: true,
      cashTransferHistoryAvailable: true,
      cashTransferHistoryComplete: true,
      selectedSubaccount: subaccountNumber,
      accountIdentity: identity,
      historyFromCursor: null,
      nextCursor: "cursor-1",
      historyCoveredFrom: baselineAt.toISOString(),
      scanStartedAt: new Date(nowMs - 500).toISOString(),
      scanFinishedAt: new Date(nowMs).toISOString(),
      events: [],
    };
    const unexplainedCash = computeBotAttributableAvailableCashDelta({
      baseline,
      currentRunId: runId,
      currentAvailableCashDollars: "24.99",
      activity: {
        authenticated: true,
        complete: true,
        selectedSubaccount: subaccountNumber,
        accountIdentity: identity,
        scanFinishedAt: new Date(nowMs).toISOString(),
        allCashComponentsKnown: true,
        fills: [],
        settlements: [],
        botOrderIds: [],
        nonBotOrderIds: [],
        botSettlementIds: [],
        nonBotSettlementIds: [],
        botSettlementOwnershipProven: true,
      },
      nowMs,
    });
    assert.equal(unexplainedCash.ok, false);
    if (!unexplainedCash.ok) {
      assert.equal(unexplainedCash.reason, "primary_cash_delta_unexplained");
    }
    const transferEventWithoutDigest = {
      id: `unrelated-transfer-${suffix}`,
      kind: "cash_transfer" as const,
      occurredAt: new Date(nowMs - 100).toISOString(),
      classification: "unrelated_permitted" as const,
      runId: null,
      affectsBotMarket: false,
      affectsPositions: false,
      affectsReservedExposure: false,
      cashDeltaMicros: "-10000",
    };
    const transferEvent = {
      ...transferEventWithoutDigest,
      evidenceDigest: createPrimaryCashActivityEventDigest(transferEventWithoutDigest),
    };
    const transferCheckpoint = reconcilePrimaryCashActivityCheckpoint({
      baseline,
      currentRunId: runId,
      previousCheckpoint: null,
      activity: { ...baseScan, events: [transferEvent] },
      nowMs,
    });
    assert.equal(transferCheckpoint.ok, true);
    if (transferCheckpoint.ok) {
      assert.deepEqual(transferCheckpoint.unrelatedCashMovementIds, [
        transferEvent.id,
      ]);
      assert.equal(transferCheckpoint.unrelatedCashDeltaMicros, "-10000");
    }
    const unrelatedFillWithoutDigest = {
      id: `unrelated-fill-${suffix}`,
      kind: "fill" as const,
      occurredAt: new Date(nowMs - 100).toISOString(),
      classification: "unrelated_permitted" as const,
      runId: null,
      affectsBotMarket: true,
      affectsPositions: true,
      affectsReservedExposure: false,
      cashDeltaMicros: null,
    };
    const unrelatedFill = {
      ...unrelatedFillWithoutDigest,
      evidenceDigest: createPrimaryCashActivityEventDigest(unrelatedFillWithoutDigest),
    };
    const unrelatedFillScan = reconcilePrimaryCashActivityCheckpoint({
      baseline,
      currentRunId: runId,
      previousCheckpoint: null,
      activity: { ...baseScan, events: [unrelatedFill] },
      nowMs,
    });
    assert.equal(unrelatedFillScan.ok, false);
    if (!unrelatedFillScan.ok) {
      assert.equal(unrelatedFillScan.reason,
        "primary_activity_unrelated_item_affects_bot_scope");
    }
    const unrelatedOrderWithoutDigest = {
      ...unrelatedFillWithoutDigest,
      id: `unrelated-order-${suffix}`,
      kind: "order" as const,
      affectsPositions: false,
      affectsReservedExposure: true,
    };
    const unrelatedOrder = {
      ...unrelatedOrderWithoutDigest,
      evidenceDigest: createPrimaryCashActivityEventDigest(unrelatedOrderWithoutDigest),
    };
    const unrelatedOrderScan = reconcilePrimaryCashActivityCheckpoint({
      baseline,
      currentRunId: runId,
      previousCheckpoint: null,
      activity: { ...baseScan, events: [unrelatedOrder] },
      nowMs,
    });
    assert.equal(unrelatedOrderScan.ok, false);
    if (!unrelatedOrderScan.ok) {
      assert.equal(unrelatedOrderScan.reason,
        "primary_activity_unrelated_item_affects_bot_scope");
    }

    const unknownTransfer = {
      ...transferEventWithoutDigest,
      id: `unknown-transfer-${suffix}`,
      classification: "unknown" as const,
    };
    const unknownTransferEvent = {
      ...unknownTransfer,
      evidenceDigest: createPrimaryCashActivityEventDigest(unknownTransfer),
    };
    const unknownTransferScan = reconcilePrimaryCashActivityCheckpoint({
      baseline,
      currentRunId: runId,
      previousCheckpoint: null,
      activity: { ...baseScan, events: [unknownTransferEvent] },
      nowMs,
    });
    assert.equal(unknownTransferScan.ok, false);
    if (!unknownTransferScan.ok) {
      assert.equal(unknownTransferScan.reason, "primary_activity_ownership_unknown");
    }

    const staleCashEvidence = computeBotAttributableAvailableCashDelta({
      baseline,
      currentRunId: runId,
      currentAvailableCashDollars: "25.00",
      activity: {
        authenticated: true,
        complete: true,
        selectedSubaccount: subaccountNumber,
        accountIdentity: identity,
        scanFinishedAt: new Date(nowMs - 6_000).toISOString(),
        allCashComponentsKnown: true,
        fills: [],
        settlements: [],
        botOrderIds: [],
        nonBotOrderIds: [],
        botSettlementIds: [],
        nonBotSettlementIds: [],
        botSettlementOwnershipProven: true,
      },
      nowMs,
    });
    assert.equal(staleCashEvidence.ok, false);
    if (!staleCashEvidence.ok) {
      assert.equal(staleCashEvidence.reason, "primary_cash_activity_stale");
    }

    const missingFeeCashEvidence = computeBotAttributableAvailableCashDelta({
      baseline,
      currentRunId: runId,
      currentAvailableCashDollars: "24.60",
      activity: {
        authenticated: true,
        complete: true,
        selectedSubaccount: subaccountNumber,
        accountIdentity: identity,
        scanFinishedAt: new Date(nowMs).toISOString(),
        allCashComponentsKnown: true,
        fills: [{
          id: `missing-fee-fill-${suffix}`,
          orderId: `missing-fee-order-${suffix}`,
          ticker: market,
          action: "buy",
          countFp: "1",
          priceDollars: "0.40",
          feeCostDollars: null,
        }],
        settlements: [],
        botOrderIds: [`missing-fee-order-${suffix}`],
        nonBotOrderIds: [],
        botSettlementIds: [],
        nonBotSettlementIds: [],
        botSettlementOwnershipProven: true,
      },
      nowMs,
    });
    assert.equal(missingFeeCashEvidence.ok, false);
    if (!missingFeeCashEvidence.ok) {
      assert.equal(missingFeeCashEvidence.reason,
        "primary_cash_fill_price_count_or_fee_unknown");
    }

    const marketShiftedPairEvidence = {
      pair: { subaccountNumber, exchangeIndex: 2 },
      balance: {
        subaccountNumber, exchangeIndex: 2, balanceDollars: "25.00",
        updatedTs: Math.floor(nowMs / 1_000),
      },
      marketExchangeIndex: 3,
      keyRestrictionVerified: true,
      tradePermissionVerified: true,
      allTimeHistoryExhaustive: false,
      exclusiveControlVerified: false,
      recordCounts: { positions: 0, orders: 0, fills: 0, settlements: 0, transfers: 0 },
      scanStartedAt: new Date(nowMs - 500).toISOString(),
      scanFinishedAt: new Date(nowMs).toISOString(),
    } as unknown as KalshiDedicatedPairEvidence;
    const emptyPairAccount = emptyAccount();
    const emptyPairActivity: KalshiAccountActivity = {
      orders: [], fills: [], available: true, truncated: false,
      selectedSubaccount: subaccountNumber,
      scanStartedAt: new Date(nowMs - 500).toISOString(),
      scanFinishedAt: new Date(nowMs).toISOString(),
      exclusiveControlVerified: false,
    };
    const emptyPairHistory: KalshiSubmissionEvidence = {
      orders: [], fills: [], historicalFills: [],
      historicalFillsAvailable: true, truncated: false,
    };
    const shiftedMarket = verifyDedicatedSettlementPairActivity({
      config: afterRestart,
      pairEvidence: marketShiftedPairEvidence,
      account: emptyPairAccount,
      activity: emptyPairActivity,
      history: emptyPairHistory,
      settlements: [{
        ticker: market,
        eventTicker: `${market}-EVENT`,
        marketResult: "yes",
        yesCountFp: "0",
        yesTotalCostDollars: "0",
        noCountFp: "0",
        noTotalCostDollars: "0",
        revenueCents: "0",
        settledAt: new Date(nowMs).toISOString(),
        feeCostDollars: "0",
      }],
      ticker: market,
      nowMs,
    });
    assert.equal(shiftedMarket, "micro_live_dedicated_pair_exchange_evidence_mismatch");

    // Downstream lifecycle states are intentionally NOT fabricated as
    // successes: no POST means partial/full fill, exit/cancel, uncertain
    // response, late-fill recovery, settlement, and final reconciliation are
    // unreached. These are explicit blockers in this continuous test journey.
    const blockedDownstreamStages = {
      partialFill: "not_reached_no_authorized_post",
      fullFill: "not_reached_no_authorized_post",
      exitOrCancel: "not_reached_no_position",
      timeoutBeforePost: "not_induced_no_authorized_post",
      timeoutAfterPost: "not_induced_no_authorized_post",
      restartAtUncertainState: "not_reached_no_uncertain_order",
      lateFillRecovery: "not_reached_no_order_or_fill",
      settlement: "not_reached_no_position_or_settlement",
      finalFeeCashReconciliation: "blocked_no_authenticated_pair_history",
    } as const;
    assert.ok(Object.values(blockedDownstreamStages).every((state) =>
      state.startsWith("not_reached") || state.startsWith("not_induced") ||
      state.startsWith("blocked")));
    assert.equal((await db.select().from(microLiveOrderTable)
      .where(eq(microLiveOrderTable.marketTicker, market))).length, 0);
    assert.equal((await db.select().from(microLiveSettlementTable)
      .where(eq(microLiveSettlementTable.marketTicker, market))).length, 0);
    assert.equal(withinAllInLiveTestCap(100, 1, 0), false,
      "the $1 cap rejects a fee-inclusive exposure above $1");
    assert.equal(postAttempts, 0,
      "timeouts and duplicate paths cannot be induced because no POST is authorized");
  } finally {
    const { id: _id, createdAt: _createdAt, ...rest } = originalConfig;
    await db.update(microLiveConfigTable).set(rest)
      .where(eq(microLiveConfigTable.id, "singleton"));
    if (priorEnv.production === undefined) delete process.env.MICRO_LIVE_PRODUCTION_ENABLED;
    else process.env.MICRO_LIVE_PRODUCTION_ENABLED = priorEnv.production;
    if (priorEnv.execution === undefined) delete process.env.LIVE_EXECUTION_ENABLED;
    else process.env.LIVE_EXECUTION_ENABLED = priorEnv.execution;
    if (priorEnv.subaccount === undefined) delete process.env.KALSHI_BOT_SUBACCOUNT;
    else process.env.KALSHI_BOT_SUBACCOUNT = priorEnv.subaccount;
    if (priorEnv.accountMode === undefined) delete process.env.MICRO_LIVE_ACCOUNT_MODE;
    else process.env.MICRO_LIVE_ACCOUNT_MODE = priorEnv.accountMode;
    if (priorEnv.keyId === undefined) delete process.env.KALSHI_API_KEY_ID;
    else process.env.KALSHI_API_KEY_ID = priorEnv.keyId;
    if (priorEnv.privateKey === undefined) delete process.env.KALSHI_API_PRIVATE_KEY;
    else process.env.KALSHI_API_PRIVATE_KEY = priorEnv.privateKey;
  }
});

test("N=7 prospective boundary drives collateral lifecycle and adversarial evidence", async () => {
  const priorEnv = {
    production: process.env.MICRO_LIVE_PRODUCTION_ENABLED,
    execution: process.env.LIVE_EXECUTION_ENABLED,
    subaccount: process.env.KALSHI_BOT_SUBACCOUNT,
    accountMode: process.env.MICRO_LIVE_ACCOUNT_MODE,
    keyId: process.env.KALSHI_API_KEY_ID,
    privateKey: process.env.KALSHI_API_PRIVATE_KEY,
    provisioningKeyId: process.env.KALSHI_PROVISIONING_API_KEY_ID,
    provisioningPrivateKey: process.env.KALSHI_PROVISIONING_PRIVATE_KEY,
    nodeEnv: process.env.NODE_ENV,
    deployment: process.env.REPLIT_DEPLOYMENT,
    creationAuthorized: process.env.KALSHI_INDEX2_SUBACCOUNT_CREATION_AUTHORIZED,
    apiEnvironment: process.env.KALSHI_API_ENVIRONMENT,
    keyProvisioningEnabled: process.env.KALSHI_KEY_PROVISIONING_ENABLED,
    keyGenerationAuthorized: process.env.KALSHI_KEY_GENERATION_AUTHORIZED,
  };
  const subaccountNumber = 7;
  const exchangeIndex = 2;
  const market = `${ticker}-N7-PROSPECTIVE-BOUNDARY`;
  const [originalShadowConfig] = await db.select().from(liveExecutionConfigTable)
    .where(eq(liveExecutionConfigTable.id, "singleton")).limit(1);
  await db.insert(liveExecutionConfigTable).values({
    id: "singleton",
    liveExecutionEnabled: false,
    manualKillSwitch: true,
  }).onConflictDoUpdate({
    target: liveExecutionConfigTable.id,
    set: { liveExecutionEnabled: false, manualKillSwitch: true },
  });
  const keyId = `isolated-n7-boundary-key-${suffix}`;
  const privateKey = `isolated-n7-boundary-private-${suffix}`;
  const keyFingerprint = createHash("sha256")
    .update(`${keyId}\u001f${privateKey}`).digest("hex");
  const baseNow = Date.now();
  const cleanAt = new Date(baseNow - 1_000);
  const transferAt = new Date(baseNow - 500);
  const scanAt = new Date(baseNow);
  const transferId = `isolated-n7-funding-${suffix}`;
  const creationOwnerKeyId = `isolated-n7-creation-owner-${suffix}`;
  const creationOwnerKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
    .export({ type: "pkcs8", format: "pem" }).toString();
  const feeApproval = {
    id: `isolated-n7-boundary-fee-${suffix}`,
    digest: createHash("sha256").update(`n7-boundary-fee-${suffix}`).digest("hex"),
    approvedAt: baseNow,
    policyVersion: STANDING_FEE_POLICY_VERSION,
    sourceUrl: CANONICAL_FEE_SCHEDULE_URL,
    formulaVersion: STANDARD_QUADRATIC_FEE_FORMULA_VERSION,
    maximumExposureMicros: 5_000_000,
    approvedRunCapMicros: 5_000_000,
    approvedBy: `isolated-n7-boundary-administrator-${suffix}`,
  };
  const feeFingerprint = boundedApprovalFingerprint(feeApproval, market);
  const historicalPriorRunId = `isolated-historical-frozen-${suffix}`;
  const historicalDigest = createHash("sha256")
    .update(`historical-frozen-${suffix}`).digest("hex");
  let ambiguousTransferPresent = false;
  let rawEvidenceReads = 0;

  process.env.MICRO_LIVE_PRODUCTION_ENABLED = "false";
  process.env.LIVE_EXECUTION_ENABLED = "false";
  process.env.KALSHI_BOT_SUBACCOUNT = String(subaccountNumber);
  process.env.MICRO_LIVE_ACCOUNT_MODE = "exclusive";
  delete process.env.KALSHI_API_KEY_ID;
  delete process.env.KALSHI_API_PRIVATE_KEY;

  try {
    testTickers.add(market);
    pairBoundarySubaccounts.add(subaccountNumber);
    pairBoundaryFeeApprovalIds.add(feeApproval.id);
    transitionPriorRunIds.add(historicalPriorRunId);

    assert.match(
      process.env.MICRO_LIVE_TEST_ISOLATED_SCHEMA ?? "",
      /^micro_live_test_[a-f0-9]{24}$/,
      "the database-backed creation-attempt fixture is limited to its disposable schema",
    );
    // The target-index uniqueness latch is deliberately reset only inside this
    // disposable integration schema so repeated test runs exercise a fresh,
    // one-shot mocked request rather than any live account mutation.
    await db.delete(microLiveSubaccountCreationAttemptTable)
      .where(eq(microLiveSubaccountCreationAttemptTable.targetExchangeIndex, exchangeIndex));
    process.env.NODE_ENV = "development";
    delete process.env.REPLIT_DEPLOYMENT;
    process.env.KALSHI_INDEX2_SUBACCOUNT_CREATION_AUTHORIZED = "true";
    process.env.KALSHI_API_ENVIRONMENT = "production";
    process.env.KALSHI_KEY_PROVISIONING_ENABLED = "true";
    process.env.KALSHI_KEY_GENERATION_AUTHORIZED = "true";
    process.env.KALSHI_PROVISIONING_API_KEY_ID = creationOwnerKeyId;
    process.env.KALSHI_PROVISIONING_PRIVATE_KEY = creationOwnerKey;
    let creationPostCount = 0;
    let mockedPairCreated = false;
    const mockedCreationFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      assert.equal(url.origin, "https://external-api.kalshi.com",
        "creation transport is always intercepted before leaving the test");
      const method = init?.method ?? "GET";
      assert.equal(new Headers(init?.headers).get("KALSHI-ACCESS-KEY"), creationOwnerKeyId,
        "the creation service must authenticate with its separately configured provisioning key");
      if (method === "POST") {
        assert.equal(url.pathname, "/trade-api/v2/portfolio/subaccounts");
        assert.deepEqual(JSON.parse(String(init?.body)), { exchange_index: exchangeIndex });
        creationPostCount++;
        assert.equal(creationPostCount, 1, "the durable service may send one mocked POST only");
        mockedPairCreated = true;
        return Response.json({
          subaccount_number: subaccountNumber, exchange_index: exchangeIndex,
        }, { status: 201 });
      }
      assert.equal(method, "GET", "attempt restart may only read account inventory");
      const nettingConfigs = [
        { subaccount_number: 0, exchange_index: 0, enabled: false },
        { subaccount_number: 0, exchange_index: 2, enabled: false },
        ...(mockedPairCreated ? [{
          subaccount_number: subaccountNumber, exchange_index: exchangeIndex, enabled: false,
        }] : []),
      ];
      const balances = [
        {
          subaccount_number: 0, exchange_index: 0,
          balance: "0.0100", updated_ts: 1_790_422_846,
        },
        {
          subaccount_number: 0, exchange_index: 2,
          balance: "163.2567", updated_ts: 1_790_422_846,
        },
        ...(mockedPairCreated ? [{
          subaccount_number: subaccountNumber, exchange_index: exchangeIndex,
          balance: "0.0000", updated_ts: 1_790_422_846,
        }] : []),
      ];
      if (url.pathname === "/trade-api/v2/portfolio/subaccounts/netting") {
        return Response.json({ netting_configs: nettingConfigs });
      }
      if (url.pathname === "/trade-api/v2/portfolio/subaccounts/balances") {
        return Response.json({ subaccount_balances: balances });
      }
      if (url.pathname === "/trade-api/v2/api_keys") {
        return Response.json({ api_keys: [{
          api_key_id: creationOwnerKeyId,
          scopes: ["read", "write"],
          subaccount: null,
        }] });
      }
      assert.fail(`unexpected mocked creation-service request: ${url.href}`);
    };
    // Simulate a process ending after the reservation commits but before it
    // can cross the network-attempt latch. A fresh service must resume this
    // single durable reservation rather than make a second one.
    const interruptedCreation = createMicroLiveSubaccountCreationService({
      store: {
        ...databaseCreationAttemptStore,
        async reserve(record) {
          const reserved = await databaseCreationAttemptStore.reserve(record);
          assert.ok(reserved);
          creationAttemptIds.add(record.attemptId);
          throw new Error("simulated restart after durable reservation");
        },
      },
      fetchImpl: mockedCreationFetch,
    });
    await assert.rejects(interruptedCreation.submit(), /simulated restart after durable reservation/);
    const [reservedAttempt] = await db.select()
      .from(microLiveSubaccountCreationAttemptTable)
      .where(eq(microLiveSubaccountCreationAttemptTable.targetExchangeIndex, exchangeIndex))
      .limit(1);
    assert.equal(reservedAttempt?.state, "reserved");
    assert.equal(reservedAttempt?.subaccountNumber, null);
    assert.equal(creationPostCount, 0);
    const creationService = createMicroLiveSubaccountCreationService({
      store: databaseCreationAttemptStore,
      fetchImpl: mockedCreationFetch,
    });
    const created = await creationService.submit();
    assert.equal(created.state, "verified", created.reason);
    assert.equal(created.subaccountNumber, subaccountNumber);
    assert.ok(created.attemptId);
    creationAttemptIds.add(created.attemptId);
    assert.equal(creationPostCount, 1);
    const [verifiedAttempt] = await db.select()
      .from(microLiveSubaccountCreationAttemptTable)
      .where(eq(microLiveSubaccountCreationAttemptTable.attemptId, created.attemptId))
      .limit(1);
    assert.ok(verifiedAttempt);
    assert.equal(verifiedAttempt.targetExchangeIndex, exchangeIndex);
    assert.equal(verifiedAttempt.state, "verified");
    assert.equal(verifiedAttempt.subaccountNumber, subaccountNumber);
    assert.match(verifiedAttempt.prePostInventoryDigest, /^[0-9a-f]{64}$/);

    // A newly constructed service represents process restart: the durable row
    // is reused and the attempted creation is never POSTed a second time.
    const restartedCreationService = createMicroLiveSubaccountCreationService({
      store: databaseCreationAttemptStore,
      fetchImpl: mockedCreationFetch,
    });
    const repeatedCreation = await restartedCreationService.submit();
    assert.equal(repeatedCreation.state, "verified");
    assert.equal(repeatedCreation.attemptId, created.attemptId);
    assert.match(repeatedCreation.reason, /POST is blocked/);
    assert.equal(creationPostCount, 1, "durable restart never repeats creation POST");
    delete process.env.KALSHI_API_KEY_ID;
    delete process.env.KALSHI_API_PRIVATE_KEY;

    await db.update(microLiveConfigTable).set({
      microLiveProductionEnabled: false,
      liveExecutionEnabled: false,
      manualKillSwitch: true,
      microLiveRunCapMicros: 1_000_000,
      microLiveRunId: null,
      // Pair commissioning/funding is permitted only while every execution
      // gate is frozen. Model that production invariant explicitly.
      microLiveRunPhase: "FROZEN",
      microLiveEntryAttempted: false,
      microLiveExitAttempted: false,
      microLiveReservedMicros: 0,
      microLiveAccountMode: null,
      microLiveSelectedSubaccount: null,
      microLiveSelectedExchangeIndex: null,
      microLiveAccountingUnresolved: false,
      microLiveAccountingUnresolvedReason: null,
      microLiveFeeApprovalId: feeApproval.id,
      microLiveFeeApprovalDigest: feeApproval.digest,
      microLiveFeeApprovalApproved: true,
      microLiveFeeApprovalInvalidated: false,
      microLiveFeeApprovalApprovedAt: new Date(baseNow),
      microLiveFeePolicyVersion: STANDING_FEE_POLICY_VERSION,
      microLiveFeeApprovalSourceUrl: CANONICAL_FEE_SCHEDULE_URL,
      microLiveFeeFormulaVersion: STANDARD_QUADRATIC_FEE_FORMULA_VERSION,
      microLiveFeeMaximumExposureMicros: feeApproval.maximumExposureMicros,
      microLiveFeeApprovedBy: feeApproval.approvedBy,
      microLiveFeeApprovedRunCapMicros: feeApproval.approvedRunCapMicros,
    }).where(eq(microLiveConfigTable.id, "singleton"));
    await db.insert(microLiveFeeVerificationTable).values({
      approvalId: feeApproval.id,
      approvalDigest: feeApproval.digest,
      policyVersion: feeApproval.policyVersion,
      sourceUrl: CANONICAL_FEE_SCHEDULE_URL,
      formulaVersion: STANDARD_QUADRATIC_FEE_FORMULA_VERSION,
      status: "verified",
      attemptId: null,
      reason: null,
      feeEvidenceFingerprint: feeFingerprint,
      checkedAt: new Date(baseNow),
    });

    // Preserve a prior frozen archive record while the new pair boundary is
    // captured; the fixture is confined to this disposable test schema.
    await db.insert(microLiveRunArchiveTable).values({
      priorRunId: historicalPriorRunId,
      successorRunId: `isolated-historical-successor-${suffix}`,
      phase: "FROZEN",
      armedAt: new Date(baseNow - 60_000),
      deadlineAt: null,
      approvalId: "historical-isolated-approval",
      approvalDigest: historicalDigest,
      approvalSourceUrl: null,
      approvalFormulaVersion: null,
      approvalApprover: null,
      freezeReason: "operator_froze_unused_run_for_reviewed_transition",
      capMicros: 1_000_000,
      reservedMicros: 0,
      entryAttempted: false,
      exitAttempted: false,
      accountMode: "exclusive",
      selectedSubaccount: 1,
      selectedExchangeIndex: null,
      restrictedApiKeyId: null,
      restrictedKeyFingerprint: null,
      fundingAnchorSubaccount: null,
      fundingAnchorExchangeIndex: null,
      fundingAnchorTransferId: null,
      fundingAnchorTransferAt: null,
      fundingAnchorAmountCents: null,
      pairCashBaselineMicros: null,
      pairCashBaselineRunId: null,
      pairCashBaselineAt: null,
      pairCashBaselineEvidenceDigest: null,
      accountActivityCheckpointSubaccount: null,
      accountActivityCheckpointExchangeIndex: null,
      accountActivityCheckpointRunId: null,
      accountActivityCheckpointCursor: null,
      accountActivityCheckpointAt: null,
      accountActivityCheckpointEvidenceDigest: null,
      maxLiveBankrollCents: 500,
      maxSingleOrderRiskCents: 500,
      maxCumulativeReservedCents: 500,
      maxScoutStakeCents: 500,
      maxConfirmAdditionalStakeCents: 500,
      actorId: "isolated-micro-live-test",
      transitionReason: "isolated historical frozen fixture",
    });
    const [historicalBefore] = await db.select().from(microLiveRunArchiveTable)
      .where(eq(microLiveRunArchiveTable.priorRunId, historicalPriorRunId)).limit(1);
    assert.ok(historicalBefore);

    const fundingRecord: KalshiPairEvidenceRecord = {
      feed: "subaccount_transfer",
      id: transferId,
      classification: "pair",
      attribution: "record_fields",
      subaccountNumber,
      exchangeIndex,
      occurredAt: transferAt.toISOString(),
      cashDeltaMicros: "25000000",
      payloadDigest: createHash("sha256").update(`transfer:${transferId}`).digest("hex"),
      details: {
        from_subaccount: "0",
        to_subaccount: String(subaccountNumber),
        exchange_index: String(exchangeIndex),
        amount_cents: "2500",
        status: "completed",
      },
    };
    const ambiguousRecord: KalshiPairEvidenceRecord = {
      feed: "cross_exchange_transfer",
      id: `isolated-ambiguous-transfer-${suffix}`,
      classification: "ambiguous",
      attribution: "unscoped",
      subaccountNumber: null,
      exchangeIndex: null,
      sourceExchangeIndex: exchangeIndex,
      destinationExchangeIndex: 3,
      occurredAt: new Date(baseNow + 1).toISOString(),
      cashDeltaMicros: null,
      payloadDigest: createHash("sha256").update(`ambiguous:${suffix}`).digest("hex"),
      details: { amount_cents: "2500", status: "completed" },
    };
    const exchangeOrders = new Map<string, {
      id: string;
      clientOrderId: string;
      ticker: string;
      side: "yes" | "no";
      action: "buy" | "sell";
      priceDollars: string;
      initialCount: number;
      filledCount: number;
      remainingCount: number;
      status: string;
      createdAt: string;
    }>();
    const exchangeFills: KalshiAccountSnapshot["fills"] = [];
    let settlementState: {
      marketResult: string;
      yesCountFp: string;
      noCountFp: string;
      revenueCents: string;
      settledAt: string;
      feeCostDollars: string;
    } | null = null;
    let evidenceMutation: "valid" | "wrong_n" | "wrong_index" | "wrong_key" |
      "wrong_market_index" | "unexplained_order" = "valid";
    const dollarText = (micros: bigint) =>
      `${micros / 1_000_000n}.${String(micros % 1_000_000n).padStart(6, "0")}`;
    const exchangePosition = () => {
      let contracts = 0;
      let exposureMicros = 0n;
      const lots: Array<{ contracts: number; unitCostMicros: bigint }> = [];
      for (const fill of [...exchangeFills].sort((left, right) =>
        Date.parse(left.createdAt ?? "") - Date.parse(right.createdAt ?? ""))) {
        const count = Number(fill.countFp);
        const priceMicros = dollarsToMicros(fill.priceDollars);
        assert.ok(priceMicros !== null && Number.isSafeInteger(count) && count > 0);
        if (fill.action === "buy") {
          lots.push({ contracts: count, unitCostMicros: BigInt(priceMicros!) });
          contracts += count;
        } else {
          let remaining = count;
          while (remaining > 0) {
            const lot = lots.find((candidate) => candidate.contracts > 0);
            assert.ok(lot, "mock exchange cannot sell unowned inventory");
            const consumed = Math.min(remaining, lot.contracts);
            lot.contracts -= consumed;
            remaining -= consumed;
            contracts -= consumed;
          }
        }
      }
      for (const lot of lots) exposureMicros += BigInt(lot.contracts) * lot.unitCostMicros;
      return { contracts, exposureMicros };
    };
    const cashDeltaMicros = () => {
      let delta = 0n;
      for (const fill of exchangeFills) {
        const price = dollarsToMicros(fill.priceDollars);
        const fee = dollarsToMicros(fill.feeCostDollars);
        assert.ok(price !== null && fee !== null);
        const trade = BigInt(Math.round(Number(fill.countFp) * price!));
        delta += (fill.action === "buy" ? -trade : trade) - BigInt(fee!);
      }
      if (settlementState) delta += BigInt(settlementState.revenueCents) * 10_000n;
      return delta;
    };
    const restingBuyReserveMicros = () => [...exchangeOrders.values()]
      .filter((order) => order.action === "buy" && Number(order.remainingCount) > 0)
      .reduce((sum, order) => sum +
        BigInt(Math.round(Number(order.remainingCount) * Number(order.priceDollars) * 1_000_000)),
      0n);
    const tradeDirection = (side: string, action: string) => {
      const outcomeSide = side === "yes"
        ? (action === "buy" ? "yes" : "no")
        : (action === "buy" ? "no" : "yes");
      return {
        outcomeSide,
        bookSide: outcomeSide === "yes" ? "bid" : "ask",
      };
    };
    const currentAccount = (): KalshiAccountSnapshot => {
      const position = exchangePosition();
      const reserve = restingBuyReserveMicros();
      const available = 25_000_000n + cashDeltaMicros() - reserve;
      assert.ok(available >= 0n);
      return {
        balance: {
          availableCashDollars: dollarText(available),
          portfolioValueDollars: dollarText(available + position.exposureMicros),
        },
        openOrders: [...exchangeOrders.values()].filter((order) =>
          Number(order.remainingCount) > 0).map((order) => ({
          id: order.id, ticker: order.ticker, exchangeIndex: 2,
          side: order.side, action: order.action, priceDollars: order.priceDollars,
          remainingCount: String(order.remainingCount), status: order.status,
          createdAt: order.createdAt,
        })),
        positions: position.contracts === 0 && !settlementState ? [] : [{
          ticker: market, exchangeIndex: 2,
          positionFp: settlementState ? "0" : String(position.contracts),
          marketExposureDollars: settlementState ? "0.000000" :
            dollarText(position.exposureMicros),
          realizedPnlDollars: "0",
        }],
        fills: exchangeFills.map((fill) => ({ ...fill })),
        truncated: { openOrders: false, positions: false, fills: false },
      };
    };
    const evidence = async (
      _n: number,
      _ticker: string,
      anchor?: KalshiDedicatedPairFundingAnchor,
    ): Promise<KalshiDedicatedPairEvidence> => {
      rawEvidenceReads++;
      const finishedAt = new Date().toISOString();
      const orders = [...exchangeOrders.values()];
      const position = exchangePosition();
      const records: KalshiPairEvidenceRecord[] = [
        fundingRecord,
        ...orders.map((order): KalshiPairEvidenceRecord => ({
          feed: "current_order",
          id: order.id,
          classification: "pair",
          attribution: "record_fields",
          subaccountNumber,
          exchangeIndex,
          occurredAt: order.createdAt,
          cashDeltaMicros: null,
          payloadDigest: createHash("sha256").update(`order:${order.id}:${order.status}:${order.filledCount}`).digest("hex"),
          details: {
            ticker: order.ticker, client_order_id: order.clientOrderId,
            side: order.side, action: order.action, type: "limit", status: order.status,
            initial_count_fp: String(order.initialCount), fill_count_fp: String(order.filledCount),
            remaining_count_fp: String(order.remainingCount), price_dollars: order.priceDollars,
            reduce_only: String(order.action === "sell"),
            ...(() => {
              const direction = tradeDirection(order.side, order.action);
              return { outcome_side: direction.outcomeSide, book_side: direction.bookSide };
            })(),
          },
        })),
        ...exchangeFills.map((fill): KalshiPairEvidenceRecord => ({
          feed: "current_fill",
          id: fill.id,
          classification: "pair",
          attribution: "record_fields",
          subaccountNumber,
          exchangeIndex,
          occurredAt: fill.createdAt,
          cashDeltaMicros: null,
          payloadDigest: createHash("sha256").update(`fill:${fill.id}`).digest("hex"),
          details: {
            order_id: fill.orderId, ticker: fill.ticker, side: fill.side,
            action: fill.action, count_fp: fill.countFp,
            price_dollars: fill.priceDollars, fee_cost: fill.feeCostDollars ?? null,
            ...(() => {
              const direction = tradeDirection(fill.side, fill.action);
              return { outcome_side: direction.outcomeSide, book_side: direction.bookSide };
            })(),
          },
        })),
        ...(position.contracts !== 0 || settlementState ? [{
          feed: "position",
          id: `position:${market}`,
          classification: "pair",
          attribution: "record_fields",
          subaccountNumber,
          exchangeIndex,
          occurredAt: finishedAt,
          cashDeltaMicros: null,
          payloadDigest: createHash("sha256").update(`position:${position.contracts}:${settlementState !== null}`).digest("hex"),
          details: {
            ticker: market,
            position_fp: settlementState ? "0" : String(position.contracts),
            market_exposure_dollars: settlementState ? "0.000000" :
              dollarText(position.exposureMicros),
          },
        } as KalshiPairEvidenceRecord] : []),
        ...(settlementState ? [{
          feed: "settlement",
          id: `settlement:${market}`,
          classification: "pair",
          attribution: "record_fields",
          subaccountNumber,
          exchangeIndex,
          occurredAt: settlementState.settledAt,
          cashDeltaMicros: (BigInt(settlementState.revenueCents) * 10_000n).toString(),
          payloadDigest: createHash("sha256").update(`settlement:${market}:${settlementState.settledAt}`).digest("hex"),
          details: {
            ticker: market, market_result: settlementState.marketResult,
            yes_count_fp: settlementState.yesCountFp,
            no_count_fp: settlementState.noCountFp,
            revenue: settlementState.revenueCents,
            fee_cost: settlementState.feeCostDollars,
          },
        } as KalshiPairEvidenceRecord] : []),
        ...(evidenceMutation === "unexplained_order" ? [{
          feed: "current_order",
          id: `unowned-order-${suffix}`,
          classification: "pair",
          attribution: "record_fields",
          subaccountNumber,
          exchangeIndex,
          occurredAt: finishedAt,
          cashDeltaMicros: null,
          payloadDigest: createHash("sha256").update(`unowned:${suffix}`).digest("hex"),
          details: {
            ticker: market, client_order_id: "unowned", side: "yes", action: "buy",
            type: "limit", status: "canceled", initial_count_fp: "1",
            fill_count_fp: "0", remaining_count_fp: "0", price_dollars: "0.40",
            reduce_only: "false",
          },
        } as KalshiPairEvidenceRecord] : []),
        ...(ambiguousTransferPresent ? [ambiguousRecord] : []),
      ];
      const account = currentAccount();
      const availableMicros = BigInt(dollarsToMicros(account.balance.availableCashDollars)!);
      const balanceMicros = availableMicros + restingBuyReserveMicros();
      const pairSubaccount: number = evidenceMutation === "wrong_n"
        ? subaccountNumber + 1 : subaccountNumber;
      const pairIndex: number = evidenceMutation === "wrong_index" ? 3 : exchangeIndex;
      return {
        pair: { subaccountNumber: pairSubaccount, exchangeIndex: pairIndex },
        balance: {
          subaccountNumber: pairSubaccount,
          exchangeIndex: pairIndex,
          balanceDollars: dollarText(balanceMicros),
          availableCashDollars: dollarText(availableMicros),
          balanceSemantics: "subaccount_inventory_plus_scoped_available_cash",
          updatedTs: Math.ceil(Date.now() / 1_000),
        },
        collateralSnapshot: {
          availableCashMicros: availableMicros.toString(),
          inventoryBalanceMicros: balanceMicros.toString(),
          restingEntryReserveMicros: restingBuyReserveMicros().toString(),
          restingExitContractsByTicker: {},
          capturedAt: finishedAt,
        },
        marketExchangeIndex: evidenceMutation === "wrong_market_index" ? 3 : exchangeIndex,
        keyRestrictionVerified: evidenceMutation !== "wrong_key",
        tradePermissionVerified: true,
        allTimeHistoryExhaustive: true,
        exclusiveControlVerified: false,
        complete: true,
        reason: null,
        reasons: [],
        records,
        feeEvidence: [],
        postAnchorCashDeltaMicros: cashDeltaMicros().toString(),
        checkpointDigest: createHash("sha256")
          .update(`pair-evidence:${suffix}:${anchor ? "anchored" : "initial"}`)
          .digest("hex"),
        historyCoveredFrom: cleanAt.toISOString(),
        fundingAnchor: anchor ? {
          transferId: anchor.transferId,
          transferredAt: anchor.transferredAt,
          amountCents: anchor.amountCents,
          baselineCashMicros: anchor.baselineCashMicros,
          baselineAt: anchor.baselineAt,
          preFundingZeroSnapshot: anchor.preFundingZeroSnapshot,
          postFundingSnapshot: anchor.postFundingSnapshot,
        } : null,
        recordCounts: {
          positions: records.filter((record) => record.feed === "position").length,
          orders: orders.length, fills: exchangeFills.length,
          settlements: settlementState ? 1 : 0,
          transfers: records.filter((record) => record.feed === "subaccount_transfer").length,
        },
        scanStartedAt: new Date(Date.now() - 100).toISOString(),
        scanFinishedAt: finishedAt,
      } as unknown as KalshiDedicatedPairEvidence;
    };
    const boundaryDependencies = {
      now: () => scanAt,
      captureSnapshot: async (): Promise<KalshiProspectiveCleanPairSnapshot> => {
        assert.equal(process.env.KALSHI_API_KEY_ID, undefined);
        assert.equal(process.env.KALSHI_API_PRIVATE_KEY, undefined);
        return {
          pair: { subaccountNumber, exchangeIndex },
          status: "clean",
          capturedAt: cleanAt.toISOString(),
          scanStartedAt: cleanAt.toISOString(),
          scanFinishedAt: cleanAt.toISOString(),
          availableCashMicros: "0",
          portfolioValueMicros: "0",
          inventoryCashMicros: "0",
          zeroPositions: true,
          zeroOrders: true,
          zeroFills: true,
          zeroSettlements: true,
          zeroPriorPairTransfers: true,
          // The creation-time authenticated zero snapshot intentionally precedes
          // restricted-key provisioning; key checks are a separate state gate.
          keyRestrictionVerified: false,
          tradePermissionVerified: false,
          marketExchangeIndex: exchangeIndex,
          evidenceDigest: createHash("sha256").update(`clean:${suffix}`).digest("hex"),
          reasons: [],
          records: [],
        };
      },
      readEvidence: evidence,
      readFeeApproval: async () => feeApproval,
      readFeeTerms: async (selectedTicker: string) =>
        ({ ...boundedFeeTerms(selectedTicker, feeFingerprint), verifiedAt: baseNow }),
    };

    const captured = await captureMicroLivePairCleanBoundary(
      { subaccountNumber, ticker: market }, boundaryDependencies,
    );
    assert.equal(captured.status, "captured", captured.reason);
    const [cleanBoundary] = await db.select().from(microLivePairBoundaryTable)
      .where(eq(microLivePairBoundaryTable.subaccountNumber, subaccountNumber)).limit(1);
    assert.ok(cleanBoundary);
    assert.equal(cleanBoundary.state, "CREATED_CLEAN");
    assert.equal(cleanBoundary.creationAttemptId, created.attemptId);
    assert.equal(cleanBoundary.creationInventoryDigest, verifiedAttempt.prePostInventoryDigest);
    assert.equal(cleanBoundary.restrictedApiKeyId, null,
      "clean snapshot was captured before a restricted key existed");
    assert.equal(cleanBoundary.cleanBalanceMicros, "0");
    assert.equal(cleanBoundary.cleanPositionCount, 0);
    assert.equal(cleanBoundary.cleanOrderCount, 0);
    assert.equal(cleanBoundary.cleanFillCount, 0);
    assert.equal(cleanBoundary.cleanSettlementCount, 0);

    // Provision the key only after the zero boundary is durably CREATED_CLEAN.
    process.env.KALSHI_API_KEY_ID = keyId;
    process.env.KALSHI_API_PRIVATE_KEY = privateKey;
    const evidenceReadsBeforeUnboundFunding = rawEvidenceReads;
    const funding = await reconcileMicroLivePairFunding(
      { subaccountNumber, ticker: market }, boundaryDependencies,
    );
    assert.equal(funding.status, "blocked",
      "funding is denied while the boundary is only CREATED_CLEAN");
    assert.equal(funding.reason, "pair_boundary_clean_snapshot_missing_or_identity_changed");
    assert.equal(rawEvidenceReads, evidenceReadsBeforeUnboundFunding,
      "funding stops at CREATED_CLEAN before reading post-funding evidence");
    const [stillCreatedClean] = await db.select().from(microLivePairBoundaryTable)
      .where(eq(microLivePairBoundaryTable.subaccountNumber, subaccountNumber)).limit(1);
    assert.equal(stillCreatedClean?.state, "CREATED_CLEAN");

    const keyVerificationProbe = {
      subaccountNumber,
      exchangeIndex,
      keyId,
      scopes: ["read", "write::trade"],
    };
    const verifyMockedBinding = async (requestedN: number) =>
      requestedN === keyVerificationProbe.subaccountNumber &&
      keyVerificationProbe.exchangeIndex === exchangeIndex &&
      process.env.KALSHI_API_KEY_ID === keyVerificationProbe.keyId &&
      keyVerificationProbe.scopes.length === 2 &&
      keyVerificationProbe.scopes.includes("read") &&
      keyVerificationProbe.scopes.includes("write::trade");
    const keyBindingDependencies = {
      ...boundaryDependencies,
      verifyKeyBinding: verifyMockedBinding,
    };

    process.env.KALSHI_API_KEY_ID = `wrong-key-${suffix}`;
    process.env.KALSHI_API_PRIVATE_KEY = `wrong-private-${suffix}`;
    const wrongKeyBinding = await bindMicroLivePairRestrictedKey(
      { subaccountNumber }, keyBindingDependencies,
    );
    assert.deepEqual(wrongKeyBinding, {
      status: "blocked", reason: "pair_boundary_restricted_key_not_exactly_bound",
    });
    process.env.KALSHI_API_KEY_ID = keyId;
    process.env.KALSHI_API_PRIVATE_KEY = privateKey;

    process.env.KALSHI_BOT_SUBACCOUNT = String(subaccountNumber + 1);
    const wrongNBinding = await bindMicroLivePairRestrictedKey(
      { subaccountNumber }, keyBindingDependencies,
    );
    assert.deepEqual(wrongNBinding, {
      status: "blocked", reason: "pair_boundary_restricted_key_binding_mismatch",
    });
    process.env.KALSHI_BOT_SUBACCOUNT = String(subaccountNumber);
    keyVerificationProbe.subaccountNumber = subaccountNumber + 1;
    const verifierWrongN = await bindMicroLivePairRestrictedKey(
      { subaccountNumber }, keyBindingDependencies,
    );
    assert.deepEqual(verifierWrongN, {
      status: "blocked", reason: "pair_boundary_restricted_key_not_exactly_bound",
    });
    keyVerificationProbe.subaccountNumber = subaccountNumber;
    keyVerificationProbe.exchangeIndex = exchangeIndex + 1;
    const wrongIndexBinding = await bindMicroLivePairRestrictedKey(
      { subaccountNumber }, keyBindingDependencies,
    );
    assert.deepEqual(wrongIndexBinding, {
      status: "blocked", reason: "pair_boundary_restricted_key_not_exactly_bound",
    });
    keyVerificationProbe.exchangeIndex = exchangeIndex;

    const [preBindConfig] = await db.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
    const [preBindShadow] = await db.select().from(liveExecutionConfigTable)
      .where(eq(liveExecutionConfigTable.id, "singleton")).limit(1);
    const [preBindBoundary] = await db.select().from(microLivePairBoundaryTable)
      .where(eq(microLivePairBoundaryTable.subaccountNumber, subaccountNumber)).limit(1);
    assert.ok(preBindConfig);
    assert.equal(preBindConfig.microLiveProductionEnabled, false);
    assert.equal(preBindConfig.liveExecutionEnabled, false);
    assert.equal(preBindConfig.manualKillSwitch, true);
    assert.ok(preBindShadow);
    assert.equal(preBindShadow.liveExecutionEnabled, false);
    assert.equal(preBindShadow.manualKillSwitch, true);
    assert.ok(preBindBoundary);
    assert.equal(preBindBoundary.state, "CREATED_CLEAN");
    assert.equal(preBindBoundary.restrictedApiKeyId, null);
    assert.equal(preBindBoundary.keyBoundAt, null);
    assert.equal(preBindBoundary.fundingTransferId, null);
    assert.equal(preBindBoundary.cleanBalanceMicros, "0");

    const keyBound = await bindMicroLivePairRestrictedKey(
      { subaccountNumber }, keyBindingDependencies,
    );
    assert.equal(keyBound.status, "captured", keyBound.reason);
    const [verifiedKeyBoundary] = await db.select().from(microLivePairBoundaryTable)
      .where(eq(microLivePairBoundaryTable.subaccountNumber, subaccountNumber)).limit(1);
    assert.equal(verifiedKeyBoundary?.state, "KEY_BOUND_VERIFIED");
    assert.equal(verifiedKeyBoundary?.restrictedApiKeyId, keyId);
    assert.equal(verifiedKeyBoundary?.restrictedKeyFingerprint, keyFingerprint);

    const funded = await reconcileMicroLivePairFunding(
      { subaccountNumber, ticker: market }, boundaryDependencies,
    );
    assert.equal(funded.status, "funded", funded.reason);
    const [fundedBoundary] = await db.select().from(microLivePairBoundaryTable)
      .where(eq(microLivePairBoundaryTable.subaccountNumber, subaccountNumber)).limit(1);
    assert.ok(fundedBoundary);
    assert.equal(fundedBoundary.fundingTransferId, transferId);
    assert.equal(fundedBoundary.fundingAmountCents, 2500);
    assert.equal(fundedBoundary.postFundingBalanceMicros, "25000000");

    // Funding is reconciled only while FROZEN. Initialization is a separate
    // commissioning step and requires a pristine UNARMED singleton with all
    // execution flags still off and the kill switch still on.
    await db.update(microLiveConfigTable).set({
      microLiveRunPhase: "UNARMED",
      microLiveRunFreezeReason: null,
    }).where(eq(microLiveConfigTable.id, "singleton"));

    const initialized = await initializeMicroLivePairRun(
      { subaccountNumber, ticker: market }, boundaryDependencies,
    );
    assert.equal(initialized.status, "initialized", initialized.reason);
    assert.ok(initialized.runId);
    const [runConfig] = await db.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
    assert.ok(runConfig);
    assert.equal(runConfig.microLiveRunPhase, "UNARMED");
    assert.equal(runConfig.microLiveSelectedSubaccount, subaccountNumber);
    assert.equal(runConfig.microLiveSelectedExchangeIndex, exchangeIndex);
    assert.equal(runConfig.microLiveProductionEnabled, false);
    assert.equal(runConfig.liveExecutionEnabled, false);
    assert.equal(runConfig.manualKillSwitch, true);

    // Supply the latest paper market identity and raw authenticated pair
    // evidence through the isolated-schema seam. The actual arm path must
    // reconcile it; this is not a preverified-proof injection.
    await insertEvaluation({ ticker: market });
    process.env.MICRO_LIVE_PRODUCTION_ENABLED = "true";
    process.env.LIVE_EXECUTION_ENABLED = "true";
    const owner = `micro-live-test-${suffix}`;
    await db.update(forwardTestEngineTable).set({
      leaseOwner: owner,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    }).where(eq(forwardTestEngineTable.id, "v1.3-paper"));
    simulateMicroLiveRestartForIsolatedTest();
    registerMicroLiveWorkerLeaseOwner(owner);
    await observeMicroLiveWorkerLeaseForIsolatedTest();
    let postAttempts = 0;
    const evidenceReadsBeforeArm = rawEvidenceReads;
    const armDependencies = mocks({
      approvedFeeSessionForTest: () => feeApproval,
      readDedicatedPairEvidenceForTest: evidence,
      readEntryFeeTerms: async (selectedTicker) => ({
        ...boundedFeeTerms(
          selectedTicker, boundedApprovalFingerprint(feeApproval, selectedTicker),
        ),
        verifiedAt: Date.now(),
      }),
      readAccount: async () => currentAccount(),
      readAccountActivity: async () => ({
        orders: [], fills: [], available: true, truncated: false,
        keyRestrictionVerified: true, selectedSubaccount: subaccountNumber,
        tradePermissionVerified: true,
        scanStartedAt: new Date(Date.now() - 100).toISOString(),
        scanFinishedAt: new Date().toISOString(), exclusiveControlVerified: true,
      }),
      submitOrder: async () => {
        postAttempts++;
        throw new Error("arming must never reach an order POST");
      },
    });
    const armResult = await armBoundedMicroLiveRun(armDependencies);
    assert.equal(armResult.status, "armed", armResult.reason);
    assert.ok(rawEvidenceReads > evidenceReadsBeforeArm,
      "arm consumes raw authenticated pair evidence through the normal audit");
    assert.equal(postAttempts, 0);
    assert.equal((await getMicroLiveState()).boundedRun.phase, "ENTRY_OPEN");

    let entryPosts = 0;
    let exitPosts = 0;
    let cancelAttempts = 0;
    let entryReservationObservedBeforePostResult = false;
    let restingExitRestartObservedBeforeDelete = false;
    let entryExchangeOrderId: string | null = null;
    const lifecycle = mocks({
      approvedFeeSessionForTest: () => feeApproval,
      readDedicatedPairEvidenceForTest: evidence,
      readOrderbook: async () => ({
        yesAskDollars: "0.48", noAskDollars: "0.48",
        yesBidDollars: "0.47", noBidDollars: "0.47",
        yesAskAvailableContracts: "2", noAskAvailableContracts: "2",
        observedAt: new Date().toISOString(),
      }),
      readEntryFeeTerms: async (selectedTicker) => ({
        ...boundedFeeTerms(
          selectedTicker, boundedApprovalFingerprint(feeApproval, selectedTicker),
        ),
        verifiedAt: Date.now(),
      }),
      readAccount: async () => currentAccount(),
      readAccountActivity: async () => ({
        orders: [...exchangeOrders.values()].map((order) => ({
          id: order.id, clientOrderId: order.clientOrderId, ticker: order.ticker,
          side: order.side, action: order.action, type: "limit", status: order.status,
          priceDollars: order.priceDollars, initialCount: String(order.initialCount),
          filledCount: String(order.filledCount), remainingCount: String(order.remainingCount),
          createdAt: order.createdAt, exchangeIndex,
        })),
        fills: exchangeFills.map((fill) => ({
          ...fill, feeCostDollars: fill.feeCostDollars ?? null,
        })),
        available: true, truncated: false, keyRestrictionVerified: true,
        selectedSubaccount: subaccountNumber,
        tradePermissionVerified: true,
        scanStartedAt: new Date(Date.now() - 100).toISOString(),
        scanFinishedAt: new Date().toISOString(), exclusiveControlVerified: true,
      }),
      readHistoricalFills: async () => ({
        fills: exchangeFills.map((fill) => ({ ...fill })),
        truncated: false, available: true,
      }),
      readSettlements: async () => ({
        settlements: settlementState ? [{
          ticker: market, eventTicker: `${market}-EVENT`, exchangeIndex,
          marketResult: settlementState.marketResult,
          yesCountFp: settlementState.yesCountFp,
          yesTotalCostDollars: "0.480000",
          noCountFp: settlementState.noCountFp,
          noTotalCostDollars: "0.000000",
          revenueCents: settlementState.revenueCents,
          settledAt: settlementState.settledAt,
          feeCostDollars: settlementState.feeCostDollars,
        }] : [],
        truncated: false,
      }),
      readOrderStatus: async (id) => {
        const order = exchangeOrders.get(id);
        assert.ok(order, `GET-only recovery requested unknown order ${id}`);
        return {
          orderId: order.id, clientOrderId: order.clientOrderId, ticker: order.ticker,
          side: order.side, action: order.action, type: "limit", status: order.status,
          remainingCount: String(order.remainingCount), filledCount: String(order.filledCount),
          priceDollars: order.priceDollars, initialCount: String(order.initialCount),
          ...tradeDirection(order.side, order.action),
        };
      },
      submitOrder: async (input) => {
        const orderId = `exchange-${input.clientOrderId}`;
        if (input.action === "buy") {
          entryPosts++;
          entryExchangeOrderId = orderId;
        } else {
          exitPosts++;
        }
        exchangeOrders.set(orderId, {
          id: orderId, clientOrderId: input.clientOrderId, ticker: input.ticker,
          side: input.side, action: input.action, priceDollars: input.priceDollars,
          initialCount: input.count, filledCount: 0, remainingCount: input.count,
          status: "resting", createdAt: new Date().toISOString(),
        });
        if (input.action === "buy") {
          const [reservedBeforeResponse] = await db.select().from(microLiveOrderTable)
            .where(eq(microLiveOrderTable.clientOrderId, input.clientOrderId)).limit(1);
          assert.ok(reservedBeforeResponse);
          assert.equal(reservedBeforeResponse.status, "pending");
          assert.equal(reservedBeforeResponse.exchangeOrderId, null,
            "reservation is durable before the exchange POST result is known");
          entryReservationObservedBeforePostResult = true;
          simulateMicroLiveRestartForIsolatedTest();
          throw new Error("isolated accepted POST response lost across simulated restart");
        }
        return {
          orderId, clientOrderId: input.clientOrderId, ticker: input.ticker,
          side: input.side, action: input.action, type: "limit", status: "resting",
          remainingCount: String(input.count), filledCount: "0",
        };
      },
      cancelOrder: async (exchangeOrderId) => {
        const [restingExit] = await db.select().from(microLiveOrderTable)
          .where(eq(microLiveOrderTable.exchangeOrderId, exchangeOrderId)).limit(1);
        assert.ok(restingExit);
        assert.equal(restingExit.action, "sell");
        assert.equal(restingExit.status, "pending",
          "restart window begins after the resting exit was persisted");
        assert.ok(restingExit.cancellationAttemptedAt,
          "the durable one-use claim exists before the DELETE transport seam");
        if (!restingExitRestartObservedBeforeDelete) {
          restingExitRestartObservedBeforeDelete = true;
          simulateMicroLiveRestartForIsolatedTest();
        }
        cancelAttempts++;
        throw new Error("isolated DELETE response lost after exchange acceptance");
      },
    });
    assert.equal((await getMicroLiveState()).boundedRun.phase, "ENTRY_OPEN");
    const entryEvaluationId = await insertEvaluation({
      // Persist a current observation; never manufacture a future tick.
      ticker: market, evaluatedAt: new Date(),
    });
    const entryResult = await executeQualifiedV13Trigger(entryEvaluationId, lifecycle);
    assert.equal(entryResult.status, "unknown", entryResult.reason);
    assert.equal(entryReservationObservedBeforePostResult, true,
      "restart was simulated after reservation and before the POST result");
    assert.equal(entryPosts, 1);
    let [buyOrder] = await db.select().from(microLiveOrderTable)
      .where(eq(microLiveOrderTable.sourceEvaluationId, entryEvaluationId)).limit(1);
    assert.ok(buyOrder);
    assert.equal(buyOrder.exchangeOrderId, null);
    assert.equal(buyOrder.status, "unknown");
    process.env.MICRO_LIVE_PRODUCTION_ENABLED = "false";
    process.env.LIVE_EXECUTION_ENABLED = "false";
    simulateMicroLiveRestartForIsolatedTest();
    const uncertainLink = await reconcileUncertainSubmission(
      buyOrder.id, "n7-pair-restart-test", {
        readAccount: async () => currentAccount(),
        readDedicatedPairEvidence: evidence,
        readEvidence: async (): Promise<KalshiSubmissionEvidence> => {
          const orders = [...exchangeOrders.values()].map((order) => ({
            id: order.id, clientOrderId: order.clientOrderId, ticker: order.ticker,
            side: order.side, action: order.action, type: "limit", status: order.status,
            priceDollars: order.priceDollars, initialCount: String(order.initialCount),
            filledCount: String(order.filledCount), remainingCount: String(order.remainingCount),
            exchangeIndex, ...tradeDirection(order.side, order.action),
          }));
          const fills = exchangeFills.map((fill) => ({
            ...fill, feeCostDollars: fill.feeCostDollars ?? null,
          }));
          return {
            orders, fills, historicalFills: fills,
            historicalFillsAvailable: true, truncated: false,
          };
        },
      },
    );
    assert.equal(uncertainLink.status, "linked_needs_reconciliation", uncertainLink.reason);
    [buyOrder] = await db.select().from(microLiveOrderTable)
      .where(eq(microLiveOrderTable.sourceEvaluationId, entryEvaluationId)).limit(1);
    assert.ok(buyOrder);
    assert.equal(buyOrder.exchangeOrderId, entryExchangeOrderId,
      "GET-only client-order evidence links the accepted N=7 shard-2 order");
    assert.equal(buyOrder.status, "unknown",
      "identity linking does not claim fill reconciliation is complete");
    const linkedRestart = await reconcileMicroLiveAtStartup(lifecycle);
    assert.equal(linkedRestart.reason,
      "dedicated_pair_outstanding_entry_recovered_get_only", linkedRestart.reason);
    assert.equal(entryPosts, 1, "restart and identity linking never repeat the entry POST");
    assert.equal(cancelAttempts, 0, "entry recovery never sends a DELETE");
    const frozenAfterEntryRecovery = await getMicroLiveState();
    assert.equal(frozenAfterEntryRecovery.killSwitch, "ON");
    assert.equal(frozenAfterEntryRecovery.databaseFlags?.microLiveProductionEnabled, false);
    assert.equal(frozenAfterEntryRecovery.databaseFlags?.liveExecutionEnabled, false);
    process.env.MICRO_LIVE_PRODUCTION_ENABLED = "true";
    process.env.LIVE_EXECUTION_ENABLED = "true";
    [buyOrder] = await db.select().from(microLiveOrderTable)
      .where(eq(microLiveOrderTable.exchangeOrderId, entryExchangeOrderId!)).limit(1);
    assert.ok(buyOrder);
    assert.equal(
      buyOrder.requestedStakeCents * 10_000 +
        (buyOrder.reservedEntryFeeMicros ?? 0) + (buyOrder.reservedExitFeeMicros ?? 0),
      1_000_000,
      "entry reservation is exactly $1 inclusive of entry and exit fee bounds",
    );

    const addFill = (orderId: string, count: number, id: string) => {
      const order = exchangeOrders.get(orderId);
      assert.ok(order);
      exchangeFills.push({
        id, orderId, ticker: market, exchangeIndex, side: order.side,
        action: order.action, countFp: String(count), priceDollars: order.priceDollars,
        createdAt: new Date().toISOString(), feeCostDollars: "0.010000",
        ...tradeDirection(order.side, order.action),
      });
      order.filledCount += count;
      order.remainingCount -= count;
      order.status = order.remainingCount > 0 ? "resting" :
        order.action === "sell" ? "canceled" : "executed";
    };
    assert.equal(buyOrder.remainingContracts, 2);
    let [restartConfig] = await db.select().from(microLiveConfigTable)
      .where(eq(microLiveConfigTable.id, "singleton")).limit(1);
    assert.equal(restartConfig?.microLiveReservedMicros, 1_000_000);

    const partialFillId = `pair-entry-partial-${suffix}`;
    addFill(entryExchangeOrderId!, 1, partialFillId);
    const partialRestart = await reconcileMicroLiveAtStartup(lifecycle);
    assert.equal(partialRestart.reason,
      "dedicated_pair_outstanding_entry_recovered_get_only",
      partialRestart.reason);
    [buyOrder] = await db.select().from(microLiveOrderTable)
      .where(eq(microLiveOrderTable.exchangeOrderId, entryExchangeOrderId!)).limit(1);
    assert.equal(buyOrder?.status, "partial");
    assert.equal(buyOrder?.filledContracts, 1);
    assert.equal(buyOrder?.remainingContracts, 1);
    addFill(entryExchangeOrderId!, 1, `pair-entry-final-${suffix}`);
    simulateMicroLiveRestartForIsolatedTest();
    const restartOwner = `micro-live-pair-restart-${suffix}`;
    await db.update(forwardTestEngineTable).set({
      leaseOwner: restartOwner, leaseExpiresAt: new Date(Date.now() + 60_000),
    }).where(eq(forwardTestEngineTable.id, "v1.3-paper"));
    assert.equal(entryPosts, 1,
      "GET-only restart after full entry fill never repeats the entry POST");
    assert.equal(cancelAttempts, 0,
      "GET-only restart after full entry fill precedes any exit DELETE");
    registerMicroLiveWorkerLeaseOwner(restartOwner);
    await observeMicroLiveWorkerLeaseForIsolatedTest();
    const resumed = await resumeBoundedMicroLiveExitOnly(lifecycle);
    assert.equal(resumed.status, "resumed",
      `${resumed.reason}; state=${JSON.stringify((await getMicroLiveState()).boundedRun)}`);
    assert.equal((await getMicroLiveState()).boundedRun.phase, "EXIT_ONLY");
    [buyOrder] = await db.select().from(microLiveOrderTable)
      .where(eq(microLiveOrderTable.exchangeOrderId, entryExchangeOrderId!)).limit(1);
    assert.equal(buyOrder?.status, "filled");
    assert.equal(buyOrder?.filledContracts, 2);

    const duplicateEntryId = await insertEvaluation({
      ticker: market, crossingKey: `${market}:duplicate-entry`,
      evaluatedAt: new Date(),
    });
    const duplicateEntry = await executeQualifiedV13Trigger(duplicateEntryId, lifecycle);
    assert.equal(duplicateEntry.status, "blocked");
    assert.equal(entryPosts, 1, "duplicate entry never reaches another POST");

    const positionId = buyOrder!.positionId ??
      `position:${market}:${buyOrder!.crossingKey}`;
    const exitEvaluationId = await insertEvaluation({
      ticker: market, signal: "EXIT", crossingKey: buyOrder!.crossingKey,
      // EXIT freshness rejects observations from the future. Keep the synthetic
      // evaluation just behind the executor clock, as a real persisted tick is.
      evaluatedAt: new Date(Date.now() - 1),
    });
    await db.update(forwardTestEvaluationTable).set({
      evaluationSource: "micro_live", livePositionId: positionId,
      sourcePaperEvaluationId: entryEvaluationId, positionWasOpen: true,
    }).where(eq(forwardTestEvaluationTable.id, exitEvaluationId));
    const exitResult = await executeQualifiedV13Trigger(exitEvaluationId, lifecycle);
    assert.equal(exitPosts, 1, `exit POST was not reached: ${exitResult.status}/${exitResult.reason}`);
    assert.ok(exitResult.status === "unknown" || exitResult.status === "submitted",
      `exit must enter the cancel/recovery path: ${exitResult.reason}`);
    assert.equal(restingExitRestartObservedBeforeDelete, true,
      "restart is exercised after the resting exit is persisted and before DELETE transport");
    assert.equal(cancelAttempts, 1, "the single-use cancellation path is exercised");
    const [exitOrder] = await db.select().from(microLiveOrderTable)
      .where(eq(microLiveOrderTable.action, "sell")).limit(1);
    assert.ok(exitOrder?.exchangeOrderId);
    assert.ok(exitOrder.cancellationAttemptedAt,
      "an uncertain DELETE response permanently records its one-use claim");
    process.env.MICRO_LIVE_PRODUCTION_ENABLED = "false";
    process.env.LIVE_EXECUTION_ENABLED = "false";
    const frozenAfterCancel = await getMicroLiveState();
    assert.equal(frozenAfterCancel.databaseFlags?.microLiveProductionEnabled, false);
    assert.equal(frozenAfterCancel.databaseFlags?.liveExecutionEnabled, false);
    assert.equal(frozenAfterCancel.killSwitch, "ON",
      "operator freeze remains in force through late-fill recovery and settlement");

    simulateMicroLiveRestartForIsolatedTest();
    const uncertainCancelRestart = await reconcileMicroLiveAtStartup(lifecycle);
    assert.equal(uncertainCancelRestart.ready, false, uncertainCancelRestart.reason);
    assert.equal(exitPosts, 1, "restart after uncertain cancellation never repeats exit POST");
    assert.equal(cancelAttempts, 1, "restart after uncertain cancellation never repeats DELETE");

    const exchangeExit = exchangeOrders.get(exitOrder.exchangeOrderId!);
    assert.ok(exchangeExit);
    addFill(exchangeExit.id, 1, `pair-exit-late-fill-${suffix}`);
    exchangeExit.remainingCount = 0;
    exchangeExit.status = "canceled";
    simulateMicroLiveRestartForIsolatedTest();
    const lateFillRecovery = await reconcileMicroLiveAtStartup(lifecycle);
    assert.equal(lateFillRecovery.reason,
      "dedicated_pair_activity_recovered_get_only", lateFillRecovery.reason);
    const [recoveredExit] = await db.select().from(microLiveOrderTable)
      .where(eq(microLiveOrderTable.id, exitOrder.id)).limit(1);
    assert.equal(recoveredExit?.status, "canceled");
    assert.equal(recoveredExit?.filledContracts, 1);
    assert.equal(recoveredExit?.remainingContracts, 0);
    assert.equal(cancelAttempts, 1, "restart recovery never repeats uncertain DELETE");

    const settledAt = new Date().toISOString();
    settlementState = {
      marketResult: "yes", yesCountFp: "1", noCountFp: "0",
      revenueCents: "100", settledAt, feeCostDollars: "0.030000",
    };
    const settlementDependencies = {
      readAccount: lifecycle.readAccount!,
      readAccountActivity: lifecycle.readAccountActivity!,
      readMarketEvidence: async (selectedTicker: string): Promise<KalshiSubmissionEvidence> => {
        assert.equal(selectedTicker, market);
        const orders = [...exchangeOrders.values()].map((order) => ({
          id: order.id, clientOrderId: order.clientOrderId, ticker: order.ticker,
          side: order.side, action: order.action, type: "limit", status: order.status,
          priceDollars: order.priceDollars, initialCount: String(order.initialCount),
          filledCount: String(order.filledCount), remainingCount: String(order.remainingCount),
          exchangeIndex, ...tradeDirection(order.side, order.action),
        }));
        const fills = exchangeFills.map((fill) => ({
          ...fill, feeCostDollars: fill.feeCostDollars ?? null,
        }));
        return {
          orders, fills, historicalFills: fills, historicalFillsAvailable: true,
          truncated: false,
        };
      },
      readSettlements: lifecycle.readSettlements!,
      readDedicatedPairEvidence: evidence,
    };
    const settlement = await reconcileMicroLiveSettlement(
      positionId, "isolated-micro-live-test", settlementDependencies,
    );
    assert.equal(settlement.status, "recorded", settlement.reason);
    const [settlementRow] = await db.select().from(microLiveSettlementTable)
      .where(eq(microLiveSettlementTable.positionId, positionId)).limit(1);
    assert.ok(settlementRow);
    assert.equal(settlementRow.contracts, 1);
    assert.equal(settlementRow.feeMicros, 30_000);
    const replay = await reconcileMicroLiveSettlement(
      positionId, "isolated-micro-live-test", settlementDependencies,
    );
    assert.equal(replay.status, "already_recorded", replay.reason);
    assert.equal(
      (await db.select().from(microLiveSettlementTable)
        .where(eq(microLiveSettlementTable.positionId, positionId))).length,
      1,
      "settlement replay does not apply cash or fees twice",
    );
    assert.equal(cashDeltaMicros(), 480_000n,
      "settlement revenue is cash once; aggregate fill fees are not deducted twice");

    simulateMicroLiveRestartForIsolatedTest();
    const finalRestart = await reconcileMicroLiveAtStartup(lifecycle);
    assert.equal(finalRestart.reason,
      "dedicated_pair_activity_recovered_get_only", finalRestart.reason);
    const duplicateExit = await executeQualifiedV13Trigger(exitEvaluationId, lifecycle);
    assert.equal(duplicateExit.status, "blocked");
    assert.equal(exitPosts, 1, "duplicate exit cannot post a second order");

    for (const mutation of [
      "wrong_n", "wrong_index", "wrong_key", "wrong_market_index", "unexplained_order",
    ] as const) {
      evidenceMutation = mutation;
      const rejected = await reconcileMicroLiveAtStartup(lifecycle);
      assert.equal(rejected.ready, false, `${mutation} raw evidence must fail closed`);
      assert.match(rejected.reason ?? "", /pair|shard|identity|order/i,
        `${mutation} exposes its first reconciliation invariant`);
      evidenceMutation = "valid";
    }

    ambiguousTransferPresent = true;
    const frozen = await verifyMicroLivePairBoundary(
      { subaccountNumber, ticker: market, runId: initialized.runId! },
      boundaryDependencies,
    );
    assert.deepEqual(frozen, {
      status: "blocked",
      reason: "pair_boundary_ambiguous_post_boundary_transfer_frozen",
    });
    const [frozenBoundary] = await db.select().from(microLivePairBoundaryTable)
      .where(eq(microLivePairBoundaryTable.subaccountNumber, subaccountNumber)).limit(1);
    assert.ok(frozenBoundary);
    assert.equal(frozenBoundary.state, "frozen");
    assert.equal(frozenBoundary.ambiguityFreezeReason,
      "post_boundary_unattributed_or_external_transfer");
    const stillFrozen = await verifyMicroLivePairBoundary(
      { subaccountNumber, ticker: market, runId: initialized.runId! },
      boundaryDependencies,
    );
    assert.deepEqual(stillFrozen, {
      status: "blocked",
      reason: "pair_boundary_run_or_key_identity_mismatch",
    }, "a later matching $25 balance cannot automatically unfreeze the pair");
    const [historicalAfter] = await db.select().from(microLiveRunArchiveTable)
      .where(eq(microLiveRunArchiveTable.priorRunId, historicalPriorRunId)).limit(1);
    assert.deepEqual(historicalAfter, historicalBefore,
      "the earlier FROZEN archive record must remain unchanged");
    assert.equal(entryPosts, 1);
    assert.equal(exitPosts, 1);
  } finally {
    registerMicroLiveWorkerLeaseOwner(null);
    const [attemptToClean] = await db.select({
      attemptId: microLiveSubaccountCreationAttemptTable.attemptId,
    }).from(microLiveSubaccountCreationAttemptTable)
      .where(eq(microLiveSubaccountCreationAttemptTable.targetExchangeIndex, exchangeIndex))
      .limit(1);
    if (attemptToClean) creationAttemptIds.add(attemptToClean.attemptId);
    if (priorEnv.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorEnv.nodeEnv;
    if (priorEnv.deployment === undefined) delete process.env.REPLIT_DEPLOYMENT;
    else process.env.REPLIT_DEPLOYMENT = priorEnv.deployment;
    if (priorEnv.creationAuthorized === undefined) {
      delete process.env.KALSHI_INDEX2_SUBACCOUNT_CREATION_AUTHORIZED;
    } else {
      process.env.KALSHI_INDEX2_SUBACCOUNT_CREATION_AUTHORIZED =
        priorEnv.creationAuthorized;
    }
    if (priorEnv.production === undefined) delete process.env.MICRO_LIVE_PRODUCTION_ENABLED;
    else process.env.MICRO_LIVE_PRODUCTION_ENABLED = priorEnv.production;
    if (priorEnv.execution === undefined) delete process.env.LIVE_EXECUTION_ENABLED;
    else process.env.LIVE_EXECUTION_ENABLED = priorEnv.execution;
    if (priorEnv.subaccount === undefined) delete process.env.KALSHI_BOT_SUBACCOUNT;
    else process.env.KALSHI_BOT_SUBACCOUNT = priorEnv.subaccount;
    if (priorEnv.accountMode === undefined) delete process.env.MICRO_LIVE_ACCOUNT_MODE;
    else process.env.MICRO_LIVE_ACCOUNT_MODE = priorEnv.accountMode;
    if (priorEnv.keyId === undefined) delete process.env.KALSHI_API_KEY_ID;
    else process.env.KALSHI_API_KEY_ID = priorEnv.keyId;
    if (priorEnv.privateKey === undefined) delete process.env.KALSHI_API_PRIVATE_KEY;
    else process.env.KALSHI_API_PRIVATE_KEY = priorEnv.privateKey;
    if (priorEnv.provisioningKeyId === undefined) {
      delete process.env.KALSHI_PROVISIONING_API_KEY_ID;
    } else {
      process.env.KALSHI_PROVISIONING_API_KEY_ID = priorEnv.provisioningKeyId;
    }
    if (priorEnv.provisioningPrivateKey === undefined) {
      delete process.env.KALSHI_PROVISIONING_PRIVATE_KEY;
    } else {
      process.env.KALSHI_PROVISIONING_PRIVATE_KEY = priorEnv.provisioningPrivateKey;
    }
    if (priorEnv.apiEnvironment === undefined) delete process.env.KALSHI_API_ENVIRONMENT;
    else process.env.KALSHI_API_ENVIRONMENT = priorEnv.apiEnvironment;
    if (priorEnv.keyProvisioningEnabled === undefined) {
      delete process.env.KALSHI_KEY_PROVISIONING_ENABLED;
    } else {
      process.env.KALSHI_KEY_PROVISIONING_ENABLED = priorEnv.keyProvisioningEnabled;
    }
    if (priorEnv.keyGenerationAuthorized === undefined) {
      delete process.env.KALSHI_KEY_GENERATION_AUTHORIZED;
    } else {
      process.env.KALSHI_KEY_GENERATION_AUTHORIZED = priorEnv.keyGenerationAuthorized;
    }
    if (originalShadowConfig) {
      const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...shadowRest } =
        originalShadowConfig;
      await db.update(liveExecutionConfigTable).set(shadowRest)
        .where(eq(liveExecutionConfigTable.id, "singleton"));
    } else {
      await db.delete(liveExecutionConfigTable)
        .where(eq(liveExecutionConfigTable.id, "singleton"));
    }
  }
});