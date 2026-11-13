import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { createPairFundingRouter } from "../routes/pairFunding";
import {
  reconcileOneShotFunding,
  submitOneShotFunding,
  type FundingAttemptStore,
  type FundingDependencies,
} from "./microLivePairFunding";
import {
  acknowledgedFundingCashProof, historyReasons, recoveryInventoryAndPortfolioClean,
} from "./microLivePairBoundary";
import { readPairTransferHistory, readPrimaryIndex2Balance } from "./kalshiPairFundingClient";

const keyId = "isolated-pair-funding-key";
const privateKey = "isolated-test-key-material";
const keyFingerprint = createHash("sha256").update(`${keyId}\u001f${privateKey}`).digest("hex");
const digest = "a".repeat(64);
const environmentKeys = [
  "NODE_ENV",
  "REPLIT_DEPLOYMENT",
  "KALSHI_API_ENVIRONMENT",
  "MICRO_LIVE_PRODUCTION_ENABLED",
  "LIVE_EXECUTION_ENABLED",
  "KALSHI_INDEX2_API_KEY_ID",
  "KALSHI_INDEX2_PRIVATE_KEY",
  "KALSHI_INDEX2_KEY_PROVISIONING_ENABLED",
  "PHASE4_ADMIN_USER_ID",
  "REPLIT_DEV_DOMAIN",
  "KALSHI_VERIFIER_API_KEY_ID",
  "KALSHI_VERIFIER_API_PRIVATE_KEY",
] as const;
const previousEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]));

before(() => {
  process.env.NODE_ENV = "development";
  delete process.env.REPLIT_DEPLOYMENT;
  process.env.KALSHI_API_ENVIRONMENT = "production";
  delete process.env.MICRO_LIVE_PRODUCTION_ENABLED;
  delete process.env.LIVE_EXECUTION_ENABLED;
  process.env.KALSHI_INDEX2_API_KEY_ID = keyId;
  process.env.KALSHI_INDEX2_PRIVATE_KEY = privateKey;
  process.env.KALSHI_INDEX2_KEY_PROVISIONING_ENABLED = "true";
  process.env.PHASE4_ADMIN_USER_ID = "isolated-owner";
  process.env.REPLIT_DEV_DOMAIN = "isolated.example.test";
});

after(() => {
  for (const key of environmentKeys) {
    const previous = previousEnvironment.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

type Attempt = NonNullable<Awaited<ReturnType<FundingAttemptStore["get"]>>>;
type Transfer = {
  transferId: string;
  fromSubaccount: number;
  toSubaccount: number;
  exchangeIndex: number;
  amountCents: number;
  occurredAt: string;
};

function fixture(options: {
  ambiguousPost?: boolean;
  destinationReconciliation?: "funded" | "blocked";
} = {}) {
  const boundary: Record<string, unknown> = {
    state: "KEY_BOUND_VERIFIED",
    subaccountNumber: 1,
    exchangeIndex: 2,
    restrictedApiKeyId: keyId,
    restrictedKeyFingerprint: keyFingerprint,
    keyBoundAt: new Date(Date.now() - 120_000),
    keyBindingEvidenceDigest: "b".repeat(64),
    cleanBalanceMicros: "0",
    cleanBalanceSemantics: "available_cash",
    cleanSnapshotAuthenticated: true,
    cleanOrderCount: 0,
    cleanFillCount: 0,
    cleanPositionCount: 0,
    cleanSettlementCount: 0,
    cleanBoundaryAt: new Date(Date.now() - 60_000),
    cleanBoundaryEvidenceDigest: digest,
    fundingTransferId: null,
    ambiguityFrozenAt: null,
  };
  const config = {
    microLiveRunPhase: "FROZEN",
    manualKillSwitch: true,
    microLiveProductionEnabled: false,
    liveExecutionEnabled: false,
  };
  const live = { manualKillSwitch: true, liveExecutionEnabled: false };
  let attempt: Attempt | null = null;
  let transfer: Transfer | null = null;
  let primaryMicros = "50000000";
  let postCalls = 0;
  let transferReads = 0;
  let destinationReconciliationCalls = 0;

  const store: FundingAttemptStore = {
    async get() { return attempt; },
    async reserve(proof) {
      if (attempt) return null;
      attempt = {
        attemptId: randomUUID(),
        sourceSubaccount: 0,
        destinationSubaccount: 1,
        exchangeIndex: 2,
        amountCents: 2500,
        marketTicker: proof.marketTicker,
        state: "attempted",
        sourceScopedBeforeMicros: proof.primary.scopedMicros,
        sourceInventoryBeforeMicros: proof.primary.inventoryMicros,
        cleanBoundaryDigest: proof.boundaryDigest,
        attemptedAt: new Date(),
        responseReceivedAt: null,
        transferId: null,
        reconciledAt: null,
      } as Attempt;
      return attempt;
    },
    async markResponse(id) {
      assert.equal(attempt?.attemptId, id);
      if (attempt) attempt.state = "response_received";
    },
    async markUncertain(id) {
      assert.equal(attempt?.attemptId, id);
      if (attempt) attempt.state = "uncertain";
    },
    async markReconciled(id, transferId) {
      assert.equal(attempt?.attemptId, id);
      if (attempt) {
        attempt.state = "reconciled";
        attempt.transferId = transferId;
        attempt.reconciledAt = new Date();
      }
    },
  };

  const dependencies: FundingDependencies = {
    store,
    async readPrimary() {
      return {
        scopedMicros: primaryMicros,
        inventoryMicros: primaryMicros,
        observedAt: Date.now(),
        updatedAt: Date.now(),
      };
    },
    async readDestination() {
      return {
        scopedMicros: transfer ? "25000000" : "0",
        inventoryMicros: transfer ? "25000000" : "0",
        observedAt: Date.now(),
        updatedAt: Date.now(),
      };
    },
    async readTransfers() {
      transferReads += 1;
      return transfer ? [transfer] : [];
    },
    async verifyClean() { return undefined as never; },
    async verifyKey() { return true; },
    async verifyTransferKey() { return true; },
    async postTransfer() {
      postCalls += 1;
      primaryMicros = "25000000";
      transfer = {
        transferId: "isolated-transfer-id",
        fromSubaccount: 0,
        toSubaccount: 1,
        exchangeIndex: 2,
        amountCents: 2500,
        occurredAt: new Date().toISOString(),
      };
      if (options.ambiguousPost) throw new Error("simulated lost response");
    },
    async ticker() { return "KXBTC15M-TEST"; },
    async reconcileBoundary(input) {
      destinationReconciliationCalls += 1;
      assert.equal(input.acknowledgedAttemptId, attempt?.attemptId);
      if (options.destinationReconciliation === "blocked") {
        return { status: "blocked", reason: "destination verification did not match" };
      }
      Object.assign(boundary, {
        state: "funded",
        fundingTransferId: transfer?.transferId,
        postFundingBalanceMicros: "25000000",
      });
      return { status: "funded", reason: "isolated destination verification passed" };
    },
    async readState() {
      return {
        boundary: boundary as never,
        config: config as never,
        live: live as never,
      };
    },
  };

  return {
    dependencies,
    store,
    counts: () => ({ postCalls, transferReads, destinationReconciliationCalls }),
    currentAttempt: () => attempt,
  };
}

test("submits and reconciles exactly one $25 transfer, then blocks duplicate submit", async () => {
  const setup = fixture();
  const result = await submitOneShotFunding(setup.dependencies);

  assert.deepEqual(result, {
    state: "funded",
    reason: "Exactly one $25 transfer reconciled; execution remains off",
  });
  assert.equal(setup.currentAttempt()?.amountCents, 2500);
  assert.equal(setup.currentAttempt()?.sourceSubaccount, 0);
  assert.equal(setup.currentAttempt()?.destinationSubaccount, 1);
  assert.equal(setup.currentAttempt()?.exchangeIndex, 2);
  assert.equal(setup.currentAttempt()?.state, "reconciled");
  assert.equal(setup.currentAttempt()?.transferId, "isolated-transfer-id");
  assert.equal(setup.counts().postCalls, 1);

  assert.equal((await submitOneShotFunding(setup.dependencies)).state, "blocked");
  assert.equal(setup.counts().postCalls, 1);
});

test("ambiguous POST is latched and GET-only restart evidence cannot authorize a second POST", async () => {
  const setup = fixture({ ambiguousPost: true });
  assert.equal((await submitOneShotFunding(setup.dependencies)).state, "uncertain");
  assert.equal(setup.currentAttempt()?.state, "uncertain");
  assert.equal(setup.counts().postCalls, 1);
  assert.equal(setup.counts().transferReads, 1);

  const recovered = await reconcileOneShotFunding({ ...setup.dependencies, store: setup.store });
  assert.equal(recovered.state, "uncertain");
  assert.match(recovered.reason, /matching transfer.*client ID/);
  assert.equal(setup.currentAttempt()?.state, "uncertain");
  assert.equal(setup.counts().destinationReconciliationCalls, 0);
  assert.equal(setup.counts().postCalls, 1);
  assert.equal(setup.counts().transferReads, 2);
});

test("acknowledged delayed $25 recovery needs exact cash, unique history and a recorded response", () => {
  const transferredAt = Math.floor((Date.now() - 180_000) / 1000) * 1000;
  const now = Date.now();
  const attempt = {
    state: "response_received",
    responseReceivedAt: new Date(transferredAt + 366),
    attemptedAt: new Date(transferredAt + 323),
    sourceSubaccount: 0,
    destinationSubaccount: 1,
    exchangeIndex: 2,
    amountCents: 2500,
    marketTicker: "KXBTC15M-TEST",
    cleanBoundaryDigest: digest,
    sourceScopedBeforeMicros: "163256700",
    sourceInventoryBeforeMicros: "163256700",
    transferId: null,
    reconciledAt: null,
  } as Attempt;
  const boundary = {
    state: "KEY_BOUND_VERIFIED", cleanBoundaryEvidenceDigest: digest,
    cleanBoundaryAt: new Date(transferredAt - 120_000), ambiguityFrozenAt: null,
  };
  const primary = {
    scopedMicros: "138256700", inventoryMicros: "138256700",
    observedAt: now, updatedAt: transferredAt,
  };
  const destination = {
    scopedMicros: "25000000", inventoryMicros: "25000000",
    observedAt: now, updatedAt: transferredAt,
  };
  const transfer: Transfer = {
    transferId: "isolated-accepted-transfer",
    fromSubaccount: 0, toSubaccount: 1, exchangeIndex: 2,
    amountCents: 2500, occurredAt: new Date(transferredAt).toISOString(),
  };
  assert.equal(
    acknowledgedFundingCashProof(attempt, boundary as never, primary, destination, [transfer], now)
      ?.transferId, transfer.transferId,
  );
  assert.equal(acknowledgedFundingCashProof(
    { ...attempt, state: "uncertain", responseReceivedAt: null },
    boundary as never, primary, destination, [transfer], now,
  ), null);
  assert.equal(acknowledgedFundingCashProof(
    { ...attempt, state: "attempted" }, boundary as never, primary, destination, [transfer], now,
  ), null);
  assert.equal(acknowledgedFundingCashProof(
    attempt, boundary as never, primary, { ...destination, scopedMicros: "24999999" }, [transfer], now,
  ), null);
  assert.equal(acknowledgedFundingCashProof(
    attempt, boundary as never, primary, destination, [transfer, { ...transfer,
      transferId: "unexplained", fromSubaccount: 2, toSubaccount: 1 }], now,
  ), null);
  assert.equal(acknowledgedFundingCashProof(
    attempt, { ...boundary, cleanBoundaryEvidenceDigest: "b".repeat(64) } as never,
    primary, destination, [transfer], now,
  ), null);
});

test("only authenticated delayed acknowledged recovery waives last-change and snapshot age", () => {
  const transferredAt = Math.floor((Date.now() - 180_000) / 1000) * 1000;
  const evidence = {
    scanFinishedAt: new Date().toISOString(),
    records: [
      { feed: "balance", id: "1:2", classification: "pair",
        details: { updated_ts: String(transferredAt / 1000) } },
      { feed: "scoped_balance", id: "query:1:2", classification: "pair",
        details: { portfolio_value: "0" } },
    ],
    collateralSnapshot: {
      availableCashMicros: "25000000", inventoryBalanceMicros: "25000000",
      restingEntryReserveMicros: "0",
    },
    postAnchorCashDeltaMicros: "0",
    recordCounts: { positions: 0, orders: 0, fills: 0, settlements: 0 },
    reasons: [
      "subaccount_inventory_balance_stale",
      "post_funding_25_snapshot_unverified",
      "pre_funding_zero_snapshot_unverified",
      "pre_funding_zero_snapshot_provenance_unverified",
    ],
  };
  assert.equal(recoveryInventoryAndPortfolioClean(evidence as never, transferredAt), true);
  assert.deepEqual(historyReasons(evidence as never, true, true), []);
  assert.ok(historyReasons(evidence as never, true, false).includes(
    "post_funding_25_snapshot_unverified",
  ));
  assert.ok(historyReasons(evidence as never, false, true).includes(
    "subaccount_inventory_balance_stale",
  ));
  assert.ok(historyReasons({
    ...evidence, postAnchorCashDeltaMicros: "1000000",
  } as never, true, true).includes("pair_cash_and_resting_entry_collateral_mismatch"));
  assert.ok(historyReasons({
    ...evidence, reasons: [...evidence.reasons, "unexpected_activity"],
  } as never, true, true).includes("unexpected_activity"));
  assert.equal(recoveryInventoryAndPortfolioClean({
    ...evidence, records: [
      { feed: "balance", id: "1:2", classification: "pair",
        details: { updated_ts: String((transferredAt - 60_000) / 1000) } },
      { feed: "scoped_balance", id: "query:1:2", classification: "pair",
        details: { portfolio_value: "0" } },
    ],
  } as never, transferredAt), false);
  assert.equal(recoveryInventoryAndPortfolioClean({
    ...evidence, recordCounts: { positions: 0, orders: 0, fills: 1, settlements: 0 },
  } as never, transferredAt), false);
});

test("GET-only transfer history parses a nonempty documented page and cursor without client ID or status", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.KALSHI_VERIFIER_API_KEY_ID = "isolated-verifier";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKey.export({
    type: "pkcs8", format: "pem",
  }).toString();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async (input, init) => {
      assert.equal(init?.method, "GET");
      assert.match(String(input), /\/portfolio\/subaccounts\/transfers\?/);
      calls += 1;
      return new Response(JSON.stringify(calls === 1 ? {
        transfers: [{
          transfer_id: "isolated-history-id",
          from_subaccount: 0,
          to_subaccount: 1,
          exchange_index: 2,
          amount_cents: 2500,
          created_ts: Math.floor(Date.now() / 1000),
        }],
        cursor: "next-page",
      } : { transfers: [], cursor: "" }), { status: 200 });
    };
    const history = await readPairTransferHistory();
    assert.equal(calls, 2);
    assert.equal(history.length, 1);
    assert.equal(history[0]?.amountCents, 2500);
    assert.equal(history[0]?.fromSubaccount, 0);
    assert.equal(history[0]?.toSubaccount, 1);
    assert.equal(history[0]?.exchangeIndex, 2);
    assert.ok(Number.isFinite(Date.parse(history[0]!.occurredAt)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("delayed GET-only recovery treats old last-change timestamps as current signed balance reads", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.KALSHI_VERIFIER_API_KEY_ID = "isolated-verifier";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKey.export({
    type: "pkcs8", format: "pem",
  }).toString();
  const originalFetch = globalThis.fetch;
  const changedAt = Math.floor(Date.now() / 1000) - 180;
  try {
    globalThis.fetch = async (input, init) => {
      assert.equal(init?.method, "GET");
      return new Response(JSON.stringify(String(input).includes("/subaccounts/balances") ?
        { subaccount_balances: [{
          subaccount_number: 0, exchange_index: 2, balance: "50.00",
          updated_ts: changedAt,
        }] } :
        { balance_dollars: "50.00", updated_ts: changedAt }), { status: 200 });
    };
    const balance = await readPrimaryIndex2Balance();
    assert.equal(balance.scopedMicros, "50000000");
    assert.equal(balance.inventoryMicros, "50000000");
    assert.ok(Date.now() - balance.observedAt < 5_000);
    assert.ok(Date.now() - balance.updatedAt > 120_000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("owner transfer route rejects wrong amount or destination before submitting", async t => {
  type Layer = {
    handle?: (req: Record<string, unknown>, res: Record<string, unknown>, next: () => void) => unknown;
    route?: {
      path: string;
      methods: Record<string, boolean>;
      stack: Array<{ handle: (req: Record<string, unknown>, res: Record<string, unknown>) => unknown }>;
    };
  };
  for (const [label, override] of [
    ["wrong amount", { amount_cents: "2499" }],
    ["wrong destination", { destination_subaccount: "9" }],
  ] as const) {
    await t.test(label, async () => {
      let submitCalls = 0;
      const router = createPairFundingRouter({
        store: { get: async () => null } as FundingAttemptStore,
        async submit() {
          submitCalls += 1;
          return { state: "funded", reason: "should not be reached" };
        },
        async reconcile() { return { state: "blocked", reason: "unused" }; },
        identity: () => ({ userId: "isolated-owner", sessionId: "isolated-session" }),
      });
      const layers = (router as unknown as { stack: Layer[] }).stack;
      const guard = layers[0]!.handle!;
      const getHandler = layers.find(layer => layer.route?.path === "/" && layer.route.methods.get)!
        .route!.stack[0]!.handle;
      const postHandler = layers.find(layer =>
        layer.route?.path === "/transfer" && layer.route.methods.post)!
        .route!.stack[0]!.handle;

      const makeResponse = () => {
        const res: Record<string, unknown> = {
          locals: {},
          statusCode: 200,
          set() { return res; },
          status(code: number) { res.statusCode = code; return res; },
          type() { return res; },
          send(body: string) { res.body = body; return res; },
        };
        return res;
      };
      const makeRequest = (body?: Record<string, string>) => ({
        body,
        get(name: string) {
          return ({
            origin: "https://isolated.example.test",
            host: "isolated.example.test",
            "x-forwarded-proto": "https",
          } as Record<string, string>)[name.toLowerCase()];
        },
      });

      const getReq = makeRequest();
      const getRes = makeResponse();
      (getReq as Record<string, unknown>).res = getRes;
      let getAllowed = false;
      guard(getReq as Record<string, unknown>, getRes, () => { getAllowed = true; });
      assert.equal(getAllowed, true);
      await getHandler(getReq as Record<string, unknown>, getRes);
      const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(String(getRes.body))?.[1];
      assert.ok(csrf);

      const postReq = makeRequest(Object.assign({
        amount_cents: "2500",
        source_subaccount: "0",
        destination_subaccount: "1",
        exchange_index: "2",
        csrf,
      }, override));
      const postRes = makeResponse();
      (postReq as Record<string, unknown>).res = postRes;
      let postAllowed = false;
      guard(postReq as Record<string, unknown>, postRes, () => { postAllowed = true; });
      assert.equal(postAllowed, true);
      await postHandler(postReq as Record<string, unknown>, postRes);
      assert.equal(postRes.statusCode, 403);
      assert.equal(submitCalls, 0);
    });
  }
});

test("failed destination reconciliation preserves an uncertain one-use attempt", async () => {
  const setup = fixture({ destinationReconciliation: "blocked" });
  const result = await submitOneShotFunding(setup.dependencies);

  assert.equal(result.state, "uncertain");
  assert.match(result.reason, /Destination or activity reconciliation failed/);
  assert.equal(setup.currentAttempt()?.state, "response_received");
  assert.equal(setup.counts().postCalls, 1);
  assert.equal(setup.counts().destinationReconciliationCalls, 1);

  assert.equal((await reconcileOneShotFunding(setup.dependencies)).state, "uncertain");
  assert.equal(setup.counts().postCalls, 1);
});