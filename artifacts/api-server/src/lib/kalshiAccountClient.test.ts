import assert from "node:assert/strict";
import {
  constants as cryptoConstants,
  createVerify,
  generateKeyPairSync,
} from "node:crypto";
import test from "node:test";
import * as kalshiClient from "./kalshiAccountClient";
import {
  KalshiApiError,
  getKalshiCredentialsState,
  readKalshiAccount,
  readKalshiAccountActivity,
  readKalshiDedicatedPairEvidence,
  captureCleanPairSnapshot,
  readKalshiHistoricalFills,
  readKalshiOrderbook,
  readKalshiSettlements,
  readKalshiSubmissionEvidence,
  getConfiguredKalshiSubaccount,
  verifyKalshiTradingKeyRestriction,
  verifyKalshiTradingKeyTradePermission,
  verifyKalshiRestrictedTradingKeyForSubaccount,
} from "./kalshiAccountClient";
import {
  PRE_BOUNDARY_INBOUND_TRANSFER_ID,
  PRE_BOUNDARY_OUTBOUND_TRANSFER_ID,
  provePreBoundaryRoundTrip,
} from "./strata/commissioning";
import {
  reconcilePairCollateralLedger,
  type PairCollateralLocalLedger,
} from "./microLivePairCollateral";

test("submission evidence reads current and historical orders and fills without a mutation", async () => {
  setCredentials();
  const methods: string[] = [];
  const ticker = "KXBTC15M-READONLY";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    methods.push(init?.method ?? "UNKNOWN");
    assert.equal(url.searchParams.get("ticker"), ticker);
    const order = {
      order_id: "matched", client_order_id: "ml-client", ticker,
      side: "yes", action: "buy", type: "limit", status: "executed",
      outcome_side: "yes", book_side: "bid",
      yes_price_dollars: "0.4000", initial_count_fp: "2",
      fill_count_fp: "2", remaining_count_fp: "0",
    };
    const payload = url.pathname.endsWith("/portfolio/orders")
      ? { orders: [{ ...order, order_id: "unrelated", client_order_id: "" }] }
      : url.pathname.endsWith("/historical/orders")
        ? { orders: [order] }
        : url.pathname.endsWith("/portfolio/fills")
          ? { fills: [] }
          : { fills: [{
            trade_id: "matched-fill", order_id: "matched", ticker,
            side: "yes", action: "buy", count_fp: "2",
            outcome_side: "yes", book_side: "bid",
            yes_price_dollars: "0.4000", no_price_dollars: "0.6000", fee_cost: "0.0200",
            created_time: "2026-09-24T12:00:00Z",
          }] };
    return { ok: true, status: 200, json: async () => payload } as Response;
  }) as typeof fetch;
  try {
    const evidence = await readKalshiSubmissionEvidence(ticker);
    assert.equal(evidence.truncated, false);
    assert.equal(evidence.orders[0]?.clientOrderId, null);
    assert.equal(evidence.orders[1]?.clientOrderId, "ml-client");
    assert.equal(evidence.orders[1]?.initialCount, "2");
    assert.equal(evidence.orders[1]?.outcomeSide, "yes");
    assert.equal(evidence.orders[1]?.bookSide, "bid");
    assert.equal(evidence.fills[0]?.feeCostDollars, "0.0200");
    assert.equal(evidence.fills[0]?.yesPriceDollars, "0.4000");
    assert.equal(evidence.fills[0]?.noPriceDollars, "0.6000");
    assert.deepEqual(methods, ["GET", "GET", "GET", "GET"]);
  } finally {
    restoreEnvironment();
  }

});

test("pair collateral reconciles a partial resting buy reserve and one fill fee once", () => {
  const checkedAt = Date.parse("2027-01-15T08:00:00.000Z");
  const evidence = {
    pair: { subaccountNumber: 3, exchangeIndex: 2 },
    balance: {
      subaccountNumber: 3, exchangeIndex: 2, balanceDollars: "23.99",
      availableCashDollars: "22.49", updatedTs: checkedAt / 1000,
    },
    collateralSnapshot: {
      availableCashMicros: "22490000",
      inventoryBalanceMicros: "23990000",
      restingEntryReserveMicros: "1500000",
      restingExitContractsByTicker: {},
      capturedAt: new Date(checkedAt).toISOString(),
    },
    marketExchangeIndex: 2,
    keyRestrictionVerified: true,
    tradePermissionVerified: true,
    reasons: [],
    scanFinishedAt: new Date(checkedAt).toISOString(),
    postAnchorCashDeltaMicros: "-1010000",
    records: [
      {
        feed: "current_order", id: "exchange-order-1",
        classification: "pair", occurredAt: new Date(checkedAt - 1000).toISOString(),
        payloadDigest: "order", details: {
          ticker: "KXBTC15M-COLLATERAL", side: "yes", action: "buy", type: "limit",
          status: "resting", initial_count_fp: "5", fill_count_fp: "2",
          remaining_count_fp: "3", yes_price_dollars: "0.5000",
          client_order_id: "client-1", reduce_only: "false",
        },
      },
      {
        feed: "current_fill", id: "exchange-fill-1",
        classification: "pair", occurredAt: new Date(checkedAt - 1000).toISOString(),
        cashDeltaMicros: "-1010000", payloadDigest: "fill", details: {
          order_id: "exchange-order-1", ticker: "KXBTC15M-COLLATERAL",
          side: "yes", action: "buy", count_fp: "2",
          yes_price_dollars: "0.5000", no_price_dollars: "0.5000",
          fee_cost: "0.010000",
        },
      },
      {
        feed: "position", id: "KXBTC15M-COLLATERAL",
        classification: "pair", occurredAt: new Date(checkedAt).toISOString(),
        payloadDigest: "position", details: {
          ticker: "KXBTC15M-COLLATERAL", position_fp: "2",
          market_exposure_dollars: "1.000000",
        },
      },
    ],
  } as unknown as Parameters<typeof reconcilePairCollateralLedger>[0]["evidence"];
  const local = {
    orders: [{
      id: "local-order-1", actionKey: "a", clientOrderId: "client-1",
      marketTicker: "KXBTC15M-COLLATERAL", crossingKey: "crossing-1",
      triggerType: "SCOUT", action: "buy", intent: "entry",
      positionId: "position-1", exitPositionId: null, side: "UP",
      sourceEvaluationId: "eval", signalAt: new Date(checkedAt - 1000),
      orderType: "LIMIT", requestedLimitPrice: 0.5, requestedContracts: 5,
      requestedStakeCents: 250, reservedRiskCents: 250, microLiveRunId: "run-1",
      reservedEntryFeeMicros: 50000, reservedExitFeeMicros: 50000,
      feeEvidenceFingerprint: "fee", feeEvidenceVerifiedAt: new Date(checkedAt - 2000),
      exchangeOrderId: "exchange-order-1", status: "partial",
      filledContracts: 2, remainingContracts: 3,
    }],
    fills: [{
      id: "local-fill-1", orderId: "local-order-1",
      exchangeFillId: "exchange-fill-1", exchangeOrderId: "exchange-order-1",
      filledAt: new Date(checkedAt - 1000), contracts: 2, fillPrice: 0.5,
      action: "buy", positionId: "position-1", costCents: 100,
      feeCents: 1, feeKnown: true, tradeMicros: 1000000, feeMicros: 10000,
    }],
    settlements: [],
  } as unknown as PairCollateralLocalLedger;
  const input = {
    evidence, local, subaccountNumber: 3, runId: "run-1",
    baselineCashMicros: "25000000", now: checkedAt,
  };
  const result = reconcilePairCollateralLedger(input);
  assert.equal(result.status, "verified");
  assert.equal(result.expectedAvailableCashMicros, "22490000");
  assert.equal(result.restingEntryReserveMicros, "1500000");
  assert.equal(result.filledBuyExposureMicros, "1000000");
  assert.equal(result.reconciledFeeMicros, "10000");
  assert.equal(result.restingEntryOrderCount, 1);
  assert.equal(result.terminalOrderCount, 0);

  const unverifiedExitFlag = structuredClone(evidence) as typeof evidence;
  const orderRecord = unverifiedExitFlag.records!.find((record) =>
    record.feed === "current_order")!;
  orderRecord.details.reduce_only = null;
  const blocked = reconcilePairCollateralLedger({ ...input, evidence: unverifiedExitFlag });
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.reason, /reduce_only/);
});

test("authenticated pair evidence exports exact partial-order collateral fields", async () => {
  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "2";
  process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key-id";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKeyPem;
  const fixture = dedicatedPairFixture({
    balance: "23.990000",
    availableCash: "22.490000",
    currentOrders: [{
      order_id: "pair-resting", client_order_id: "pair-client",
      ticker: "KXBTC15M", subaccount_number: 2, exchange_index: 2,
      side: "yes", action: "buy", type: "limit", status: "resting",
      initial_count_fp: "5", fill_count_fp: "2", remaining_count_fp: "3",
      yes_price_dollars: "0.500000", reduce_only: false,
      created_time: new Date((Math.floor(Date.now() / 1000) - 8) * 1000).toISOString(),
    }],
    currentFills: [{
      trade_id: "pair-fill", order_id: "pair-resting", ticker: "KXBTC15M",
      subaccount_number: 2, exchange_index: 2, side: "yes", action: "buy",
      count_fp: "2", yes_price_dollars: "0.500000", no_price_dollars: "0.500000",
      fee_cost: "0.010000",
      created_time: new Date(Date.now() - 8_000).toISOString(),
    }],
    positions: [{
      ticker: "KXBTC15M", subaccount_number: 2, exchange_index: 2,
      position_fp: "2", market_exposure_dollars: "1.000000",
    }],
  });
  globalThis.fetch = fixture.fetcher;
  try {
    const evidence = await readKalshiDedicatedPairEvidence(
      2, "KXBTC15M", fixture.anchor,
    );
    assert.equal(evidence.collateralSnapshot?.availableCashMicros, "22490000");
    assert.equal(evidence.collateralSnapshot?.inventoryBalanceMicros, "23990000");
    assert.equal(evidence.collateralSnapshot?.restingEntryReserveMicros, "1500000");
    assert.equal(evidence.postAnchorCashDeltaMicros, "-1010000");
    assert.ok(!evidence.reasons?.some((reason) =>
      reason.startsWith("pair_order_") || reason.startsWith("pair_entry_")));
  } finally {
    restoreEnvironment();
  }
});

test("market evidence pages all four ticker-scoped sources and flags unfinished history", async () => {
  setCredentials();
  const ticker = "KXBTC15M-MARKET-PAGES";
  const order = {
    order_id: "owned-order", client_order_id: "owned-client", ticker,
    side: "yes", action: "buy", type: "limit", status: "executed",
    yes_price_dollars: "0.4000", initial_count_fp: "2",
    fill_count_fp: "2", remaining_count_fp: "0",
  };
  const fill = {
    trade_id: "owned-fill", order_id: order.order_id, ticker,
    side: "yes", action: "buy", count_fp: "2",
    yes_price_dollars: "0.4000", fee_cost: "0.020000",
    created_time: "2026-09-24T12:00:00Z",
  };
  let loopHistory = false;
  const paths = new Map<string, Set<string>>();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method, "GET");
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("ticker"), ticker);
    const cursor = url.searchParams.get("cursor");
    const seen = paths.get(url.pathname) ?? new Set<string>();
    seen.add(cursor ?? "first");
    paths.set(url.pathname, seen);
    const isOrder = url.pathname.endsWith("/orders");
    const payload = cursor === null
      ? { [isOrder ? "orders" : "fills"]: [], cursor: "p2" }
      : {
        [isOrder ? "orders" : "fills"]: [isOrder ? order : fill],
        cursor: loopHistory && url.pathname.endsWith("/historical/fills") ? "p2" : null,
      };
    return { ok: true, status: 200, json: async () => payload } as Response;
  }) as typeof fetch;
  try {
    const complete = await readKalshiSubmissionEvidence(ticker);
    assert.equal(complete.truncated, false);
    assert.equal(complete.historicalFillsAvailable, true);
    assert.equal(complete.orders.length, 2, "current/historical overlap is retained for ownership dedup");
    assert.equal(complete.fills.length, 1, "the same fill on both endpoints counts once");
    assert.equal(paths.size, 4);
    assert.ok([...paths.values()].every((seen) =>
      seen.has("first") && seen.has("p2")));
    loopHistory = true;
    assert.equal((await readKalshiSubmissionEvidence(ticker)).truncated, true);
  } finally {
    restoreEnvironment();
  }
});

test("historical fills 404 is explicit, not proof that an order had no fills", async () => {
  setCredentials();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method, "GET");
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/historical/fills")) {
      return { ok: false, status: 404 } as Response;
    }
    const result = path.endsWith("/orders") ? { orders: [] } : { fills: [] };
    return { ok: true, status: 200, json: async () => result } as Response;
  }) as typeof fetch;
  try {
    const evidence = await readKalshiSubmissionEvidence("KXBTC15M-READONLY");
    assert.equal(evidence.historicalFillsAvailable, false);
    assert.equal(evidence.truncated, false);
    assert.deepEqual(evidence.fills, []);
  } finally {
    restoreEnvironment();
  }
});

test("NO exit overlap promotes equivalent precision and canonical fields, not conflicting prices", async () => {
  setCredentials();
  const ticker = "KXBTC15M-NO-FILL-OVERLAP";
  let conflict = false;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method, "GET");
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("ticker"), ticker);
    const historical = url.pathname.includes("/historical/");
    const order = {
      order_id: "no-sell", client_order_id: "owned", ticker,
      side: "no", action: "sell", type: "limit", status: "executed",
      no_price_dollars: "0.8500", initial_count_fp: "2",
      fill_count_fp: "2", remaining_count_fp: "0",
      ...(historical ? { outcome_side: "yes", book_side: "bid" } : {}),
    };
    const fill = {
      trade_id: "same-fill", order_id: "no-sell", ticker,
      side: "yes", action: "sell", count_fp: "2",
      yes_price_dollars: historical ? "0.1300" : "0.13",
      no_price_dollars: historical ? conflict ? "0.8600" : "0.8700" : "0.87",
      fee_cost: "0.001200", created_time: "2026-09-24T12:00:00Z",
      ...(historical ? { outcome_side: "yes", book_side: "bid" } : {}),
    };
    return { ok: true, status: 200, json: async () =>
      url.pathname.endsWith("/orders") ? { orders: [order] } : { fills: [fill] } } as Response;
  }) as typeof fetch;
  try {
    const evidence = await readKalshiSubmissionEvidence(ticker);
    assert.equal(evidence.truncated, false);
    assert.equal(evidence.fills.length, 1);
    assert.equal(evidence.fills[0]?.priceDollars, "0.13");
    assert.equal(evidence.fills[0]?.noPriceDollars, "0.87");
    assert.equal(evidence.fills[0]?.outcomeSide, "yes");
    assert.equal(evidence.fills[0]?.bookSide, "bid");
    conflict = true;
    await assert.rejects(readKalshiSubmissionEvidence(ticker),
      (error: unknown) => error instanceof kalshiClient.KalshiApiError &&
        error.type === "INVALID_RESPONSE");
  } finally {
    restoreEnvironment();
  }
});

test("generic NO fill price remains visible when only the opposite named quote exists", async () => {
  setCredentials();
  const ticker = "KXBTC15M-INCOMPLETE-PRICE-PAIR";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method, "GET");
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("ticker"), ticker);
    const fills = url.pathname.endsWith("/portfolio/fills")
      ? [{
        trade_id: "incomplete-price-fill", order_id: "no-sell", ticker,
        side: "no", action: "sell", outcome_side: "yes", book_side: "bid",
        count_fp: "2", price_dollars: "0.85",
        yes_price_dollars: "0.13", fee_cost: "0.001200",
        created_time: "2026-09-24T12:00:00Z",
      }] : [];
    return { ok: true, status: 200, json: async () =>
      url.pathname.endsWith("/orders") ? { orders: [] } : { fills } } as Response;
  }) as typeof fetch;
  try {
    const evidence = await readKalshiSubmissionEvidence(ticker);
    assert.equal(evidence.fills[0]?.priceDollars, "0.85");
    assert.equal(evidence.fills[0]?.yesPriceDollars, "0.13");
    assert.equal(evidence.fills[0]?.noPriceDollars, null);
  } finally {
    restoreEnvironment();
  }
});

test("historical fill reader uses authenticated ticker-scoped GETs and marks 404 or truncation", async () => {
  setCredentials();
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url, init: init ?? {} });
    if (url.searchParams.get("ticker") === "KXBTC15M-404") {
      return { ok: false, status: 404 } as Response;
    }
    return {
      ok: true, status: 200,
      json: async () => ({
        fills: [{
          trade_id: "historic-fill", order_id: "historic-order", ticker: "KXBTC15M-HIST",
          side: "yes", action: "buy", count_fp: "2", yes_price_dollars: "0.4",
          created_time: "2026-09-24T12:00:00Z",
        }],
        cursor: "repeat",
      }),
    } as Response;
  }) as typeof fetch;
  try {
    const result = await readKalshiHistoricalFills(["KXBTC15M-HIST", "KXBTC15M-404"]);
    assert.equal(result.available, false);
    assert.equal(result.truncated, true);
    assert.equal(result.fills.length, 1, "cursor-loop duplicate is suppressed but incomplete");
    assert.ok(requests.every(({ init }) => init.method === "GET"));
    for (const { url, init } of requests) {
      assert.equal(url.pathname, "/trade-api/v2/historical/fills");
      assert.ok(url.searchParams.get("ticker"));
      const headers = init.headers as Record<string, string>;
      assert.equal(headers["KALSHI-ACCESS-KEY"], "test-key-id");
      const verifier = createVerify("sha256");
      verifier.update(`${headers["KALSHI-ACCESS-TIMESTAMP"]}GET${url.pathname}`);
      verifier.end();
      assert.equal(verifier.verify({
        key: publicKey, padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: 32,
      }, Buffer.from(headers["KALSHI-ACCESS-SIGNATURE"], "base64")), true);
    }
    assert.ok(requests.some(({ url }) => url.searchParams.get("cursor") === "repeat"));
  } finally {
    restoreEnvironment();
  }
});

test("submission evidence rejects immutable-field conflicts across current and historical fills", async () => {
  setCredentials();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const fill = {
      trade_id: "overlap", order_id: "order", ticker: "KXBTC15M-OVERLAP",
      side: "yes", action: "buy", count_fp: path.endsWith("/historical/fills") ? "2" : "1",
      yes_price_dollars: "0.4", created_time: "2026-09-24T12:00:00Z",
    };
    return { ok: true, status: 200, json: async () =>
      path.endsWith("/orders") ? { orders: [] } : { fills: [fill] } } as Response;
  }) as typeof fetch;
  try {
    await assert.rejects(
      readKalshiSubmissionEvidence("KXBTC15M-OVERLAP"),
      /INVALID_RESPONSE/,
    );
  } finally {
    restoreEnvironment();
  }
});

test("submission fill merge promotes unknown fees only when overlap agrees", async () => {
  setCredentials();
  let historicalFee = "0.0200";
  let currentFee: string | null = null;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    const fill = {
      trade_id: "fee-overlap", order_id: "order", ticker: "KXBTC15M-FEE",
      side: "yes", action: "buy", count_fp: "2", yes_price_dollars: "0.4",
      created_time: "2026-09-24T12:00:00Z",
      ...(path.endsWith("/historical/fills")
        ? { fee_cost: historicalFee }
        : currentFee === null ? {} : { fee_cost: currentFee }),
    };
    return { ok: true, status: 200, json: async () =>
      path.endsWith("/orders") ? { orders: [] } : { fills: [fill] } } as Response;
  }) as typeof fetch;
  try {
    const evidence = await readKalshiSubmissionEvidence("KXBTC15M-FEE");
    assert.equal(evidence.fills.length, 1);
    assert.equal(evidence.fills[0]?.feeCostDollars, "0.0200");
    assert.equal(evidence.historicalFills?.[0]?.feeCostDollars, "0.0200");

    currentFee = "0.0200";
    historicalFee = "0.0300";
    await assert.rejects(
      readKalshiSubmissionEvidence("KXBTC15M-FEE"),
      /INVALID_RESPONSE/,
    );
  } finally {
    restoreEnvironment();
  }
});

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const originalFetch = globalThis.fetch;
const originalEnvironment = {
  keyId: process.env.KALSHI_API_KEY_ID,
  privateKey: process.env.KALSHI_API_PRIVATE_KEY,
  environment: process.env.KALSHI_API_ENVIRONMENT,
  subaccount: process.env.KALSHI_BOT_SUBACCOUNT,
  verifierKeyId: process.env.KALSHI_VERIFIER_API_KEY_ID,
  verifierPrivateKey: process.env.KALSHI_VERIFIER_API_PRIVATE_KEY,
};

function setCredentials() {
  process.env.KALSHI_API_KEY_ID = "test-key-id";
  process.env.KALSHI_API_PRIVATE_KEY = privateKeyPem;
  process.env.KALSHI_BOT_SUBACCOUNT = "1";
  delete process.env.KALSHI_VERIFIER_API_KEY_ID;
  delete process.env.KALSHI_VERIFIER_API_PRIVATE_KEY;
  delete process.env.KALSHI_API_ENVIRONMENT;
}

function restoreEnvironment() {
  if (originalEnvironment.keyId === undefined) delete process.env.KALSHI_API_KEY_ID;
  else process.env.KALSHI_API_KEY_ID = originalEnvironment.keyId;
  if (originalEnvironment.privateKey === undefined) delete process.env.KALSHI_API_PRIVATE_KEY;
  else process.env.KALSHI_API_PRIVATE_KEY = originalEnvironment.privateKey;
  if (originalEnvironment.environment === undefined) delete process.env.KALSHI_API_ENVIRONMENT;
  else process.env.KALSHI_API_ENVIRONMENT = originalEnvironment.environment;
  if (originalEnvironment.subaccount === undefined) delete process.env.KALSHI_BOT_SUBACCOUNT;
  else process.env.KALSHI_BOT_SUBACCOUNT = originalEnvironment.subaccount;
  if (originalEnvironment.verifierKeyId === undefined) delete process.env.KALSHI_VERIFIER_API_KEY_ID;
  else process.env.KALSHI_VERIFIER_API_KEY_ID = originalEnvironment.verifierKeyId;
  if (originalEnvironment.verifierPrivateKey === undefined) delete process.env.KALSHI_VERIFIER_API_PRIVATE_KEY;
  else process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = originalEnvironment.verifierPrivateKey;
  globalThis.fetch = originalFetch;
}

function dedicatedPairFixture(overrides: {
  balance?: string;
  availableCash?: string;
  currentOrders?: unknown[];
  currentFills?: unknown[];
  historicalFills?: unknown[];
  positions?: unknown[];
  historicalOrders?: unknown[];
  settlements?: unknown[];
  transfers?: unknown[];
  crossTransfers?: unknown[];
  omitAvailableCash?: boolean;
  omitAnchorStatus?: boolean;
  loopHistoricalOrders?: boolean;
} = {}) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const anchorSeconds = nowSeconds - 20;
  const baselineSeconds = nowSeconds - 10;
  const anchor = {
    transferId: "funding-25",
    transferredAt: new Date(anchorSeconds * 1000).toISOString(),
    amountCents: 2500 as const,
    baselineCashMicros: "25000000" as const,
    baselineAt: new Date(baselineSeconds * 1000).toISOString(),
    preFundingZeroSnapshot: {
      availableCashMicros: "0" as const,
      capturedAt: new Date((anchorSeconds - 5) * 1000).toISOString(),
      evidenceDigest: "a".repeat(64),
      authenticated: true as const,
      balanceSemantics: "available_cash" as const,
    },
    postFundingSnapshot: {
      availableCashMicros: "25000000" as const,
      capturedAt: new Date(baselineSeconds * 1000).toISOString(),
      evidenceDigest: "b".repeat(64),
      authenticated: true as const,
      balanceSemantics: "available_cash" as const,
    },
  };
  const baseTransfers = [{
    transfer_id: "funding-25",
    from_subaccount: 0,
    to_subaccount: 2,
    exchange_index: 2,
    amount_cents: 2500,
    created_ts: anchorSeconds,
    status: overrides.omitAnchorStatus ? undefined : "completed",
  }];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method, "GET");
    const url = new URL(String(input));
    const headers = init?.headers as Record<string, string>;
    if (url.pathname.endsWith("/api_keys")) {
      return {
        ok: true, status: 200,
        json: async () => ({
          api_keys: [{
            api_key_id: "test-key-id", subaccount: 2, scopes: ["read", "write::trade"],
          }],
        }),
      } as Response;
    }
    if (url.pathname.endsWith("/portfolio/balance")) {
      assert.equal(headers["KALSHI-ACCESS-KEY"], "test-key-id");
      assert.equal(url.searchParams.get("subaccount"), "2");
      assert.equal(url.searchParams.get("exchange_index"), "2");
      return {
        ok: true, status: 200,
        json: async () => ({
          ...(overrides.omitAvailableCash ? {} : {
            balance_dollars: overrides.availableCash ?? overrides.balance ?? "25.000000",
          }),
          ...(overrides.omitAvailableCash ? {
            balance_breakdown: [{ exchange_index: 2, balance_dollars: "25.000000" }],
          } : {}),
          updated_ts: nowSeconds,
        }),
      } as Response;
    }
    if (url.pathname.endsWith("/subaccounts/balances")) {
      return {
        ok: true, status: 200,
        json: async () => ({
          subaccount_balances: [
            {
              subaccount_number: 2, exchange_index: 2,
              balance: overrides.balance ?? "25.000000",
              updated_ts: nowSeconds,
            },
            {
              subaccount_number: 2, exchange_index: 0, balance: "7.000000",
              updated_ts: nowSeconds,
            },
            {
              subaccount_number: 3, exchange_index: 2, balance: "9.000000",
              updated_ts: nowSeconds,
            },
          ],
        }),
      } as Response;
    }
    if (url.pathname.endsWith("/subaccounts/transfers")) {
      return {
        ok: true, status: 200,
        json: async () => ({ transfers: overrides.transfers ?? baseTransfers }),
      } as Response;
    }
    if (url.pathname.endsWith("/intra_exchange_instance_transfers")) {
      return {
        ok: true, status: 200,
        json: async () => ({ transfers: overrides.crossTransfers ?? [] }),
      } as Response;
    }
    if (url.pathname.endsWith("/markets/KXBTC15M")) {
      return {
        ok: true, status: 200,
        json: async () => ({ market: { ticker: "KXBTC15M", exchange_index: 2 } }),
      } as Response;
    }
    if (url.pathname.endsWith("/historical/orders")) {
      if (overrides.loopHistoricalOrders) {
        return {
          ok: true, status: 200,
          json: async () => ({ orders: [], cursor: "repeat-cursor" }),
        } as Response;
      }
      return {
        ok: true, status: 200,
        json: async () => ({ orders: overrides.historicalOrders ?? [] }),
      } as Response;
    }
    if (url.pathname.endsWith("/portfolio/fills")) {
      return {
        ok: true, status: 200,
        json: async () => ({ fills: overrides.currentFills ?? [] }),
      } as Response;
    }
    if (url.pathname.endsWith("/historical/fills")) {
      return {
        ok: true, status: 200,
        json: async () => ({ fills: overrides.historicalFills ?? [] }),
      } as Response;
    }
    if (url.pathname.endsWith("/portfolio/positions")) {
      return {
        ok: true, status: 200,
        json: async () => ({
          market_positions: overrides.positions ?? [{
            ticker: "KXBTC15M", subaccount_number: 2, exchange_index: 2,
            position_fp: "0", market_exposure_dollars: "0",
          }],
        }),
      } as Response;
    }
    if (url.pathname.endsWith("/portfolio/settlements")) {
      return {
        ok: true, status: 200,
        json: async () => ({ settlements: overrides.settlements ?? [] }),
      } as Response;
    }
    if (url.pathname.endsWith("/portfolio/orders")) {
      return {
        ok: true, status: 200,
        json: async () => ({ orders: overrides.currentOrders ?? [] }),
      } as Response;
    }
    assert.fail(`unexpected evidence request ${url.pathname}`);
  }) as typeof fetch;
  return { anchor, fetcher, nowSeconds, baselineSeconds };
}

function cleanPairFixture(overrides: {
  availableCash?: string;
  inventoryCash?: string;
  positions?: unknown[];
  currentOrders?: unknown[];
  historicalOrders?: unknown[];
  currentFills?: unknown[];
  historicalFills?: unknown[];
  settlements?: unknown[];
  transfers?: unknown[];
  crossTransfers?: unknown[];
  keySubaccount?: number;
  marketShard?: number;
  pageHistoricalOrders?: boolean;
  loopHistoricalOrders?: boolean;
  historicalFillsUnavailable?: boolean;
  creationBoundary?: boolean;
  inventoryAgeSeconds?: number;
  subaccount?: number;
} = {}) {
  const pairSubaccount = overrides.subaccount ?? 7;
  const pairSubaccountText = String(pairSubaccount);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const requests: Array<{ url: URL; keyId: string; method: string }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = init?.headers as Record<string, string>;
    const keyId = headers["KALSHI-ACCESS-KEY"]!;
    requests.push({ url, keyId, method: init?.method ?? "UNKNOWN" });
    assert.equal(init?.method, "GET");
    if (url.pathname.endsWith("/api_keys")) {
      assert.equal(keyId, "verifier-key-id");
      return {
        ok: true, status: 200,
        json: async () => ({
          api_keys: [{
            api_key_id: "test-key-id",
            subaccount: overrides.keySubaccount ?? 7,
            scopes: ["read", "write::trade"],
          }],
        }),
      } as Response;
    }
    if (url.pathname.endsWith("/portfolio/balance")) {
      assert.equal(keyId, overrides.creationBoundary ? "verifier-key-id" : "test-key-id");
      assert.equal(url.searchParams.get("subaccount"), pairSubaccountText);
      assert.equal(url.searchParams.get("exchange_index"), "2");
      const signature = createVerify("sha256");
      const timestamp = headers["KALSHI-ACCESS-TIMESTAMP"]!;
      signature.update(`${timestamp}GET${url.pathname}`);
      signature.end();
      assert.equal(signature.verify({
        key: publicKey,
        padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
        saltLength: 32,
      }, Buffer.from(headers["KALSHI-ACCESS-SIGNATURE"]!, "base64")), true);
      return {
        ok: true, status: 200,
        json: async () => ({
          balance_dollars: overrides.availableCash ?? "0.0000",
          portfolio_value: "0.0000",
          updated_ts: nowSeconds,
        }),
      } as Response;
    }
    if (url.pathname.endsWith("/subaccounts/balances")) {
      assert.equal(keyId, "verifier-key-id");
      return {
        ok: true, status: 200,
        json: async () => ({
          subaccount_balances: [
            {
              subaccount_number: pairSubaccount, exchange_index: 2,
              balance: overrides.inventoryCash ?? "0.0000",
              updated_ts: nowSeconds - (overrides.inventoryAgeSeconds ?? 0),
            },
            { subaccount_number: pairSubaccount, exchange_index: 0, balance: "4.0000",
              updated_ts: nowSeconds },
            { subaccount_number: 8, exchange_index: 2, balance: "9.0000",
              updated_ts: nowSeconds },
          ],
        }),
      } as Response;
    }
    if (url.pathname.endsWith("/subaccounts/transfers")) {
      assert.equal(keyId, "verifier-key-id");
      return {
        ok: true, status: 200,
        json: async () => ({ transfers: overrides.transfers ?? [] }),
      } as Response;
    }
    if (url.pathname.endsWith("/intra_exchange_instance_transfers")) {
      assert.equal(keyId, "verifier-key-id");
      return {
        ok: true, status: 200,
        json: async () => ({ transfers: overrides.crossTransfers ?? [] }),
      } as Response;
    }
    if (url.pathname.endsWith("/markets/KXBTC15M")) {
      assert.equal(keyId, overrides.creationBoundary ? "verifier-key-id" : "test-key-id");
      return {
        ok: true, status: 200,
        json: async () => ({
          market: { ticker: "KXBTC15M", exchange_index: overrides.marketShard ?? 2 },
        }),
      } as Response;
    }
    if (url.pathname.includes("/historical/fills") &&
        overrides.historicalFillsUnavailable) {
      return { ok: false, status: 404 } as Response;
    }
    const feed: Record<string, { key: string; rows: unknown[] }> = {
      "/portfolio/positions": {
        key: "market_positions", rows: overrides.positions ?? [],
      },
      "/portfolio/orders": { key: "orders", rows: overrides.currentOrders ?? [] },
      "/historical/orders": { key: "orders", rows: overrides.historicalOrders ?? [] },
      "/portfolio/fills": { key: "fills", rows: overrides.currentFills ?? [] },
      "/historical/fills": { key: "fills", rows: overrides.historicalFills ?? [] },
      "/portfolio/settlements": { key: "settlements", rows: overrides.settlements ?? [] },
    };
    const matched = Object.entries(feed).find(([suffix]) => url.pathname.endsWith(suffix));
    assert.ok(matched, `unexpected clean-boundary request ${url.pathname}`);
    const [suffix, item] = matched;
    const needsPairQuery = suffix.startsWith("/portfolio/");
    if (needsPairQuery) {
      assert.equal(url.searchParams.get("subaccount"), pairSubaccountText);
      assert.equal(url.searchParams.get("exchange_index"),
        suffix.endsWith("/settlements") ? null : "2");
    } else {
      assert.equal(url.searchParams.get("subaccount"), pairSubaccountText);
    }
    const cursor = url.searchParams.get("cursor");
    if (suffix === "/historical/orders" && overrides.loopHistoricalOrders) {
      return {
        ok: true, status: 200,
        json: async () => ({ [item.key]: [], cursor: "loop" }),
      } as Response;
    }
    if (suffix === "/historical/orders" && overrides.pageHistoricalOrders) {
      return {
        ok: true, status: 200,
        json: async () => ({
          [item.key]: cursor === "next" ? [] : item.rows,
          cursor: cursor === "next" ? null : "next",
        }),
      } as Response;
    }
    return { ok: true, status: 200, json: async () =>
      ({ [item.key]: item.rows }) } as Response;
  }) as typeof fetch;
  return { fetcher, requests };
}

test("credentials state is explicit and missing credentials fail without requesting", async () => {
  delete process.env.KALSHI_API_KEY_ID;
  delete process.env.KALSHI_API_PRIVATE_KEY;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    throw new Error("should not call");
  }) as typeof fetch;
  try {
    assert.equal(getKalshiCredentialsState(), "NOT_CONFIGURED");
    await assert.rejects(readKalshiAccount(), /NOT_CONFIGURED/);
    assert.equal(called, false);
  } finally {
    restoreEnvironment();
  }
});

test("configured bot subaccount must be an explicitly configured integer from 0 through 63", () => {
  const previous = process.env.KALSHI_BOT_SUBACCOUNT;
  try {
    for (const invalid of [undefined, "", "64", "1.5", "-1", "1x", "1e1"]) {
      if (invalid === undefined) delete process.env.KALSHI_BOT_SUBACCOUNT;
      else process.env.KALSHI_BOT_SUBACCOUNT = invalid;
      assert.throws(() => getConfiguredKalshiSubaccount(), /NOT_CONFIGURED|INVALID_CREDENTIALS/);
    }
    for (const valid of ["0", "1", "63"]) {
      process.env.KALSHI_BOT_SUBACCOUNT = valid;
      assert.equal(getConfiguredKalshiSubaccount(), Number(valid));
    }
  } finally {
    if (previous === undefined) delete process.env.KALSHI_BOT_SUBACCOUNT;
    else process.env.KALSHI_BOT_SUBACCOUNT = previous;
  }
});

test("primary account activity is GET-only with readable history and separate fail-closed trade proof", async () => {
  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "0";
  const requests: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method, "GET");
    const url = new URL(String(input));
    requests.push(url);
    const payload = url.pathname.endsWith("/orders") ? { orders: [] } : { fills: [] };
    return { ok: true, status: 200, json: async () => payload } as Response;
  }) as typeof fetch;
  try {
    const activity = await readKalshiAccountActivity();
    assert.equal(activity.selectedSubaccount, 0);
    assert.equal(activity.available, true);
    assert.equal(activity.keyRestrictionVerified, false);
    assert.equal(activity.tradePermissionVerified, false,
      "missing verifier metadata is not mutation authorization");
    assert.equal(activity.exclusiveControlVerified, false);
    assert.ok(requests.length >= 4);
    assert.ok(requests.every((url) => url.searchParams.get("subaccount") === "0"));

    process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key-id";
    process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKeyPem;
    let record: unknown = {
      api_key_id: "test-key-id", subaccount: 0, scopes: ["read", "write::trade"],
    };
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/trade-api/v2/api_keys");
      assert.equal(init?.method, "GET");
      return {
        ok: true, status: 200,
        json: async () => ({ api_keys: record === null ? [] : [record] }),
      } as Response;
    }) as typeof fetch;
    assert.equal(await verifyKalshiTradingKeyTradePermission(), true);
    assert.equal(await verifyKalshiTradingKeyRestriction(), false,
      "primary trade permission is distinct from numbered subaccount restriction");
    record = { api_key_id: "test-key-id", scopes: ["read", "write::trade"] };
    assert.equal(await verifyKalshiTradingKeyTradePermission(), true,
      "documented omission means unrestricted access to primary");
    record = { api_key_id: "test-key-id", subaccount: null, scopes: ["read", "write::trade"] };
    assert.equal(await verifyKalshiTradingKeyTradePermission(), true);
    for (const invalid of [1, 63, -1, "0", undefined, {}]) {
      record = { api_key_id: "test-key-id", subaccount: invalid, scopes: ["read", "write::trade"] };
      assert.equal(await verifyKalshiTradingKeyTradePermission(), false,
        "only null, omission, or numeric 0 can authorize the primary account");
    }
    record = { api_key_id: "test-key-id", scopes: ["read", "write::trade", 1] };
    assert.equal(await verifyKalshiTradingKeyTradePermission(), false,
      "malformed scopes are not permission proof");
    record = { api_key_id: "test-key-id", subaccount: 0, scopes: ["read"] };
    assert.equal(await verifyKalshiTradingKeyTradePermission(), false,
      "missing trade scope is not mutation authorization");
    record = { api_key_id: "test-key-id", subaccount: 0, scopes: ["write::trade"] };
    assert.equal(await verifyKalshiTradingKeyTradePermission(), false,
      "missing read scope is not mutation authorization");
    process.env.KALSHI_BOT_SUBACCOUNT = "1";
    record = { api_key_id: "test-key-id", scopes: ["read", "write::trade"] };
    assert.equal(await verifyKalshiTradingKeyTradePermission(), false,
      "numbered-account verification still rejects omitted metadata");
    record = { api_key_id: "test-key-id", subaccount: 1, scopes: ["read", "write::trade"] };
    assert.equal(await verifyKalshiTradingKeyTradePermission(), true);
    record = null;
    assert.equal(await verifyKalshiTradingKeyTradePermission(), false,
      "missing key metadata is not mutation authorization");
  } finally {
    restoreEnvironment();
  }
});

test("primary history reader completes current and archived pages before claiming availability", async () => {
  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "0";
  const pages = new Map<string, Set<string>>();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(init?.method, "GET");
    assert.equal(url.searchParams.get("subaccount"), "0");
    const cursor = url.searchParams.get("cursor");
    const seen = pages.get(url.pathname) ?? new Set<string>();
    seen.add(cursor ?? "first");
    pages.set(url.pathname, seen);
    return {
      ok: true, status: 200,
      json: async () => ({
        [url.pathname.endsWith("/orders") ? "orders" : "fills"]: [],
        cursor: cursor === null ? "second" : null,
      }),
    } as Response;
  }) as typeof fetch;
  try {
    const activity = await readKalshiAccountActivity();
    assert.equal(activity.available, true);
    assert.equal(activity.truncated, false);
    assert.equal(activity.selectedSubaccount, 0);
    for (const path of [
      "/trade-api/v2/portfolio/orders", "/trade-api/v2/portfolio/fills",
      "/trade-api/v2/historical/orders", "/trade-api/v2/historical/fills",
    ]) {
      assert.deepEqual([...pages.get(path) ?? []], ["first", "second"]);
    }
    assert.equal(pages.size, 4, "only the four authenticated account GETs are used");
  } finally {
    restoreEnvironment();
  }
});

test("account history merges only exact order overlaps and retains endpoint/page provenance", async () => {
  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "0";
  const order = {
    order_id: "overlap-order", client_order_id: "client-order",
    ticker: "KXBTC-OVERLAP", side: "yes", action: "buy", type: "limit",
    status: "canceled", yes_price_dollars: "0.4",
    initial_count_fp: "1", fill_count_fp: "0", remaining_count_fp: "0",
    created_time: "2026-09-25T12:00:00Z", subaccount: 0,
  };
  let archivedOrder: Record<string, unknown> = order;
  let withinEndpoint: Record<string, unknown> | null = null;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(init?.method, "GET");
    assert.equal(url.searchParams.get("subaccount"), "0");
    const current = url.pathname.endsWith("/portfolio/orders");
    const archived = url.pathname.endsWith("/historical/orders");
    const second = url.searchParams.has("cursor");
    const payload = current
      ? { orders: second ? [withinEndpoint ?? order] : withinEndpoint ? [order] : [],
          cursor: second ? null : "next" }
      : archived ? { orders: withinEndpoint ? [] : [archivedOrder] }
        : { fills: [] };
    return { ok: true, status: 200, json: async () => payload } as Response;
  }) as typeof fetch;
  try {
    const identical = await readKalshiAccountActivity();
    assert.equal(identical.truncated, false);
    assert.equal(identical.orders.length, 1);
    assert.deepEqual(identical.orders[0]!.sources, [
      { endpoint: "portfolio/orders", page: 2 },
      { endpoint: "historical/orders", page: 1 },
    ]);
    assert.deepEqual(identical.orderOverlapConflicts, []);
    for (const changed of [
      { status: "executed" },
      { fill_count_fp: "1" },
      { ticker: "KXBTC-OTHER" },
      { subaccount: undefined },
    ]) {
      archivedOrder = { ...order, ...changed };
      if (changed.subaccount === undefined && "subaccount" in changed) {
        delete archivedOrder.subaccount;
      }
      const mismatch = await readKalshiAccountActivity();
      assert.equal(mismatch.truncated, true);
      assert.equal(mismatch.orders.length, 0, "neither conflicting record may be selected");
      assert.deepEqual(mismatch.orderOverlapConflicts, [{
        sources: [
          { endpoint: "portfolio/orders", page: 2 },
          { endpoint: "historical/orders", page: 1 },
        ],
      }]);
    }
    withinEndpoint = { ...order, status: "executed" };
    const withinMismatch = await readKalshiAccountActivity();
    assert.equal(withinMismatch.truncated, true);
    assert.equal(withinMismatch.orders.length, 0);
    assert.deepEqual(withinMismatch.orderOverlapConflicts, [{
      sources: [
        { endpoint: "portfolio/orders", page: 1 },
        { endpoint: "portfolio/orders", page: 2 },
      ],
    }]);
    withinEndpoint = order;
    const withinIdentical = await readKalshiAccountActivity();
    assert.equal(withinIdentical.truncated, false,
      "existing identical within-endpoint pagination deduplication remains intact");
    assert.equal(withinIdentical.orders.length, 1);
  } finally {
    restoreEnvironment();
  }
});

test("all portfolio and historical account reads explicitly select the configured subaccount", async () => {
  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "7";
  const requests: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requests.push(url);
    const path = url.pathname;
    const payload = path.endsWith("/balance") ? { balance: 100 }
      : path.endsWith("/positions") ? { market_positions: [] }
        : path.endsWith("/settlements") ? { settlements: [] }
          : path.endsWith("/orders") ? { orders: [] }
            : { fills: [] };
    return { ok: true, status: 200, json: async () => payload } as Response;
  }) as typeof fetch;
  try {
    await readKalshiAccount();
    await readKalshiSettlements();
    await readKalshiHistoricalFills(["KXBTC15M-SELECTOR"]);
    await readKalshiSubmissionEvidence("KXBTC15M-SELECTOR");
    const activity = await readKalshiAccountActivity();
    assert.equal(activity.exclusiveControlVerified, false);
    const accountReads = requests.filter(({ pathname }) =>
      /\/(?:portfolio|historical)\//.test(pathname));
    assert.ok(accountReads.length > 0);
    assert.ok(accountReads.every((url) => url.searchParams.get("subaccount") === "7"),
      "every account/history GET must carry the selected subaccount");
  } finally {
    restoreEnvironment();
  }
});

test("account reads reject records that name a different subaccount", async () => {
  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "7";
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    const payload = path.endsWith("/balance") ? { balance: 100 }
      : path.endsWith("/orders")
        ? { orders: [{ subaccount: 8, order_id: "foreign" }] }
        : path.endsWith("/positions") ? { market_positions: [] } : { fills: [] };
    return { ok: true, status: 200, json: async () => payload } as Response;
  }) as typeof fetch;
  try {
    await assert.rejects(readKalshiAccount(),
      (error: Error) => error instanceof KalshiApiError &&
        error.type === "INVALID_RESPONSE");
  } finally {
    restoreEnvironment();
  }
});

test("trading-key restriction verifier fails closed and accepts only the matching restricted key", async () => {
  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "9";
  let apiKeyRecord: unknown = {
    api_key_id: "test-key-id", subaccount: 9, scopes: ["read", "write::trade"],
  };
  let available = true;
  let requests = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests += 1;
    const url = new URL(String(input));
    assert.equal(url.pathname, "/trade-api/v2/api_keys");
    assert.equal(url.search, "");
    assert.equal(init?.method, "GET");
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers["KALSHI-ACCESS-KEY"], "verifier-key-id");
    if (!available) return { ok: false, status: 503 } as Response;
    return {
      ok: true, status: 200,
      json: async () => ({ api_keys: [apiKeyRecord] }),
    } as Response;
  }) as typeof fetch;
  try {
    assert.equal(await verifyKalshiTradingKeyRestriction(), false,
      "missing owner credentials are unavailable, not verified");
    assert.equal(requests, 0);

    process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key-id";
    process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKeyPem;
    apiKeyRecord = {
      api_key_id: "some-other-key", subaccount: 9, scopes: ["read", "write"],
    };
    assert.equal(await verifyKalshiTradingKeyRestriction(), false, "key mismatch fails closed");
    apiKeyRecord = {
      api_key_id: "test-key-id", subaccount: 8, scopes: ["read", "write"],
    };
    assert.equal(await verifyKalshiTradingKeyRestriction(), false, "subaccount mismatch fails closed");
    apiKeyRecord = {
      api_key_id: "test-key-id", subaccount: 9, scopes: ["read"],
    };
    assert.equal(await verifyKalshiTradingKeyRestriction(), false, "missing write scope fails closed");
    available = false;
    assert.equal(await verifyKalshiTradingKeyRestriction(), false, "HTTP errors fail closed");
    available = true;
    apiKeyRecord = {
      api_key_id: "test-key-id", subaccount: 9, scopes: ["read", "write::trade"],
    };
    assert.equal(await verifyKalshiTradingKeyRestriction(), true);
  } finally {
    restoreEnvironment();
  }
});

test("key metadata verification never claims exclusive future control, even with complete history", async () => {
  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "9";
  process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key-id";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKeyPem;
  let historicalFillsUnavailable = false;
  let mismatchedHistorySelector = false;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/api_keys")) {
      return {
        ok: true, status: 200,
        json: async () => ({
          api_keys: [{
            api_key_id: "test-key-id", subaccount: 9, scopes: ["read", "write"],
          }],
        }),
      } as Response;
    }
    if (historicalFillsUnavailable && url.pathname.endsWith("/historical/fills")) {
      return { ok: false, status: 404 } as Response;
    }
    const payload = url.pathname.endsWith("/orders") ? { orders: [] } : { fills: [] };
    return {
      ok: true, status: 200,
      json: async () => ({
        ...payload,
        ...(mismatchedHistorySelector && url.pathname.endsWith("/portfolio/orders")
          ? { subaccount: 10 }
          : {}),
      }),
    } as Response;
  }) as typeof fetch;
  try {
    const complete = await readKalshiAccountActivity();
    assert.equal(complete.available, true);
    assert.equal(complete.truncated, false);
    assert.equal(complete.keyRestrictionVerified, true);
    assert.equal(complete.selectedSubaccount, 9);
    assert.ok(Number.isFinite(Date.parse(complete.scanStartedAt ?? "")));
    assert.ok(Number.isFinite(Date.parse(complete.scanFinishedAt ?? "")));
    assert.equal(complete.exclusiveControlVerified, false);
    historicalFillsUnavailable = true;
    const incomplete = await readKalshiAccountActivity();
    assert.equal(incomplete.available, false);
    assert.equal(incomplete.keyRestrictionVerified, true);
    assert.equal(incomplete.exclusiveControlVerified, false);
    historicalFillsUnavailable = false;
    mismatchedHistorySelector = true;
    await assert.rejects(readKalshiAccountActivity(),
      (error: Error) => error instanceof KalshiApiError &&
        error.type === "INVALID_RESPONSE");
  } finally {
    restoreEnvironment();
  }
});

test("account requests are signed GETs and normalize cents and pagination", async () => {
  setCredentials();
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const results: Record<string, unknown> = {
    "/portfolio/balance": { balance: 1234, portfolio_value: 1600 },
    "/portfolio/orders": {
      orders: [{
        order_id: "order-1", ticker: "KXTEST", side: "yes", action: "buy",
        yes_price: 55, remaining_count_fp: "2.5", status: "resting",
        created_time: "2025-01-02T03:04:05Z",
      }, {
        order_id: "order-2", ticker: "KXTEST", side: "no", action: "buy",
        yes_price: 55, no_price_dollars: "0.4501",
        remaining_count_fp: "1", status: "resting",
      }],
      cursor: "more",
    },
    "/portfolio/positions": {
      market_positions: [{
        ticker: "KXTEST", position_fp: "3.0", market_exposure: -200,
        realized_pnl: 45,
      }],
      cursor: "",
    },
    "/portfolio/fills": {
      fills: [{
        trade_id: "fill-1", order_id: "order-1", ticker: "KXTEST",
        side: "yes", action: "buy", count_fp: "1.25", yes_price: 52,
        fee_cost: "0",
        created_time: "2025-01-02T03:04:05Z",
      }, {
        trade_id: "fill-2", order_id: "order-2", ticker: "KXTEST",
        side: "no", action: "buy", count_fp: "1", yes_price: 52,
        no_price_dollars: "0.4801", fee_cost: null,
      }],
    },
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init: init ?? {} });
    const parsedUrl = new URL(url);
    const path = parsedUrl.pathname.replace("/trade-api/v2", "");
    return {
      ok: true,
      status: 200,
      json: async () => path === "/portfolio/orders" &&
          parsedUrl.searchParams.get("cursor") === "more"
        ? { orders: [{
          order_id: "order-3", ticker: "KXTEST", side: "yes", action: "buy",
          yes_price: 55, remaining_count_fp: "1", status: "resting",
        }] }
        : results[path],
    } as Response;
  }) as typeof fetch;
  try {
    const account = await readKalshiAccount();
    assert.equal(account.balance.availableCashDollars, "12.34");
    assert.equal(account.balance.portfolioValueDollars, "16.00");
    assert.equal(account.openOrders[0]?.priceDollars, "0.55");
    assert.equal(account.openOrders[1]?.priceDollars, "0.4501");
    assert.equal(account.openOrders[0]?.remainingCount, "2.5");
    assert.equal(account.positions[0]?.marketExposureDollars, "-2.00");
    assert.equal(account.positions[0]?.realizedPnlDollars, "0.45");
    assert.equal(account.fills[0]?.countFp, "1.25");
    assert.equal(account.fills[1]?.priceDollars, "0.4801");
    assert.equal(account.fills[0]?.feeCostDollars, "0");
    assert.equal(account.fills[1]?.feeCostDollars, null);
    assert.deepEqual(account.truncated, {
      openOrders: false, positions: false, fills: false,
    });
    assert.equal(requests.length, 5);
    for (const request of requests) {
      assert.equal(request.init.method, "GET");
      const url = new URL(request.url);
      assert.equal(url.origin, "https://external-api.demo.kalshi.co");
      assert.equal(request.init.headers instanceof Object, true);
      const headers = request.init.headers as Record<string, string>;
      assert.equal(headers["KALSHI-ACCESS-KEY"], "test-key-id");
      const timestamp = headers["KALSHI-ACCESS-TIMESTAMP"];
      const signature = Buffer.from(headers["KALSHI-ACCESS-SIGNATURE"], "base64");
      const verifier = createVerify("sha256");
      verifier.update(`${timestamp}GET${url.pathname}`);
      verifier.end();
      assert.equal(verifier.verify({
        key: publicKey,
        padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
        saltLength: 32,
      }, signature), true);
    }
    assert.ok(requests.some(({ url }) => url.endsWith("/portfolio/orders?status=resting&limit=100&subaccount=1")));
    assert.ok(requests.some(({ url }) => url.endsWith("/portfolio/orders?status=resting&limit=100&subaccount=1&cursor=more")));
  } finally {
    restoreEnvironment();
  }
});

test("settlements are signed GETs, paginated, normalized, and duplicate tickers are incomplete", async () => {
  setCredentials();
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  const settlement = {
    ticker: "KXSETTLED-1",
    exchange_index: 0,
    event_ticker: "KXSETTLED",
    market_result: "yes",
    yes_count_fp: "2.00",
    yes_total_cost_dollars: "0.800000",
    no_count_fp: "0.00",
    no_total_cost_dollars: "0.000000",
    revenue: 200,
    settled_time: "2025-01-02T03:04:05Z",
    fee_cost: "0.000001",
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url, init: init ?? {} });
    return {
      ok: true,
      status: 200,
      json: async () => url.searchParams.has("cursor")
        ? { settlements: [{ ...settlement }], cursor: "" }
        : { settlements: [settlement], cursor: "settlements-next" },
    } as Response;
  }) as typeof fetch;
  try {
    const result = await readKalshiSettlements();
    assert.equal(requests.length, 2);
    assert.equal(result.settlements.length, 2, "duplicate settlement evidence is retained");
    assert.equal(result.truncated, true, "a repeated market ticker marks the list incomplete");
    assert.equal(result.settlements[0]?.feeCostDollars, "0.000001");
    assert.equal(result.settlements[0]?.yesTotalCostDollars, "0.800000");
    assert.equal(result.settlements[0]?.revenueCents, "200");
    assert.equal(result.settlements[0]?.settledAt, "2025-01-02T03:04:05.000Z");
    for (const { url, init } of requests) {
      assert.equal(init.method, "GET");
      assert.equal(url.pathname, "/trade-api/v2/portfolio/settlements");
      const headers = init.headers as Record<string, string>;
      const verifier = createVerify("sha256");
      verifier.update(`${headers["KALSHI-ACCESS-TIMESTAMP"]}GET${url.pathname}`);
      verifier.end();
      assert.equal(verifier.verify({
        key: publicKey,
        padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
        saltLength: 32,
      }, Buffer.from(headers["KALSHI-ACCESS-SIGNATURE"], "base64")), true);
    }
    assert.equal(requests[0]?.url.searchParams.get("limit"), "100");
    assert.equal(requests[0]?.url.searchParams.get("subaccount"), "1");
    assert.equal(requests[1]?.url.searchParams.get("cursor"), "settlements-next");
  } finally {
    restoreEnvironment();
  }
});

test("fill fee_cost rejects values outside documented fixed-point string precision", async () => {
  setCredentials();
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    const payload = path.endsWith("/balance")
      ? { balance: 100 }
      : path.endsWith("/fills")
        ? { fills: [{
          trade_id: "bad-fee", ticker: "KXTEST", side: "yes", action: "buy",
          count_fp: "1", fee_cost: "0.0000001",
        }] }
        : path.endsWith("/positions") ? { market_positions: [] } : { orders: [] };
    return { ok: true, status: 200, json: async () => payload } as Response;
  }) as typeof fetch;
  try {
    await assert.rejects(readKalshiAccount(), /INVALID_RESPONSE/);
  } finally {
    restoreEnvironment();
  }
});

test("account snapshot follows cursors, deduplicates stable IDs, and enforces page cap", async () => {
  setCredentials();
  const seen: string[] = [];
  const rows: Record<string, Record<string, unknown>[]> = {
    orders: [
      { order_id: "same-order", ticker: "KX1", side: "yes", action: "buy", status: "resting" },
      { order_id: "same-order", ticker: "KX1", side: "yes", action: "buy", status: "resting" },
      { order_id: "second-order", ticker: "KX2", side: "no", action: "sell", status: "resting" },
    ],
    positions: [
      { ticker: "KX1", position_fp: "1" },
      { ticker: "KX2", position_fp: "2" },
    ],
    fills: [
      { trade_id: "same-fill", ticker: "KX1", side: "yes", action: "buy", count_fp: "1", fee_cost: "0.01" },
      { trade_id: "same-fill", ticker: "KX1", side: "yes", action: "buy", count_fp: "1", fee_cost: "0.01" },
      { trade_id: "second-fill", ticker: "KX2", side: "no", action: "sell", count_fp: "2" },
    ],
  };
  const paths = [
    { path: "/portfolio/orders", key: "orders", list: "orders" },
    { path: "/portfolio/positions", key: "positions", list: "market_positions" },
    { path: "/portfolio/fills", key: "fills", list: "fills" },
  ];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const route = paths.find(({ path }) => path === url.pathname.replace("/trade-api/v2", ""));
    const cursor = url.searchParams.get("cursor");
    if (url.pathname.endsWith("/balance")) {
      return { ok: true, status: 200, json: async () => ({ balance: 100 }) } as Response;
    }
    assert.ok(route);
    seen.push(`${route.key}:${cursor ?? "first"}`);
    const index = cursor === null ? 0 : Number(cursor.slice(route.key.length + 6));
    const firstRow = rows[route.key]![index]!;
    const payload = {
      [route.list]: [firstRow],
      ...(index < rows[route.key]!.length - 1
        ? { cursor: `${route.key}-page-${index + 1}` }
        : {}),
    };
    return { ok: true, status: 200, json: async () => payload } as Response;
  }) as typeof fetch;
  try {
    const snapshot = await readKalshiAccount();
    assert.equal(snapshot.openOrders.length, 2);
    assert.equal(snapshot.fills.length, 2);
    assert.equal(snapshot.fills[0]?.feeCostDollars, "0.01");
    assert.equal(snapshot.fills[1]?.feeCostDollars, null);
    assert.equal(snapshot.positions.length, 2);
    assert.deepEqual(snapshot.truncated, {
      openOrders: false, positions: false, fills: false,
    });
    assert.equal(seen.length, 8);
    assert.ok(seen.includes("orders:orders-page-1"));
    assert.ok(seen.includes("positions:positions-page-1"));
    assert.ok(seen.includes("fills:fills-page-1"));
  } finally {
    restoreEnvironment();
  }

  setCredentials();
  let pages = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path.endsWith("/balance")) {
      return { ok: true, status: 200, json: async () => ({ balance: 100 }) } as Response;
    }
    if (!path.endsWith("/orders")) {
      const key = path.endsWith("/positions") ? "market_positions" : "fills";
      return { ok: true, status: 200, json: async () => ({ [key]: [] }) } as Response;
    }
    pages += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ orders: [], cursor: `page-${pages}` }),
    } as Response;
  }) as typeof fetch;
  try {
    const snapshot = await readKalshiAccount();
    assert.equal(pages, 20, "pagination is bounded by the page limit");
    assert.equal(snapshot.truncated.openOrders, true);
  } finally {
    restoreEnvironment();
  }
});

test("conflicting duplicate order/fill IDs and repeated position tickers mark snapshots incomplete", async () => {
  setCredentials();
  const calls: Record<string, number> = { orders: 0, positions: 0, fills: 0 };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/balance")) {
      return { ok: true, status: 200, json: async () => ({ balance: 100 }) } as Response;
    }
    const kind = url.pathname.endsWith("/orders") ? "orders"
      : url.pathname.endsWith("/positions") ? "positions" : "fills";
    const cursor = url.searchParams.get("cursor");
    calls[kind] += 1;
    if (kind === "orders") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          orders: [{
            order_id: "duplicate-order",
            ticker: cursor ? "KX2" : "KX1",
            side: "yes",
            action: "buy",
            status: "resting",
          }],
          ...(!cursor ? { cursor: "orders-next" } : {}),
        }),
      } as Response;
    }
    if (kind === "positions") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          market_positions: [{ ticker: "KX1", position_fp: cursor ? "2" : "1" }],
          ...(!cursor ? { cursor: "positions-next" } : {}),
        }),
      } as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        fills: [{
          trade_id: "duplicate-fill",
          ticker: "KX1",
          side: "yes",
          action: "buy",
          count_fp: cursor ? "2" : "1",
        }],
        ...(!cursor ? { cursor: "fills-next" } : {}),
      }),
    } as Response;
  }) as typeof fetch;
  try {
    const snapshot = await readKalshiAccount();
    assert.deepEqual(calls, { orders: 2, positions: 2, fills: 2 });
    assert.equal(snapshot.openOrders.length, 2, "conflicting order evidence is retained");
    assert.equal(snapshot.fills.length, 2, "conflicting fill evidence is retained");
    assert.equal(snapshot.positions.length, 2, "duplicate ticker evidence is retained");
    assert.deepEqual(snapshot.truncated, {
      openOrders: true,
      positions: true,
      fills: true,
    });
  } finally {
    restoreEnvironment();
  }
});

test("pagination timeout returns a visibly truncated partial collection", async () => {
  setCredentials();
  const originalSetTimeout = globalThis.setTimeout;
  let timers = 0;
  let orderPage = 0;
  globalThis.setTimeout = ((handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) => {
    timers += 1;
    if (timers === 5) {
      const handle = originalSetTimeout(() => {}, 60_000);
      queueMicrotask(() => {
        handler(...args);
      });
      return handle;
    }
    return originalSetTimeout(handler, timeout, ...args);
  }) as typeof setTimeout;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path.endsWith("/balance")) {
      return { ok: true, status: 200, json: async () => ({ balance: 100 }) } as Response;
    }
    if (path.endsWith("/orders")) {
      orderPage += 1;
      if (url.searchParams.has("cursor")) return new Promise<Response>(() => {});
      return {
        ok: true,
        status: 200,
        json: async () => ({
          orders: [{ order_id: "timeout-order", ticker: "KX", side: "yes", action: "buy", status: "resting" }],
          cursor: "next",
        }),
      } as Response;
    }
    const key = path.endsWith("/positions") ? "market_positions" : "fills";
    return { ok: true, status: 200, json: async () => ({ [key]: [] }) } as Response;
  }) as typeof fetch;
  try {
    const snapshot = await readKalshiAccount();
    assert.equal(orderPage, 2);
    assert.equal(snapshot.openOrders.length, 1);
    assert.equal(snapshot.truncated.openOrders, true);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    restoreEnvironment();
  }
});

test("account pagination marks cursor loops and record caps as truncated", async () => {
  setCredentials();
  let ordersCalls = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path.endsWith("/balance")) {
      return { ok: true, status: 200, json: async () => ({ balance: 100 }) } as Response;
    }
    if (path.endsWith("/positions") || path.endsWith("/fills")) {
      const key = path.endsWith("/positions") ? "market_positions" : "fills";
      return { ok: true, status: 200, json: async () => ({ [key]: [] }) } as Response;
    }
    ordersCalls += 1;
    if (url.searchParams.get("cursor") === null) {
      return {
        ok: true, status: 200,
        json: async () => ({
          orders: [{ order_id: "loop-order", ticker: "KX", side: "yes", action: "buy", status: "resting" }],
          cursor: "repeat",
        }),
      } as Response;
    }
    return {
      ok: true, status: 200,
      json: async () => ({
        orders: [{ order_id: "loop-order", ticker: "KX", side: "yes", action: "buy", status: "resting" }],
        cursor: "repeat",
      }),
    } as Response;
  }) as typeof fetch;
  try {
    const snapshot = await readKalshiAccount();
    assert.equal(ordersCalls, 2, "repeated cursor must not trigger another request");
    assert.equal(snapshot.openOrders.length, 1, "duplicate stable order ID is suppressed");
    assert.equal(snapshot.truncated.openOrders, true);
  } finally {
    restoreEnvironment();
  }

  setCredentials();
  let pageNumber = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path.endsWith("/balance")) {
      return { ok: true, status: 200, json: async () => ({ balance: 100 }) } as Response;
    }
    if (path.endsWith("/positions") || path.endsWith("/fills")) {
      const key = path.endsWith("/positions") ? "market_positions" : "fills";
      return { ok: true, status: 200, json: async () => ({ [key]: [] }) } as Response;
    }
    pageNumber += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        orders: Array.from({ length: 100 }, (_, index) => ({
          order_id: `order-${pageNumber}-${index}`, ticker: "KX", side: "yes",
          action: "buy", status: "resting",
        })),
        cursor: `cursor-${pageNumber}`,
      }),
    } as Response;
  }) as typeof fetch;
  try {
    const snapshot = await readKalshiAccount();
    assert.equal(snapshot.openOrders.length, 1_000);
    assert.equal(pageNumber, 10);
    assert.equal(snapshot.truncated.openOrders, true, "record cap cannot appear complete");
  } finally {
    restoreEnvironment();
  }
});

test("orderbook derives asks and ask sizes from opposite-side bids", async () => {
  setCredentials();
  let seenUrl = "";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(input);
    assert.equal(init?.method, "GET");
    return {
      ok: true,
      status: 200,
      json: async () => ({
        orderbook_fp: {
          yes_dollars: [["0.4201", "7.5"], ["0.40", "9"]],
          no_dollars: [["0.3102", "4"]],
        },
      }),
    } as Response;
  }) as typeof fetch;
  try {
    const book = await readKalshiOrderbook("KXTEST");
    assert.equal(new URL(seenUrl).search, "?depth=100");
    assert.equal(book.yesBidDollars, "0.4201");
    assert.equal(book.noBidDollars, "0.3102");
    assert.equal(book.yesAskDollars, "0.6898");
    assert.equal(book.noAskDollars, "0.5799");
    assert.equal(book.yesAskAvailableContracts, "4");
    assert.equal(book.noAskAvailableContracts, "7.5");
    assert.deepEqual(book.yesBidLevels, [
      { priceDollars: "0.4201", availableContracts: "7.5" },
      { priceDollars: "0.4000", availableContracts: "9" },
    ]);
    assert.deepEqual(book.noBidLevels, [
      { priceDollars: "0.3102", availableContracts: "4" },
    ]);
    assert.deepEqual(book.yesAskLevels, [
      { priceDollars: "0.6898", availableContracts: "4" },
    ]);
    assert.deepEqual(book.noAskLevels, [
      { priceDollars: "0.5799", availableContracts: "7.5" },
      { priceDollars: "0.6000", availableContracts: "9" },
    ]);
    assert.ok(Number.isFinite(Date.parse(book.observedAt)));
  } finally {
    restoreEnvironment();
  }
});

test("single-line PEM secrets sign read-only requests", async () => {
  setCredentials();
  process.env.KALSHI_API_PRIVATE_KEY = privateKeyPem.replaceAll("\n", "");
  let verified = false;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(init?.method, "GET");
    const headers = init?.headers as Record<string, string>;
    const verifier = createVerify("sha256");
    verifier.update(`${headers["KALSHI-ACCESS-TIMESTAMP"]}GET${url.pathname}`);
    verifier.end();
    verified = verifier.verify({
      key: publicKey,
      padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    }, Buffer.from(headers["KALSHI-ACCESS-SIGNATURE"], "base64"));
    return {
      ok: true,
      status: 200,
      json: async () => ({ orderbook_fp: { yes_dollars: [], no_dollars: [] } }),
    } as Response;
  }) as typeof fetch;
  try {
    await readKalshiOrderbook("KXTEST");
    assert.equal(verified, true);
  } finally {
    restoreEnvironment();
  }
});

test("Kalshi client exports are explicitly reviewed; account mutations are isolated from read APIs", () => {
  // Account provisioning/mutation helpers were deliberately added for the
  // separately authorized setup flow. An outdated read-only export allowlist
  // must not silently mask them or prevent unrelated safety tests from running.
  const reviewedReadAndEvidenceExports = [
    "KalshiApiError", "OPEN_MARKET_MAX_MARKETS", "OPEN_MARKET_MAX_PAGES",
    "OPEN_MARKET_PAGE_LIMIT", "captureCleanPairSnapshot", "getConfiguredKalshiSubaccount",
    "getKalshiCredentialsState", "getScopedKalshiJson", "listOpenKalshiMarkets",
    "readKalshiAccount", "readKalshiAccountActivity", "readKalshiDedicatedPairEvidence",
    "readKalshiHistoricalFills", "readKalshiOrderbook", "readKalshiSettlements",
    "readKalshiSubmissionEvidence", "reviewedKalshiCents",
    "verifyKalshiRestrictedTradingKeyForSubaccount",
    "verifyKalshiTradingKeyRestriction", "verifyKalshiTradingKeyTradePermission",
  ];
  const reviewedAccountSetupMutations = [
    "createScopedKalshiSubaccountOne", "generateScopedKalshiSubaccountOneKey", "mutateScopedKalshi", "postScopedKalshiPilotTransfer",
  ];
  assert.deepEqual(
    Object.keys(kalshiClient).sort(),
    [...reviewedReadAndEvidenceExports, ...reviewedAccountSetupMutations].sort(),
  );
});

test("creation boundary uses verifier-only GET evidence before a restricted key exists", async () => {
  setCredentials();
  delete process.env.KALSHI_API_KEY_ID;
  delete process.env.KALSHI_API_PRIVATE_KEY;
  process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key-id";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKeyPem;
  const fixture = cleanPairFixture({ creationBoundary: true });
  globalThis.fetch = fixture.fetcher;
  try {
    const snapshot = await captureCleanPairSnapshot(7, "KXBTC15M", {
      creationBoundary: true,
    });
    assert.equal(snapshot.status, "clean");
    assert.equal(snapshot.pair.exchangeIndex, 2);
    assert.equal(snapshot.availableCashMicros, "0");
    assert.equal(snapshot.inventoryCashMicros, "0");
    assert.equal(snapshot.portfolioValueMicros, "0");
    assert.match(snapshot.evidenceDigest ?? "", /^[0-9a-f]{64}$/);
    assert.ok(fixture.requests.length >= 11);
    assert.ok(fixture.requests.every((request) =>
      request.method === "GET" && request.keyId === "verifier-key-id"));
    assert.ok(!fixture.requests.some((request) =>
      request.url.pathname.endsWith("/api_keys")));
  } finally {
    restoreEnvironment();
  }
});

test("creation boundary accepts unchanged zero inventory with an older last-change timestamp", async () => {
  setCredentials();
  delete process.env.KALSHI_API_KEY_ID;
  delete process.env.KALSHI_API_PRIVATE_KEY;
  process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key-id";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKeyPem;
  const fixture = cleanPairFixture({ creationBoundary: true, inventoryAgeSeconds: 120 });
  globalThis.fetch = fixture.fetcher;
  try {
    const snapshot = await captureCleanPairSnapshot(7, "KXBTC15M", {
      creationBoundary: true,
    });
    assert.equal(snapshot.status, "clean", snapshot.reasons.join(", "));
    assert.equal(snapshot.availableCashMicros, "0");
    assert.equal(snapshot.inventoryCashMicros, "0");
    assert.equal(snapshot.portfolioValueMicros, "0");
    assert.equal(snapshot.zeroPriorPairTransfers, true);
    assert.ok(fixture.requests.every((request) => request.method === "GET"));
  } finally {
    restoreEnvironment();
  }
});

test("restricted-key binding accepts only exact N and exactly read plus write::trade", async () => {
  setCredentials();
  process.env.KALSHI_API_KEY_ID = "test-key-id";
  process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key-id";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKeyPem;
  const otherPrivateKey = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 0x10001,
  }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const cases = [
    {
      keyId: "test-key-id", subaccount: 7, scopes: ["read", "write::trade"],
      balance: { balance_dollars: "0.0000", subaccount_number: 7, exchange_index: 2 },
      expected: true,
    },
    {
      keyId: "test-key-id", subaccount: 8, scopes: ["read", "write::trade"],
      balance: { balance_dollars: "0.0000", subaccount_number: 7, exchange_index: 2 },
      expected: false,
    },
    {
      keyId: "test-key-id", subaccount: 7, scopes: ["read", "write"],
      balance: { balance_dollars: "0.0000", subaccount_number: 7, exchange_index: 2 },
      expected: false,
    },
    {
      keyId: "test-key-id", subaccount: 7,
      scopes: ["read", "write::trade", "write::account"],
      balance: { balance_dollars: "0.0000", subaccount_number: 7, exchange_index: 2 },
      expected: false,
    },
    {
      keyId: "test-key-id", subaccount: 7, scopes: ["read", "write::trade"],
      balance: { balance_dollars: "0.0000", subaccount_number: 8, exchange_index: 2 },
      expected: false,
    },
    {
      keyId: "test-key-id", subaccount: 7, scopes: ["read", "write::trade"],
      balance: { balance_dollars: "0.0000", subaccount_number: 7, exchange_index: 1 },
      expected: false,
    },
    {
      keyId: "different-key", subaccount: 7, scopes: ["read", "write::trade"],
      balance: { balance_dollars: "0.0000", subaccount_number: 7, exchange_index: 2 },
      expected: false,
    },
    {
      keyId: "test-key-id", subaccount: 7, scopes: ["read", "write::trade"],
      balance: null, expected: false,
    },
    {
      keyId: "test-key-id", subaccount: 7, scopes: ["read", "write::trade"],
      balance: { balance_dollars: "0.0000", subaccount_number: 7, exchange_index: 2 },
      selectedPrivateKey: otherPrivateKey,
      expected: false,
    },
    {
      keyId: "test-key-id", subaccount: 7, scopes: ["read", "write::trade"],
      balance: { balance_dollars: "0.0000", subaccount_number: 7, exchange_index: 2 },
      balanceHttpStatus: 503,
      expected: false,
    },
  ];
  try {
    for (const item of cases) {
      process.env.KALSHI_API_PRIVATE_KEY =
        "selectedPrivateKey" in item ? item.selectedPrivateKey : privateKeyPem;
      const requests: Array<{ url: URL; method: string; keyId: string }> = [];
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const headers = init?.headers as Record<string, string>;
        requests.push({
          url,
          method: init?.method ?? "",
          keyId: headers["KALSHI-ACCESS-KEY"],
        });
        if (url.pathname.endsWith("/api_keys")) {
          assert.equal(headers["KALSHI-ACCESS-KEY"], "verifier-key-id");
          return {
            ok: true,
            status: 200,
            json: async () => ({
              api_keys: [{
                api_key_id: item.keyId,
                subaccount: item.subaccount,
                scopes: item.scopes,
              }],
            }),
          } as Response;
        }
        assert.equal(url.pathname.endsWith("/portfolio/balance"), true);
        assert.equal(url.searchParams.get("subaccount"), "7");
        assert.equal(url.searchParams.get("exchange_index"), "2");
        assert.equal(headers["KALSHI-ACCESS-KEY"], "test-key-id");
        const signature = createVerify("sha256");
        signature.update(
          `${headers["KALSHI-ACCESS-TIMESTAMP"]}GET${url.pathname}`,
        );
        signature.end();
        const authenticated = signature.verify({
          key: publicKey,
          padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
          saltLength: 32,
        }, Buffer.from(headers["KALSHI-ACCESS-SIGNATURE"], "base64"));
        if (!authenticated) return { ok: false, status: 401 } as Response;
        if ("balanceHttpStatus" in item) {
          return { ok: false, status: item.balanceHttpStatus } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => item.balance === null ? {} : item.balance,
        } as Response;
      }) as typeof fetch;
      assert.equal(
        await verifyKalshiRestrictedTradingKeyForSubaccount(7),
        item.expected,
      );
      assert.ok(requests.every((request) => request.method === "GET"));
      assert.equal(requests[0]?.url.pathname.endsWith("/api_keys"), true);
      if (item.keyId === "test-key-id" &&
          item.subaccount === 7 && item.scopes.length === 2 &&
          item.scopes.includes("read") && item.scopes.includes("write::trade")) {
        assert.equal(requests[1]?.url.pathname.endsWith("/portfolio/balance"), true);
      }
      if ("selectedPrivateKey" in item) {
        assert.equal(requests[1]?.keyId, "test-key-id");
      }
    }
  } finally {
    restoreEnvironment();
  }
});

test("prospective clean-pair capture signs the scoped $0 balance and exhausts every source", async () => {
  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "7";
  process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key-id";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKeyPem;
  const fixture = cleanPairFixture({
    inventoryCash: "0.000000",
    pageHistoricalOrders: true,
    positions: [{
      ticker: "KXBTC15M", subaccount_number: 7, exchange_index: 2,
      position_fp: "0", market_exposure_dollars: "0.000000",
    }],
  });
  globalThis.fetch = fixture.fetcher;
  try {
    const snapshot = await captureCleanPairSnapshot(7, "KXBTC15M");
    assert.deepEqual(snapshot.pair, { subaccountNumber: 7, exchangeIndex: 2 });
    assert.equal(snapshot.status, "clean");
    assert.equal(snapshot.availableCashMicros, "0");
    assert.equal(snapshot.inventoryCashMicros, "0");
    assert.equal(snapshot.zeroPositions, true);
    assert.equal(snapshot.zeroOrders, true);
    assert.equal(snapshot.zeroFills, true);
    assert.equal(snapshot.zeroSettlements, true);
    assert.equal(snapshot.zeroPriorPairTransfers, true);
    assert.equal(snapshot.keyRestrictionVerified, true);
    assert.equal(snapshot.tradePermissionVerified, true);
    assert.equal(snapshot.marketExchangeIndex, 2);
    assert.match(snapshot.evidenceDigest ?? "", /^[0-9a-f]{64}$/);
    assert.equal(snapshot.capturedAt, snapshot.scanFinishedAt);
    assert.equal(snapshot.reasons.length, 0);
    assert.ok(fixture.requests.length >= 14);
    assert.ok(fixture.requests.every((request) => request.method === "GET"));
    assert.ok(fixture.requests.some((request) =>
      request.url.pathname.endsWith("/historical/orders") &&
      request.url.searchParams.get("cursor") === "next"));
    for (const path of [
      "/portfolio/positions", "/portfolio/orders", "/historical/orders",
      "/portfolio/fills", "/historical/fills", "/portfolio/settlements",
      "/portfolio/subaccounts/transfers", "/portfolio/intra_exchange_instance_transfers",
      "/portfolio/subaccounts/balances", "/portfolio/balance", "/markets/KXBTC15M",
      "/api_keys",
    ]) {
      assert.ok(fixture.requests.some((request) => request.url.pathname.endsWith(path)),
        `missing clean-boundary source ${path}`);
    }
  } finally {
    restoreEnvironment();
  }
});

test("prospective clean-pair capture blocks timestamp-less ambiguous shard-2 transfers", async () => {
  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "7";
  process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key-id";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKeyPem;
  const fixture = cleanPairFixture({
    crossTransfers: [{
      transfer_id: "unknown-subaccount-transfer",
      source_exchange_shard: 2,
      destination_exchange_shard: 0,
      amount: "2.5000",
      status: "completed",
    }],
  });
  globalThis.fetch = fixture.fetcher;
  try {
    const snapshot = await captureCleanPairSnapshot(7, "KXBTC15M");
    assert.equal(snapshot.status, "blocked");
    assert.equal(snapshot.availableCashMicros, "0");
    assert.equal(snapshot.zeroPriorPairTransfers, false);
    assert.equal(snapshot.evidenceDigest, null);
    assert.ok(snapshot.reasons.includes(
      "clean_cross_exchange_transfer_timestamp_missing:unknown-subaccount-transfer",
    ));
    assert.ok(snapshot.records.some((record) =>
      record.id === "unknown-subaccount-transfer" &&
      record.classification === "ambiguous"));
  } finally {
    restoreEnvironment();
  }
});

test("prospective clean boundary retains older ambiguous primary funding transfers without attribution", async () => {
  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "7";
  process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key-id";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKeyPem;
  const beforeCaptureSeconds = Math.floor(Date.now() / 1000) - 30;
  const fixture = cleanPairFixture({
    crossTransfers: [{
      transfer_id: "older-primary-funding-step",
      source_exchange_shard: 0,
      destination_exchange_shard: 2,
      amount: "25.0000",
      status: "completed",
      created_ts: beforeCaptureSeconds,
    }],
  });
  globalThis.fetch = fixture.fetcher;
  try {
    const snapshot = await captureCleanPairSnapshot(7, "KXBTC15M");
    assert.equal(snapshot.status, "clean");
    assert.equal(snapshot.availableCashMicros, "0");
    assert.equal(snapshot.zeroPriorPairTransfers, true);
    assert.match(snapshot.evidenceDigest ?? "", /^[0-9a-f]{64}$/);
    const historicalTransfer = snapshot.records.find((record) =>
      record.id === "older-primary-funding-step");
    assert.equal(historicalTransfer?.classification, "ambiguous");
    assert.equal(historicalTransfer?.sourceExchangeIndex, 0);
    assert.equal(historicalTransfer?.destinationExchangeIndex, 2);
    assert.ok(!snapshot.reasons.includes(
      "clean_ambiguous_cross_exchange_transfer:older-primary-funding-step",
    ));
  } finally {
    restoreEnvironment();
  }
});

test("prospective clean-pair capture blocks cross-shard transfer timestamps during or missing from scan", async () => {
  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "7";
  process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key-id";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKeyPem;
  const duringScan = cleanPairFixture({
    crossTransfers: [{
      transfer_id: "transfer-at-scan-boundary",
      source_exchange_shard: 0,
      destination_exchange_shard: 2,
      amount: "25.0000",
      status: "completed",
      created_ts: Math.ceil(Date.now() / 1000) + 1,
    }],
  });
  globalThis.fetch = duringScan.fetcher;
  try {
    const snapshot = await captureCleanPairSnapshot(7, "KXBTC15M");
    assert.equal(snapshot.status, "blocked");
    assert.equal(snapshot.evidenceDigest, null);
    assert.ok(snapshot.reasons.includes(
      "clean_cross_exchange_transfer_during_snapshot_scan:transfer-at-scan-boundary",
    ));
  } finally {
    restoreEnvironment();
  }

  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "7";
  process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key-id";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKeyPem;
  const missingTime = cleanPairFixture({
    crossTransfers: [{
      transfer_id: "transfer-without-timestamp",
      source_exchange_shard: 0,
      destination_exchange_shard: 2,
      amount: "25.0000",
      status: "completed",
    }],
  });
  globalThis.fetch = missingTime.fetcher;
  try {
    const snapshot = await captureCleanPairSnapshot(7, "KXBTC15M");
    assert.equal(snapshot.status, "blocked");
    assert.equal(snapshot.evidenceDigest, null);
    assert.ok(snapshot.reasons.includes(
      "clean_cross_exchange_transfer_timestamp_missing:transfer-without-timestamp",
    ));
  } finally {
    restoreEnvironment();
  }
});

test("exact subaccount round trip retains nine pre-scan account-wide cross-exchange records", async () => {
  const inboundCreated = Math.floor(Date.parse("2026-09-27T01:08:49.000Z") / 1000);
  const outboundCreated = Math.floor(Date.parse("2026-10-10T16:24:20.000Z") / 1000);
  const roundTrip = [
    {
      transfer_id: PRE_BOUNDARY_INBOUND_TRANSFER_ID,
      from_subaccount: 0,
      to_subaccount: 1,
      exchange_index: 2,
      amount_cents: 2500,
      created_ts: inboundCreated,
      status: "completed",
    },
    {
      transfer_id: PRE_BOUNDARY_OUTBOUND_TRANSFER_ID,
      from_subaccount: 1,
      to_subaccount: 0,
      exchange_index: 2,
      amount_cents: 2500,
      created_ts: outboundCreated,
      status: "completed",
    },
  ];
  const oldCross = Array.from({ length: 9 }, (_, index) => {
    const n = index + 1;
    const source = n % 2 === 0 ? 0 : 2;
    return {
      transfer_id: `old-account-wide-cross-${n}`,
      source_exchange_shard: source,
      destination_exchange_shard: source === 0 ? 2 : 0,
      amount: "10.0000",
      status: "completed",
      created_ts: Math.floor(Date.parse("2026-01-15T00:00:00.000Z") / 1000) + n,
    };
  });
  const prepare = () => {
    setCredentials();
    process.env.KALSHI_BOT_SUBACCOUNT = "1";
    process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key-id";
    process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKeyPem;
  };
  const capture = async (
    overrides: {
      transfers?: unknown[];
      crossTransfers?: unknown[];
      availableCash?: string;
      inventoryCash?: string;
    },
    acknowledged?: {
      id: string;
      inboundTransferId: string;
      outboundTransferId: string;
      evidenceDigest: string;
    } | null,
  ) => {
    prepare();
    const fixture = cleanPairFixture({
      subaccount: 1,
      creationBoundary: true,
      ...overrides,
    });
    globalThis.fetch = fixture.fetcher;
    const snapshot = await captureCleanPairSnapshot(1, "KXBTC15M", {
      creationBoundary: true,
      acknowledgedRoundTrip: acknowledged,
    });
    assert.ok(fixture.requests.length > 0);
    assert.ok(fixture.requests.every((request) => request.method === "GET"));
    return snapshot;
  };
  try {
    const blocked = await capture({ transfers: roundTrip, crossTransfers: oldCross });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.evidenceDigest, null);
    assert.deepEqual([...blocked.reasons].sort(), [
      `clean_prior_subaccount_transfer:${PRE_BOUNDARY_INBOUND_TRANSFER_ID}`,
      `clean_prior_subaccount_transfer:${PRE_BOUNDARY_OUTBOUND_TRANSFER_ID}`,
    ].sort());
    const retained = blocked.records.filter((record) => record.id.startsWith("old-account-wide-cross-"));
    assert.equal(retained.length, 9);
    assert.ok(retained.every((record) =>
      record.feed === "cross_exchange_transfer" &&
      record.classification === "ambiguous" &&
      record.subaccountNumber === null));
    const proof = provePreBoundaryRoundTrip({
      availableCashMicros: blocked.availableCashMicros,
      inventoryCashMicros: blocked.inventoryCashMicros,
      portfolioValueMicros: blocked.portfolioValueMicros ?? null,
      zeroPositions: blocked.zeroPositions,
      zeroOrders: blocked.zeroOrders,
      zeroFills: blocked.zeroFills,
      zeroSettlements: blocked.zeroSettlements,
      reasons: blocked.reasons,
      records: blocked.records,
      scanStartedAt: blocked.scanStartedAt,
    });
    assert.equal(proof.ok, true);
    if (!proof.ok) return;
    assert.equal(proof.roundTrip.inboundTransferId, PRE_BOUNDARY_INBOUND_TRANSFER_ID);
    assert.equal(proof.roundTrip.outboundTransferId, PRE_BOUNDARY_OUTBOUND_TRANSFER_ID);
    const acknowledgment = {
      id: "11111111-1111-4111-8111-111111111111",
      inboundTransferId: proof.roundTrip.inboundTransferId,
      outboundTransferId: proof.roundTrip.outboundTransferId,
      evidenceDigest: proof.roundTrip.evidenceDigest,
    };
    const waived = await capture({ transfers: roundTrip, crossTransfers: oldCross }, acknowledgment);
    assert.equal(waived.status, "clean");
    assert.match(waived.evidenceDigest ?? "", /^[0-9a-f]{64}$/);
    assert.deepEqual(waived.reasons, []);
    assert.equal(waived.preBoundaryRoundTripSatisfied, true);
    assert.equal(waived.zeroPriorPairTransfers, false);
    const canonical = waived.records.filter((record) => record.id.startsWith("old-account-wide-cross-"));
    assert.equal(canonical.length, 9);
    assert.ok(canonical.every((record) => record.classification === "ambiguous"));
    assert.ok(waived.records.some((record) => record.id === PRE_BOUNDARY_INBOUND_TRANSFER_ID));
    assert.ok(waived.records.some((record) => record.id === PRE_BOUNDARY_OUTBOUND_TRANSFER_ID));

    const thirdId = "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const third = await capture({
      transfers: [...roundTrip, {
        transfer_id: thirdId,
        from_subaccount: 1,
        to_subaccount: 0,
        exchange_index: 2,
        amount_cents: 100,
        created_ts: outboundCreated,
        status: "completed",
      }],
      crossTransfers: oldCross,
    }, acknowledgment);
    assert.equal(third.status, "blocked");
    assert.equal(third.evidenceDigest, null);
    assert.equal(third.preBoundaryRoundTripSatisfied, false);
    assert.ok(third.reasons.includes(`clean_prior_subaccount_transfer:${thirdId}`));

    const during = await capture({
      transfers: roundTrip,
      crossTransfers: [...oldCross, {
        transfer_id: "during-scan-cross",
        source_exchange_shard: 0,
        destination_exchange_shard: 2,
        amount: "1.0000",
        status: "completed",
        created_ts: Math.ceil(Date.now() / 1000) + 30,
      }],
    }, acknowledgment);
    assert.equal(during.status, "blocked");
    assert.ok(during.reasons.includes(
      "clean_cross_exchange_transfer_during_snapshot_scan:during-scan-cross",
    ));
    assert.equal(during.preBoundaryRoundTripSatisfied, false);

    const tied = await capture({
      transfers: roundTrip,
      crossTransfers: [...oldCross, {
        transfer_id: "tied-to-subaccount-1",
        source_subaccount: 1,
        source_exchange_shard: 2,
        destination_exchange_shard: 0,
        amount: "1.0000",
        status: "completed",
        created_ts: inboundCreated,
      }],
    });
    assert.equal(tied.status, "blocked");
    assert.ok(tied.reasons.includes("clean_prior_cross_exchange_transfer:tied-to-subaccount-1"));
    assert.equal(provePreBoundaryRoundTrip({
      availableCashMicros: tied.availableCashMicros,
      inventoryCashMicros: tied.inventoryCashMicros,
      portfolioValueMicros: tied.portfolioValueMicros ?? null,
      zeroPositions: tied.zeroPositions,
      zeroOrders: tied.zeroOrders,
      zeroFills: tied.zeroFills,
      zeroSettlements: tied.zeroSettlements,
      reasons: tied.reasons,
      records: tied.records,
      scanStartedAt: tied.scanStartedAt,
    }).ok, false);

    const timeless = await capture({
      transfers: roundTrip,
      crossTransfers: [...oldCross, {
        transfer_id: "timestampless-cross",
        source_exchange_shard: 2,
        destination_exchange_shard: 0,
        amount: "1.0000",
        status: "completed",
      }],
    });
    assert.equal(timeless.status, "blocked");
    assert.ok(timeless.reasons.includes(
      "clean_cross_exchange_transfer_timestamp_missing:timestampless-cross",
    ));

    const wrongInboundId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const wrongInbound = await capture({
      transfers: roundTrip.map((row) => row.transfer_id === PRE_BOUNDARY_INBOUND_TRANSFER_ID
        ? { ...row, transfer_id: wrongInboundId }
        : row),
      crossTransfers: oldCross,
    });
    assert.equal(wrongInbound.status, "blocked");
    assert.equal(provePreBoundaryRoundTrip({
      availableCashMicros: wrongInbound.availableCashMicros,
      inventoryCashMicros: wrongInbound.inventoryCashMicros,
      portfolioValueMicros: wrongInbound.portfolioValueMicros ?? null,
      zeroPositions: wrongInbound.zeroPositions,
      zeroOrders: wrongInbound.zeroOrders,
      zeroFills: wrongInbound.zeroFills,
      zeroSettlements: wrongInbound.zeroSettlements,
      reasons: wrongInbound.reasons,
      records: wrongInbound.records,
      scanStartedAt: wrongInbound.scanStartedAt,
    }).ok, false);

    const wrongOutboundId = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const wrongOutbound = await capture({
      transfers: roundTrip.map((row) => row.transfer_id === PRE_BOUNDARY_OUTBOUND_TRANSFER_ID
        ? { ...row, transfer_id: wrongOutboundId }
        : row),
      crossTransfers: oldCross,
    });
    assert.equal(provePreBoundaryRoundTrip({
      availableCashMicros: wrongOutbound.availableCashMicros,
      inventoryCashMicros: wrongOutbound.inventoryCashMicros,
      portfolioValueMicros: wrongOutbound.portfolioValueMicros ?? null,
      zeroPositions: wrongOutbound.zeroPositions,
      zeroOrders: wrongOutbound.zeroOrders,
      zeroFills: wrongOutbound.zeroFills,
      zeroSettlements: wrongOutbound.zeroSettlements,
      reasons: wrongOutbound.reasons,
      records: wrongOutbound.records,
      scanStartedAt: wrongOutbound.scanStartedAt,
    }).ok, false);

    const funded = await capture({
      transfers: roundTrip,
      crossTransfers: oldCross,
      availableCash: "0.0100",
      inventoryCash: "0.0100",
    });
    assert.equal(funded.status, "blocked");
    assert.ok(funded.reasons.includes("clean_pair_available_cash_not_zero"));
    assert.equal(provePreBoundaryRoundTrip({
      availableCashMicros: funded.availableCashMicros,
      inventoryCashMicros: funded.inventoryCashMicros,
      portfolioValueMicros: funded.portfolioValueMicros ?? null,
      zeroPositions: funded.zeroPositions,
      zeroOrders: funded.zeroOrders,
      zeroFills: funded.zeroFills,
      zeroSettlements: funded.zeroSettlements,
      reasons: funded.reasons,
      records: funded.records,
      scanStartedAt: funded.scanStartedAt,
    }).ok, false);
  } finally {
    restoreEnvironment();
  }
});

test("prospective clean-pair capture rejects pair order, fill, and settlement history", async () => {
  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "7";
  process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key-id";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKeyPem;
  const fixture = cleanPairFixture({
    currentOrders: [{
      order_id: "resting-order", ticker: "KXBTC15M", subaccount_number: 7,
      exchange_index: 2, status: "resting", remaining_count_fp: "1",
    }],
    historicalFills: [{
      trade_id: "prior-fill", ticker: "KXBTC15M", subaccount_number: 7,
      exchange_index: 2, fee_cost: "0.0100",
    }],
    settlements: [{
      ticker: "KXBTC15M", subaccount_number: 7, exchange_index: 2,
      event_ticker: "KXBTC15M", fee_cost: "0.0100",
    }],
  });
  globalThis.fetch = fixture.fetcher;
  try {
    const snapshot = await captureCleanPairSnapshot(7, "KXBTC15M");
    assert.equal(snapshot.status, "blocked");
    assert.equal(snapshot.zeroOrders, false);
    assert.equal(snapshot.zeroFills, false);
    assert.equal(snapshot.zeroSettlements, false);
    assert.equal(snapshot.evidenceDigest, null);
    assert.ok(snapshot.reasons.includes("clean_prior_order:resting-order"));
    assert.ok(snapshot.reasons.includes("clean_prior_fill:prior-fill"));
    assert.ok(snapshot.reasons.includes("clean_prior_settlement:KXBTC15M"));
  } finally {
    restoreEnvironment();
  }
});

test("prospective clean-pair capture rejects positive cash, exposure, wrong key, or wrong shard", async () => {
  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "7";
  process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key-id";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKeyPem;
  const cases = [
    {
      overrides: { availableCash: "0.0100", inventoryCash: "0.0100" },
      reason: "clean_pair_available_cash_not_zero",
    },
    {
      overrides: {
        positions: [{
          ticker: "KXBTC15M", subaccount_number: 7, exchange_index: 2,
          position_fp: "1", market_exposure_dollars: "0.5000",
        }],
      },
      reason: "clean_position_not_zero:KXBTC15M",
    },
    {
      overrides: { keySubaccount: 8 },
      reason: "clean_key_subaccount_restriction_unverified",
    },
    {
      overrides: { marketShard: 0 },
      reason: "clean_market_exchange_index_mismatch",
    },
  ];
  try {
    for (const item of cases) {
      const fixture = cleanPairFixture(item.overrides);
      globalThis.fetch = fixture.fetcher;
      const snapshot = await captureCleanPairSnapshot(7, "KXBTC15M");
      assert.equal(snapshot.status, "blocked");
      assert.equal(snapshot.evidenceDigest, null);
      assert.ok(snapshot.reasons.includes(item.reason), item.reason);
    }
  } finally {
    restoreEnvironment();
  }
});

test("prospective clean-pair capture fails closed on pagination and unavailable history", async () => {
  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "7";
  process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key-id";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKeyPem;
  const loop = cleanPairFixture({ loopHistoricalOrders: true });
  globalThis.fetch = loop.fetcher;
  try {
    const snapshot = await captureCleanPairSnapshot(7, "KXBTC15M");
    assert.equal(snapshot.status, "blocked");
    assert.equal(snapshot.evidenceDigest, null);
    assert.ok(snapshot.reasons.includes("clean_historical_orders_cursor_loop"));
  } finally {
    restoreEnvironment();
  }

  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "7";
  process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key-id";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKeyPem;
  const unavailable = cleanPairFixture({ historicalFillsUnavailable: true });
  globalThis.fetch = unavailable.fetcher;
  try {
    const snapshot = await captureCleanPairSnapshot(7, "KXBTC15M");
    assert.equal(snapshot.status, "blocked");
    assert.equal(snapshot.evidenceDigest, null);
    assert.ok(snapshot.reasons.includes("clean_historical_fills_http_error_http_404"));
  } finally {
    restoreEnvironment();
  }
});

test("dedicated pair evidence verifies authenticated shard-2 inventory with read-only GETs", async () => {
  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "2";
  process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key-id";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKeyPem;
  const requests: Array<{ path: string; query: URLSearchParams; keyId: string; method: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = init?.headers as Record<string, string>;
    const keyId = headers["KALSHI-ACCESS-KEY"]!;
    requests.push({
      path: url.pathname,
      query: url.searchParams,
      keyId,
      method: init?.method ?? "UNKNOWN",
    });
    assert.equal(init?.method, "GET");
    if (url.pathname.endsWith("/api_keys")) {
      assert.equal(keyId, "verifier-key-id");
      return {
        ok: true, status: 200,
        json: async () => ({
          api_keys: [{
            api_key_id: "test-key-id",
            subaccount: 2,
            scopes: ["read", "write::trade"],
          }],
        }),
      } as Response;
    }
    if (url.pathname.endsWith("/portfolio/balance")) {
      assert.equal(keyId, "test-key-id");
      assert.equal(url.searchParams.get("subaccount"), "2");
      assert.equal(url.searchParams.get("exchange_index"), "2");
      return {
        ok: true, status: 200,
        json: async () => ({
          balance_dollars: "25.0000",
          updated_ts: Math.floor(Date.now() / 1000),
        }),
      } as Response;
    }
    if (url.pathname.endsWith("/subaccounts/balances")) {
      assert.equal(keyId, "verifier-key-id");
      return {
        ok: true, status: 200,
        json: async () => ({
          subaccount_balances: [{
            subaccount_number: 2, exchange_index: 2,
            balance: "25.0000", updated_ts: 1_800_000_000,
          }, {
            subaccount_number: 2, exchange_index: 0,
            balance: "7.0000", updated_ts: 1_700_000_000,
          }],
        }),
      } as Response;
    }
    if (url.pathname.endsWith("/subaccounts/transfers")) {
      assert.equal(keyId, "verifier-key-id");
      return {
        ok: true, status: 200,
        json: async () => ({
          transfers: [
            { transfer_id: "other-shard", from_subaccount: 0, to_subaccount: 2,
              exchange_index: 0 },
            { transfer_id: "pair-transfer", from_subaccount: 0, to_subaccount: 2,
              exchange_index: 2 },
            { transfer_id: "unrelated-pair", from_subaccount: 0, to_subaccount: 3,
              exchange_index: 2 },
          ],
        }),
      } as Response;
    }
    if (url.pathname.endsWith("/intra_exchange_instance_transfers")) {
      assert.equal(keyId, "verifier-key-id");
      return {
        ok: true, status: 200,
        json: async () => ({
          transfers: [
            { transfer_id: "intra-other-shard", source_subaccount: 2,
              source_exchange_shard: 0, destination_subaccount: 0,
              destination_exchange_shard: 2 },
            { transfer_id: "intra-pair", source_subaccount: 2,
              source_exchange_shard: 2, destination_subaccount: 0,
              destination_exchange_shard: 2 },
          ],
        }),
      } as Response;
    }
    if (url.pathname.endsWith("/markets/KXBTC15M")) {
      assert.equal(keyId, "test-key-id");
      return {
        ok: true, status: 200,
        json: async () => ({ market: { ticker: "KXBTC15M", exchange_index: 2 } }),
      } as Response;
    }
    assert.equal(keyId, "test-key-id");
    assert.equal(url.searchParams.get("subaccount"), "2");
    const expectedIndex = url.pathname.endsWith("/settlements")
      ? null
      : url.searchParams.get("exchange_index");
    if (expectedIndex !== null) assert.equal(expectedIndex, "2");
    const key = url.pathname.endsWith("/positions") ? "market_positions"
      : url.pathname.endsWith("/orders") ? "orders"
        : url.pathname.endsWith("/fills") ? "fills"
          : url.pathname.endsWith("/settlements") ? "settlements"
            : null;
    assert.ok(key, `unexpected pair evidence path ${url.pathname}`);
    const historyRecord = (id: string, exchangeIndex: number) => ({
      [key === "orders" ? "order_id" : key === "fills" ? "trade_id" : "ticker"]: id,
      subaccount_number: 2,
      exchange_index: exchangeIndex,
    });
    const historyRows = url.pathname.includes("/historical/")
      ? [historyRecord("history-other-shard", 0), historyRecord("history-pair", 2)]
      : key === "settlements"
        ? [historyRecord("settlement-other-shard", 0), historyRecord("settlement-pair", 2)]
        : [];
    return { ok: true, status: 200, json: async () => ({ [key!]: historyRows }) } as Response;
  }) as typeof fetch;

  try {
    const evidence = await readKalshiDedicatedPairEvidence(2, "KXBTC15M");
    assert.deepEqual(evidence.pair, { subaccountNumber: 2, exchangeIndex: 2 });
    assert.equal(evidence.balance.balanceDollars, "25.0000");
    assert.equal(evidence.balance.availableCashDollars, "25.0000");
    assert.equal(
      evidence.records?.find((record) => record.feed === "scoped_balance")?.attribution,
      "balance_subaccount_exchange_filter",
    );
    assert.equal(evidence.marketExchangeIndex, 2);
    assert.equal(evidence.keyRestrictionVerified, true);
    assert.equal(evidence.tradePermissionVerified, true);
    assert.equal(evidence.allTimeHistoryExhaustive, false);
    assert.equal(evidence.exclusiveControlVerified, false);
    assert.deepEqual(evidence.recordCounts, {
      positions: 0, orders: 1, fills: 1, settlements: 1, transfers: 2,
    });
    assert.ok(requests.length >= 12);
    assert.ok(requests.every((request) => request.method === "GET"));
    assert.ok(requests.some((request) =>
      request.path.endsWith("/portfolio/positions") &&
      request.query.get("exchange_index") === "2"));
    assert.ok(requests.some((request) =>
      request.path.endsWith("/portfolio/fills") &&
      request.query.get("exchange_index") === "2"));
    assert.ok(requests.some((request) =>
      request.path.endsWith("/portfolio/settlements") &&
      request.query.get("subaccount") === "2"));
    assert.ok(requests.some((request) =>
      request.path.endsWith("/portfolio/balance") &&
      request.query.get("subaccount") === "2" &&
      request.query.get("exchange_index") === "2" &&
      request.keyId === "test-key-id"));
  } finally {
    restoreEnvironment();
  }
});

test("canonical pair evidence verifies funding, classifies same-subaccount shards, and nets all transfers", async () => {
  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "2";
  process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key-id";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKeyPem;
  const time = dedicatedPairFixture();
  const nowSeconds = time.nowSeconds;
  const baselineSeconds = time.baselineSeconds;
  const transfers = [
    {
      transfer_id: "funding-25", from_subaccount: 0, to_subaccount: 2,
      exchange_index: 2, amount_cents: 2500, created_ts: nowSeconds - 20,
      status: "completed",
    },
    {
      transfer_id: "offset-in", from_subaccount: 0, to_subaccount: 2,
      exchange_index: 2, amount_cents: 500, created_ts: baselineSeconds + 1,
      status: "completed",
    },
    {
      transfer_id: "offset-out", from_subaccount: 2, to_subaccount: 0,
      exchange_index: 2, amount_cents: 500, created_ts: baselineSeconds + 2,
      status: "completed",
    },
    {
      transfer_id: "same-subaccount-other-shard-transfer", from_subaccount: 0,
      to_subaccount: 2, exchange_index: 0, amount_cents: 700,
      created_ts: baselineSeconds + 3, status: "completed",
    },
    {
      transfer_id: "other-subaccount-same-shard-transfer", from_subaccount: 0,
      to_subaccount: 3, exchange_index: 2, amount_cents: 900,
      created_ts: baselineSeconds + 3, status: "completed",
    },
  ];
  const configuredFetcher = dedicatedPairFixture({
    balance: "24.590000",
    historicalOrders: [
      {
        order_id: "pair-order", ticker: "KXBTC15M", subaccount_number: 2,
        exchange_index: 2, side: "yes", action: "buy", type: "limit",
        status: "executed", initial_count_fp: "1", fill_count_fp: "1",
        remaining_count_fp: "0", yes_price_dollars: "0.400000",
        client_order_id: "pair-client", reduce_only: false,
        created_time: new Date((baselineSeconds + 4) * 1000).toISOString(),
      },
      {
        order_id: "same-subaccount-other-shard", ticker: "KXBTC15M-OTHER",
        subaccount_number: 2, exchange_index: 0, side: "yes", action: "buy",
        status: "executed", remaining_count_fp: "0",
        created_time: new Date((baselineSeconds + 5) * 1000).toISOString(),
      },
    ],
    currentFills: [{
      trade_id: "pair-fill", ticker: "KXBTC15M", subaccount_number: 2, exchange_index: 2,
      side: "yes", action: "buy", count_fp: "1", yes_price_dollars: "0.400000",
      fee_cost: "0.010000",
      created_time: new Date((baselineSeconds + 6) * 1000).toISOString(),
    }],
    transfers,
  });
  globalThis.fetch = configuredFetcher.fetcher;
  try {
    const evidence = await readKalshiDedicatedPairEvidence(2, "KXBTC15M", configuredFetcher.anchor);
    assert.equal(evidence.complete, false);
    assert.equal(
      evidence.reason,
      "pre_funding_zero_snapshot_provenance_unverified",
    );
    assert.equal(evidence.allTimeHistoryExhaustive, false);
    assert.equal(evidence.exclusiveControlVerified, false);
    assert.equal(evidence.postAnchorCashDeltaMicros, "-410000");
    assert.equal(evidence.checkpointDigest, null);
    assert.equal(evidence.fundingAnchor?.transferId, "funding-25");
    assert.equal(evidence.feeEvidence?.[0]?.feeMicros, "10000");
    assert.equal(
      evidence.records?.find((record) => record.id === "same-subaccount-other-shard")
        ?.classification,
      "elsewhere",
    );
    assert.equal(
      evidence.records?.find((record) => record.id === "same-subaccount-other-shard-transfer")
        ?.classification,
      "elsewhere",
    );
    assert.equal(
      evidence.records?.find((record) => record.id === "other-subaccount-same-shard-transfer")
        ?.classification,
      "elsewhere",
    );
    assert.deepEqual(
      evidence.records?.filter((record) => record.id === "offset-in" || record.id === "offset-out")
        .map((record) => record.cashDeltaMicros).sort(),
      ["-5000000", "5000000"],
      "offsetting transfers remain individually visible even though their net is zero",
    );
  } finally {
    restoreEnvironment();
  }
});

test("pair evidence fails closed on transfer-history cursor loops", async () => {
  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "2";
  process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key-id";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKeyPem;
  const fixture = dedicatedPairFixture({ loopHistoricalOrders: true });
  globalThis.fetch = fixture.fetcher;
  try {
    const evidence = await readKalshiDedicatedPairEvidence(2, "KXBTC15M", fixture.anchor);
    assert.equal(evidence.complete, false);
    assert.equal(evidence.reason, "historical_orders_cursor_loop");
    assert.equal(evidence.checkpointDigest, null);
  } finally {
    restoreEnvironment();
  }
});

test("pair evidence reports missing fill fees and unscoped cross-shard transfers", async () => {
  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "2";
  process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key-id";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKeyPem;
  const first = dedicatedPairFixture({
    currentFills: [{
      trade_id: "fee-less-fill", ticker: "KXBTC15M", subaccount_number: 2,
      exchange_index: 2, side: "yes", action: "buy", count_fp: "1",
      yes_price_dollars: "0.400000",
      created_time: new Date((Math.floor(Date.now() / 1000) - 4) * 1000).toISOString(),
    }],
  });
  globalThis.fetch = first.fetcher;
  try {
    const evidence = await readKalshiDedicatedPairEvidence(2, "KXBTC15M", first.anchor);
    assert.equal(evidence.complete, false);
    assert.ok(evidence.reason?.startsWith("missing_fee:fill:"));
  } finally {
    restoreEnvironment();
  }

  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "2";
  process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key-id";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKeyPem;
  const second = dedicatedPairFixture({
    crossTransfers: [{
      transfer_id: "unscoped-cross-transfer",
      source_exchange_shard: 2,
      destination_exchange_shard: 0,
      amount_cents: 100,
      status: "completed",
      created_ts: Math.floor(Date.now() / 1000) - 4,
    }],
  });
  globalThis.fetch = second.fetcher;
  try {
    const evidence = await readKalshiDedicatedPairEvidence(2, "KXBTC15M", second.anchor);
    assert.equal(evidence.complete, false);
    assert.equal(
      evidence.reason,
      "cross_exchange_transfer_subaccount_missing_after_clean_boundary:unscoped-cross-transfer",
    );
    assert.ok(evidence.records?.some((record) =>
      record.id === "unscoped-cross-transfer" && record.classification === "ambiguous"));
  } finally {
    restoreEnvironment();
  }
});

test("pre-anchor unscoped cross-shard transfers remain in the digest without blocking", async () => {
  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "2";
  process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key-id";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKeyPem;
  const fixture = dedicatedPairFixture();
  const preAnchorCrossTransfer = {
    transfer_id: "primary-cross-before-funding",
    source_exchange_shard: 0,
    destination_exchange_shard: 2,
    amount_cents: 2500,
    status: "completed",
    created_ts: fixture.nowSeconds - 40,
  };
  const withPreAnchorTransfer = dedicatedPairFixture({
    crossTransfers: [preAnchorCrossTransfer],
  });
  globalThis.fetch = withPreAnchorTransfer.fetcher;
  try {
    const evidence = await readKalshiDedicatedPairEvidence(
      2, "KXBTC15M", withPreAnchorTransfer.anchor,
    );
    assert.equal(evidence.complete, false);
    assert.equal(
      evidence.reason,
      "pre_funding_zero_snapshot_provenance_unverified",
    );
    assert.ok(evidence.records?.some((record) =>
      record.id === "primary-cross-before-funding" && record.classification === "ambiguous"));
    assert.equal(evidence.checkpointDigest, null);
  } finally {
    restoreEnvironment();
  }
});

test("funded pair evidence permanently blocks ambiguous cross-shard transfers after clean boundary before funding", async () => {
  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "2";
  process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key-id";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKeyPem;
  const fixture = dedicatedPairFixture();
  const betweenBoundaryAndFunding = dedicatedPairFixture({
    crossTransfers: [{
      transfer_id: "cross-transfer-after-clean-before-funding",
      source_exchange_shard: 0,
      destination_exchange_shard: 2,
      amount_cents: 2500,
      status: "completed",
      created_ts: fixture.nowSeconds - 22,
    }],
  });
  globalThis.fetch = betweenBoundaryAndFunding.fetcher;
  try {
    const evidence = await readKalshiDedicatedPairEvidence(
      2, "KXBTC15M", betweenBoundaryAndFunding.anchor,
    );
    assert.equal(evidence.complete, false);
    assert.ok(evidence.reasons?.includes(
      "cross_exchange_transfer_subaccount_missing_after_clean_boundary:" +
        "cross-transfer-after-clean-before-funding",
    ));
    assert.ok(evidence.records?.some((record) =>
      record.id === "cross-transfer-after-clean-before-funding" &&
      record.classification === "ambiguous"));
  } finally {
    restoreEnvironment();
  }
});

test("an extra pair transfer before the funding baseline blocks clean initialization", async () => {
  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "2";
  process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key-id";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKeyPem;
  const fixture = dedicatedPairFixture();
  const extraTransfer = {
    transfer_id: "unexpected-pre-anchor-transfer-in",
    from_subaccount: 0,
    to_subaccount: 2,
    exchange_index: 2,
    amount_cents: 500,
    created_ts: fixture.nowSeconds - 25,
    status: "completed",
  };
  const offsettingTransfer = {
    transfer_id: "unexpected-pre-anchor-transfer-out",
    from_subaccount: 2,
    to_subaccount: 0,
    exchange_index: 2,
    amount_cents: 500,
    created_ts: fixture.nowSeconds - 24,
    status: "completed",
  };
  const withExtraTransfer = dedicatedPairFixture({
    transfers: [
      extraTransfer,
      offsettingTransfer,
      {
        transfer_id: "funding-25",
        from_subaccount: 0,
        to_subaccount: 2,
        exchange_index: 2,
        amount_cents: 2500,
        created_ts: fixture.nowSeconds - 20,
        status: "completed",
      },
    ],
  });
  globalThis.fetch = withExtraTransfer.fetcher;
  try {
    const evidence = await readKalshiDedicatedPairEvidence(
      2, "KXBTC15M", withExtraTransfer.anchor,
    );
    assert.equal(evidence.complete, false);
    assert.equal(evidence.reason, "pre_baseline_pair_transfer:unexpected-pre-anchor-transfer-in");
    assert.ok(evidence.reasons?.includes(
      "pre_baseline_pair_transfer:unexpected-pre-anchor-transfer-out",
    ));
    assert.ok(evidence.reasons?.includes(
      "pre_funding_zero_snapshot_provenance_unverified",
    ));
    assert.ok(evidence.records?.some((record) =>
      record.id === "unexpected-pre-anchor-transfer-in" &&
      record.classification === "pair"));
    assert.ok(evidence.records?.some((record) =>
      record.id === "unexpected-pre-anchor-transfer-out" &&
      record.classification === "pair"));
    assert.equal(evidence.checkpointDigest, null);
  } finally {
    restoreEnvironment();
  }
});

test("pair evidence requires the exact reconciled twenty-five-dollar funding transfer", async () => {
  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "2";
  process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key-id";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKeyPem;
  const fixture = dedicatedPairFixture({ transfers: [] });
  globalThis.fetch = fixture.fetcher;
  try {
    const evidence = await readKalshiDedicatedPairEvidence(2, "KXBTC15M", fixture.anchor);
    assert.equal(evidence.complete, false);
    assert.equal(evidence.reason, "funding_anchor_transfer_not_found");
    assert.equal(evidence.postAnchorCashDeltaMicros, "0");
  } finally {
    restoreEnvironment();
  }
});

test("pair evidence requires explicit authenticated zero and twenty-five-dollar snapshots", async () => {
  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "2";
  process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key-id";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKeyPem;
  const fixture = dedicatedPairFixture();
  globalThis.fetch = fixture.fetcher;
  try {
    const evidence = await readKalshiDedicatedPairEvidence(2, "KXBTC15M", {
      ...fixture.anchor,
      preFundingZeroSnapshot: undefined,
    });
    assert.equal(evidence.complete, false);
    assert.equal(evidence.reason, "pre_funding_zero_snapshot_unverified");
  } finally {
    restoreEnvironment();
  }

  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "2";
  process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key-id";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKeyPem;
  const noAvailableCash = dedicatedPairFixture({ omitAvailableCash: true });
  globalThis.fetch = noAvailableCash.fetcher;
  try {
    const evidence = await readKalshiDedicatedPairEvidence(
      2, "KXBTC15M", noAvailableCash.anchor,
    );
    assert.equal(evidence.complete, false);
    assert.equal(evidence.reason, "scoped_available_cash_field_missing");
    assert.equal(evidence.balance.availableCashDollars, null);
    assert.equal(
      evidence.balance.balanceSemantics,
      "subaccount_inventory_plus_scoped_available_cash",
    );
  } finally {
    restoreEnvironment();
  }

  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "2";
  process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key-id";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKeyPem;
  const mismatchedCash = dedicatedPairFixture({
    balance: "25.000000",
    availableCash: "24.990000",
  });
  globalThis.fetch = mismatchedCash.fetcher;
  try {
    const evidence = await readKalshiDedicatedPairEvidence(
      2, "KXBTC15M", mismatchedCash.anchor,
    );
    assert.equal(evidence.complete, false);
    assert.equal(evidence.reason, "pair_inventory_available_and_resting_entry_mismatch");
  } finally {
    restoreEnvironment();
  }
});

test("caller-forged funding snapshot flags cannot prove pre-funding provenance", async () => {
  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "2";
  process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key-id";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKeyPem;
  const fixture = dedicatedPairFixture();
  globalThis.fetch = fixture.fetcher;
  try {
    const forgedAnchor = {
      ...fixture.anchor,
      preFundingZeroSnapshot: {
        ...fixture.anchor.preFundingZeroSnapshot,
        authenticated: true as const,
        evidenceDigest: "f".repeat(64),
      },
    };
    const evidence = await readKalshiDedicatedPairEvidence(
      2, "KXBTC15M", forgedAnchor,
    );
    assert.equal(evidence.complete, false);
    assert.equal(
      evidence.reason,
      "pre_funding_zero_snapshot_provenance_unverified",
    );
    assert.ok(evidence.reasons?.includes(
      "pre_funding_zero_snapshot_provenance_unverified",
    ));
    assert.equal(evidence.allTimeHistoryExhaustive, false);
    assert.equal(evidence.checkpointDigest, null);
    assert.equal(evidence.postAnchorCashDeltaMicros, "0");
    assert.ok(evidence.records?.some((record) => record.feed === "scoped_balance"));
  } finally {
    restoreEnvironment();
  }
});

test("funding anchor accepts documented transfer history without a status field", async () => {
  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "2";
  process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key-id";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKeyPem;
  const noStatusFixture = dedicatedPairFixture({ omitAnchorStatus: true });
  globalThis.fetch = noStatusFixture.fetcher;
  try {
    const evidence = await readKalshiDedicatedPairEvidence(
      2, "KXBTC15M", noStatusFixture.anchor,
    );
    assert.ok(!evidence.reasons?.includes("funding_anchor_transfer_mismatch"));
  } finally {
    restoreEnvironment();
  }
});

test("resting pair orders and remaining quantity block initializer evidence", async () => {
  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "2";
  process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key-id";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKeyPem;
  const fixture = dedicatedPairFixture({
    historicalOrders: [{
      order_id: "resting-pair-order",
      ticker: "KXBTC15M",
      subaccount_number: 2,
      exchange_index: 2,
      side: "yes",
      action: "buy",
      type: "limit",
      status: "resting",
      initial_count_fp: "1",
      fill_count_fp: "0",
      remaining_count_fp: "1",
      yes_price_dollars: "0.500000",
      client_order_id: "resting-client",
      reduce_only: false,
      created_time: new Date((Math.floor(Date.now() / 1000) - 4) * 1000).toISOString(),
    }],
  });
  globalThis.fetch = fixture.fetcher;
  try {
    const evidence = await readKalshiDedicatedPairEvidence(2, "KXBTC15M", fixture.anchor);
    assert.equal(evidence.complete, false);
    assert.ok(evidence.reason?.startsWith("pair_active_order_missing_from_current_snapshot:"));
    assert.ok(evidence.records?.some((record) =>
      record.id === "resting-pair-order" && record.classification === "pair"));
  } finally {
    restoreEnvironment();
  }
});

test("pair activity without an event timestamp is never ignored", async () => {
  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "2";
  process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key-id";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKeyPem;
  const fixture = dedicatedPairFixture({
    historicalOrders: [{
      order_id: "pair-order-without-time",
      ticker: "KXBTC15M",
      subaccount_number: 2,
      exchange_index: 2,
      side: "yes",
      action: "buy",
      status: "executed",
      remaining_count_fp: "0",
    }],
  });
  globalThis.fetch = fixture.fetcher;
  try {
    const evidence = await readKalshiDedicatedPairEvidence(2, "KXBTC15M", fixture.anchor);
    assert.equal(evidence.complete, false);
    assert.equal(evidence.reason, "missing_timestamp:historical_order:pair-order-without-time");
  } finally {
    restoreEnvironment();
  }
});

test("settlement payout does not deduct the fill fee twice and aggregate fees reconcile", async () => {
  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "2";
  process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key-id";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKeyPem;
  const baselineSeconds = Math.floor(Date.now() / 1000) - 10;
  const fixture = dedicatedPairFixture({
    balance: "25.590000",
    currentFills: [{
      trade_id: "settled-fill",
      ticker: "KXBTC15M-SETTLED",
      subaccount_number: 2,
      exchange_index: 2,
      side: "yes",
      action: "buy",
      count_fp: "1",
      yes_price_dollars: "0.400000",
      fee_cost: "0.010000",
      created_time: new Date((baselineSeconds + 1) * 1000).toISOString(),
    }],
    settlements: [{
      ticker: "KXBTC15M-SETTLED",
      event_ticker: "KXBTC15M",
      exchange_index: 2,
      revenue: 100,
      fee_cost: "0.010000",
      settled_time: new Date((baselineSeconds + 2) * 1000).toISOString(),
    }],
  });
  globalThis.fetch = fixture.fetcher;
  try {
    const evidence = await readKalshiDedicatedPairEvidence(2, "KXBTC15M", fixture.anchor);
    assert.equal(evidence.complete, false);
    assert.equal(
      evidence.reason,
      "pre_funding_zero_snapshot_provenance_unverified",
    );
    assert.equal(evidence.postAnchorCashDeltaMicros, "590000");
    assert.equal(evidence.allTimeHistoryExhaustive, false);
    assert.equal(evidence.checkpointDigest, null);
    const settlement = evidence.records?.find((record) => record.feed === "settlement");
    assert.equal(settlement?.cashDeltaMicros, "1000000");
    assert.equal(settlement?.feeMicros, "10000");
    assert.equal(evidence.feeEvidence?.filter((item) =>
      item.ticker === "KXBTC15M-SETTLED").length, 2);
  } finally {
    restoreEnvironment();
  }

  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "2";
  process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key-id";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKeyPem;
  const mismatchSeconds = Math.floor(Date.now() / 1000) - 10;
  const mismatch = dedicatedPairFixture({
    balance: "25.590000",
    currentFills: [{
      trade_id: "settled-fill-mismatch",
      ticker: "KXBTC15M-SETTLED",
      subaccount_number: 2,
      exchange_index: 2,
      side: "yes",
      action: "buy",
      count_fp: "1",
      yes_price_dollars: "0.400000",
      fee_cost: "0.010000",
      created_time: new Date((mismatchSeconds + 1) * 1000).toISOString(),
    }],
    settlements: [{
      ticker: "KXBTC15M-SETTLED",
      event_ticker: "KXBTC15M",
      exchange_index: 2,
      revenue: 100,
      fee_cost: "0.020000",
      settled_time: new Date((mismatchSeconds + 2) * 1000).toISOString(),
    }],
  });
  globalThis.fetch = mismatch.fetcher;
  try {
    const evidence = await readKalshiDedicatedPairEvidence(2, "KXBTC15M", mismatch.anchor);
    assert.equal(evidence.complete, false);
    assert.equal(evidence.reason, "settlement_fee_aggregate_mismatch:KXBTC15M-SETTLED");
  } finally {
    restoreEnvironment();
  }
});

test("dedicated pair evidence fails closed for absent or mismatched shard identity", async () => {
  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "2";
  process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier-key-id";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = privateKeyPem;
  let mismatch: "market" | "position" | "order" | "fill" |
    "missing-index" | "balance" | "balance-missing-pair" |
    "transfer" | "transfer-missing-index" |
    "intra-transfer" | "intra-missing-index" | "key" = "market";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/api_keys")) {
      return {
        ok: true, status: 200,
        json: async () => ({
          api_keys: [{
            api_key_id: "test-key-id",
            subaccount: mismatch === "key" ? 1 : 2,
            scopes: ["read", "write::trade"],
          }],
        }),
      } as Response;
    }
    if (url.pathname.endsWith("/portfolio/balance")) {
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers["KALSHI-ACCESS-KEY"], "test-key-id");
      assert.equal(url.searchParams.get("subaccount"), "2");
      assert.equal(url.searchParams.get("exchange_index"), "2");
      return {
        ok: true, status: 200,
        json: async () => ({
          balance_dollars: "25.0000",
          updated_ts: Math.floor(Date.now() / 1000),
        }),
      } as Response;
    }
    if (url.pathname.endsWith("/subaccounts/balances")) {
      return {
        ok: true, status: 200,
        json: async () => ({
          subaccount_balances: mismatch === "balance-missing-pair"
            ? [{ exchange_index: 2, balance: "25.0000", updated_ts: 1_800_000_000 }]
            : [{
                subaccount_number: 2,
                exchange_index: mismatch === "balance" ? 0 : 2,
                balance: "25.0000",
                updated_ts: 1_800_000_000,
              }],
        }),
      } as Response;
    }
    if (url.pathname.endsWith("/subaccounts/transfers")) {
      return {
        ok: true, status: 200,
        json: async () => ({
          transfers: mismatch === "transfer"
            ? [{ transfer_id: "conflicting-pair", from_subaccount: 0, to_subaccount: 2,
                subaccount_number: 1, exchange_index: 2 }]
            : mismatch === "transfer-missing-index"
              ? [{ transfer_id: "missing-shard", from_subaccount: 0, to_subaccount: 2 }]
            : [],
        }),
      } as Response;
    }
    if (url.pathname.endsWith("/intra_exchange_instance_transfers")) {
      return {
        ok: true, status: 200,
        json: async () => ({
          transfers: mismatch === "intra-transfer"
            ? [{ transfer_id: "conflicting-pair", source_subaccount: 2,
                source_exchange_shard: 2, subaccount_number: 1 }]
            : mismatch === "intra-missing-index"
              ? [{ transfer_id: "missing-shard", source_subaccount: 2 }]
            : [],
        }),
      } as Response;
    }
    if (url.pathname.endsWith("/markets/KXBTC15M")) {
      return {
        ok: true, status: 200,
        json: async () => ({
          market: { ticker: "KXBTC15M", exchange_index: mismatch === "market" ? 0 : 2 },
        }),
      } as Response;
    }
    const key = url.pathname.endsWith("/positions") ? "market_positions"
      : url.pathname.endsWith("/orders") ? "orders"
        : url.pathname.endsWith("/fills") ? "fills"
          : url.pathname.endsWith("/settlements") ? "settlements"
            : null;
    assert.ok(key);
    const wrongRecord = mismatch === "position" && key === "market_positions" ||
      mismatch === "order" && key === "orders" ||
      mismatch === "fill" && key === "fills";
    const missingIndex = mismatch === "missing-index" &&
      (key === "fills" || key === "settlements");
    const values = missingIndex
      ? [{ ticker: "KXBTC15M", subaccount_number: 2 }]
      : wrongRecord
      ? [{ ticker: "KXBTC15M", subaccount_number: 2, exchange_index: 0 }]
      : [];
    return { ok: true, status: 200, json: async () => ({ [key!]: values }) } as Response;
  }) as typeof fetch;

  try {
    for (const kind of [
      "market", "position", "order", "fill",
      "missing-index", "balance", "balance-missing-pair",
      "transfer", "transfer-missing-index",
      "intra-transfer", "intra-missing-index", "key",
    ] as const) {
      mismatch = kind;
      const evidence = await readKalshiDedicatedPairEvidence(2, "KXBTC15M");
      assert.equal(evidence.complete, false, `${kind} mismatch must block pair verification`);
      assert.ok(evidence.reason, `${kind} mismatch exposes a reason`);
    }
    await assert.rejects(
      readKalshiDedicatedPairEvidence(2.5, "KXBTC15M"),
      /INVALID_CREDENTIALS/,
      "invalid assigned subaccount numbers are rejected before any fetch",
    );
  } finally {
    restoreEnvironment();
  }
});

test("normalized account and history records preserve only explicit exchange shard indices", async () => {
  setCredentials();
  process.env.KALSHI_BOT_SUBACCOUNT = "1";
  const ticker = "KXBTC15M-SHARD-DTO";
  let shardValue: unknown = 2;
  let omitShard = false;
  const withShard = (record: Record<string, unknown>) => omitShard
    ? record
    : { ...record, exchange_index: shardValue };
  const order = (id: string) => withShard({
    order_id: id, client_order_id: `client-${id}`, ticker, side: "yes", action: "buy",
    type: "limit", status: "resting", yes_price_dollars: "0.4",
    initial_count_fp: "1", fill_count_fp: "0", remaining_count_fp: "1",
    created_time: "2026-09-25T12:00:00Z",
  });
  const fill = (id: string) => withShard({
    trade_id: id, order_id: "shard-order", ticker, side: "yes", action: "buy",
    count_fp: "1", yes_price_dollars: "0.4", fee_cost: "0.001",
    created_time: "2026-09-25T12:00:00Z",
  });
  const position = () => withShard({
    ticker, position_fp: "1", market_exposure_dollars: "0.4",
    realized_pnl_dollars: "0",
  });
  const settlement = () => withShard({
    ticker, event_ticker: "KXBTC15M-EVENT", market_result: "yes",
    yes_count_fp: "1", yes_total_cost_dollars: "0.4",
    no_count_fp: "0", no_total_cost_dollars: "0",
    revenue: 100, settled_time: "2026-09-25T12:00:00Z",
  });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const historical = path.includes("/historical/");
    const payload = path.endsWith("/balance") ? { balance_dollars: "25.00" }
      : path.endsWith("/positions") ? { market_positions: [position()] }
        : path.endsWith("/settlements") ? { settlements: [settlement()] }
          : path.endsWith("/orders") ? { orders: [order(historical ? "history-order" : "shard-order")] }
            : { fills: [fill(historical ? "history-fill" : "shard-fill")] };
    return { ok: true, status: 200, json: async () => payload } as Response;
  }) as typeof fetch;

  try {
    const account = await readKalshiAccount();
    assert.equal(account.openOrders[0]?.exchangeIndex, 2);
    assert.equal(account.positions[0]?.exchangeIndex, 2);
    assert.equal(account.fills[0]?.exchangeIndex, 2);

    const activity = await readKalshiAccountActivity();
    assert.equal(activity.orders[0]?.exchangeIndex, 2);
    assert.equal(activity.fills[0]?.exchangeIndex, 2);

    const submission = await readKalshiSubmissionEvidence(ticker);
    assert.ok(submission.orders.every((record) => record.exchangeIndex === 2));
    assert.equal(submission.fills[0]?.exchangeIndex, 2);
    assert.equal(submission.historicalFills?.[0]?.exchangeIndex, 2);

    const historical = await readKalshiHistoricalFills([ticker]);
    assert.equal(historical.fills[0]?.exchangeIndex, 2);
    assert.equal((await readKalshiSettlements()).settlements[0]?.exchangeIndex, 2);

    // Missing and malformed shard values remain explicitly unproven rather
    // than being guessed from the KXBTC15M ticker.
    for (const invalid of [undefined, "2", -1, 2.5]) {
      omitShard = invalid === undefined;
      shardValue = invalid;
      const missingAccount = await readKalshiAccount();
      assert.equal(missingAccount.openOrders[0]?.exchangeIndex, null);
      assert.equal(missingAccount.positions[0]?.exchangeIndex, null);
      assert.equal(missingAccount.fills[0]?.exchangeIndex, null);
      assert.equal((await readKalshiSettlements()).settlements[0]?.exchangeIndex, null);
      assert.equal((await readKalshiHistoricalFills([ticker])).fills[0]?.exchangeIndex, null);
    }
  } finally {
    restoreEnvironment();
  }
});

test("HTTP failures expose only error type and status, never response or credentials", async () => {
  setCredentials();
  const privateCredential = privateKeyPem;
  globalThis.fetch = (async () => ({
    ok: false,
    status: 403,
    json: async () => ({ message: privateCredential }),
  }) as Response) as typeof fetch;
  try {
    await assert.rejects(readKalshiAccount(), (error: Error) => {
      assert.match(error.message, /HTTP_ERROR/);
      assert.match(error.message, /403/);
      assert.doesNotMatch(error.message, /test-key-id|BEGIN PRIVATE KEY/);
      assert.equal(JSON.stringify(error).includes(privateCredential), false);
      return true;
    });
  } finally {
    restoreEnvironment();
  }
});