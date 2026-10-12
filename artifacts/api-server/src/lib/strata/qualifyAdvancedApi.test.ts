import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { getScopedKalshiJson, listOpenKalshiMarkets, mutateScopedKalshi, OPEN_MARKET_MAX_PAGES, OPEN_MARKET_PAGE_LIMIT } from "../kalshiAccountClient";
import { sanitizePublic } from "../v13-production/sanitize";
import { closedUserScopePort, createUserExecutionRouter } from "../../routes/userExecutionRouter";
import { createDatabaseUserScopePort, type UserScopeQuery } from "./userScopeDatabase";
import {
  createMemoryQualificationGuard,
  createSqlQualificationGuard,
  dollarTenThousandths,
  qualificationOrderBody,
  QUALIFICATION_CONFIRMATION,
  QUALIFICATION_ORDER_PATH,
  QUALIFICATION_UPGRADE_PATH,
  RESIDUAL_RISK_CONFIRMATION,
  qualifyAdvancedApi,
  selectQualificationMarket,
  type QualificationExchangeResult,
  type QualificationTransport,
} from "./qualifyAdvancedApi";

const NOW = Date.parse("2026-10-11T00:00:00.000Z");
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

function market(ticker: string, ask: string, close = "2026-12-01T00:00:00.000Z", status = "active") {
  return { ticker, status, close_time: close, yes_ask_dollars: ask, yes_bid_dollars: "0.4000" };
}

function ok(body: unknown, status = 200): QualificationExchangeResult {
  return { status, body, unreadable: false };
}

function v2Cancel(orderId = "ord-1", clientOrderId: string | null = "client-1", reducedBy = "1.00"): QualificationExchangeResult {
  return ok({
    order_id: orderId,
    ...(clientOrderId === null ? {} : { client_order_id: clientOrderId }),
    reduced_by: reducedBy,
    ts_ms: 1234567890,
  });
}

function harness(overrides: Partial<{
  balance: unknown;
  limits: unknown[];
  markets: unknown[] | "uncertain";
  create: QualificationExchangeResult | "uncertain";
  cancel: QualificationExchangeResult | "uncertain";
  upgrade: QualificationExchangeResult | "uncertain";
}> = {}) {
  const calls: Array<{ method: string; path: string; body?: unknown; keyId: string }> = [];
  let limitReads = 0;
  const limits = overrides.limits ?? [{ usage_tier: "basic" }, { usage_tier: "advanced" }];
  const transport: QualificationTransport = {
    async get(creds, path) {
      calls.push({ method: "GET", path, keyId: creds.keyId });
      if (path.endsWith("/portfolio/balance")) return ok(overrides.balance ?? { balance: 2500, portfolio_value: 0 });
      if (path.endsWith("/account/limits")) return ok(limits[Math.min(limitReads++, limits.length - 1)]);
      return ok(null, 404);
    },
    async post(creds, path, body) {
      calls.push({ method: "POST", path, body, keyId: creds.keyId });
      if (path === QUALIFICATION_UPGRADE_PATH) return overrides.upgrade ?? ok({}, 201);
      return overrides.create ?? ok({ order_id: "ord-1", fill_count: "0.00", remaining_count: "1.00" }, 201);
    },
    async delete(creds, path, query) {
      calls.push({ method: "DELETE", path, body: query, keyId: creds.keyId });
      return overrides.cancel ?? v2Cancel();
    },
    async listOpenMarkets() {
      calls.push({ method: "GET", path: "/markets", keyId: "" });
      return overrides.markets ?? [
        market("EXPIRED-MKT", "0.5000", "2020-01-01T00:00:00.000Z"),
        market("TOUCH-MKT", "0.0100"),
        market("SAFE-MKT", "0.4500"),
      ];
    },
  };
  const guard = createMemoryQualificationGuard();
  const run = (confirm: unknown = QUALIFICATION_CONFIRMATION, connectionId = "conn-1") => qualifyAdvancedApi({
    creds: { keyId: "key-user", privateKey: "stored-private-key" },
    connectionId,
    confirm,
    guard,
    transport,
    now: NOW,
    newClientOrderId: () => "client-1",
  });
  const orders = () => calls.filter((call) => call.method === "POST" && call.path === QUALIFICATION_ORDER_PATH);
  const cancels = () => calls.filter((call) => call.method === "DELETE");
  const upgrades = () => calls.filter((call) => call.method === "POST" && call.path === QUALIFICATION_UPGRADE_PATH);
  return { calls, run, orders, cancels, upgrades };
}

test("a one-cent ask and an expired market are not qualification markets", () => {
  const selected = selectQualificationMarket([
    market("EXPIRED-MKT", "0.8000", "2020-01-01T00:00:00.000Z"),
    market("TOUCH-MKT", "0.0100"),
    { ticker: "SAFE-MKT", status: "active", close_time: "2026-12-01T00:00:00.000Z", yes_ask: 2 },
  ], NOW);
  assert.equal(selected?.ticker, "SAFE-MKT");
  assert.equal(selectQualificationMarket([market("TOUCH-MKT", "0.0100")], NOW), null);
});

test("qualification asks use exact four-decimal dollars and reject unsafe or malformed prices", () => {
  assert.equal(dollarTenThousandths("0.0100"), 100);
  assert.equal(dollarTenThousandths("0.0101"), 101);
  assert.equal(dollarTenThousandths("0.0123"), 123);
  assert.equal(dollarTenThousandths("0.0199"), 199);
  assert.equal(dollarTenThousandths("0.0200"), 200);
  assert.equal(dollarTenThousandths("0.5600"), 5600);
  assert.equal(dollarTenThousandths("1.0000"), 10000);
  const chosen = (ask: string) => selectQualificationMarket([market("PX-MKT", ask)], NOW)?.ticker ?? null;
  assert.equal(chosen("0.0100"), null);
  assert.equal(chosen("0.0101"), "PX-MKT");
  assert.equal(chosen("0.0123"), "PX-MKT");
  assert.equal(chosen("0.0199"), "PX-MKT");
  assert.equal(chosen("0.0200"), "PX-MKT");
  assert.equal(chosen("0.5600"), "PX-MKT");
  assert.equal(chosen("nope"), null);
  assert.equal(chosen("-0.0100"), null);
  assert.equal(chosen("1.0001"), null);
  assert.equal(chosen("0.01001"), null);
  assert.equal(dollarTenThousandths("-0.0100"), null);
  assert.equal(dollarTenThousandths("1.0001"), null);
  assert.equal(dollarTenThousandths("0.01001"), null);
  const highest = selectQualificationMarket([
    market("LOW-SAFE", "0.0123"),
    market("HIGH-SAFE", "0.5600"),
  ], NOW);
  assert.equal(highest?.ticker, "HIGH-SAFE");
  const dollarsWin = selectQualificationMarket([{
    ticker: "DOLLAR-WINS", status: "open", close_time: "2026-12-01T00:00:00.000Z",
    yes_ask_dollars: "0.0100", yes_ask: 50,
  }], NOW);
  assert.equal(dollarsWin, null);
  const legacy = selectQualificationMarket([{
    ticker: "LEGACY-ASK", status: "open", close_time: "2026-12-01T00:00:00.000Z", yes_ask: 2,
  }], NOW);
  assert.equal(legacy?.ticker, "LEGACY-ASK");
});

test("closing, paused, and closed markets are not qualification markets", () => {
  const boundary = new Date(NOW + 60_000).toISOString();
  assert.equal(selectQualificationMarket([market("CLOSING", "0.5600", boundary)], NOW), null);
  assert.equal(selectQualificationMarket([market("PAUSED", "0.5600", "2026-12-01T00:00:00.000Z", "paused")], NOW), null);
  assert.equal(selectQualificationMarket([market("CLOSED", "0.5600", "2026-12-01T00:00:00.000Z", "closed")], NOW), null);
  const later = new Date(NOW + 60_001).toISOString();
  assert.equal(selectQualificationMarket([market("STILL-OPEN", "0.0123", later, "open")], NOW)?.ticker, "STILL-OPEN");
});

test("open-market discovery follows a cursor only until a safe ask and stays bounded", async () => {
  const urls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    headers.push(Object.fromEntries(new Headers(init?.headers).entries()));
    const page = urls.length;
    const markets = page === 1
      ? Array.from({ length: 100 }, (_, index) => market(`UNSAFE-${index}`, "0.0100"))
      : [market("LATER-SAFE", "0.0123")];
    const cursor = page < 5 ? `cursor-${page}` : "";
    return new Response(JSON.stringify({ markets, cursor }), { status: 200 });
  };
  const found = await listOpenKalshiMarkets(fetchImpl as typeof fetch, (markets) => selectQualificationMarket(markets, NOW) !== null);
  assert.equal(urls.length, 2);
  assert.equal(found.some((item) => (item as { ticker?: string }).ticker === "LATER-SAFE"), true);
  assert.match(urls[0] ?? "", new RegExp(`status=open`));
  assert.match(urls[0] ?? "", /mve_filter=exclude/);
  assert.match(urls[0] ?? "", new RegExp(`limit=${OPEN_MARKET_PAGE_LIMIT}`));
  assert.match(urls[1] ?? "", /cursor=cursor-1/);
  assert.equal(headers.every((header) => header["kalshi-access-key"] === undefined && header.authorization === undefined), true);
  const bounded: string[] = [];
  const keepGoing = async (url: string | URL | Request) => {
    bounded.push(String(url));
    return new Response(JSON.stringify({
      markets: [market(`NONE-${bounded.length}`, "0.0100")],
      cursor: `more-${bounded.length}`,
    }), { status: 200 });
  };
  await listOpenKalshiMarkets(keepGoing as typeof fetch);
  assert.equal(bounded.length, OPEN_MARKET_MAX_PAGES);
  await assert.rejects(listOpenKalshiMarkets((async () => new Response(JSON.stringify({
    markets: [market("UNSAFE-0", "0.0100")],
    cursor: "bad cursor",
  }), { status: 200 })) as typeof fetch));
});

test("no safe market reports scan counts and places no order", async () => {
  const flow = harness({ markets: [
    market("TOUCH-MKT", "0.0100"),
    market("BAD-ASK", "nope"),
    market("CLOSED", "0.5000", "2026-12-01T00:00:00.000Z", "closed"),
  ] });
  const result = await flow.run();
  assert.equal(result.status, "NO_SAFE_QUALIFICATION_MARKET");
  assert.equal(result.marketsScanned, 3);
  assert.equal(result.openMarkets, 2);
  assert.equal(result.validCloseTimes, 2);
  assert.equal(result.validAskPrices, 1);
  assert.equal(result.safeAskPrices, 0);
  assert.equal(flow.orders().length, 0);
  assert.equal(JSON.stringify(result).includes("stored-private-key"), false);
});

test("basic user with exact confirmation places one post-only qualification order", async () => {
  const flow = harness();
  const result = await flow.run();
  assert.equal(result.status, "ADVANCED_VERIFIED");
  assert.equal(result.usageTier, "advanced");
  assert.equal(result.qualificationOrderCreated, true);
  assert.equal(result.qualificationOrderCanceled, true);
  assert.equal(result.fillCount, "0.00");
  assert.equal(flow.orders().length, 1);
  assert.equal(flow.cancels().length, 1);
  assert.equal(flow.upgrades().length, 1);
  assert.equal(flow.calls.filter((call) => call.path.endsWith("/account/limits")).length, 2);
  const body = flow.orders()[0]?.body as Record<string, unknown>;
  assert.equal(body.ticker, "SAFE-MKT");
  assert.equal(body.side, "bid");
  assert.equal(body.count, "1.00");
  assert.equal(body.price, "0.0100");
  assert.equal(body.post_only, true);
  assert.equal(body.subaccount, 0);
  assert.equal(body.cancel_order_on_pause, true);
  assert.equal(body.reduce_only, false);
  assert.equal(body.time_in_force, "good_till_canceled");
  assert.equal("exchange_index" in body, false);
  assert.equal(JSON.stringify(body).includes("stored-private-key"), false);
  assert.deepEqual(qualificationOrderBody("SAFE-MKT", "client-1").price, "0.0100");
});

test("missing confirmation places zero orders", async () => {
  const flow = harness();
  const result = await flow.run("please");
  assert.equal(result.status, "CONFIRMATION_REQUIRED");
  assert.equal(flow.orders().length, 0);
  assert.equal(flow.calls.length, 0);
});

test("an already advanced tier places zero orders", async () => {
  const flow = harness({ limits: [{ usage_tier: "premier" }] });
  const result = await flow.run();
  assert.equal(result.status, "ALREADY_ADVANCED");
  assert.equal(result.usageTier, "premier");
  assert.equal(flow.orders().length, 0);
});

test("insufficient primary cash places zero orders", async () => {
  const flow = harness({ balance: { balance: 0, portfolio_value: 0 } });
  const result = await flow.run();
  assert.equal(result.status, "INSUFFICIENT_PRIMARY_CASH_FOR_QUALIFICATION");
  assert.equal(flow.orders().length, 0);
});

test("an unknown tier fails closed before any order", async () => {
  const flow = harness({ limits: [{ usage_tier: "restricted" }] });
  const result = await flow.run();
  assert.equal(result.status, "API_TIER_NOT_QUALIFIABLE");
  assert.equal(flow.orders().length, 0);
});

test("qualification does not call strategy code or the legacy signer", () => {
  const source = [
    "src/lib/strata/qualifyAdvancedApi.ts",
    "src/lib/strata/qualificationDiagnostics.ts",
    "src/lib/strata/userScopeDatabase.ts",
    "src/routes/userExecutionRouter.ts",
  ].map((path) => readFileSync(path, "utf8")).join("\n");
  assert.equal(source.includes("getLiveProductionSupervisor"), false);
  assert.equal(source.includes("KALSHI_INDEX2"), false);
  assert.equal(source.includes("KALSHI_API_PRIVATE_KEY"), false);
  assert.equal(source.includes("v13StrategyResearch"), false);
  assert.equal(source.includes("bot_eligible = true"), false);
  assert.equal(source.includes("bot_eligible=true"), false);
  assert.equal(source.includes("/trade-api/v2/portfolio/orders"), true);
  assert.equal(source.includes("/trade-api/v2/portfolio/fills"), true);
  assert.equal(source.includes("/trade-api/v2/portfolio/positions"), true);
});

test("a confirmed create cancels once and an uncertain create is not retried", async () => {
  const uncertain = harness({ create: "uncertain" });
  assert.equal((await uncertain.run()).status, "QUALIFICATION_ORDER_OUTCOME_UNCERTAIN");
  assert.equal((await uncertain.run()).status, "QUALIFICATION_ORDER_OUTCOME_UNCERTAIN");
  assert.equal(uncertain.orders().length, 1);
  assert.equal(uncertain.cancels().length, 0);
  assert.equal(uncertain.upgrades().length, 0);
});

test("an unexpected fill does not place or cancel another order", async () => {
  const flow = harness({
    create: ok({ order_id: "ord-fill", fill_count: "1.00", remaining_count: "0.00", average_fill_price: "0.0100" }, 201),
  });
  const result = await flow.run();
  assert.equal(result.status, "UNEXPECTED_QUALIFICATION_FILL");
  assert.equal(result.orderId, "ord-fill");
  assert.equal(result.ticker, "SAFE-MKT");
  assert.equal(result.fillCount, "1.00");
  assert.equal(result.averageFillPrice, "0.0100");
  assert.equal(JSON.stringify(result).includes("stored-private-key"), false);
  assert.equal((await flow.run()).status, "UNEXPECTED_QUALIFICATION_FILL");
  assert.equal(flow.orders().length, 1);
  assert.equal(flow.cancels().length, 0);
  assert.equal(flow.upgrades().length, 0);
});

test("an uncertain cancel does not request the upgrade", async () => {
  const flow = harness({ cancel: "uncertain" });
  assert.equal((await flow.run()).status, "QUALIFICATION_CANCEL_UNCERTAIN");
  assert.equal((await flow.run()).status, "QUALIFICATION_CANCEL_RECONCILIATION_UNCERTAIN");
  assert.equal(flow.orders().length, 1);
  assert.equal(flow.cancels().length, 1);
  assert.equal(flow.upgrades().length, 0);
});

test("a rejected upgrade keeps one attempt and a sanitized Kalshi error", async () => {
  const flow = harness({
    upgrade: ok({
      error: { code: "not_eligible", message: "Need one API-created order.", details: { private_key: "stored-private-key" } },
      headers: { authorization: "Bearer secret" },
    }, 400),
  });
  const result = await flow.run();
  assert.equal(result.status, "UPGRADE_REJECTED");
  assert.equal(result.upstreamHttpStatus, 400);
  assert.equal(result.upstreamCode, "not_eligible");
  assert.equal(result.upstreamMessage, "Need one API-created order.");
  assert.equal(JSON.stringify(result).includes("stored-private-key"), false);
  assert.equal(JSON.stringify(result).includes("authorization"), false);
  assert.equal(JSON.stringify(result).includes("Bearer"), false);
  assert.equal(flow.upgrades().length, 1);
  assert.equal(flow.orders().length, 1);
  const noisy = harness({
    upgrade: ok({ error: { code: "bad\u0000code", message: `x${"y".repeat(600)}` } }, 403),
  });
  const rejected = await noisy.run();
  assert.equal(rejected.upstreamHttpStatus, 403);
  assert.equal(rejected.upstreamCode, undefined);
  assert.equal(rejected.upstreamMessage?.length, 500);
  assert.equal(noisy.upgrades().length, 1);
});

test("a successful cancel requests the upgrade once and rereads limits", async () => {
  const flow = harness();
  const result = await flow.run();
  assert.equal(result.status, "ADVANCED_VERIFIED");
  assert.equal(flow.upgrades().length, 1);
  assert.equal(flow.calls.filter((call) => call.path.endsWith("/account/limits")).length, 2);
  assert.equal(flow.upgrades()[0]?.keyId, "key-user");
});

test("two concurrent confirmations cannot create two qualification orders", async () => {
  const calls: Array<{ method: string; path: string; body?: unknown; keyId: string }> = [];
  let releaseOrder: () => void = () => undefined;
  const orderGate = new Promise<void>((resolve) => { releaseOrder = resolve; });
  let orders = 0;
  const transport: QualificationTransport = {
    async get(creds, path) {
      calls.push({ method: "GET", path, keyId: creds.keyId });
      if (path.endsWith("/portfolio/balance")) return ok({ balance: 2500, portfolio_value: 0 });
      return ok({ usage_tier: "basic" });
    },
    async post(creds, path, body) {
      calls.push({ method: "POST", path, body, keyId: creds.keyId });
      if (path === QUALIFICATION_ORDER_PATH) {
        orders += 1;
        await orderGate;
        return ok({ order_id: "ord-1", fill_count: "0.00", remaining_count: "1.00" }, 201);
      }
      return ok({}, 201);
    },
    async delete(creds, path) {
      calls.push({ method: "DELETE", path, keyId: creds.keyId });
      return v2Cancel("ord-1", null);
    },
    async listOpenMarkets() {
      return [market("SAFE-MKT", "0.4500")];
    },
  };
  const guard = createMemoryQualificationGuard();
  const start = (id: string) => qualifyAdvancedApi({
    creds: { keyId: "key-user", privateKey: "stored-private-key" },
    connectionId: "conn-1",
    confirm: QUALIFICATION_CONFIRMATION,
    guard,
    transport,
    now: NOW,
    newClientOrderId: () => id,
  });
  const first = start("client-a");
  const second = start("client-b");
  const deadline = Date.now() + 1000;
  while (orders < 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(orders, 1);
  releaseOrder();
  await Promise.all([first, second]);
  assert.equal(calls.filter((call) => call.method === "POST" && call.path === QUALIFICATION_ORDER_PATH).length, 1);
});

test("user A cannot qualify user B", async () => {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  const db: UserScopeQuery = {
    async query(text, params = []) {
      queries.push({ text, params });
      if (text.includes("fa.user_id")) {
        if (params[0] === USER_A) return { rows: [{ provider_connection_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", vault_secret_id: "vault-a" }] };
        if (params[0] === USER_B) return { rows: [{ provider_connection_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", vault_secret_id: "vault-b" }] };
        return { rows: [] };
      }
      if (text.includes("decrypted_secrets")) {
        if (params[0] === "vault-a") return { rows: [{ decrypted_secret: JSON.stringify({ api_key_id: "key-a", private_key: "pem-a" }) }] };
        if (params[0] === "vault-b") return { rows: [{ decrypted_secret: JSON.stringify({ api_key_id: "key-b", private_key: "pem-b-secret" }) }] };
      }
      return { rows: [] };
    },
  };
  const seen: string[] = [];
  let limitReads = 0;
  const port = createDatabaseUserScopePort(db, {
    qualificationGuard: createMemoryQualificationGuard(),
    qualifyTransport: {
      async get(creds, path) {
        seen.push(creds.keyId);
        if (path.endsWith("/portfolio/balance")) return ok({ balance: 2500, portfolio_value: 0 });
        limitReads += 1;
        return ok({ usage_tier: limitReads === 1 ? "basic" : "advanced" });
      },
      async post(creds, path) {
        seen.push(creds.keyId);
        if (path === QUALIFICATION_ORDER_PATH) return ok({ order_id: "ord-a", fill_count: "0.00", remaining_count: "1.00" }, 201);
        return ok({}, 201);
      },
      async delete() {
        return v2Cancel("ord-a", null);
      },
      async listOpenMarkets() {
        return [market("SAFE-MKT", "0.4500")];
      },
    },
  });
  const result = await port.qualify(USER_A, {
    confirm: QUALIFICATION_CONFIRMATION,
    owner_user_id: USER_B,
    target_user_id: USER_B,
    api_key: "injected",
    private_key: "injected-secret",
  });
  assert.equal(result.status, "ADVANCED_VERIFIED");
  assert.equal(seen.every((key) => key === "key-a"), true);
  assert.equal(queries.some((query) => query.params.includes(USER_B)), false);
  assert.equal(queries.some((query) => query.params.includes("vault-b")), false);
  assert.equal(JSON.stringify(result).includes("pem-b-secret"), false);
  assert.equal(JSON.stringify(result).includes("injected-secret"), false);
  assert.equal(queries.some((query) => query.text.includes("bot_eligible")), false);
});

test("the route rejects a missing confirmation before any qualification call", async () => {
  let called = false;
  const port = createDatabaseUserScopePort({ query: async () => { throw new Error("db"); } }, {
    qualifyTransport: { async get() { called = true; return "uncertain"; }, async post() { called = true; return "uncertain"; }, async delete() { called = true; return "uncertain"; }, async listOpenMarkets() { called = true; return "uncertain"; } },
  });
  const original = port.qualify.bind(port);
  port.qualify = async (...args) => {
    called = true;
    return original(...args);
  };
  const app = express();
  app.use(express.json());
  app.use("/me", createUserExecutionRouter((_req, res, next) => {
    res.locals.strata = { subject: USER_A };
    next();
  }, port));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/me/qualify-advanced-api`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "no", private_key: "secret" }),
    });
    assert.equal(response.status, 400);
    assert.equal(called, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a valid V2 cancel proves the one-contract reduction and upgrades once", async () => {
  const flow = harness();
  const result = await flow.run();
  assert.equal(result.status, "ADVANCED_VERIFIED");
  assert.equal(flow.orders().length, 1);
  assert.equal(flow.cancels().length, 1);
  assert.equal(flow.upgrades().length, 1);
  assert.equal(flow.orders()[0]?.body && (flow.orders()[0].body as { price: string }).price, "0.0100");
});

test("a V2 cancel for another order or a partial reduction does not upgrade", async () => {
  const wrongOrder = harness({ cancel: v2Cancel("ord-other") });
  assert.equal((await wrongOrder.run()).status, "QUALIFICATION_CANCEL_UNCERTAIN");
  assert.equal(wrongOrder.upgrades().length, 0);
  assert.equal(wrongOrder.orders().length, 1);
  const partial = harness({ cancel: v2Cancel("ord-1", "client-1", "0.50") });
  assert.equal((await partial.run()).status, "QUALIFICATION_CANCEL_UNCERTAIN");
  assert.equal(partial.upgrades().length, 0);
  assert.equal(partial.cancels().length, 1);
  const malformed = harness({ cancel: ok({ order_id: "ord-1", client_order_id: "client-1", reduced_by: "1.00abc", ts_ms: 1234567890 }) });
  assert.equal((await malformed.run()).status, "QUALIFICATION_CANCEL_UNCERTAIN");
  assert.equal(malformed.upgrades().length, 0);
  const fractionalTime = harness({ cancel: ok({ order_id: "ord-1", client_order_id: "client-1", reduced_by: "1.00", ts_ms: 1.5 }) });
  assert.equal((await fractionalTime.run()).status, "QUALIFICATION_CANCEL_UNCERTAIN");
  assert.equal(fractionalTime.upgrades().length, 0);
  const wrongClient = harness({ cancel: v2Cancel("ord-1", "client-other") });
  assert.equal((await wrongClient.run()).status, "QUALIFICATION_CANCEL_UNCERTAIN");
  assert.equal(wrongClient.orders().length, 1);
  assert.equal(wrongClient.upgrades().length, 0);
  const oldOrderShape = harness({ cancel: ok({ status: "canceled", remaining_count: "0.00" }) });
  assert.equal((await oldOrderShape.run()).status, "QUALIFICATION_CANCEL_UNCERTAIN");
  assert.equal(oldOrderShape.upgrades().length, 0);
  assert.equal(oldOrderShape.orders().length, 1);
});

function qualificationOrder(overrides: Record<string, unknown> = {}) {
  return ok({
    order: {
      order_id: "ord-1",
      client_order_id: "client-1",
      ticker: "SAFE-MKT",
      fill_count: "0.00",
      remaining_count: "0.00",
      status: "canceled",
      ...overrides,
    },
  });
}

async function recover(order: QualificationExchangeResult | "uncertain", cancel?: QualificationExchangeResult | "uncertain") {
  const calls: Array<{ method: string; path: string; body?: unknown; keyId: string }> = [];
  const transport: QualificationTransport = {
    async get(creds, path) {
      calls.push({ method: "GET", path, keyId: creds.keyId });
      if (path === "/trade-api/v2/portfolio/orders/ord-1") return order;
      if (path.endsWith("/account/limits")) return ok({ usage_tier: "advanced" });
      return ok(null, 404);
    },
    async post(creds, path, body) {
      calls.push({ method: "POST", path, body, keyId: creds.keyId });
      return path === QUALIFICATION_ORDER_PATH ? ok({ order_id: "ord-new" }, 201) : ok({}, 201);
    },
    async delete(creds, path, query) {
      calls.push({ method: "DELETE", path, body: query, keyId: creds.keyId });
      return cancel ?? v2Cancel();
    },
    async listOpenMarkets() {
      calls.push({ method: "GET", path: "/markets", keyId: "" });
      return [market("OTHER-MKT", "0.9900")];
    },
  };
  const guard = createMemoryQualificationGuard();
  await guard.claim("conn-1");
  await guard.transition("conn-1", {
    state: "cancel_uncertain",
    clientOrderId: "client-1",
    orderId: "ord-1",
    ticker: "SAFE-MKT",
    fillCount: "0.00",
  });
  const run = () => qualifyAdvancedApi({
    creds: { keyId: "key-user", privateKey: "stored-private-key" },
    connectionId: "conn-1",
    confirm: QUALIFICATION_CONFIRMATION,
    guard,
    transport,
    now: NOW,
    newClientOrderId: () => "client-new",
  });
  const orders = () => calls.filter((call) => call.method === "POST" && call.path === QUALIFICATION_ORDER_PATH);
  const cancels = () => calls.filter((call) => call.method === "DELETE");
  const upgrades = () => calls.filter((call) => call.method === "POST" && call.path === QUALIFICATION_UPGRADE_PATH);
  return { calls, run, orders, cancels, upgrades };
}

test("a canceled qualification order recovers into one upgrade and no new order", async () => {
  const flow = await recover(qualificationOrder());
  const result = await flow.run();
  assert.equal(result.status, "ADVANCED_VERIFIED");
  assert.equal(flow.orders().length, 0);
  assert.equal(flow.cancels().length, 0);
  assert.equal(flow.upgrades().length, 1);
  assert.equal(flow.calls.some((call) => call.path === "/markets"), false);
  assert.equal(flow.calls.some((call) => call.path === "/trade-api/v2/portfolio/orders/ord-1"), true);
});

test("a still-resting qualification order is canceled once with the stored ticker", async () => {
  const flow = await recover(qualificationOrder({ fill_count: "0.00", remaining_count: "1.00", status: "resting" }));
  const result = await flow.run();
  assert.equal(result.status, "ADVANCED_VERIFIED");
  assert.equal(flow.orders().length, 0);
  assert.equal(flow.cancels().length, 1);
  assert.equal(flow.cancels()[0]?.path, `${QUALIFICATION_ORDER_PATH}/ord-1`);
  assert.equal(flow.cancels()[0]?.body, "?market_ticker=SAFE-MKT");
  assert.equal(flow.upgrades().length, 1);
  const uncertain = await recover(
    qualificationOrder({ fill_count: "0.00", remaining_count: "1.00", status: "resting" }),
    "uncertain",
  );
  assert.equal((await uncertain.run()).status, "QUALIFICATION_CANCEL_UNCERTAIN");
  assert.equal(uncertain.orders().length, 0);
  assert.equal(uncertain.cancels().length, 1);
  assert.equal(uncertain.upgrades().length, 0);
});

test("a qualification fill found during cancel recovery is not upgraded or replaced", async () => {
  const flow = await recover(qualificationOrder({
    fill_count: "0.50",
    remaining_count: "0.50",
    status: "executed",
    average_fill_price: "0.0100",
  }));
  const result = await flow.run();
  assert.equal(result.status, "UNEXPECTED_QUALIFICATION_FILL");
  assert.equal(result.fillCount, "0.50");
  assert.equal(result.orderId, "ord-1");
  assert.equal(result.ticker, "SAFE-MKT");
  assert.equal(result.averageFillPrice, "0.0100");
  assert.equal(JSON.stringify(result).includes("stored-private-key"), false);
  assert.equal(flow.orders().length, 0);
  assert.equal(flow.cancels().length, 0);
  assert.equal(flow.upgrades().length, 0);
  assert.equal((await flow.run()).status, "UNEXPECTED_QUALIFICATION_FILL");
  assert.equal(flow.orders().length, 0);
});

test("an unreadable qualification order stays cancel-uncertain without another order", async () => {
  const malformed = await recover(ok({ order: { order_id: "ord-1" } }));
  assert.equal((await malformed.run()).status, "QUALIFICATION_CANCEL_RECONCILIATION_UNCERTAIN");
  assert.equal(malformed.orders().length, 0);
  assert.equal(malformed.cancels().length, 0);
  assert.equal(malformed.upgrades().length, 0);
  assert.equal((await malformed.run()).status, "QUALIFICATION_CANCEL_RECONCILIATION_UNCERTAIN");
  assert.equal(malformed.orders().length, 0);
  const unavailable = await recover("uncertain");
  assert.equal((await unavailable.run()).status, "QUALIFICATION_CANCEL_RECONCILIATION_UNCERTAIN");
  assert.equal(unavailable.orders().length, 0);
  assert.equal(unavailable.cancels().length, 0);
  assert.equal(unavailable.upgrades().length, 0);
  const wrongOrder = await recover(qualificationOrder({ order_id: "ord-other" }));
  assert.equal((await wrongOrder.run()).status, "QUALIFICATION_CANCEL_RECONCILIATION_UNCERTAIN");
  assert.equal(wrongOrder.orders().length, 0);
  assert.equal(wrongOrder.cancels().length, 0);
  assert.equal(wrongOrder.upgrades().length, 0);
});

async function seededAttempt(confirm: unknown, options: {
  tiers?: string[];
  upgrade?: QualificationExchangeResult | "uncertain";
} = {}) {
  const calls: Array<{ method: string; path: string; body?: unknown; keyId: string }> = [];
  let limitReads = 0;
  const tiers = options.tiers ?? ["basic", "advanced"];
  const guard = createMemoryQualificationGuard();
  await guard.claim("conn-1");
  await guard.transition("conn-1", {
    state: "cancel_uncertain",
    clientOrderId: "client-1",
    orderId: "ord-1",
    ticker: "SAFE-MKT",
    fillCount: "0.00",
  });
  const transport: QualificationTransport = {
    async get(creds, path) {
      calls.push({ method: "GET", path, keyId: creds.keyId });
      if (path.endsWith("/account/limits")) return ok({ usage_tier: tiers[Math.min(limitReads++, tiers.length - 1)] });
      return ok(null, 404);
    },
    async post(creds, path, body) {
      calls.push({ method: "POST", path, body, keyId: creds.keyId });
      if (path === QUALIFICATION_ORDER_PATH) return ok({ order_id: "ord-new" }, 201);
      return options.upgrade ?? ok({}, 201);
    },
    async delete(creds, path, query) {
      calls.push({ method: "DELETE", path, body: query, keyId: creds.keyId });
      return v2Cancel();
    },
    async listOpenMarkets() {
      calls.push({ method: "GET", path: "/markets", keyId: "" });
      return [market("OTHER-MKT", "0.9900")];
    },
  };
  const run = () => qualifyAdvancedApi({
    creds: { keyId: "key-user", privateKey: "stored-private-key" },
    connectionId: "conn-1",
    confirm,
    guard,
    transport,
    now: NOW,
    newClientOrderId: () => "client-new",
  });
  const orders = () => calls.filter((call) => call.method === "POST" && call.path === QUALIFICATION_ORDER_PATH);
  const cancels = () => calls.filter((call) => call.method === "DELETE");
  const upgrades = () => calls.filter((call) => call.method === "POST" && call.path === QUALIFICATION_UPGRADE_PATH);
  return { calls, run, guard, orders, cancels, upgrades };
}

test("the normal confirmation still fail-closes an uncertain cancel", async () => {
  const flow = await seededAttempt(QUALIFICATION_CONFIRMATION);
  const result = await flow.run();
  assert.equal(result.status, "QUALIFICATION_CANCEL_RECONCILIATION_UNCERTAIN");
  assert.equal(result.acceptedResidualOrderRisk, undefined);
  assert.equal(result.qualificationOrderCanceled, undefined);
  assert.equal(flow.orders().length, 0);
  assert.equal(flow.cancels().length, 0);
  assert.equal(flow.upgrades().length, 0);
  assert.equal((await flow.guard.read("conn-1"))?.state, "cancel_uncertain");
});

test("explicit residual-risk acceptance upgrades the existing order once", async () => {
  const flow = await seededAttempt(RESIDUAL_RISK_CONFIRMATION);
  const result = sanitizePublic(await flow.run());
  assert.equal(result.status, "ADVANCED_VERIFIED");
  assert.equal(result.usageTier, "advanced");
  assert.equal(result.qualificationOrderCreated, true);
  assert.equal(result.qualificationOrderCancellationUncertain, true);
  assert.equal(result.acceptedResidualOrderRisk, true);
  assert.equal(result.qualificationOrderCanceled, undefined);
  assert.equal(result.orderId, "ord-1");
  assert.equal(result.ticker, "SAFE-MKT");
  assert.equal(JSON.stringify(result).includes("qualificationOrderCanceled"), false);
  assert.equal(JSON.stringify(result).includes("stored-private-key"), false);
  assert.equal(flow.orders().length, 0);
  assert.equal(flow.cancels().length, 0);
  assert.equal(flow.upgrades().length, 1);
  assert.equal(flow.calls.filter((call) => call.path.endsWith("/account/limits")).length, 2);
  assert.equal(flow.calls.some((call) => call.path === "/markets"), false);
  const row = await flow.guard.read("conn-1");
  assert.equal(row?.state, "advanced_verified_with_cancel_uncertain");
  assert.equal(row?.orderId, "ord-1");
  assert.equal(row?.clientOrderId, "client-1");
  assert.equal(row?.ticker, "SAFE-MKT");
  assert.equal(row?.residualRiskAcceptedAt, new Date(NOW).toISOString());
  assert.equal(row?.advancedVerifiedAt, new Date(NOW).toISOString());
  assert.notEqual(row?.state, "canceled");
  assert.equal((await flow.run()).status, "ADVANCED_VERIFIED");
  assert.equal(flow.orders().length, 0);
  assert.equal(flow.upgrades().length, 1);
});

test("an uncertain residual upgrade is not retried", async () => {
  const flow = await seededAttempt(RESIDUAL_RISK_CONFIRMATION, { upgrade: "uncertain" });
  const first = await flow.run();
  assert.equal(first.status, "UPGRADE_OUTCOME_UNCERTAIN");
  assert.equal(first.qualificationOrderCanceled, undefined);
  assert.equal(first.qualificationOrderCancellationUncertain, true);
  assert.equal(flow.upgrades().length, 1);
  assert.equal(flow.orders().length, 0);
  const second = await flow.run();
  assert.equal(second.status, "UPGRADE_OUTCOME_UNCERTAIN");
  assert.equal(second.qualificationOrderCanceled, undefined);
  assert.equal(flow.upgrades().length, 1);
  assert.equal(flow.orders().length, 0);
  assert.equal(flow.cancels().length, 0);
});

test("an already advanced account does not order, cancel, or upgrade again", async () => {
  const flow = await seededAttempt(RESIDUAL_RISK_CONFIRMATION, { tiers: ["advanced"] });
  const result = await flow.run();
  assert.equal(result.status, "ALREADY_ADVANCED");
  assert.equal(result.usageTier, "advanced");
  assert.equal(result.qualificationOrderCanceled, undefined);
  assert.equal(result.orderId, "ord-1");
  assert.equal(result.ticker, "SAFE-MKT");
  assert.equal(flow.orders().length, 0);
  assert.equal(flow.cancels().length, 0);
  assert.equal(flow.upgrades().length, 0);
  assert.equal((await flow.guard.read("conn-1"))?.state, "advanced_verified_with_cancel_uncertain");
});

test("a new qualification attempt still cancels before requesting the upgrade", async () => {
  const flow = harness();
  const result = await flow.run();
  assert.equal(result.status, "ADVANCED_VERIFIED");
  assert.equal(result.qualificationOrderCanceled, true);
  const cancelAt = flow.calls.findIndex((call) => call.method === "DELETE");
  const upgradeAt = flow.calls.findIndex((call) => call.path === QUALIFICATION_UPGRADE_PATH);
  assert.equal(cancelAt >= 0 && cancelAt < upgradeAt, true);
  assert.equal(flow.orders().length, 1);
  assert.equal(flow.cancels().length, 1);
  assert.equal(flow.upgrades().length, 1);
});

test("user A cannot accept residual risk on user B's qualification guard", async () => {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  const guard = createMemoryQualificationGuard();
  const userBConnection = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  await guard.claim(userBConnection);
  await guard.transition(userBConnection, {
    state: "cancel_uncertain",
    clientOrderId: "client-b",
    orderId: "ord-b",
    ticker: "SAFE-MKT",
    fillCount: "0.00",
  });
  const db: UserScopeQuery = {
    async query(text, params = []) {
      queries.push({ text, params });
      if (text.includes("fa.user_id")) {
        if (params[0] === USER_A) return { rows: [{ provider_connection_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", vault_secret_id: "vault-a" }] };
        if (params[0] === USER_B) return { rows: [{ provider_connection_id: userBConnection, vault_secret_id: "vault-b" }] };
        return { rows: [] };
      }
      if (text.includes("decrypted_secrets") && params[0] === "vault-a") {
        return { rows: [{ decrypted_secret: JSON.stringify({ api_key_id: "key-a", private_key: "pem-a" }) }] };
      }
      return { rows: [] };
    },
  };
  let kalshiCalls = 0;
  const port = createDatabaseUserScopePort(db, {
    qualificationGuard: guard,
    qualifyTransport: {
      async get() { kalshiCalls += 1; return ok({ usage_tier: "advanced" }); },
      async post() { kalshiCalls += 1; return ok({ order_id: "ord-new" }, 201); },
      async delete() { kalshiCalls += 1; return v2Cancel(); },
      async listOpenMarkets() { kalshiCalls += 1; return [market("SAFE-MKT", "0.4500")]; },
    },
  });
  const result = await port.qualify(USER_A, {
    confirm: RESIDUAL_RISK_CONFIRMATION,
    owner_user_id: USER_B,
    target_user_id: USER_B,
    private_key: "injected-secret",
  });
  assert.equal(result.status, "RESIDUAL_RISK_CONFIRMATION_NOT_APPLICABLE");
  assert.equal(kalshiCalls, 0);
  assert.equal(queries.some((query) => query.params.includes(USER_B)), false);
  assert.equal(queries.some((query) => query.params.includes("vault-b")), false);
  assert.equal(JSON.stringify(result).includes("injected-secret"), false);
  assert.equal((await guard.read(userBConnection))?.state, "cancel_uncertain");
  assert.equal((await guard.read(userBConnection))?.orderId, "ord-b");
});

test("the guard read still works before the residual-risk migration is applied", async () => {
  const texts: string[] = [];
  const missing = Object.assign(new Error("column residual_risk_accepted_at does not exist"), { code: "42703" });
  const guard = createSqlQualificationGuard({
    async query(text) {
      texts.push(text);
      if (text.includes("residual_risk_accepted_at")) throw missing;
      return { rows: [{ state: "cancel_uncertain", client_order_id: "client-1", order_id: "ord-1", ticker: "SAFE-MKT", fill_count: "0.00" }] };
    },
  });
  const row = await guard.read("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(row?.orderId, "ord-1");
  assert.equal(row?.state, "cancel_uncertain");
  texts.length = 0;
  await guard.transition("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
    state: "order_uncertain",
    clientOrderId: "client-1",
    orderId: "ord-1",
    ticker: "SAFE-MKT",
  });
  assert.equal(texts.some((text) => text.includes("residual_risk_accepted_at")), false);
  texts.length = 0;
  await assert.rejects(guard.transition("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
    state: "upgrade_uncertain",
    orderId: "ord-1",
    ticker: "SAFE-MKT",
    residualRiskAcceptedAt: new Date(NOW).toISOString(),
  }));
  assert.equal(texts.some((text) => text.includes("SET state = $2")), false);
  assert.equal(texts.some((text) => text.includes("residual_risk_accepted_at")), true);
});

test("the route accepts only the two exact qualification confirmations", async () => {
  const seen: unknown[] = [];
  const port = closedUserScopePort();
  port.qualify = async (_userId, body) => {
    seen.push(body && typeof body === "object" ? (body as { confirm?: unknown }).confirm : undefined);
    return { status: "ADVANCED_VERIFIED", orderId: "ord-1", ticker: "SAFE-MKT" };
  };
  const app = express();
  app.use(express.json());
  app.use("/me", createUserExecutionRouter((_req, res, next) => {
    res.locals.strata = { subject: USER_A };
    next();
  }, port));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/me/qualify-advanced-api`;
    const rejected = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: "no" }) });
    assert.equal(rejected.status, 400);
    const accepted = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: RESIDUAL_RISK_CONFIRMATION, private_key: "secret" }),
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(seen, [RESIDUAL_RISK_CONFIRMATION]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("scoped mutations refuse every path except the qualification order, cancel, and upgrade", async () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response("{}", { status: 201 });
  };
  const creds = { keyId: "key-user", privateKey: pem };
  await assert.rejects(mutateScopedKalshi(creds, "POST", "/trade-api/v2/portfolio/orders", { body: {}, fetchImpl }));
  await assert.rejects(mutateScopedKalshi(creds, "DELETE", "/trade-api/v2/portfolio/events/orders/../balance", { fetchImpl }));
  assert.equal(calls, 0);
});
