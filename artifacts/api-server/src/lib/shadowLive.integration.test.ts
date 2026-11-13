import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { and, eq, gte, inArray } from "drizzle-orm";
import {
  db,
  forwardTestEvaluationTable,
  liveExecutionConfigTable,
  liveNotificationEventTable,
  liveProposedOrderTable,
  pool,
} from "@workspace/db";
import {
  calculateShadowContractCount,
  getPhase4State,
  isShadowObserverEnabled,
  recordShadowProposal,
  scanShadowOnce,
  setShadowLimits,
  startShadowObserver,
  stopShadowObserver,
  type ShadowLimitsInput,
} from "./shadowLive";
import { verifyProductionShadowReads } from "./productionShadowPreflight";

const suffix = randomUUID().replaceAll("-", "").slice(0, 14);
if (!/^shadow_test_[a-f0-9]{24}$/.test(process.env.SHADOW_TEST_ISOLATED_SCHEMA ?? "")) {
  throw new Error("Shadow integration tests require a disposable isolated schema");
}
const ticker = `KXBTC15M-SHADOW-TEST-${suffix}`;
const evaluationTicker = `${ticker}-NOCREDS`;
const proposalTicker = `${ticker}-PROPOSAL`;
const truncatedTicker = `${ticker}-TRUNCATED`;
const zeroTicker = `${ticker}-ZERO`;
const originalNodeEnv = process.env.NODE_ENV;
const originalProductionFlag = process.env.SHADOW_LIVE_PRODUCTION_ENABLED;
const originalKalshiEnvironment = process.env.KALSHI_API_ENVIRONMENT;
const originalKeyId = process.env.KALSHI_API_KEY_ID;
const originalPrivateKey = process.env.KALSHI_API_PRIVATE_KEY;
const originalApiKey = process.env.KALSHI_API_KEY;
const originalAccessKeyId = process.env.KALSHI_ACCESS_KEY_ID;
const originalLegacyPrivateKey = process.env.KALSHI_PRIVATE_KEY;
const originalPrivateKeyPem = process.env.KALSHI_PRIVATE_KEY_PEM;
const originalFetch = globalThis.fetch;
let previousConfig: typeof liveExecutionConfigTable.$inferSelect | undefined;
let createdConfig = false;
let configCaptured = false;
const testStartedAt = new Date();

const validLimits: ShadowLimitsInput = {
  liveCapitalLimit: 12,
  liveCapitalRemaining: 10,
  maxStakePerTrade: 5,
  maxDailyLoss: 3,
  maxTotalExperimentLoss: 8,
  maxOpenPositions: 2,
  maxEntryPrice: 0.7,
  maxSlippage: 0.2,
  manualKillSwitch: false,
  mode: "SHADOW_LIVE",
};

async function capturePreviousConfig() {
  if (configCaptured) return;
  const [existing] = await db.select().from(liveExecutionConfigTable)
    .where(eq(liveExecutionConfigTable.id, "singleton")).limit(1);
  previousConfig = existing;
  if (!existing) {
    await db.insert(liveExecutionConfigTable).values({ id: "singleton" }).onConflictDoNothing();
    createdConfig = true;
  }
  configCaptured = true;
}

after(async () => {
  await db.delete(liveProposedOrderTable).where(inArray(liveProposedOrderTable.marketTicker, [
    ticker, evaluationTicker, proposalTicker, truncatedTicker, zeroTicker,
  ]));
  await db.delete(forwardTestEvaluationTable).where(
    inArray(forwardTestEvaluationTable.marketTicker, [ticker, evaluationTicker, proposalTicker, truncatedTicker, zeroTicker]));
  // Leave notifications intact rather than deleting concurrent development events.
  if (previousConfig) {
    const { id: _id, createdAt: _createdAt, ...restore } = previousConfig;
    await db.update(liveExecutionConfigTable).set(restore)
      .where(eq(liveExecutionConfigTable.id, "singleton"));
  } else if (createdConfig) {
    await db.delete(liveExecutionConfigTable).where(eq(liveExecutionConfigTable.id, "singleton"));
  }
  for (const [key, value] of [
    ["NODE_ENV", originalNodeEnv],
    ["SHADOW_LIVE_PRODUCTION_ENABLED", originalProductionFlag],
    ["KALSHI_API_ENVIRONMENT", originalKalshiEnvironment],
    ["KALSHI_API_KEY_ID", originalKeyId],
    ["KALSHI_API_PRIVATE_KEY", originalPrivateKey],
    ["KALSHI_API_KEY", originalApiKey],
    ["KALSHI_ACCESS_KEY_ID", originalAccessKeyId],
    ["KALSHI_PRIVATE_KEY", originalLegacyPrivateKey],
    ["KALSHI_PRIVATE_KEY_PEM", originalPrivateKeyPem],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = originalFetch;
  await pool.end();
});

test("shadow proposals are idempotent for the stable crossing action key", async () => {
  const proposal = {
    id: randomUUID(),
    marketTicker: ticker,
    crossingKey: `cross-${suffix}`,
    triggerType: "SCOUT",
    direction: "UP",
    sourceEvaluationId: `eval-${suffix}`,
    quotePrice: 0.42,
    proposedLimitPrice: 0.42,
    contracts: 1,
    intendedStake: 0.42,
    simulatedRemainingCapital: 24.58,
    status: "PROPOSED",
    riskVerdict: "ALLOW",
    riskReason: "shadow_only; order submission is disabled",
    recordedAt: new Date(Date.now() - 60 * 60_000),
  };
  const inserted = await recordShadowProposal(proposal);
  const duplicate = await recordShadowProposal({ ...proposal, id: randomUUID() });
  assert.ok(inserted);
  assert.equal(duplicate, null);
  const rows = await db.select().from(liveProposedOrderTable)
    .where(eq(liveProposedOrderTable.marketTicker, ticker));
  assert.equal(rows.length, 1);
});

test("contract sizing floors budget and book availability independently", () => {
  assert.equal(calculateShadowContractCount(10, 0.4, 8), 8);
  assert.equal(calculateShadowContractCount(1, 0.4, 8), 2);
  assert.equal(calculateShadowContractCount(10, 0.4, 1.9), 1);
  assert.equal(calculateShadowContractCount(0, 0.4, 8), 0);
});

test("production observer is opt-in and disabled without an exact true flag", async () => {
  process.env.NODE_ENV = "production";
  delete process.env.SHADOW_LIVE_PRODUCTION_ENABLED;
  assert.equal(isShadowObserverEnabled("production", undefined), false);
  assert.equal(isShadowObserverEnabled("production", "TRUE"), false);
  assert.equal(startShadowObserver(), null);
  await assert.rejects(scanShadowOnce(), /not enabled/);
  await assert.rejects(getPhase4State(), /not initialized/);
  const [before] = await db.select().from(liveExecutionConfigTable);
  assert.equal(before, undefined, "production GET must not create the singleton");

  process.env.SHADOW_LIVE_PRODUCTION_ENABLED = "true";
  assert.equal(isShadowObserverEnabled("production", "true"), true);
  assert.ok(startShadowObserver(60_000));
  stopShadowObserver();
  delete process.env.SHADOW_LIVE_PRODUCTION_ENABLED;
  process.env.NODE_ENV = "development";
});

test("production refuses failed GET preflight, then initializes only its $25 shadow budget", async () => {
  process.env.NODE_ENV = "production";
  process.env.SHADOW_LIVE_PRODUCTION_ENABLED = "true";
  process.env.KALSHI_API_ENVIRONMENT = "demo";
  await assert.rejects(scanShadowOnce(), /Production Kalshi environment/);
  const [uninitialized] = await db.select().from(liveExecutionConfigTable);
  assert.equal(uninitialized, undefined, "failed preflight must not initialize configuration");

  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.KALSHI_API_ENVIRONMENT = "production";
  process.env.KALSHI_API_KEY_ID = "shadow-test-only";
  process.env.KALSHI_API_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  await db.insert(forwardTestEvaluationTable).values({
    id: randomUUID(), evaluatedAt: new Date(), marketTicker: ticker,
    btcPrice: 90_000, target: 90_000, signedBuffer: 0, absoluteBuffer: 0,
    feedFreshness: "FRESH", freshCross: false, crossingConsumed: false,
    signal: "PASS", direction: "NONE", qualifyingTrigger: false,
    reason: "preflight market test", positionWasOpen: false,
  });
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method, "GET");
    return { ok: false, status: 401 } as Response;
  }) as typeof fetch;
  await assert.rejects(scanShadowOnce(), /Kalshi request failed/);
  const [afterFailedAuth] = await db.select().from(liveExecutionConfigTable);
  assert.equal(afterFailedAuth, undefined, "failed production authentication cannot create limits");

  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method, "GET");
    const path = new URL(String(input)).pathname;
    requests.push(path);
    const data = path.endsWith("/portfolio/balance") ? { balance: 2500 }
      : path.endsWith("/portfolio/orders") ? { orders: [] }
      : path.endsWith("/portfolio/positions") ? { market_positions: [] }
      : path.endsWith("/portfolio/fills") ? { fills: [] }
      : path.endsWith("/orderbook") ? {
        orderbook_fp: { yes_dollars: [["0.4000", "9"]], no_dollars: [["0.5000", "3"]] },
      } : null;
    assert.ok(data, `Unexpected preflight GET path ${path}`);
    return { ok: true, status: 200, json: async () => data } as Response;
  }) as typeof fetch;
  await verifyProductionShadowReads();
  const [afterReadOnlyPreflight] = await db.select().from(liveExecutionConfigTable);
  assert.equal(afterReadOnlyPreflight, undefined, "GET-only preflight must not initialize limits");
  const beforeEvaluations = await db.select().from(forwardTestEvaluationTable);
  const result = await scanShadowOnce();
  assert.equal(result.skipped, "no_fresh_evaluations");
  assert.equal(requests.length, 5, "preflight must read balance, orders, positions, fills and orderbook");
  const [before] = await db.select().from(liveExecutionConfigTable);
  assert.equal(before?.mode, "SHADOW_LIVE");
  assert.equal(before?.liveExecutionEnabled, false);
  assert.equal(before?.manualKillSwitch, true);
  assert.equal(before?.shadowCapitalLimit, 25);
  assert.equal(before?.shadowCapitalRemaining, 25);
  assert.equal(before?.shadowMaxStakePerTrade, 5);
  assert.equal(before?.shadowMaxOpenPositions, 1);
  assert.equal(before?.shadowMaxTotalLoss, 25);
  assert.equal(before?.liveCapitalLimit, 0);
  assert.equal(before?.maxStakePerTrade, 0);
  const state = await getPhase4State();
  assert.deepEqual(state.proposedOrders.length, 1); // earlier idempotency fixture
  const [afterRead] = await db.select().from(liveExecutionConfigTable);
  assert.deepEqual(afterRead, before);
  const afterEvaluations = await db.select().from(forwardTestEvaluationTable);
  assert.deepEqual(afterEvaluations, beforeEvaluations);
  await db.update(liveExecutionConfigTable).set({ shadowCapitalRemaining: 23.5 })
    .where(eq(liveExecutionConfigTable.id, "singleton"));
  await scanShadowOnce();
  const [afterRestartEquivalent] = await db.select().from(liveExecutionConfigTable);
  assert.equal(afterRestartEquivalent?.shadowCapitalRemaining, 23.5,
    "repeated scans must not replenish previously reserved simulated capital");
  await db.update(liveExecutionConfigTable).set({
    shadowCapitalLimit: 0, shadowCapitalRemaining: 0,
    shadowMaxStakePerTrade: 0, shadowMaxOpenPositions: 0, shadowMaxTotalLoss: 0,
  }).where(eq(liveExecutionConfigTable.id, "singleton"));
  await assert.rejects(scanShadowOnce(), /safety preflight/);
  const [unsafeRow] = await db.select().from(liveExecutionConfigTable);
  assert.equal(unsafeRow?.shadowCapitalLimit, 0, "an existing row is never silently reset");
  await db.update(liveExecutionConfigTable).set({
    shadowCapitalLimit: 25, shadowCapitalRemaining: 23.5,
    shadowMaxStakePerTrade: 5, shadowMaxOpenPositions: 1, shadowMaxTotalLoss: 25,
  }).where(eq(liveExecutionConfigTable.id, "singleton"));
  await db.update(liveExecutionConfigTable).set({ manualKillSwitch: false })
    .where(eq(liveExecutionConfigTable.id, "singleton"));
  await assert.rejects(scanShadowOnce(), /safety preflight/);
  await db.update(liveExecutionConfigTable).set({ manualKillSwitch: true })
    .where(eq(liveExecutionConfigTable.id, "singleton"));
  delete process.env.SHADOW_LIVE_PRODUCTION_ENABLED;
  if (originalKalshiEnvironment === undefined) delete process.env.KALSHI_API_ENVIRONMENT;
  else process.env.KALSHI_API_ENVIRONMENT = originalKalshiEnvironment;
  if (originalKeyId === undefined) delete process.env.KALSHI_API_KEY_ID;
  else process.env.KALSHI_API_KEY_ID = originalKeyId;
  if (originalPrivateKey === undefined) delete process.env.KALSHI_API_PRIVATE_KEY;
  else process.env.KALSHI_API_PRIVATE_KEY = originalPrivateKey;
  globalThis.fetch = originalFetch;
  process.env.NODE_ENV = "development";
});

test("shadow limits validate risk controls and only notify on kill-switch transition", async () => {
  process.env.NODE_ENV = "development";
  await capturePreviousConfig();
  await db.update(liveExecutionConfigTable).set({ manualKillSwitch: false })
    .where(eq(liveExecutionConfigTable.id, "singleton"));
  const killEventsBefore = await db.select().from(liveNotificationEventTable).where(and(
    eq(liveNotificationEventTable.eventType, "KILL"),
    gte(liveNotificationEventTable.createdAt, testStartedAt),
  ));

  const configured = await setShadowLimits(validLimits);
  assert.equal(configured.liveExecutionEnabled, false);
  assert.equal(configured.mode, "SHADOW_LIVE");
  assert.equal(configured.liveCapitalLimit, validLimits.liveCapitalLimit);
  await assert.rejects(setShadowLimits({ ...validLimits, liveCapitalRemaining: 13 }), /must not exceed/);
  await assert.rejects(setShadowLimits({ ...validLimits, maxStakePerTrade: 13 }), /must not exceed/);
  await assert.rejects(setShadowLimits({ ...validLimits, maxOpenPositions: 101 }), /integer between/);
  await assert.rejects(setShadowLimits({ ...validLimits, maxOpenPositions: 1.5 }), /integer between/);
  await assert.rejects(setShadowLimits({ ...validLimits, maxEntryPrice: 1.1 }), /maxEntryPrice/);
  await assert.rejects(setShadowLimits({ ...validLimits, maxSlippage: 1.1 }), /maxSlippage/);
  await assert.rejects(setShadowLimits({ ...validLimits, maxDailyLoss: -1 }), /finite nonnegative/);
  await assert.rejects(setShadowLimits({ ...validLimits, maxTotalExperimentLoss: Number.NaN }), /finite nonnegative/);
  await assert.rejects(setShadowLimits({ ...validLimits, mode: "MICRO_LIVE" as never }), /only PAPER_ONLY or SHADOW_LIVE/);

  const killLimits = { ...validLimits, manualKillSwitch: true };
  await setShadowLimits(killLimits);
  await setShadowLimits(killLimits);
  const killEventsAfter = await db.select().from(liveNotificationEventTable).where(and(
    eq(liveNotificationEventTable.eventType, "KILL"),
    gte(liveNotificationEventTable.createdAt, testStartedAt),
  ));
  assert.equal(killEventsAfter.length - killEventsBefore.length, 1);
});

test("no qualifying trigger records nothing", async () => {
  process.env.NODE_ENV = "development";
  await capturePreviousConfig();
  await setShadowLimits({ ...validLimits, manualKillSwitch: true });
  const result = await scanShadowOnce();
  assert.deepEqual(result, { scanned: 0, recorded: 0, skipped: "no_fresh_evaluations" });
});

test("scan is fail-closed and makes no account calls without credentials", async () => {
  process.env.NODE_ENV = "development";
  delete process.env.KALSHI_API_PRIVATE_KEY;
  delete process.env.KALSHI_API_KEY_ID;
  delete process.env.KALSHI_API_KEY;
  delete process.env.KALSHI_ACCESS_KEY_ID;
  delete process.env.KALSHI_PRIVATE_KEY;
  delete process.env.KALSHI_PRIVATE_KEY_PEM;

  await capturePreviousConfig();
  await db.update(liveExecutionConfigTable).set({
    mode: "SHADOW_LIVE",
    liveExecutionEnabled: false,
    liveCapitalLimit: 0,
    liveCapitalRemaining: 0,
    maxStakePerTrade: 0,
    maxOpenPositions: 0,
    maxEntryPrice: 0,
    manualKillSwitch: false,
  }).where(eq(liveExecutionConfigTable.id, "singleton"));
  await db.insert(forwardTestEvaluationTable).values({
    id: `eval-${suffix}`,
    evaluatedAt: new Date(),
    marketTicker: evaluationTicker,
    btcPrice: 90_000,
    target: 90_000,
    signedBuffer: 0,
    absoluteBuffer: 0,
    feedFreshness: "FRESH",
    freshCross: true,
    crossingConsumed: false,
    crossingKey: `cross-${suffix}`,
    signal: "SCOUT",
    direction: "UP",
    qualifyingTrigger: true,
    reason: "integration test",
    positionWasOpen: false,
  });

  const result = await scanShadowOnce();
  assert.equal(result.skipped, "credentials_not_configured");
  const rows = await db.select().from(liveProposedOrderTable)
    .where(eq(liveProposedOrderTable.marketTicker, evaluationTicker));
  assert.equal(rows.length, 0);
  await db.delete(forwardTestEvaluationTable).where(eq(forwardTestEvaluationTable.marketTicker, evaluationTicker));
});

test("MICRO_LIVE and real execution are independently forbidden by database constraints", async () => {
  await assert.rejects(db.update(liveExecutionConfigTable).set({
    mode: "MICRO_LIVE",
  }).where(eq(liveExecutionConfigTable.id, "singleton")));
  await db.update(liveExecutionConfigTable).set({ manualKillSwitch: true })
    .where(eq(liveExecutionConfigTable.id, "singleton"));
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("MICRO_LIVE must never call Kalshi");
  }) as typeof fetch;
  await assert.rejects(db.update(liveExecutionConfigTable).set({
    liveExecutionEnabled: true,
  }).where(eq(liveExecutionConfigTable.id, "singleton")));
  assert.equal(calls, 0);
  const [config] = await db.select().from(liveExecutionConfigTable);
  assert.equal(config?.mode, "SHADOW_LIVE");
  assert.equal(config?.manualKillSwitch, true);
  assert.equal(config?.liveExecutionEnabled, false);
});

test("shadow-only $25 budget records a real-book proposal with kill on and real-money limits zero", async () => {
  process.env.NODE_ENV = "development";
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.KALSHI_API_KEY_ID = "shadow-test-only";
  process.env.KALSHI_API_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  await capturePreviousConfig();
  await setShadowLimits({
    ...validLimits,
    liveCapitalLimit: 0,
    liveCapitalRemaining: 0,
    maxStakePerTrade: 0,
    maxDailyLoss: 0,
    maxTotalExperimentLoss: 0,
    maxOpenPositions: 0,
    maxEntryPrice: 0,
    maxSlippage: 0,
    manualKillSwitch: true,
  });
  await db.update(liveExecutionConfigTable).set({
    shadowCapitalLimit: 0,
    shadowCapitalRemaining: 0,
    shadowMaxStakePerTrade: 0,
    shadowMaxOpenPositions: 0,
    shadowMaxTotalLoss: 0,
  }).where(eq(liveExecutionConfigTable.id, "singleton"));

  let orderbookRequests = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method, "GET");
    const path = new URL(String(input)).pathname;
    assert.ok(path.endsWith("/orderbook"), `Unexpected Kalshi GET path ${path}`);
    orderbookRequests += 1;
    return { ok: true, status: 200, json: async () => ({
      orderbook_fp: { yes_dollars: [["0.4000", "9"]], no_dollars: [["0.5000", "3"]] },
    }) } as Response;
  }) as typeof fetch;

  await db.insert(forwardTestEvaluationTable).values({
    id: randomUUID(), evaluatedAt: new Date(), marketTicker: zeroTicker,
    btcPrice: 90_000, target: 90_000, signedBuffer: 0, absoluteBuffer: 0,
    feedFreshness: "FRESH", freshCross: true, crossingConsumed: false,
    crossingKey: `cross-${zeroTicker}`, signal: "SCOUT", direction: "UP",
    qualifyingTrigger: true, entryOffer: 0.50, reason: "zero budget test",
    positionWasOpen: false,
  });
  const zeroResult = await scanShadowOnce();
  assert.ok(zeroResult.recorded >= 1);
  const [zeroProposal] = await db.select().from(liveProposedOrderTable)
    .where(eq(liveProposedOrderTable.marketTicker, zeroTicker));
  assert.equal(zeroProposal?.status, "BLOCKED");
  assert.equal(zeroProposal?.intendedStake, 0);
  assert.equal(zeroProposal?.contracts, 0);
  assert.match(zeroProposal?.riskReason ?? "", /shadow_capital_exhausted/);
  const [zeroConfig] = await db.select().from(liveExecutionConfigTable);
  assert.equal(zeroConfig?.shadowCapitalRemaining, 0);

  await db.update(liveExecutionConfigTable).set({
    shadowCapitalLimit: 25, shadowCapitalRemaining: 25,
    shadowMaxStakePerTrade: 5, shadowMaxOpenPositions: 1, shadowMaxTotalLoss: 25,
  }).where(eq(liveExecutionConfigTable.id, "singleton"));

  for (const marketTicker of [proposalTicker, truncatedTicker]) {
    await db.insert(forwardTestEvaluationTable).values({
      id: randomUUID(),
      evaluatedAt: new Date(),
      marketTicker,
      btcPrice: 90_000,
      target: 90_000,
      signedBuffer: 0,
      absoluteBuffer: 0,
      feedFreshness: "FRESH",
      freshCross: true,
      crossingConsumed: false,
      crossingKey: `cross-${marketTicker}`,
      signal: "SCOUT",
      direction: "UP",
      qualifyingTrigger: true,
      entryOffer: 0.50,
      reason: "synthetic shadow test",
      positionWasOpen: false,
    });
    if (marketTicker === proposalTicker) {
      const first = await scanShadowOnce();
      assert.ok(first.recorded >= 1);
      const [proposal] = await db.select().from(liveProposedOrderTable)
        .where(eq(liveProposedOrderTable.marketTicker, proposalTicker));
      assert.equal(proposal?.status, "PROPOSED");
      assert.equal(proposal?.quotePrice, 0.5);
      assert.equal(proposal?.proposedLimitPrice, 0.5);
      assert.equal(proposal?.contracts, 3);
      assert.equal(proposal?.intendedStake, 1.5);
      assert.equal(proposal?.simulatedRemainingCapital, 23.5);
      assert.equal(proposal?.riskVerdict, "ALLOW");
      assert.equal(proposal?.triggerType, "SCOUT");
      assert.equal(proposal?.direction, "UP");
      assert.ok(proposal?.recordedAt);
      const [config] = await db.select().from(liveExecutionConfigTable);
      assert.equal(config?.shadowCapitalRemaining, 23.5);
      assert.equal(config?.liveCapitalRemaining, 0);
      assert.equal(config?.liveExecutionEnabled, false);
      assert.equal(config?.manualKillSwitch, true);
      const requestsAfterFirstScan = orderbookRequests;
      const repeated = await scanShadowOnce();
      assert.equal(repeated.recorded, 0);
      assert.equal(orderbookRequests, requestsAfterFirstScan);
    }
  }

  const blocked = await scanShadowOnce();
  assert.equal(blocked.recorded, 1);
  assert.ok(orderbookRequests >= 1);
  const [blockedProposal] = await db.select().from(liveProposedOrderTable)
    .where(eq(liveProposedOrderTable.marketTicker, truncatedTicker));
  assert.equal(blockedProposal?.status, "BLOCKED");
  assert.match(blockedProposal?.riskReason ?? "", /shadow_open_position_limit_reached/);
  assert.equal(blockedProposal?.simulatedRemainingCapital, 23.5);
  const [config] = await db.select().from(liveExecutionConfigTable);
  assert.equal(config?.shadowCapitalRemaining, 23.5);
});