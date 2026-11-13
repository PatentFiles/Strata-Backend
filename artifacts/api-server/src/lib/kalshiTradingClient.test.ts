import assert from "node:assert/strict";
import {
  constants as cryptoConstants,
  createHash,
  createVerify,
  generateKeyPairSync,
} from "node:crypto";
import test from "node:test";
import {
  forwardTestEngineTable,
  microLiveConfigTable,
  microLiveFillTable,
  microLiveFeeVerificationTable,
  microLiveOrderTable,
  microLivePairBoundaryTable,
  microLiveRunArchiveTable,
  microLiveSettlementTable,
} from "@workspace/db/schema";
import {
  authorizeKalshiSubmission,
  authorizeKalshiCancellation,
  createKalshiTradingClient as createProductionKalshiTradingClient,
  KalshiTradingApiError,
  resetKalshiCancellationAuthorizationStateForTest,
  setKalshiCashPreflightForTest,
  setKalshiReadinessForTest,
  type KalshiLimitOrderRequest,
  type KalshiCancellationCapability,
  type KalshiShardTwoPairEvidence,
  type KalshiShardTwoPairVerificationRequest,
  type KalshiTradingClientOptions,
  type KalshiReduceOnlyExitRequest,
  type KalshiMutationGuardContext,
} from "./kalshiTradingClient";

const envKeys = [
  "KALSHI_API_KEY_ID",
  "KALSHI_API_PRIVATE_KEY",
  "KALSHI_API_ENVIRONMENT",
  "KALSHI_BOT_SUBACCOUNT",
  "KALSHI_VERIFIER_API_KEY_ID",
  "KALSHI_VERIFIER_API_PRIVATE_KEY",
  "MICRO_LIVE_ACCOUNT_MODE",
  "MICRO_LIVE_PRODUCTION_ENABLED",
  "LIVE_EXECUTION_ENABLED",
  "NODE_ENV",
] as const;
const originalEnvironment = Object.fromEntries(
  envKeys.map((key) => [key, process.env[key]]),
) as Record<(typeof envKeys)[number], string | undefined>;
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const testPrivateKey = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
type SeenRequest = { url: string; init: RequestInit };

const forgedPermissiveContext: KalshiMutationGuardContext = {
  databaseEnabled: true,
  killSwitch: "OFF",
  leaseHeld: true,
  reconciled: true,
};

function configure(enabled = true): void {
  process.env.NODE_ENV = "test";
  setKalshiReadinessForTest(() => true);
  setKalshiCashPreflightForTest(() => true);
  process.env.KALSHI_API_KEY_ID = "mock-key-id";
  process.env.KALSHI_API_PRIVATE_KEY = testPrivateKey;
  process.env.KALSHI_API_ENVIRONMENT = "demo";
  process.env.KALSHI_BOT_SUBACCOUNT = "7";
  process.env.MICRO_LIVE_ACCOUNT_MODE = "exclusive";
  if (enabled) {
    process.env.MICRO_LIVE_PRODUCTION_ENABLED = "true";
    process.env.LIVE_EXECUTION_ENABLED = "true";
  } else {
    process.env.MICRO_LIVE_PRODUCTION_ENABLED = "false";
    process.env.LIVE_EXECUTION_ENABLED = "false";
  }
}

function restoreEnvironment(): void {
  const currentMode = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  setKalshiReadinessForTest(null);
  setKalshiCashPreflightForTest(null);
  if (currentMode === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = currentMode;
  for (const key of envKeys) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response;
}

function testShardTwoEvidence(
  input: KalshiShardTwoPairVerificationRequest,
): KalshiShardTwoPairEvidence {
  const accountIdentity = {
    runId: input.runId,
    subaccountNumber: input.subaccountNumber,
    exchangeIndex: input.exchangeIndex,
  };
  const authorizationMode = input.authorizationMode ?? "final_post";
  return {
    checkedAt: input.now,
    apiKeyId: input.apiKeyId,
    restrictedKeySubaccount: input.subaccountNumber,
    persistedIdentity: { ...accountIdentity, apiKeyId: input.apiKeyId },
    fundingAnchor: {
      ...accountIdentity,
      transferId: "funding-transfer-test",
      transferredAt: input.now - 60_000,
      amountMicros: "25000000",
      initialBalanceMicros: "25000000",
      evidenceDigest: "c".repeat(64),
    },
    accountEvidence: {
      ...accountIdentity,
      capturedAt: input.now,
      complete: true,
      evidenceDigest: "d".repeat(64),
    },
    marketEvidence: {
      ticker: input.marketTicker,
      exchangeIndex: input.exchangeIndex,
      capturedAt: input.now,
    },
    collateralProof: {
      status: "verified",
      proofKind: "collateral_reconciliation_only",
      authorization: "none",
      mode: authorizationMode === "recovery_get"
        ? { kind: "recovery_get" }
        : {
          kind: "final_post",
          action: input.action === "buy" ? "entry" : "exit",
          phase: "ENTRY_OPEN",
        },
      runId: input.runId,
      checkedAt: input.now,
      evidenceDigest: input.requiredEvidenceDigest ?? "e".repeat(64),
      boundaryEvidenceDigest: "f".repeat(64),
      configStateDigest: "a".repeat(64),
      availableCashMicros: "25000000",
      inventoryBalanceMicros: "25000000",
      activityCashDeltaMicros: "0",
      expectedAvailableCashMicros: "25000000",
      restingEntryReserveMicros: "0",
      filledBuyExposureMicros: "0",
      reconciledFeeMicros: "0",
    },
  } as unknown as KalshiShardTwoPairEvidence;
}

type TestKalshiTradingClientOptions = KalshiTradingClientOptions & {
  omitDedicatedPairVerifier?: boolean;
};

function createKalshiTradingClient(options: TestKalshiTradingClientOptions) {
  const { omitDedicatedPairVerifier, ...clientOptions } = options;
  return createProductionKalshiTradingClient({
    ...clientOptions,
    ...(!omitDedicatedPairVerifier && !clientOptions.verifyDedicatedShardTwoPair
      ? { verifyDedicatedShardTwoPair: async (input) => testShardTwoEvidence(input) }
      : {}),
  });
}

function verifyRequest(request: SeenRequest, method: string, signedPath: string): void {
  assert.equal(request.init.method, method);
  const headers = request.init.headers as Record<string, string>;
  assert.equal(headers["KALSHI-ACCESS-KEY"], "mock-key-id");
  const verifier = createVerify("sha256");
  verifier.update(`${headers["KALSHI-ACCESS-TIMESTAMP"]}${method}${signedPath}`);
  verifier.end();
  assert.equal(verifier.verify({
    key: publicKey,
    padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  }, Buffer.from(headers["KALSHI-ACCESS-SIGNATURE"], "base64")), true);
}

function feeFingerprint(approvalId: string, digest: string): string {
  return [
    "series", "event", approvalId, digest, "micro-live-standing-fee-policy-v1",
    "1000000", "1000000", "test-admin", "evidence", "approved-standard-0.07-sixdp-nondirect-cash-risk-v2",
  ].join("|");
}

function cancellationStateDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function authorizedSubmissionFixture(
  now: number,
  request: KalshiLimitOrderRequest = {
    ticker: "KXTEST",
    clientOrderId: "entry-client",
    side: "yes",
    action: "buy",
    count: 1,
    priceDollars: "0.42",
  },
) {
  const approvalId = "approval-test";
  const digest = "a".repeat(64);
  const feeEvidenceFingerprint = feeFingerprint(approvalId, digest);
  const verifiedAt = new Date(now - 500);
  const runId = "run-test";
  const input = request;
  const stakeCents = Math.ceil(input.count * Number(input.priceDollars) * 100);
  const config = {
    id: "singleton",
    manualKillSwitch: false,
    microLiveProductionEnabled: true,
    liveExecutionEnabled: true,
    microLiveAccountingUnresolved: false,
    microLiveAccountMode: "exclusive",
    microLiveSelectedSubaccount: 7,
    microLiveRunId: runId,
    microLiveRunCapMicros: 1_000_000,
    microLiveRunPhase: "ENTRY_OPEN",
    microLiveRunArmedAt: new Date(now - 60_000),
    microLivePrimaryCashBaselineMicros: "1000000",
    microLivePrimaryCashBaselineRunId: runId,
    microLivePrimaryCashBaselineAt: new Date(now - 120_000),
    microLivePrimaryCashBaselineEvidenceDigest: "b".repeat(64),
    // Condition-based valid runs intentionally have no deadline.
    microLiveRunDeadline: null,
    microLiveEntryAttempted: true,
    microLiveExitAttempted: false,
    microLiveRunApprovalId: approvalId,
    microLiveRunApprovalDigest: digest,
    microLiveReservedMicros: stakeCents * 10_000 + 20_000,
    microLiveFeeApprovalApproved: true,
    microLiveFeeApprovalInvalidated: false,
    microLiveFeeApprovalId: approvalId,
    microLiveFeeApprovalDigest: digest,
    microLiveFeeApprovalApprovedAt: verifiedAt,
    microLiveFeePolicyVersion: "micro-live-standing-fee-policy-v1",
    microLiveFeeApprovalSourceUrl: "https://kalshi.com/docs/kalshi-fee-schedule.pdf",
    microLiveFeeFormulaVersion: "standard-quadratic-0.07-v1",
    microLiveFeeMaximumExposureMicros: 1_000_000,
    microLiveFeeApprovedRunCapMicros: 1_000_000,
    microLiveFeeApprovedBy: "test-admin",
    microLiveFeeArtifactStatus: "verified",
    maxSingleOrderRiskCents: 500,
    maxLiveBankrollCents: 2500,
    maxCumulativeReservedCents: 2500,
  };
  const order = {
    id: "order-row",
    action: input.action,
    triggerType: input.action === "buy" ? "SCOUT" : "EXIT",
    intent: input.action === "buy" ? "entry" : "exit",
    positionId: null,
    marketTicker: input.ticker,
    crossingKey: "crossing",
    clientOrderId: input.clientOrderId,
    side: input.side === "yes" ? "UP" : "DOWN",
    status: "pending",
    requestedContracts: input.count,
    requestedLimitPrice: Number(input.priceDollars),
    requestedStakeCents: stakeCents,
    reservedRiskCents: stakeCents,
    filledContracts: 0,
    remainingContracts: input.count,
    reservedEntryFeeMicros: 10_000,
    reservedExitFeeMicros: 10_000,
    microLiveRunId: runId,
    feeEvidenceFingerprint,
    feeEvidenceVerifiedAt: verifiedAt,
  };
  const engine = {
    id: "v1.3-paper",
    enabled: true,
    strategyVersion: "V1.3",
    leaseOwner: "worker-test",
    leaseExpiresAt: new Date(now + 20_000),
  };
  const feeVerification = {
    approvalId,
    approvalDigest: digest,
    policyVersion: "micro-live-standing-fee-policy-v1",
    sourceUrl: "https://kalshi.com/docs/kalshi-fee-schedule.pdf",
    formulaVersion: "standard-quadratic-0.07-v1",
    status: "verified",
    feeEvidenceFingerprint,
    checkedAt: verifiedAt,
  };
  const tableRows = new Map<unknown, unknown[]>([
    [microLiveConfigTable, [config]],
    [microLiveOrderTable, [order]],
    [microLiveFillTable, []],
    [forwardTestEngineTable, [engine]],
    [microLiveFeeVerificationTable, [feeVerification]],
    [microLiveRunArchiveTable, []],
    [microLiveSettlementTable, []],
  ]);
  const orderLookupRows: unknown[][] = [[order]];
  let beforeLimitedQuery: (() => Promise<void>) | null = null;
  const tx = {
    select: () => {
      let table: unknown;
      let filtered = false;
      const builder = {
        from(value: unknown) {
          table = value;
          return builder;
        },
        where() {
          filtered = true;
          return builder;
        },
        for() {
          return builder;
        },
        limit() {
          let rows: unknown[];
          if (table === microLiveOrderTable && filtered) {
            rows = orderLookupRows.shift() ?? tableRows.get(table) ?? [];
          } else {
            rows = tableRows.get(table) ?? [];
          }
          return beforeLimitedQuery
            ? beforeLimitedQuery().then(() => rows)
            : Promise.resolve(rows);
        },
        then(resolve: (value: unknown[]) => unknown, reject?: (error: unknown) => unknown) {
          return Promise.resolve(tableRows.get(table) ?? []).then(resolve, reject);
        },
      };
      return builder;
    },
    execute: async () => undefined,
    update: (table: unknown) => {
      let values: Record<string, unknown> = {};
      const builder = {
        set(patch: Record<string, unknown>) {
          values = patch;
          return builder;
        },
        where() {
          return builder;
        },
        returning() {
          const rows = tableRows.get(table) ?? [];
          const row = rows[0] as Record<string, unknown> | undefined;
          if (!row) return Promise.resolve([]);
          if (table === microLiveOrderTable &&
              values.cancellationAuthorizedAt !== undefined &&
              row.cancellationAuthorizedAt != null) return Promise.resolve([]);
          Object.assign(row, values);
          return Promise.resolve([{ id: row.id }]);
        },
      };
      return builder;
    },
  };
  return {
    input,
    tx,
    config,
    order,
    tableRows,
    orderLookupRows,
    delayLimitedQueries: (delay: (() => Promise<void>) | null) => {
      beforeLimitedQuery = delay;
    },
    witness: {
      orderId: order.id,
      reconciled: true,
      reconciledAt: now - 500,
      leaseOwner: engine.leaseOwner,
      leaseObservedAt: now - 500,
      leaseExpiresAt: engine.leaseExpiresAt.getTime(),
      isStillReconciled: () => true,
    },
  };
}

async function authorizeFixture(
  input: KalshiLimitOrderRequest,
  now: number,
) {
  const fixture = authorizedSubmissionFixture(now, input);
  const capability = await authorizeKalshiSubmission(
    fixture.tx as never, input, fixture.witness, now,
  );
  fixture.orderLookupRows.splice(0, fixture.orderLookupRows.length, [fixture.order]);
  return { fixture, capability };
}

function primarySubmissionFixture(now: number) {
  const fixture = authorizedSubmissionFixture(now);
  fixture.config.microLiveAccountMode = "primary_nonexclusive";
  fixture.config.microLiveSelectedSubaccount = 0;
  setKalshiCashPreflightForTest((identity) =>
    identity.orderId === fixture.order.id &&
    identity.runId === fixture.order.microLiveRunId &&
    identity.marketTicker === fixture.order.marketTicker &&
    identity.baselineDigest === fixture.config.microLivePrimaryCashBaselineEvidenceDigest &&
    identity.baselineMicros === fixture.config.microLivePrimaryCashBaselineMicros &&
    identity.baselineAt === fixture.config.microLivePrimaryCashBaselineAt.getTime());
  process.env.MICRO_LIVE_ACCOUNT_MODE = "primary_nonexclusive";
  process.env.KALSHI_BOT_SUBACCOUNT = "0";
  return fixture;
}

async function authorizeExitFixture(
  input: KalshiReduceOnlyExitRequest,
  now: number,
) {
  const buyInput: KalshiLimitOrderRequest = {
    ticker: input.ticker,
    clientOrderId: "original-entry-client",
    side: input.side,
    action: "buy",
    count: input.count,
    priceDollars: "0.42",
  };
  const fixture = authorizedSubmissionFixture(now, buyInput);
  fixture.config.microLiveRunPhase = "EXIT_ONLY";
  fixture.config.microLiveExitAttempted = true;
  const sourceBuy = {
    ...fixture.order,
    id: "source-buy",
    status: "filled",
    clientOrderId: buyInput.clientOrderId,
    positionId: null,
    filledContracts: buyInput.count,
    remainingContracts: 0,
  };
  const exitOrder = {
    ...fixture.order,
    id: "exit-row",
    action: "sell",
    clientOrderId: input.clientOrderId,
    requestedStakeCents: 0,
    requestedLimitPrice: Number(input.priceDollars),
    side: input.side === "yes" ? "UP" : "DOWN",
    triggerType: "EXIT",
    intent: "exit",
    exitPositionId: `position:${input.ticker}:crossing`,
  };
  fixture.tableRows.set(microLiveOrderTable, [sourceBuy, exitOrder]);
  fixture.tableRows.set(microLiveFillTable, [{
    id: "source-fill",
    orderId: sourceBuy.id,
    exchangeFillId: "exchange-source-fill",
    exchangeOrderId: "exchange-buy",
    filledAt: new Date(now),
    contracts: buyInput.count,
    fillPrice: 0.42,
    action: "buy",
    positionId: null,
    costCents: Math.ceil(buyInput.count * 0.42 * 100),
    feeCents: 0,
    feeKnown: true,
    tradeMicros: Math.round(buyInput.count * 0.42 * 1_000_000),
    feeMicros: 0,
    proceedsCents: null,
    costBasisCents: null,
    createdAt: new Date(now),
  }]);
  fixture.orderLookupRows.splice(0, fixture.orderLookupRows.length,
    [exitOrder], [sourceBuy]);
  const capability = await authorizeKalshiSubmission(
    fixture.tx as never,
    input,
    { ...fixture.witness, orderId: exitOrder.id },
    now,
  );
  fixture.orderLookupRows.splice(0, fixture.orderLookupRows.length,
    [exitOrder], [sourceBuy]);
  return { fixture, capability, sourceBuy, exitOrder };
}

let cancellationFixtureSequence = 0;

function frozenCancellationFixture(now: number) {
  const sequence = ++cancellationFixtureSequence;
  const request: KalshiLimitOrderRequest = {
    ticker: "KXTEST",
    clientOrderId: `exit-client-${sequence}`,
    side: "yes",
    action: "sell",
    count: 1,
    priceDollars: "0.42",
  };
  const fixture = authorizedSubmissionFixture(now, request);
  Object.assign(fixture.config, {
    microLiveSelectedExchangeIndex: 2,
    microLiveExitAttempted: true,
    microLiveRunFreezeReason: "emergency_stop",
    manualKillSwitch: true,
    microLiveProductionEnabled: false,
    liveExecutionEnabled: false,
    microLiveRunPhase: "FROZEN",
  });
  const order = {
    ...fixture.order,
    action: "sell",
    triggerType: "EXIT",
    intent: "exit",
    status: "partial",
    remainingContracts: 1,
    exchangeOrderId: `exchange-exit-${sequence}`,
    id: `exit-row-${sequence}`,
    exitPositionId: "position:KXTEST:crossing",
    cancellationAttemptedAt: new Date(now - 500),
    cancellationAuthorizedAt: null,
  };
  const boundary = {
    subaccountNumber: 7,
    exchangeIndex: 2,
    restrictedApiKeyId: "mock-key-id",
    restrictedKeyFingerprint: "b".repeat(64),
    cleanBalanceMicros: "0",
    cleanBalanceSemantics: "available_cash",
    cleanSnapshotAuthenticated: true,
    cleanOrderCount: 0,
    cleanFillCount: 0,
    cleanPositionCount: 0,
    cleanSettlementCount: 0,
    cleanBoundaryAt: new Date(now - 120_000),
    cleanBoundaryEvidenceDigest: "c".repeat(64),
    state: "initialized",
    fundingTransferId: "funding-transfer-test",
    fundingAmountCents: 2500,
    fundingTransferredAt: new Date(now - 60_000),
    postFundingBalanceMicros: "25000000",
    postFundingBalanceSemantics: "available_cash",
    postFundingSnapshotAuthenticated: true,
    postFundingSnapshotAt: new Date(now - 60_000),
    postFundingEvidenceDigest: "d".repeat(64),
    initializedRunId: order.microLiveRunId,
    initializedAt: new Date(now - 60_000),
    activityCheckpointCursor: "cursor-test",
    activityCheckpointAt: new Date(now - 30_000),
    activityCheckpointDigest: "e".repeat(64),
    ambiguityFrozenAt: null,
    ambiguityFreezeReason: null,
    ambiguityEvidenceDigest: null,
    createdAt: new Date(now - 120_000),
    updatedAt: new Date(now - 30_000),
  };
  fixture.tableRows.set(microLiveOrderTable, [order]);
  fixture.tableRows.set(microLivePairBoundaryTable, [boundary]);
  fixture.orderLookupRows.splice(0, fixture.orderLookupRows.length, [order]);
  const identity = {
    exchangeOrderId: order.exchangeOrderId,
    localOrderId: order.id,
    clientOrderId: order.clientOrderId,
    runId: order.microLiveRunId!,
  };
  const [engine] = fixture.tableRows.get(forwardTestEngineTable) as Array<{
    leaseOwner: string;
    leaseExpiresAt: Date;
  }>;
  const witness = {
    runId: identity.runId,
    reconciled: true,
    reconciledAt: now - 500,
    leaseOwner: engine!.leaseOwner,
    leaseObservedAt: now - 500,
    leaseExpiresAt: engine!.leaseExpiresAt.getTime(),
    cancellationClaimedAt: order.cancellationAttemptedAt.getTime(),
    pairRecoveryProof: {
      checkedAt: now - 500,
      evidenceDigest: "e".repeat(64),
        configStateDigest: cancellationStateDigest(fixture.config),
        boundaryStateDigest: cancellationStateDigest(boundary),
        ledgerStateDigest: cancellationStateDigest({
          orders: [order], fills: [], settlements: [],
        }),
    },
    isStillReconciled: () => true,
  };
  return { fixture, identity, witness, order };
}

async function authorizeCancellationFixture(
  now: number,
  options: {
    identity?: Partial<ReturnType<typeof frozenCancellationFixture>["identity"]>;
    witness?: Partial<ReturnType<typeof frozenCancellationFixture>["witness"]>;
  } = {},
): Promise<{
  fixture: ReturnType<typeof frozenCancellationFixture>["fixture"];
  identity: ReturnType<typeof frozenCancellationFixture>["identity"];
  witness: ReturnType<typeof frozenCancellationFixture>["witness"];
  order: ReturnType<typeof frozenCancellationFixture>["order"];
  capability: KalshiCancellationCapability | null;
}> {
  const prepared = frozenCancellationFixture(now);
  const identity = { ...prepared.identity, ...options.identity };
  const witness = { ...prepared.witness, ...options.witness };
  const capability = await authorizeKalshiCancellation(
    prepared.fixture.tx as never, identity, witness, now,
  );
  prepared.fixture.orderLookupRows.splice(
    0, prepared.fixture.orderLookupRows.length, [prepared.order],
  );
  return { ...prepared, identity, witness, capability };
}

test("forged permissive contexts cannot authorize entry or reduce-only POSTs", async () => {
  configure();
  let metadataCalls = 0;
  let exchangeCalls = 0;
  const client = createKalshiTradingClient({
    verifySubaccount: async () => {
      metadataCalls++;
      return true;
    },
    fetchImpl: (async () => {
      exchangeCalls++;
      return jsonResponse({});
    }) as typeof fetch,
  });
  try {
    await assert.rejects(client.createLimitOrder({
      ticker: "KXTEST",
      clientOrderId: "entry-client",
      side: "yes",
      action: "buy",
      count: 1,
      priceDollars: "0.42",
    }, forgedPermissiveContext), (error: Error) =>
      error instanceof KalshiTradingApiError &&
      error.type === "MUTATION_GUARD_REJECTED");

    await assert.rejects(client.createReduceOnlyExit({
      ticker: "KXTEST",
      clientOrderId: "exit-client",
      side: "yes",
      action: "sell",
      count: 1,
      priceDollars: "0.42",
    }, { ...forgedPermissiveContext }), (error: Error) =>
      error instanceof KalshiTradingApiError &&
      error.type === "MUTATION_GUARD_REJECTED");

    assert.equal(metadataCalls, 0, "a rejected POST does not request account verification");
    assert.equal(exchangeCalls, 0, "a rejected POST never reaches transport");
  } finally {
    restoreEnvironment();
  }
});

test("authorized mocked entry POST is immutable-scoped and consumes its capability once", async () => {
  const now = Date.now();
  configure();
  const fixture = authorizedSubmissionFixture(now);
  const capability = await authorizeKalshiSubmission(
    fixture.tx as never, fixture.input, fixture.witness, now,
  );
  assert.ok(capability, "valid transaction-backed evidence authorizes one exact order");
  fixture.orderLookupRows.splice(0, fixture.orderLookupRows.length, [fixture.order]);
  let posts = 0;
  const client = createKalshiTradingClient({
    verifySubaccount: async () => true,
    fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
      posts++;
      assert.equal(init?.method, "POST");
      return jsonResponse({
        order_id: "exchange-order-1",
        client_order_id: fixture.input.clientOrderId,
        fill_count: "0.00",
        remaining_count: "0.00",
        ts_ms: now,
      });
    }) as typeof fetch,
  });
  try {
    await assert.rejects(client.createLimitOrder({
      ...fixture.input,
      priceDollars: "0.43",
    }, forgedPermissiveContext, capability!), (error: Error) =>
      error instanceof KalshiTradingApiError &&
      error.type === "MUTATION_GUARD_REJECTED");
    assert.equal(posts, 0, "capability cannot be retargeted to different order terms");
    const validCapability = await authorizeKalshiSubmission(
      fixture.tx as never, fixture.input, fixture.witness, now,
    );
    assert.ok(validCapability,
      "a rejected retarget attempt consumes its capability, so valid terms need a fresh one");
    fixture.orderLookupRows.splice(0, fixture.orderLookupRows.length, [fixture.order]);
    const order = await client.createLimitOrder(
      fixture.input, forgedPermissiveContext, validCapability!,
    );
    assert.equal(order.orderId, "exchange-order-1");
    assert.equal(posts, 1);
    await assert.rejects(
      client.createLimitOrder(fixture.input, forgedPermissiveContext, validCapability!),
      (error: Error) => error instanceof KalshiTradingApiError &&
        error.type === "MUTATION_GUARD_REJECTED",
    );
    assert.equal(posts, 1, "capability replay cannot cause a second POST");
  } finally {
    restoreEnvironment();
  }
});

test("concurrent calls atomically claim one capability before delayed validation", async () => {
  const now = Date.now();
  configure();
  const fixture = authorizedSubmissionFixture(now);
  const capability = await authorizeKalshiSubmission(
    fixture.tx as never, fixture.input, fixture.witness, now,
  );
  assert.ok(capability);
  fixture.orderLookupRows.splice(0, fixture.orderLookupRows.length, [fixture.order]);
  let releaseValidation!: () => void;
  let markValidationStarted!: () => void;
  const validationGate = new Promise<void>((resolve) => { releaseValidation = resolve; });
  const validationStarted = new Promise<void>((resolve) => { markValidationStarted = resolve; });
  fixture.delayLimitedQueries(() => {
    markValidationStarted();
    return validationGate;
  });
  let posts = 0;
  const client = createKalshiTradingClient({
    verifySubaccount: async () => true,
    fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
      posts++;
      const body = JSON.parse(String(init?.body)) as { client_order_id: string };
      return jsonResponse({
        order_id: "race-order",
        client_order_id: body.client_order_id,
        fill_count: "0.00",
        remaining_count: "0.00",
        ts_ms: now,
      }, 201);
    }) as typeof fetch,
  });
  try {
    const first = client.createLimitOrder(
      fixture.input, forgedPermissiveContext, capability!,
    );
    await validationStarted;
    const second = client.createLimitOrder(
      fixture.input, forgedPermissiveContext, capability!,
    );
    await assert.rejects(second, (error: Error) => error instanceof KalshiTradingApiError &&
      error.type === "MUTATION_GUARD_REJECTED");
    releaseValidation();
    const [firstResult] = await Promise.allSettled([first]);
    assert.equal(firstResult?.status, "fulfilled");
    assert.equal(posts, 1, "concurrent capability use can reach transport at most once");
  } finally {
    releaseValidation();
    restoreEnvironment();
  }
});

test("authorized mocked reduce-only exit POST validates linked buy and run exposure", async () => {
  const now = Date.now();
  configure();
  const fixture = authorizedSubmissionFixture(now);
  fixture.config.microLiveRunPhase = "EXIT_ONLY";
  fixture.config.microLiveExitAttempted = true;
  const sourceBuy = {
    ...fixture.order,
    id: "source-buy",
    status: "filled",
    clientOrderId: "original-entry-client",
    positionId: null,
    filledContracts: 1,
    remainingContracts: 0,
  };
  const exitInput = {
    ticker: fixture.input.ticker,
    clientOrderId: "exit-client",
    side: "yes" as const,
    action: "sell" as const,
    count: 1,
    priceDollars: "0.38",
  };
  const exitOrder = {
    ...fixture.order,
    id: "exit-row",
    action: "sell",
    clientOrderId: exitInput.clientOrderId,
    requestedStakeCents: 0,
    requestedLimitPrice: 0.38,
    filledContracts: 0,
    remainingContracts: 1,
    triggerType: "EXIT",
    intent: "exit",
    exitPositionId: `position:${fixture.input.ticker}:crossing`,
  };
  fixture.tableRows.set(microLiveOrderTable, [sourceBuy, exitOrder]);
  fixture.tableRows.set(microLiveFillTable, [{
    id: "source-fill",
    orderId: sourceBuy.id,
    exchangeFillId: "exchange-source-fill",
    exchangeOrderId: "exchange-buy",
    filledAt: new Date(now),
    contracts: 1,
    fillPrice: 0.42,
    action: "buy",
    positionId: null,
    costCents: 42,
    feeCents: 0,
    feeKnown: true,
    tradeMicros: 420_000,
    feeMicros: 0,
    proceedsCents: null,
    costBasisCents: null,
    createdAt: new Date(now),
  }]);
  fixture.orderLookupRows.splice(0, fixture.orderLookupRows.length,
    [exitOrder], [sourceBuy]);
  const capability = await authorizeKalshiSubmission(
    fixture.tx as never,
    exitInput,
    { ...fixture.witness, orderId: exitOrder.id },
    now,
  );
  assert.ok(capability, "valid exit reservation and linked buy authorize the exact exit");
  fixture.orderLookupRows.splice(0, fixture.orderLookupRows.length,
    [exitOrder], [sourceBuy]);
  let posts = 0;
  const client = createKalshiTradingClient({
    verifySubaccount: async () => true,
    fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
      posts++;
      const body = JSON.parse(String(init?.body)) as { client_order_id: string };
      return jsonResponse({
        order_id: "exchange-exit-1",
        client_order_id: body.client_order_id,
        fill_count: "0.00",
        remaining_count: "0.00",
        ts_ms: now,
      });
    }) as typeof fetch,
  });
  try {
    const placed = await client.createReduceOnlyExit(
      exitInput, forgedPermissiveContext, capability!,
    );
    assert.equal(placed.orderId, "exchange-exit-1");
    assert.equal(placed.action, "sell");
    assert.equal(posts, 1);
    await assert.rejects(
      client.createReduceOnlyExit(exitInput, forgedPermissiveContext, capability!),
      (error: Error) => error instanceof KalshiTradingApiError &&
        error.type === "MUTATION_GUARD_REJECTED",
    );
    assert.equal(posts, 1);
  } finally {
    restoreEnvironment();
  }
});

test("legacy V2 price mapping, response validation, IOC, and non-retry behavior remain covered", async () => {
  const now = Date.now();
  configure();
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const client = createKalshiTradingClient({
    verifySubaccount: async () => true,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      const body = JSON.parse(String(init?.body)) as { client_order_id: string };
      return jsonResponse({
        order_id: `order-${seen.length}`,
        client_order_id: body.client_order_id,
        fill_count: "0.00",
        remaining_count: "0.00",
        ts_ms: now,
      }, 201);
    }) as typeof fetch,
  });
  try {
    const yesInput: KalshiLimitOrderRequest = {
      ticker: "KXTEST", clientOrderId: "yes-client",
      side: "yes", action: "buy", count: 1, priceDollars: "0.42",
    };
    const noInput: KalshiLimitOrderRequest = {
      ticker: "KXTEST", clientOrderId: "no-client",
      side: "no", action: "buy", count: 1, priceDollars: "0.37",
    };
    const yes = await authorizeFixture(yesInput, now);
    const no = await authorizeFixture(noInput, now);
    assert.ok(yes.capability && no.capability);
    assert.equal((await client.createLimitOrder(
      yesInput, forgedPermissiveContext, yes.capability!,
    )).bookSide, "bid");
    assert.equal((await client.createLimitOrder(
      noInput, forgedPermissiveContext, no.capability!,
    )).bookSide, "ask");
    assert.deepEqual(JSON.parse(String(seen[0]?.init.body)), {
      ticker: "KXTEST", client_order_id: "yes-client", side: "bid",
      count: "1.00", price: "0.4200", time_in_force: "immediate_or_cancel",
      self_trade_prevention_type: "taker_at_cross", post_only: false,
      cancel_order_on_pause: true, subaccount: 7, exchange_index: 2,
    });
    assert.deepEqual(JSON.parse(String(seen[1]?.init.body)), {
      ticker: "KXTEST", client_order_id: "no-client", side: "ask",
      count: "1.00", price: "0.6300", time_in_force: "immediate_or_cancel",
      self_trade_prevention_type: "taker_at_cross", post_only: false,
      cancel_order_on_pause: true, subaccount: 7, exchange_index: 2,
    });
    for (const request of seen) {
      verifyRequest(request, "POST", "/trade-api/v2/portfolio/events/orders");
      assert.equal(new URL(request.url).pathname,
        "/trade-api/v2/portfolio/events/orders");
    }

    const malformedInput: KalshiLimitOrderRequest = {
      ticker: "KXTEST", clientOrderId: "bad-response",
      side: "yes", action: "buy", count: 1, priceDollars: "0.40",
    };
    const malformed = await authorizeFixture(malformedInput, now);
    const malformedClient = createKalshiTradingClient({
      verifySubaccount: async () => true,
      fetchImpl: (async () => jsonResponse({
        order_id: "",
        client_order_id: malformedInput.clientOrderId,
        fill_count: "0.00",
        remaining_count: "1.00",
        ts_ms: now,
      }, 201)) as typeof fetch,
    });
    await assert.rejects(malformedClient.createLimitOrder(
      malformedInput, forgedPermissiveContext, malformed.capability!,
    ), (error: Error) => error instanceof KalshiTradingApiError &&
      error.type === "INVALID_RESPONSE");

    for (const [index, response] of [
      { order_id: "bad-1", client_order_id: "different-client",
        fill_count: "0.00", remaining_count: "1.00", ts_ms: now },
      { order_id: "bad-2", client_order_id: "bad-entry-1",
        fill_count: "0.50", remaining_count: "1.00", ts_ms: now },
      { order_id: "bad-3", client_order_id: "bad-entry-2",
        fill_count: "0.00", remaining_count: "1.00", ts_ms: 0 },
      { order_id: "bad-4", client_order_id: "bad-entry-3" },
    ].entries()) {
      const input: KalshiLimitOrderRequest = {
        ticker: "KXTEST", clientOrderId: `bad-entry-${index}`,
        side: "yes", action: "buy", count: 1, priceDollars: "0.40",
      };
      const authorized = await authorizeFixture(input, now);
      let attempts = 0;
      const invalidClient = createKalshiTradingClient({
        verifySubaccount: async () => true,
        fetchImpl: (async () => {
          attempts++;
          return jsonResponse(response, 201);
        }) as typeof fetch,
      });
      await assert.rejects(invalidClient.createLimitOrder(
        input, forgedPermissiveContext, authorized.capability!,
      ), (error: Error) => error instanceof KalshiTradingApiError &&
        error.type === "INVALID_RESPONSE");
      assert.equal(attempts, 1, "malformed responses are never retried or downgraded");
    }

    const networkInput: KalshiLimitOrderRequest = {
      ticker: "KXTEST", clientOrderId: "network-failure",
      side: "yes", action: "buy", count: 1, priceDollars: "0.40",
    };
    const network = await authorizeFixture(networkInput, now);
    let transportCalls = 0;
    const networkClient = createKalshiTradingClient({
      verifySubaccount: async () => true,
      fetchImpl: (async () => {
        transportCalls++;
        throw new Error("connection lost after mock request");
      }) as typeof fetch,
    });
    await assert.rejects(networkClient.createLimitOrder(
      networkInput, forgedPermissiveContext, network.capability!,
    ), (error: Error) => error instanceof KalshiTradingApiError &&
      error.type === "NETWORK_ERROR");
    assert.equal(transportCalls, 1, "a failed submission is never retried");
  } finally {
    restoreEnvironment();
  }
});

test("legacy YES/NO reduce-only IOC mapping and canceled remainder semantics remain covered", async () => {
  const now = Date.now();
  configure();
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const client = createKalshiTradingClient({
    verifySubaccount: async () => true,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      const body = JSON.parse(String(init?.body)) as { client_order_id: string };
      return jsonResponse({
        order_id: `exit-${requests.length}`,
        client_order_id: body.client_order_id,
        fill_count: requests.length === 1 ? "1.00" : "0.00",
        remaining_count: "0.00",
        ts_ms: now,
      }, 201);
    }) as typeof fetch,
  });
  try {
    const yesInput: KalshiReduceOnlyExitRequest = {
      ticker: "KXTEST", clientOrderId: "yes-exit",
      side: "yes", action: "sell", count: 2, priceDollars: "0.39",
    };
    const noInput: KalshiReduceOnlyExitRequest = {
      ticker: "KXTEST", clientOrderId: "no-exit",
      side: "no", action: "sell", count: 2, priceDollars: "0.37",
    };
    const yes = await authorizeExitFixture(yesInput, now);
    const no = await authorizeExitFixture(noInput, now);
    assert.ok(yes.capability && no.capability);
    const yesExit = await client.createReduceOnlyExit(
      yesInput, forgedPermissiveContext, yes.capability!,
    );
    const noExit = await client.createReduceOnlyExit(
      noInput, forgedPermissiveContext, no.capability!,
    );
    assert.equal(yesExit.status, "canceled");
    assert.equal(yesExit.filledCount, "1.00");
    assert.equal(noExit.status, "canceled");
    assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
      ticker: "KXTEST", client_order_id: "yes-exit", side: "ask",
      count: "2.00", price: "0.3900", time_in_force: "immediate_or_cancel",
      self_trade_prevention_type: "taker_at_cross", post_only: false,
      cancel_order_on_pause: true, reduce_only: true, subaccount: 7,
      exchange_index: 2,
    });
    assert.deepEqual(JSON.parse(String(requests[1]?.init.body)), {
      ticker: "KXTEST", client_order_id: "no-exit", side: "bid",
      count: "2.00", price: "0.6300", time_in_force: "immediate_or_cancel",
      self_trade_prevention_type: "taker_at_cross", post_only: false,
      cancel_order_on_pause: true, reduce_only: true, subaccount: 7,
      exchange_index: 2,
    });
    for (const request of requests) {
      verifyRequest(request, "POST", "/trade-api/v2/portfolio/events/orders");
      assert.equal(new URL(request.url).pathname,
        "/trade-api/v2/portfolio/events/orders");
    }

    const oversizedInput: KalshiReduceOnlyExitRequest = {
      ticker: "KXTEST", clientOrderId: "oversized-exit",
      side: "yes", action: "sell", count: 2, priceDollars: "0.39",
    };
    const oversized = await authorizeExitFixture(oversizedInput, now);
    let oversizedCalls = 0;
    const malformedExitClient = createKalshiTradingClient({
      verifySubaccount: async () => true,
      fetchImpl: (async () => {
        oversizedCalls++;
        return jsonResponse({
          order_id: "bad-exit",
          client_order_id: oversizedInput.clientOrderId,
          fill_count: "3.00",
          remaining_count: "0.00",
          ts_ms: now,
        }, 201);
      }) as typeof fetch,
    });
    await assert.rejects(malformedExitClient.createReduceOnlyExit(
      oversizedInput, forgedPermissiveContext, oversized.capability!,
    ), (error: Error) => error instanceof KalshiTradingApiError &&
      error.type === "INVALID_RESPONSE");
    assert.equal(oversizedCalls, 1, "an oversized IOC response is never retried");
  } finally {
    restoreEnvironment();
  }
});

test("subaccount verification or selector drift still blocks a capability-backed POST", async () => {
  const now = Date.now();
  configure();
  const rejectedFixture = authorizedSubmissionFixture(now);
  const rejectedCapability = await authorizeKalshiSubmission(
    rejectedFixture.tx as never,
    rejectedFixture.input,
    rejectedFixture.witness,
    now,
  );
  assert.ok(rejectedCapability);
  rejectedFixture.orderLookupRows.splice(0, rejectedFixture.orderLookupRows.length,
    [rejectedFixture.order]);
  let exchangeCalls = 0;
  const scopeRejectedClient = createKalshiTradingClient({
    verifySubaccount: async () => false,
    fetchImpl: (async () => {
      exchangeCalls++;
      return jsonResponse({});
    }) as typeof fetch,
  });
  try {
    await assert.rejects(scopeRejectedClient.createLimitOrder(
      rejectedFixture.input, forgedPermissiveContext, rejectedCapability!,
    ), (error: Error) => error instanceof KalshiTradingApiError &&
      error.type === "MUTATION_GUARD_REJECTED");
    assert.equal(exchangeCalls, 0);

    const driftFixture = authorizedSubmissionFixture(now);
    const driftCapability = await authorizeKalshiSubmission(
      driftFixture.tx as never,
      driftFixture.input,
      driftFixture.witness,
      now,
    );
    assert.ok(driftCapability);
    driftFixture.orderLookupRows.splice(0, driftFixture.orderLookupRows.length,
      [driftFixture.order]);
    const driftClient = createKalshiTradingClient({
      verifySubaccount: async () => {
        process.env.KALSHI_BOT_SUBACCOUNT = "8";
        return true;
      },
      fetchImpl: (async () => {
        exchangeCalls++;
        return jsonResponse({});
      }) as typeof fetch,
    });
    await assert.rejects(driftClient.createLimitOrder(
      driftFixture.input, forgedPermissiveContext, driftCapability!,
    ), (error: Error) => error instanceof KalshiTradingApiError &&
      error.type === "MUTATION_GUARD_REJECTED");
    assert.equal(exchangeCalls, 0);
  } finally {
    restoreEnvironment();
  }
});

test("forged reconciliation witness cannot replace process-local startup readiness", async () => {
  const now = Date.now();
  configure();
  process.env.NODE_ENV = "test";
  setKalshiReadinessForTest(null);
  process.env.NODE_ENV = "development";
  const fixture = authorizedSubmissionFixture(now);
  const capability = await authorizeKalshiSubmission(
    fixture.tx as never,
    fixture.input,
    { ...fixture.witness, reconciled: true, isStillReconciled: () => true },
    now,
  );
  assert.equal(capability, null,
    "all DB/fee/lease fixtures are permissive, but startup readiness is actually false");
  fixture.orderLookupRows.splice(0, fixture.orderLookupRows.length, [fixture.order]);
  let fetchCalls = 0;
  const client = createKalshiTradingClient({
    verifySubaccount: async () => true,
    fetchImpl: (async () => {
      fetchCalls++;
      return jsonResponse({});
    }) as typeof fetch,
  });
  try {
    await assert.rejects(client.createLimitOrder(
      fixture.input, forgedPermissiveContext, capability ?? undefined,
    ), (error: Error) => error instanceof KalshiTradingApiError &&
      error.type === "MUTATION_GUARD_REJECTED");
    assert.equal(fetchCalls, 0);
  } finally {
    restoreEnvironment();
  }
});

test("persisted gate changes block capability minting; GET normalization stays intact", async () => {
  const now = Date.now();
  configure();
  const input: KalshiLimitOrderRequest = {
    ticker: "KXTEST", clientOrderId: "entry-client",
    side: "yes", action: "buy", count: 1, priceDollars: "0.42",
  };
  const invalid = authorizedSubmissionFixture(now, input);
  invalid.config.manualKillSwitch = true;
  invalid.config.microLiveProductionEnabled = false;
  invalid.config.liveExecutionEnabled = false;
  assert.equal(await authorizeKalshiSubmission(
    invalid.tx as never, input, invalid.witness, now,
  ), null, "the actual locked DB kill switch overrides forged positive context");
  const mismatchedBarrier = authorizedSubmissionFixture(now, input);
  mismatchedBarrier.order.feeEvidenceVerifiedAt = new Date(now - 1_000);
  assert.equal(await authorizeKalshiSubmission(
    mismatchedBarrier.tx as never,
    input,
    mismatchedBarrier.witness,
    now,
  ), null, "order proof must match the exact persisted fee-verification barrier");

  const missingBaseline = primarySubmissionFixture(now);
  Object.assign(missingBaseline.config, { microLivePrimaryCashBaselineMicros: null });
  assert.equal(await authorizeKalshiSubmission(
    missingBaseline.tx as never,
    missingBaseline.input,
    missingBaseline.witness,
    now,
  ), null, "primary authorizations require a durable cash baseline");
  const mismatchedBaseline = primarySubmissionFixture(now);
  mismatchedBaseline.config.microLivePrimaryCashBaselineRunId = "another-run";
  assert.equal(await authorizeKalshiSubmission(
    mismatchedBaseline.tx as never,
    mismatchedBaseline.input,
    mismatchedBaseline.witness,
    now,
  ), null, "cash baseline must be bound to this exact run");

  const forgedCashWitness = primarySubmissionFixture(now);
  setKalshiCashPreflightForTest(() => false);
  assert.equal(await authorizeKalshiSubmission(
    forgedCashWitness.tx as never,
    forgedCashWitness.input,
    {
      ...forgedCashWitness.witness,
      reconciled: true,
      cashPreflightVerified: true,
      cashPreflightOrderId: forgedCashWitness.order.id,
      cashPreflightRunId: forgedCashWitness.order.microLiveRunId,
      cashPreflightMarketTicker: forgedCashWitness.order.marketTicker,
      cashPreflightBaselineDigest:
        forgedCashWitness.config.microLivePrimaryCashBaselineEvidenceDigest,
    } as never,
    now,
  ), null, "caller-provided cash witness cannot replace process-local successful preflight");
  setKalshiCashPreflightForTest(() => true);
  process.env.MICRO_LIVE_ACCOUNT_MODE = "exclusive";
  process.env.KALSHI_BOT_SUBACCOUNT = "7";

  const readRequests: SeenRequest[] = [];
  const client = createKalshiTradingClient({
    verifySubaccount: async () => true,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      readRequests.push({ url: String(url), init: init ?? {} });
      if (String(url).includes("/portfolio/orders/")) {
        return jsonResponse({ order: {
          order_id: "order-1", client_order_id: "client-1", ticker: "KXTEST",
          side: "yes", action: "buy", type: "limit", status: "resting",
          remaining_count_fp: "1.00", fill_count_fp: "0",
        } });
      }
      return jsonResponse({ fills: [{
        fill_id: "fill-1", trade_id: "trade-1", order_id: "order-1",
        ticker: "KXTEST", side: "yes", action: "buy", count_fp: "1.00",
        yes_price_dollars: "0.4200", created_time: "2025-01-02T03:04:05Z",
      }], cursor: "" });
    }) as typeof fetch,
  });
  try {
    assert.equal((await client.getOrder("order-1")).filledCount, "0");
    const fills = await client.getFills();
    assert.equal(fills.fills[0]?.priceDollars, "0.4200");
    assert.equal(fills.fills[0]?.createdAt, "2025-01-02T03:04:05.000Z");
    await assert.rejects(
      client.cancelOrder("order-1", forgedPermissiveContext as never),
      (error: Error) => error instanceof KalshiTradingApiError &&
        error.type === "MUTATION_GUARD_REJECTED",
    );
    const signedPaths = [
      "/trade-api/v2/portfolio/orders/order-1",
      "/trade-api/v2/portfolio/fills",
    ];
    readRequests.forEach((request, index) => {
      verifyRequest(request, "GET", signedPaths[index]!);
      assert.equal(new URL(request.url).pathname, signedPaths[index]);
    });
    assert.equal(readRequests.length, 2, "context-only cancellation never reaches the exchange");
    assert.equal(new URL(readRequests[1]!.url).searchParams.get("subaccount"), "7");
    const malformed = createKalshiTradingClient({
      verifySubaccount: async () => true,
      fetchImpl: (async () => jsonResponse({ order: {
        order_id: "order-1", client_order_id: "client-1", ticker: "KXTEST",
        side: "yes", action: "buy", type: "limit", status: "resting",
        remaining_count: "0", fill_count: "1.5",
      } })) as typeof fetch,
    });
    await assert.rejects(malformed.getOrder("order-1"),
      (error: Error) => error instanceof KalshiTradingApiError &&
        error.type === "INVALID_RESPONSE");
  } finally {
    restoreEnvironment();
  }
});

test("GET order requires authoritative nonnegative integer fill counts and matching account", async () => {
  configure();
  const baseOrder = {
    order_id: "order-1", client_order_id: "client-1", ticker: "KXTEST",
    side: "yes", action: "buy", type: "limit", status: "canceled",
    remaining_count: "0",
  };
  try {
    for (const order of [
      baseOrder,
      { ...baseOrder, fill_count: "-1" },
      { ...baseOrder, fill_count: "1.5" },
      { ...baseOrder, fill_count: "0", subaccount: 8 },
    ]) {
      const client = createKalshiTradingClient({
        verifySubaccount: async () => true,
        fetchImpl: (async () => jsonResponse({ order })) as typeof fetch,
      });
      await assert.rejects(client.getOrder("order-1"),
        (error: Error) => error instanceof KalshiTradingApiError &&
          error.type === "INVALID_RESPONSE");
    }
    for (const [field, value] of [["fill_count_fp", "0"], ["fill_count", 2]] as const) {
      const client = createKalshiTradingClient({
        verifySubaccount: async () => true,
        fetchImpl: (async () => jsonResponse({
          order: { ...baseOrder, [field]: value },
        })) as typeof fetch,
      });
      assert.equal((await client.getOrder("order-1")).filledCount, String(value));
    }
  } finally {
    restoreEnvironment();
  }
});

test("HTTP and malformed-response errors do not expose credentials or response bodies", async () => {
  configure();
  const secretBody = testPrivateKey;
  const malformed = createKalshiTradingClient({
    verifySubaccount: async () => true,
    fetchImpl: (async () => jsonResponse({ order: { order_id: "incomplete" } })) as typeof fetch,
  });
  const rejected = createKalshiTradingClient({
    verifySubaccount: async () => true,
    fetchImpl: (async () => ({
      ok: false,
      status: 403,
      json: async () => ({ message: secretBody }),
    }) as Response) as typeof fetch,
  });
  try {
    await assert.rejects(malformed.getOrder("order-1"),
      (error: Error) => error instanceof KalshiTradingApiError &&
        error.type === "INVALID_RESPONSE");
    await assert.rejects(rejected.getOrder("order-1"), (error: Error) => {
      assert.match(error.message, /HTTP_ERROR.*403/);
      assert.doesNotMatch(error.message, /BEGIN PRIVATE KEY|mock-key-id/);
      assert.equal(JSON.stringify(error).includes(secretBody), false);
      return error instanceof KalshiTradingApiError && error.type === "HTTP_ERROR";
    });
  } finally {
    restoreEnvironment();
  }
});

test("missing, primary, malformed, or unverified subaccounts fail before transport", async () => {
  configure();
  let calls = 0;
  const client = createKalshiTradingClient({
    verifySubaccount: async () => false,
    fetchImpl: (async () => {
      calls++;
      return jsonResponse({});
    }) as typeof fetch,
  });
  try {
    for (const selector of [undefined, "0", "-1", "01", "64", "7.0", "garbage"]) {
      if (selector === undefined) delete process.env.KALSHI_BOT_SUBACCOUNT;
      else process.env.KALSHI_BOT_SUBACCOUNT = selector;
      const expectedType = selector === "0"
        ? "MUTATION_GUARD_REJECTED" : "NOT_CONFIGURED";
      await assert.rejects(client.getOrder("order-1"),
        (error: Error) => error instanceof KalshiTradingApiError &&
          error.type === expectedType);
    }
    process.env.KALSHI_BOT_SUBACCOUNT = "7";
    await assert.rejects(client.getOrder("order-1"),
      (error: Error) => error instanceof KalshiTradingApiError &&
        error.type === "MUTATION_GUARD_REJECTED");
    assert.equal(calls, 0);
  } finally {
    restoreEnvironment();
  }
});

test("primary non-exclusive metadata verification remains mandatory after DB authorization", async () => {
  const now = Date.now();
  configure();
  process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = testPrivateKey;
  const originalFetch = globalThis.fetch;
  let metadataCalls = 0;
  let exchangeCalls = 0;
  let metadataRecord: Record<string, unknown> = {
    api_key_id: "mock-key-id",
    subaccount: 0,
    scopes: ["read", "write::trade"],
  };
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    metadataCalls++;
    assert.equal(init?.method, "GET");
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers["KALSHI-ACCESS-KEY"], "verifier-key");
    const verifier = createVerify("sha256");
    verifier.update(`${headers["KALSHI-ACCESS-TIMESTAMP"]}GET/trade-api/v2/api_keys`);
    verifier.end();
    assert.equal(verifier.verify({
      key: publicKey,
      padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    }, Buffer.from(headers["KALSHI-ACCESS-SIGNATURE"], "base64")), true);
    return jsonResponse({ api_keys: [metadataRecord] });
  }) as typeof fetch;
  try {
    const fixture = primarySubmissionFixture(now);
    const capability = await authorizeKalshiSubmission(
      fixture.tx as never, fixture.input, fixture.witness, now,
    );
    assert.ok(capability);
    fixture.orderLookupRows.splice(0, fixture.orderLookupRows.length, [fixture.order]);
    const client = createKalshiTradingClient({
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        exchangeCalls++;
        const body = JSON.parse(String(init?.body)) as { client_order_id: string };
        assert.equal(JSON.parse(String(init?.body)).subaccount, 0);
        return jsonResponse({
          order_id: "primary-order",
          client_order_id: body.client_order_id,
          fill_count: "0.00",
          remaining_count: "1.00",
          ts_ms: now,
        }, 201);
      }) as typeof fetch,
    });
    await assert.rejects(client.createLimitOrder(
      fixture.input, forgedPermissiveContext, capability!,
    ), (error: Error) => error instanceof KalshiTradingApiError &&
      error.type === "MUTATION_GUARD_REJECTED");
    assert.equal(metadataCalls, 1);
    assert.equal(exchangeCalls, 0, "primary account cannot enter the dedicated shard path");

    const wrongModeFixture = primarySubmissionFixture(now);
    process.env.MICRO_LIVE_ACCOUNT_MODE = "exclusive";
    assert.equal(await authorizeKalshiSubmission(
      wrongModeFixture.tx as never,
      wrongModeFixture.input,
      wrongModeFixture.witness,
      now,
    ), null, "primary subaccount requires explicit primary_nonexclusive mode");
    assert.equal(metadataCalls, 1, "wrong mode blocks before API-key metadata lookup");

    process.env.MICRO_LIVE_ACCOUNT_MODE = "primary_nonexclusive";
    metadataRecord = {
      api_key_id: "mock-key-id", subaccount: 0, scopes: ["read"],
    };
    const scopeFixture = primarySubmissionFixture(now);
    const scopeCapability = await authorizeKalshiSubmission(
      scopeFixture.tx as never, scopeFixture.input, scopeFixture.witness, now,
    );
    assert.ok(scopeCapability);
    scopeFixture.orderLookupRows.splice(0, scopeFixture.orderLookupRows.length,
      [scopeFixture.order]);
    await assert.rejects(client.createLimitOrder(
      scopeFixture.input, forgedPermissiveContext, scopeCapability!,
    ), (error: Error) => error instanceof KalshiTradingApiError &&
      error.type === "MUTATION_GUARD_REJECTED");
    assert.equal(exchangeCalls, 0, "read-only metadata cannot authorize a POST");

    metadataRecord = {
      api_key_id: "mock-key-id", subaccount: 0, scopes: ["read", "write::trade"],
    };
    const driftFixture = primarySubmissionFixture(now);
    const driftCapability = await authorizeKalshiSubmission(
      driftFixture.tx as never, driftFixture.input, driftFixture.witness, now,
    );
    assert.ok(driftCapability);
    driftFixture.orderLookupRows.splice(0, driftFixture.orderLookupRows.length,
      [driftFixture.order]);
    globalThis.fetch = (async () => {
      metadataCalls++;
      process.env.KALSHI_BOT_SUBACCOUNT = "1";
      return jsonResponse({ api_keys: [metadataRecord] });
    }) as typeof fetch;
    await assert.rejects(client.createLimitOrder(
      driftFixture.input, forgedPermissiveContext, driftCapability!,
    ), (error: Error) => error instanceof KalshiTradingApiError &&
      error.type === "MUTATION_GUARD_REJECTED");
    assert.equal(exchangeCalls, 0, "selector drift during verification blocks the POST");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment();
  }
});

test("dedicated shard-two verifier is required and rejects stale or mismatched pair evidence", async () => {
  configure();
  let fetchCalls = 0;
  const fetchImpl = (async () => {
    fetchCalls++;
    return jsonResponse({});
  }) as typeof fetch;
  const attempts: Array<KalshiTradingClientOptions["verifyDedicatedShardTwoPair"]> = [
    undefined,
    async (input) => ({
      ...testShardTwoEvidence(input),
      persistedIdentity: {
        ...testShardTwoEvidence(input).persistedIdentity,
        subaccountNumber: input.subaccountNumber + 1,
      },
    }),
    async (input) => ({
      ...testShardTwoEvidence(input),
      marketEvidence: {
        ...testShardTwoEvidence(input).marketEvidence,
        capturedAt: input.now - 5_001,
      },
    }),
  ];
  try {
    for (const verifier of attempts) {
      const now = Date.now();
      const fixture = authorizedSubmissionFixture(now);
      const capability = await authorizeKalshiSubmission(
        fixture.tx as never, fixture.input, fixture.witness, now,
      );
      assert.ok(capability);
      fixture.orderLookupRows.splice(0, fixture.orderLookupRows.length, [fixture.order]);
      const client = verifier === undefined
        ? createProductionKalshiTradingClient({ verifySubaccount: async () => true, fetchImpl })
        : createKalshiTradingClient({
          verifySubaccount: async () => true,
          verifyDedicatedShardTwoPair: verifier,
          fetchImpl,
        });
      await assert.rejects(client.createLimitOrder(
        fixture.input, forgedPermissiveContext, capability!,
      ), (error: Error) => error instanceof KalshiTradingApiError &&
        error.type === "MUTATION_GUARD_REJECTED");
    }
    assert.equal(fetchCalls, 0, "pair proof is checked before signing or transport");
  } finally {
    restoreEnvironment();
  }
});

test("dedicated (N,2) signed POST and DELETE require exact key, shard, and market evidence", async () => {
  configure();
  const now = Date.now();
  const postInput: KalshiLimitOrderRequest = {
    ticker: "KXTEST",
    clientOrderId: "pair-signed-post",
    side: "yes",
    action: "buy",
    count: 1,
    priceDollars: "0.42",
  };
  const postAuthorization = await authorizeFixture(postInput, now);
  assert.ok(postAuthorization.capability);
  const cancellation = await authorizeCancellationFixture(now);
  assert.ok(cancellation.capability);
  const requests: SeenRequest[] = [];
  const client = createKalshiTradingClient({
    verifySubaccount: async () => true,
    verifyDedicatedShardTwoPair: async (input) => testShardTwoEvidence(input),
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init: init ?? {} });
      if (init?.method === "POST") {
        return jsonResponse({
          order_id: postInput.clientOrderId,
          client_order_id: postInput.clientOrderId,
          fill_count: "0.00",
          remaining_count: "0.00",
          ts_ms: Date.now(),
        }, 201);
      }
      if (init?.method === "GET") {
        return jsonResponse({ order: {
          order_id: cancellation.identity.exchangeOrderId,
          client_order_id: cancellation.identity.clientOrderId,
          ticker: "KXTEST",
          subaccount_number: 7,
          exchange_index: 2,
          side: "yes",
          action: "sell",
          type: "limit",
          status: "resting",
          remaining_count_fp: "1.00",
          fill_count_fp: "0",
        } });
      }
      return jsonResponse({
        order_id: cancellation.identity.exchangeOrderId,
        client_order_id: cancellation.identity.clientOrderId,
        reduced_by: "1.00",
      });
    }) as typeof fetch,
  });

  try {
    const posted = await client.createLimitOrder(
      postInput, forgedPermissiveContext, postAuthorization.capability!,
    );
    assert.equal(posted.status, "canceled");
    const canceled = await client.cancelOrder(
      cancellation.identity.exchangeOrderId,
      forgedPermissiveContext,
      cancellation.capability!,
    );
    assert.deepEqual(canceled, {
      orderId: cancellation.identity.exchangeOrderId,
      remainingCount: "0",
    });
    assert.deepEqual(requests.map((request) => request.init.method), [
      "POST", "GET", "DELETE",
    ]);
    verifyRequest(requests[0]!, "POST", "/trade-api/v2/portfolio/events/orders");
    verifyRequest(requests[1]!, "GET",
      `/trade-api/v2/portfolio/orders/${cancellation.identity.exchangeOrderId}`);
    verifyRequest(requests[2]!, "DELETE",
      `/trade-api/v2/portfolio/events/orders/${cancellation.identity.exchangeOrderId}`);
    const postBody = JSON.parse(String(requests[0]!.init.body)) as Record<string, unknown>;
    assert.equal(postBody.subaccount, 7);
    assert.equal(postBody.exchange_index, 2);
    const deleteUrl = new URL(requests[2]!.url);
    assert.equal(deleteUrl.searchParams.get("market_ticker"), "KXTEST");
    assert.equal(deleteUrl.searchParams.get("subaccount"), "7");
    assert.equal(deleteUrl.searchParams.get("exchange_index"), "2");

    const mismatches = [
      (input: KalshiShardTwoPairVerificationRequest) => {
        const evidence = testShardTwoEvidence(input);
        return {
          ...evidence,
          apiKeyId: "wrong-key",
          persistedIdentity: { ...evidence.persistedIdentity, apiKeyId: "wrong-key" },
        };
      },
      (input: KalshiShardTwoPairVerificationRequest) => {
        const evidence = testShardTwoEvidence(input);
        return {
          ...evidence,
          persistedIdentity: { ...evidence.persistedIdentity, exchangeIndex: 1 },
        };
      },
      (input: KalshiShardTwoPairVerificationRequest) => {
        const evidence = testShardTwoEvidence(input);
        return {
          ...evidence,
          marketEvidence: { ...evidence.marketEvidence, ticker: "KXOTHER" },
        };
      },
    ];
    for (const mismatch of mismatches) {
      const rejectedPost = await authorizeFixture({
        ...postInput,
        clientOrderId: `pair-reject-post-${requests.length}`,
      }, Date.now());
      assert.ok(rejectedPost.capability);
      const beforePost = requests.length;
      const rejectingClient = createKalshiTradingClient({
        verifySubaccount: async () => true,
        verifyDedicatedShardTwoPair: async (input) => mismatch(input),
        fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
          requests.push({ url: String(input), init: init ?? {} });
          return jsonResponse({});
        }) as typeof fetch,
      });
      await assert.rejects(rejectingClient.createLimitOrder(
        rejectedPost.fixture.input, forgedPermissiveContext, rejectedPost.capability!,
      ), (error: Error) => error instanceof KalshiTradingApiError &&
        error.type === "MUTATION_GUARD_REJECTED");
      assert.equal(requests.length, beforePost,
        "wrong key, shard, or market evidence blocks before signed POST transport");

      const rejectedCancel = await authorizeCancellationFixture(Date.now());
      assert.ok(rejectedCancel.capability);
      const beforeDelete = requests.length;
      await assert.rejects(rejectingClient.cancelOrder(
        rejectedCancel.identity.exchangeOrderId,
        forgedPermissiveContext,
        rejectedCancel.capability!,
      ), (error: Error) => error instanceof KalshiTradingApiError &&
        error.type === "MUTATION_GUARD_REJECTED");
      assert.equal(requests.length, beforeDelete,
        "wrong key, shard, or market evidence blocks before cancellation GET/DELETE");
    }
  } finally {
    restoreEnvironment();
  }
});

test("signed reduce-only cancellation keeps recovery-GET proof on both pair guards", async () => {
  configure();
  const cancellation = await authorizeCancellationFixture(Date.now());
  assert.ok(cancellation.capability);
  const expectedEvidenceDigest = cancellation.witness.pairRecoveryProof?.evidenceDigest;
  assert.ok(expectedEvidenceDigest);

  const verifierCalls: Array<{
    authorizationMode: string | undefined;
    requiredEvidenceDigest: string | undefined;
  }> = [];
  const requests: SeenRequest[] = [];
  const client = createKalshiTradingClient({
    verifySubaccount: async () => true,
    verifyDedicatedShardTwoPair: async (input) => {
      verifierCalls.push({
        authorizationMode: input.authorizationMode,
        requiredEvidenceDigest: input.requiredEvidenceDigest,
      });
      assert.equal(input.authorizationMode, "recovery_get",
        "cancellation pair verification must never fall back to final_post");
      assert.equal(input.requiredEvidenceDigest, expectedEvidenceDigest,
        "both pair checks must bind the exact persisted recovery evidence digest");
      return testShardTwoEvidence(input);
    },
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init: init ?? {} });
      if (init?.method === "GET") {
        return jsonResponse({ order: {
          order_id: cancellation.identity.exchangeOrderId,
          client_order_id: cancellation.identity.clientOrderId,
          ticker: "KXTEST",
          subaccount_number: 7,
          exchange_index: 2,
          side: "yes",
          action: "sell",
          type: "limit",
          status: "resting",
          remaining_count_fp: "1.00",
          fill_count_fp: "0",
        } });
      }
      return jsonResponse({
        order_id: cancellation.identity.exchangeOrderId,
        client_order_id: cancellation.identity.clientOrderId,
        reduced_by: "1.00",
      });
    }) as typeof fetch,
  });

  try {
    const canceled = await client.cancelReduceOnlyExit(
      cancellation.identity.exchangeOrderId,
      "KXTEST",
      "1",
      forgedPermissiveContext,
      cancellation.capability!,
    );
    assert.deepEqual(canceled, {
      orderId: cancellation.identity.exchangeOrderId,
      remainingCount: "0",
    });
    assert.deepEqual(verifierCalls, [
      { authorizationMode: "recovery_get", requiredEvidenceDigest: expectedEvidenceDigest },
      { authorizationMode: "recovery_get", requiredEvidenceDigest: expectedEvidenceDigest },
    ], "the pre-GET check and DELETE transport guard use identical recovery proof");
    assert.deepEqual(requests.map((request) => request.init.method), ["GET", "DELETE"]);
    verifyRequest(requests[0]!, "GET",
      `/trade-api/v2/portfolio/orders/${cancellation.identity.exchangeOrderId}`);
    verifyRequest(requests[1]!, "DELETE",
      `/trade-api/v2/portfolio/events/orders/${cancellation.identity.exchangeOrderId}`);
  } finally {
    restoreEnvironment();
  }
});

test("an already minted capability cannot POST after process flags turn off", async () => {
  const now = Date.now();
  configure();
  const fixture = authorizedSubmissionFixture(now);
  const capability = await authorizeKalshiSubmission(
    fixture.tx as never, fixture.input, fixture.witness, now,
  );
  assert.ok(capability);
  fixture.orderLookupRows.splice(0, fixture.orderLookupRows.length, [fixture.order]);
  configure(false);
  let fetchCalls = 0;
  const client = createKalshiTradingClient({
    verifySubaccount: async () => true,
    fetchImpl: (async () => {
      fetchCalls++;
      return jsonResponse({});
    }) as typeof fetch,
  });
  try {
    await assert.rejects(client.createLimitOrder(
      fixture.input, forgedPermissiveContext, capability!,
    ), (error: Error) => error instanceof KalshiTradingApiError &&
      error.type === "MUTATION_GUARD_REJECTED");
    assert.equal(fetchCalls, 0);
  } finally {
    restoreEnvironment();
  }
});

test("caller-provided contexts cannot authorize DELETE cancellation", async () => {
  configure();
  let fetchCalls = 0;
  const client = createKalshiTradingClient({
    verifySubaccount: async () => true,
    fetchImpl: (async () => {
      fetchCalls++;
      return jsonResponse({});
    }) as typeof fetch,
  });
  try {
    await assert.rejects(
      client.cancelOrder("order-1", forgedPermissiveContext as never),
      (error: Error) => error instanceof KalshiTradingApiError &&
        error.type === "MUTATION_GUARD_REJECTED",
    );
    await assert.rejects(
      client.cancelReduceOnlyExit(
        "order-1", "KXTEST", "1.00", forgedPermissiveContext as never,
      ),
      (error: Error) => error instanceof KalshiTradingApiError &&
        error.type === "MUTATION_GUARD_REJECTED",
    );
    assert.equal(fetchCalls, 0, "context-only DELETE attempts never reach the transport");
  } finally {
    restoreEnvironment();
  }
});

test("frozen exit cancellation needs exact DB-backed authorization and is one-use", async () => {
  const now = Date.now();
  configure();
  const authorized = await authorizeCancellationFixture(now);
  assert.ok(authorized.capability);
  const methods: string[] = [];
  const urls: string[] = [];
  const client = createKalshiTradingClient({
    verifySubaccount: async () => true,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      methods.push(String(init?.method));
      urls.push(String(input));
      if (init?.method === "GET") {
        return jsonResponse({ order: {
          order_id: authorized.identity.exchangeOrderId,
          client_order_id: authorized.identity.clientOrderId,
          ticker: "KXTEST",
          subaccount_number: 7,
          exchange_index: 2,
          side: "yes",
          action: "sell",
          type: "limit",
          status: "resting",
          remaining_count_fp: "1.00",
          fill_count_fp: "0",
        } });
      }
      return jsonResponse({
        order_id: authorized.identity.exchangeOrderId,
        client_order_id: authorized.identity.clientOrderId,
        reduced_by: "1.00",
      });
    }) as typeof fetch,
  });
  try {
    await assert.rejects(
      client.cancelOrder(
        "different-exchange-order", forgedPermissiveContext, authorized.capability!,
      ),
      (error: Error) => error instanceof KalshiTradingApiError &&
        error.type === "MUTATION_GUARD_REJECTED",
    );
    assert.deepEqual(methods, [], "wrong-order capabilities fail before GET or DELETE");
    assert.deepEqual(await client.cancelOrder(
      authorized.identity.exchangeOrderId, forgedPermissiveContext, authorized.capability!,
    ), { orderId: authorized.identity.exchangeOrderId, remainingCount: "0" });
    assert.deepEqual(methods, ["GET", "DELETE"]);
    const deleteUrl = new URL(urls[1]!);
    assert.equal(deleteUrl.searchParams.get("subaccount"), "7");
    assert.equal(deleteUrl.searchParams.get("exchange_index"), "2");
    assert.equal(
      authorized.order.cancellationAttemptedAt.getTime(),
      authorized.witness.cancellationClaimedAt,
      "authorization leaves the original cancellation-attempt time untouched",
    );
    assert.equal(
      (authorized.order as { cancellationAuthorizedAt: Date | null })
        .cancellationAuthorizedAt?.getTime(),
      now,
      "the durable authorization marker is set exactly once",
    );
    resetKalshiCancellationAuthorizationStateForTest();
    assert.equal(await authorizeKalshiCancellation(
      authorized.fixture.tx as never,
      authorized.identity,
      authorized.witness,
      now,
    ), null, "the persisted marker blocks remint after process-local state resets");
    await assert.rejects(
      client.cancelOrder(
        authorized.identity.exchangeOrderId, forgedPermissiveContext, authorized.capability!,
      ),
      (error: Error) => error instanceof KalshiTradingApiError &&
        error.type === "MUTATION_GUARD_REJECTED",
    );
    assert.deepEqual(methods, ["GET", "DELETE"], "replay is rejected before another request");
  } finally {
    restoreEnvironment();
  }
});

test("cancellation authorizer rejects wrong order, run, and stale durable claims", async () => {
  const now = Date.now();
  configure();
  try {
    const wrongOrder = frozenCancellationFixture(now);
    assert.equal(await authorizeKalshiCancellation(
      wrongOrder.fixture.tx as never,
      { ...wrongOrder.identity, exchangeOrderId: "different-order" },
      wrongOrder.witness,
      now,
    ), null, "the locked local order must own the exact exchange ID");

    const wrongRun = frozenCancellationFixture(now + 1);
    assert.equal(await authorizeKalshiCancellation(
      wrongRun.fixture.tx as never,
      wrongRun.identity,
      { ...wrongRun.witness, runId: "another-run" },
      now + 1,
    ), null, "reconciliation witness and persisted run identity must agree");

    const staleClaim = frozenCancellationFixture(now + 2);
    assert.equal(await authorizeKalshiCancellation(
      staleClaim.fixture.tx as never,
      staleClaim.identity,
      staleClaim.witness,
      now + 30_003,
    ), null, "a durable claim surviving a restart cannot authorize a late DELETE");

    const wrongPersistedRun = frozenCancellationFixture(now + 3);
    wrongPersistedRun.fixture.config.microLiveRunId = "different-run";
    assert.equal(await authorizeKalshiCancellation(
      wrongPersistedRun.fixture.tx as never,
      wrongPersistedRun.identity,
      wrongPersistedRun.witness,
      now + 3,
    ), null, "current config run must match the local order run");
  } finally {
    restoreEnvironment();
  }
});

test("cancellation authorization is development-only and fails closed on binding or claim drift", async () => {
  const now = Date.now();
  configure();
  try {
    const production = frozenCancellationFixture(now);
    process.env.NODE_ENV = "production";
    assert.equal(await authorizeKalshiCancellation(
      production.fixture.tx as never,
      production.identity,
      production.witness,
      now,
    ), null, "production cannot mint cancellation capabilities");
    process.env.NODE_ENV = "test";

    const wrongBinding = frozenCancellationFixture(now + 1);
    process.env.MICRO_LIVE_ACCOUNT_MODE = "primary_nonexclusive";
    process.env.KALSHI_BOT_SUBACCOUNT = "0";
    assert.equal(await authorizeKalshiCancellation(
      wrongBinding.fixture.tx as never,
      wrongBinding.identity,
      wrongBinding.witness,
      now + 1,
    ), null, "environment and persisted account/subaccount binding must match");
    process.env.MICRO_LIVE_ACCOUNT_MODE = "exclusive";
    process.env.KALSHI_BOT_SUBACCOUNT = "7";

    const missingClaim = frozenCancellationFixture(now + 2);
    Object.assign(missingClaim.order, { cancellationAttemptedAt: null });
    assert.equal(await authorizeKalshiCancellation(
      missingClaim.fixture.tx as never,
      missingClaim.identity,
      missingClaim.witness,
      now + 2,
    ), null, "a missing durable cancellation claim cannot mint authority");
  } finally {
    restoreEnvironment();
  }
});

test("a rolled-back marker cannot remint the same claim in the same process", async () => {
  const now = Date.now();
  configure();
  const prepared = frozenCancellationFixture(now);
  try {
    const capability = await authorizeKalshiCancellation(
      prepared.fixture.tx as never,
      prepared.identity,
      prepared.witness,
      now,
    );
    assert.ok(capability);
    // Simulate the transaction rolling back its database marker.
    prepared.order.cancellationAuthorizedAt = null;
    let requests = 0;
    const client = createKalshiTradingClient({
      fetchImpl: (async () => {
        requests++;
        return jsonResponse({});
      }) as typeof fetch,
    });
    await assert.rejects(client.cancelOrder(
      prepared.identity.exchangeOrderId, forgedPermissiveContext, capability!,
    ), (error: Error) => error instanceof KalshiTradingApiError &&
      error.type === "MUTATION_GUARD_REJECTED");
    assert.equal(requests, 0, "a rolled-back authorization cannot reach even GET");
    assert.equal(await authorizeKalshiCancellation(
      prepared.fixture.tx as never,
      prepared.identity,
      prepared.witness,
      now,
    ), null, "process-local claim consumption survives transaction rollback");
  } finally {
    restoreEnvironment();
  }
});

test("a committed cancellation marker survives an unknown DELETE and process restart", async () => {
  const now = Date.now();
  configure();
  const prepared = await authorizeCancellationFixture(now);
  assert.ok(prepared.capability);
  const methods: string[] = [];
  const client = createKalshiTradingClient({
    verifySubaccount: async () => true,
    fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
      const method = String(init?.method);
      methods.push(method);
      if (method === "GET") return jsonResponse({ order: {
        order_id: prepared.identity.exchangeOrderId,
        client_order_id: prepared.identity.clientOrderId,
        ticker: "KXTEST", subaccount_number: 7, exchange_index: 2,
        side: "yes", action: "sell", type: "limit",
        status: "resting", remaining_count_fp: "1.00", fill_count_fp: "0",
      } });
      throw new Error("unknown DELETE outcome");
    }) as typeof fetch,
  });
  try {
    await assert.rejects(client.cancelOrder(
      prepared.identity.exchangeOrderId, forgedPermissiveContext, prepared.capability!,
    ));
    assert.deepEqual(methods, ["GET", "DELETE"]);
    resetKalshiCancellationAuthorizationStateForTest();
    assert.equal(await authorizeKalshiCancellation(
      prepared.fixture.tx as never,
      prepared.identity,
      prepared.witness,
      now + 1,
    ), null, "the committed marker forbids remint after restart");
    assert.deepEqual(methods, ["GET", "DELETE"], "restart cannot repeat an uncertain DELETE");
  } finally {
    restoreEnvironment();
  }
});

test("cancellation lease expiry during the pre-DELETE GET blocks mutation", async () => {
  const now = Date.now();
  configure();
  const prepared = await authorizeCancellationFixture(now);
  assert.ok(prepared.capability);
  const [engine] = prepared.fixture.tableRows.get(forwardTestEngineTable) as Array<{
    leaseExpiresAt: Date;
  }>;
  const methods: string[] = [];
  let scopeChecks = 0;
  const client = createKalshiTradingClient({
    verifySubaccount: async () => {
      scopeChecks++;
      if (scopeChecks === 2) engine!.leaseExpiresAt = new Date(Date.now() - 1);
      return true;
    },
    fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
      methods.push(String(init?.method));
      if (init?.method === "GET") {
        return jsonResponse({ order: {
          order_id: prepared.identity.exchangeOrderId,
          client_order_id: prepared.identity.clientOrderId,
          ticker: "KXTEST", subaccount_number: 7, exchange_index: 2,
          side: "yes", action: "sell", type: "limit",
          status: "resting", remaining_count_fp: "1.00", fill_count_fp: "0",
        } });
      }
      return jsonResponse({ order_id: prepared.identity.exchangeOrderId, reduced_by: "1" });
    }) as typeof fetch,
  });
  try {
    await assert.rejects(client.cancelOrder(
      prepared.identity.exchangeOrderId, forgedPermissiveContext, prepared.capability!,
    ), (error: Error) => error instanceof KalshiTradingApiError &&
      error.type === "MUTATION_GUARD_REJECTED");
    assert.deepEqual(methods, ["GET"], "lease is rechecked after request preflight, before DELETE");
  } finally {
    restoreEnvironment();
  }
});

test("cancellation capability becomes stale when reconciliation is revoked", async () => {
  const now = Date.now();
  configure();
  const current = { valid: true };
  const authorized = await authorizeCancellationFixture(now, {
    witness: { isStillReconciled: () => current.valid },
  });
  assert.ok(authorized.capability);
  current.valid = false;
  let fetchCalls = 0;
  const client = createKalshiTradingClient({
    verifySubaccount: async () => true,
    fetchImpl: (async () => {
      fetchCalls++;
      return jsonResponse({});
    }) as typeof fetch,
  });
  try {
    await assert.rejects(
      client.cancelOrder(
        authorized.identity.exchangeOrderId,
        forgedPermissiveContext,
        authorized.capability!,
      ),
      (error: Error) => error instanceof KalshiTradingApiError &&
        error.type === "MUTATION_GUARD_REJECTED",
    );
    assert.equal(fetchCalls, 0, "stale reconciliation is rejected before even the GET");
  } finally {
    restoreEnvironment();
  }
});

test("frozen reduce-only cancellation checks exact live client identity", async () => {
  const now = Date.now();
  configure();
  const authorized = await authorizeCancellationFixture(now);
  assert.ok(authorized.capability);
  const methods: string[] = [];
  const client = createKalshiTradingClient({
    verifySubaccount: async () => true,
    fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
      methods.push(String(init?.method));
      if (init?.method === "GET") {
        return jsonResponse({ order: {
          order_id: authorized.identity.exchangeOrderId,
          client_order_id: "wrong-client",
          ticker: "KXTEST",
          subaccount_number: 7,
          exchange_index: 2,
          side: "yes",
          action: "sell",
          type: "limit",
          status: "resting",
          remaining_count_fp: "1.00",
          fill_count_fp: "0",
        } });
      }
      return jsonResponse({
        order_id: authorized.identity.exchangeOrderId,
        reduced_by: "1.00",
      });
    }) as typeof fetch,
  });
  try {
    await assert.rejects(
      client.cancelReduceOnlyExit(
        authorized.identity.exchangeOrderId,
        "KXTEST",
        "1.00",
        forgedPermissiveContext,
        authorized.capability!,
      ),
      (error: Error) => error instanceof KalshiTradingApiError &&
        error.type === "MUTATION_GUARD_REJECTED",
    );
    assert.deepEqual(methods, ["GET"], "exchange identity mismatch prevents DELETE");
  } finally {
    restoreEnvironment();
  }
});

test("authorized frozen reduce-only cancellation preserves one permitted DELETE", async () => {
  const now = Date.now();
  configure();
  const authorized = await authorizeCancellationFixture(now);
  assert.ok(authorized.capability);
  const methods: string[] = [];
  const client = createKalshiTradingClient({
    verifySubaccount: async () => true,
    fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
      methods.push(String(init?.method));
      if (init?.method === "GET") {
        return jsonResponse({ order: {
          order_id: authorized.identity.exchangeOrderId,
          client_order_id: authorized.identity.clientOrderId,
          ticker: "KXTEST",
          subaccount_number: 7,
          exchange_index: 2,
          side: "yes",
          action: "sell",
          type: "limit",
          status: "resting",
          remaining_count_fp: "1.00",
          fill_count_fp: "0",
        } });
      }
      return jsonResponse({
        order_id: authorized.identity.exchangeOrderId,
        client_order_id: authorized.identity.clientOrderId,
        reduced_by: "1.00",
      });
    }) as typeof fetch,
  });
  try {
    await assert.rejects(
      client.createLimitOrder({
        ticker: "KXTEST",
        clientOrderId: "cannot-use-cancel-cap-for-post",
        side: "yes",
        action: "buy",
        count: 1,
        priceDollars: "0.42",
      }, forgedPermissiveContext, authorized.capability as never),
      (error: Error) => error instanceof KalshiTradingApiError &&
        error.type === "MUTATION_GUARD_REJECTED",
    );
    assert.deepEqual(methods, [], "DELETE authorization cannot enable a POST");
    assert.deepEqual(await client.cancelReduceOnlyExit(
      authorized.identity.exchangeOrderId,
      "KXTEST",
      "1.00",
      forgedPermissiveContext,
      authorized.capability!,
    ), { orderId: authorized.identity.exchangeOrderId, remainingCount: "0" });
    assert.deepEqual(methods, ["GET", "DELETE"]);
    await assert.rejects(
      client.cancelReduceOnlyExit(
        authorized.identity.exchangeOrderId,
        "KXTEST",
        "1.00",
        forgedPermissiveContext,
        authorized.capability!,
      ),
      (error: Error) => error instanceof KalshiTradingApiError &&
        error.type === "MUTATION_GUARD_REJECTED",
    );
    assert.deepEqual(methods, ["GET", "DELETE"], "replayed capability cannot DELETE again");
  } finally {
    restoreEnvironment();
  }
});

test("concurrent DELETE attempts can consume one cancellation capability only once", async () => {
  const now = Date.now();
  configure();
  const authorized = await authorizeCancellationFixture(now);
  assert.ok(authorized.capability);
  let releaseValidation!: () => void;
  let markValidationStarted!: () => void;
  const validationGate = new Promise<void>((resolve) => { releaseValidation = resolve; });
  const validationStarted = new Promise<void>((resolve) => { markValidationStarted = resolve; });
  authorized.fixture.delayLimitedQueries(() => {
    markValidationStarted();
    return validationGate;
  });
  let deletes = 0;
  const client = createKalshiTradingClient({
    verifySubaccount: async () => true,
    fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        deletes++;
        return jsonResponse({
          order_id: authorized.identity.exchangeOrderId,
          client_order_id: authorized.identity.clientOrderId,
          reduced_by: "1.00",
        });
      }
      return jsonResponse({ order: {
        order_id: authorized.identity.exchangeOrderId,
        client_order_id: authorized.identity.clientOrderId,
        ticker: "KXTEST",
          subaccount_number: 7,
          exchange_index: 2,
        side: "yes",
        action: "sell",
        type: "limit",
        status: "resting",
        remaining_count_fp: "1.00",
        fill_count_fp: "0",
      } });
    }) as typeof fetch,
  });
  try {
    const first = client.cancelOrder(
      authorized.identity.exchangeOrderId, forgedPermissiveContext, authorized.capability!,
    );
    await validationStarted;
    await assert.rejects(
      client.cancelOrder(
        authorized.identity.exchangeOrderId, forgedPermissiveContext, authorized.capability!,
      ),
      (error: Error) => error instanceof KalshiTradingApiError &&
        error.type === "MUTATION_GUARD_REJECTED",
    );
    releaseValidation();
    const result = await first;
    assert.deepEqual(result, {
      orderId: authorized.identity.exchangeOrderId,
      remainingCount: "0",
    });
    assert.equal(deletes, 1, "concurrent capability use reaches one DELETE at most");
  } finally {
    releaseValidation();
    restoreEnvironment();
  }
});
