import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { sanitizePublic } from "../v13-production/sanitize";
import { createUserExecutionRouter } from "../../routes/userExecutionRouter";
import { createMemoryQualificationGuard, type QualificationGuard, type QualificationGuardRecord } from "./qualifyAdvancedApi";
import { readQualificationDiagnostics, type DiagnosticRead } from "./qualificationDiagnostics";
import { createDatabaseUserScopePort, type UserScopeQuery } from "./userScopeDatabase";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const CONNECTION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONNECTION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function guardRow(overrides: Partial<QualificationGuardRecord> = {}): QualificationGuardRecord {
  return {
    state: "upgrade_rejected",
    orderId: "ord-1",
    clientOrderId: "client-1",
    ticker: "SAFE-MKT",
    fillCount: "0.00",
    residualRiskAcceptedAt: "2026-10-11T00:00:00.000Z",
    advancedVerifiedAt: null,
    ...overrides,
  };
}

function kalshiOrder(overrides: Record<string, unknown> = {}) {
  return {
    order_id: "ord-1",
    client_order_id: "client-1",
    ticker: "SAFE-MKT",
    status: "resting",
    subaccount_number: 0,
    created_time: "2026-10-11T00:00:00Z",
    last_update_time: "2026-10-11T00:01:00Z",
    fill_count_fp: "0.00",
    remaining_count_fp: "1.00",
    initial_count_fp: "1.00",
    yes_price_dollars: "0.0100",
    no_price_dollars: "0.9900",
    book_side: "bid",
    outcome_side: "yes",
    cancel_order_on_pause: true,
    api_created: true,
    user_id: "secret-user",
    ...overrides,
  };
}

function limits() {
  return {
    usage_tier: "basic",
    read: { refill_rate: 20, bucket_capacity: 20 },
    grants: [
      { exchange_instance: "margined", level: "premier", source: "volume", expires_ts: 10 },
      { exchange_instance: "event_contract", level: "basic", source: "manual" },
    ],
  };
}

function reader(routes: Record<string, DiagnosticRead>) {
  const calls: Array<{ path: string; query: string }> = [];
  return {
    calls,
    get: async (path: string, query: string): Promise<DiagnosticRead> => {
      calls.push({ path, query });
      return routes[`${path}${query}`] ?? { outcome: "HTTP_404" };
    },
  };
}

test("diagnostics reads the stored order with GET only and does not invent an API-created flag", async () => {
  const transport = reader({
    "/trade-api/v2/account/limits": { outcome: "OK", body: limits() },
    "/trade-api/v2/portfolio/orders/ord-1": { outcome: "OK", body: { order: kalshiOrder() } },
    "/trade-api/v2/portfolio/orders?limit=100&subaccount=0": { outcome: "OK", body: { orders: [kalshiOrder(), kalshiOrder({ order_id: "ord-other" })] } },
    "/trade-api/v2/historical/orders?ticker=SAFE-MKT&limit=100": { outcome: "OK", body: { orders: [kalshiOrder({ status: "canceled", fill_count: "0.00" })] } },
  });
  const result = sanitizePublic(await readQualificationDiagnostics({ guard: guardRow(), get: transport.get }));
  assert.equal(result.status, "QUALIFICATION_DIAGNOSTIC_READY");
  assert.equal(transport.calls.length, 4);
  assert.equal(transport.calls.every((call) => !call.path.includes("/events/orders") && !call.path.includes("upgrade")), true);
  assert.equal(transport.calls[1]?.path, "/trade-api/v2/portfolio/orders/ord-1");
  assert.equal(transport.calls[1]?.query, "");
  assert.equal(transport.calls[2]?.query, "?limit=100&subaccount=0");
  assert.equal(transport.calls[3]?.query.includes("subaccount"), false);
  assert.equal(transport.calls[3]?.query, "?ticker=SAFE-MKT&limit=100");
  assert.equal(result.guard.state, "upgrade_rejected");
  assert.equal(result.guard.orderId, "ord-1");
  assert.equal(result.guard.clientOrderId, "client-1");
  assert.equal(result.guard.ticker, "SAFE-MKT");
  assert.equal(result.guard.fillCount, "0.00");
  assert.equal(result.guard.residualRiskAcceptedAt, "2026-10-11T00:00:00.000Z");
  assert.equal(result.tier.apiUsageTier, "basic");
  assert.equal(result.tier.predictionsGrantLevel, "basic");
  assert.equal(result.tier.predictionsGrantSource, "manual");
  assert.equal(result.tier.predictionsGrantExpiresAt, null);
  assert.equal(result.exactOrder.orderFound, true);
  assert.equal(result.exactOrder.orderIdMatchesGuard, true);
  assert.equal(result.exactOrder.clientOrderIdMatchesGuard, true);
  assert.equal(result.exactOrder.tickerMatchesGuard, true);
  assert.equal(result.exactOrder.isPrimarySubaccount, true);
  assert.equal(result.exactOrder.order?.exchangeIndex, null);
  assert.equal(result.exactOrder.order?.fillCount, "0.00");
  assert.equal(result.exactOrder.order?.yesPriceDollars, "0.0100");
  assert.equal(result.currentPrimaryOrders.count, 2);
  assert.equal(result.currentPrimaryOrders.storedOrderFound, true);
  assert.equal(result.currentPrimaryOrders.orderIdMatchesGuard, true);
  assert.equal(result.historicalOrders.countForStoredTicker, 1);
  assert.equal(result.historicalOrders.storedOrderFound, true);
  assert.equal(result.historicalOrders.orderIdMatchesGuard, true);
  assert.equal(result.historicalOrders.clientOrderIdMatchesGuard, true);
  assert.equal(result.historicalOrders.tickerMatchesGuard, true);
  assert.equal(result.historicalOrders.isPrimarySubaccount, true);
  assert.equal(result.conclusions.storedQualificationEvidenceExists, true);
  assert.equal(result.conclusions.exactOrderVisibleToAuthenticatedKalshiUser, true);
  assert.equal(result.conclusions.exactOrderMatchesGuard, true);
  assert.equal(result.conclusions.primarySubaccountConfirmed, true);
  assert.equal(result.conclusions.visibleInCurrentOrHistoricalOrders, true);
  assert.equal(result.conclusions.kalshiExposesApiCreatedFlag, false);
  const json = JSON.stringify(result);
  assert.equal(json.includes("api_created"), false);
  assert.equal(json.includes("secret-user"), false);
  assert.equal(json.includes("refill_rate"), false);
  assert.equal(json.includes("private"), false);
});

test("a historical match survives an exact-order 404, and a total miss is not success", async () => {
  const historicalOnly = reader({
    "/trade-api/v2/account/limits": { outcome: "HTTP_401" },
    "/trade-api/v2/portfolio/orders/ord-1": { outcome: "HTTP_404" },
    "/trade-api/v2/portfolio/orders?limit=100&subaccount=0": { outcome: "OK", body: { orders: [] } },
    "/trade-api/v2/historical/orders?ticker=SAFE-MKT&limit=100": { outcome: "OK", body: { orders: [kalshiOrder()] } },
  });
  const foundLater = await readQualificationDiagnostics({ guard: guardRow(), get: historicalOnly.get });
  assert.equal(foundLater.exactOrder.readOutcome, "HTTP_404");
  assert.equal(foundLater.exactOrder.orderFound, false);
  assert.equal(foundLater.tier.readOutcome, "HTTP_401");
  assert.equal(foundLater.historicalOrders.storedOrderFound, true);
  assert.equal(foundLater.conclusions.exactOrderVisibleToAuthenticatedKalshiUser, false);
  assert.equal(foundLater.conclusions.visibleInCurrentOrHistoricalOrders, true);
  assert.equal(foundLater.conclusions.exactOrderMatchesGuard, false);
  const missing = reader({
    "/trade-api/v2/account/limits": { outcome: "OK", body: limits() },
    "/trade-api/v2/portfolio/orders/ord-1": { outcome: "HTTP_404" },
    "/trade-api/v2/portfolio/orders?limit=100&subaccount=0": { outcome: "OK", body: { orders: [kalshiOrder({ order_id: "ord-other" })] } },
    "/trade-api/v2/historical/orders?ticker=SAFE-MKT&limit=100": { outcome: "OK", body: { orders: [] } },
  });
  const absent = await readQualificationDiagnostics({ guard: guardRow(), get: missing.get });
  assert.equal(absent.conclusions.storedQualificationEvidenceExists, true);
  assert.equal(absent.conclusions.exactOrderVisibleToAuthenticatedKalshiUser, false);
  assert.equal(absent.conclusions.visibleInCurrentOrHistoricalOrders, false);
  assert.equal(absent.conclusions.exactOrderMatchesGuard, false);
  assert.equal(absent.currentPrimaryOrders.storedOrderFound, false);
  assert.equal(absent.historicalOrders.storedOrderFound, false);
});

test("diagnostic comparisons surface a mismatched identity and a non-primary subaccount", async () => {
  const transport = reader({
    "/trade-api/v2/account/limits": { outcome: "UNCERTAIN" },
    "/trade-api/v2/portfolio/orders/ord-1": {
      outcome: "OK",
      body: { order: kalshiOrder({ client_order_id: "client-other", ticker: "OTHER-MKT", subaccount_number: 1, exchange_index: 2, fill_count: "0.00" }) },
    },
    "/trade-api/v2/portfolio/orders?limit=100&subaccount=0": { outcome: "HTTP_5XX" },
    "/trade-api/v2/historical/orders?ticker=SAFE-MKT&limit=100": { outcome: "UNREADABLE" },
  });
  const result = await readQualificationDiagnostics({ guard: guardRow(), get: transport.get });
  assert.equal(result.exactOrder.clientOrderIdMatchesGuard, false);
  assert.equal(result.exactOrder.tickerMatchesGuard, false);
  assert.equal(result.exactOrder.isPrimarySubaccount, false);
  assert.equal(result.exactOrder.order?.exchangeIndex, 2);
  assert.equal(result.exactOrder.order?.fillCount, "0.00");
  assert.equal(result.conclusions.exactOrderMatchesGuard, false);
  assert.equal(result.conclusions.primarySubaccountConfirmed, false);
  assert.equal(result.currentPrimaryOrders.readOutcome, "HTTP_5XX");
  assert.equal(result.historicalOrders.readOutcome, "UNREADABLE");
  assert.equal(transport.calls.filter((call) => call.path === "/trade-api/v2/portfolio/orders/ord-1").length, 1);
});

test("the signed-in user diagnostic ignores a client order id and does not mutate the guard", async () => {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  const guard = createMemoryQualificationGuard();
  await guard.claim(CONNECTION_A);
  await guard.transition(CONNECTION_A, guardRow());
  await guard.claim(CONNECTION_B);
  await guard.transition(CONNECTION_B, guardRow({ orderId: "ord-b", clientOrderId: "client-b", ticker: "OTHER-MKT" }));
  let mutations = 0;
  const watched: QualificationGuard = {
    claim: async (id) => { mutations += 1; return guard.claim(id); },
    claimUpgrade: async (id) => { mutations += 1; return guard.claimUpgrade(id); },
    read: (id) => guard.read(id),
    transition: async (id, record) => { mutations += 1; await guard.transition(id, record); },
    clear: async (id) => { mutations += 1; await guard.clear(id); },
  };
  const calls: Array<{ path: string; query: string; keyId: string }> = [];
  const db: UserScopeQuery = {
    async query(text, params = []) {
      queries.push({ text, params });
      if (text.includes("fa.user_id")) {
        if (params[0] === USER_A) return { rows: [{ provider_connection_id: CONNECTION_A, vault_secret_id: "vault-a" }] };
        if (params[0] === USER_B) return { rows: [{ provider_connection_id: CONNECTION_B, vault_secret_id: "vault-b" }] };
        return { rows: [] };
      }
      if (text.includes("decrypted_secrets") && params[0] === "vault-a") {
        return { rows: [{ decrypted_secret: JSON.stringify({ api_key_id: "key-a", private_key: "pem-a-secret" }) }] };
      }
      return { rows: [] };
    },
  };
  const port = createDatabaseUserScopePort(db, {
    qualificationGuard: watched,
    kalshiGet: async (creds, path, query) => {
      calls.push({ path, query: query ?? "", keyId: creds.keyId });
      if (path.endsWith("/account/limits")) return limits();
      if (path === "/trade-api/v2/portfolio/orders/ord-1") return { order: kalshiOrder() };
      if (path === "/trade-api/v2/portfolio/orders") return { orders: [kalshiOrder()] };
      if (path === "/trade-api/v2/historical/orders") return { orders: [kalshiOrder()] };
      throw new Error(`unexpected ${path}`);
    },
    qualifyTransport: {
      async get() { throw new Error("qualify get"); },
      async post() { throw new Error("qualification post"); },
      async delete() { throw new Error("qualification delete"); },
      async listOpenMarkets() { throw new Error("market scan"); },
    },
  });
  const app = express();
  app.use(express.json());
  app.use("/me", createUserExecutionRouter((_req, res, next) => {
    res.locals.strata = { subject: USER_A };
    next();
  }, port));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/me/qualification-diagnostics?order_id=evil-order&user_id=${USER_B}&private_key=injected`, {
      method: "GET",
      headers: { "content-type": "application/json" },
    });
    const body = await response.json() as { guard?: { orderId?: string }; conclusions?: { kalshiExposesApiCreatedFlag?: boolean } };
    assert.equal(response.status, 200);
    assert.equal(body.guard?.orderId, "ord-1");
    assert.equal(body.conclusions?.kalshiExposesApiCreatedFlag, false);
    assert.equal(JSON.stringify(body).includes("pem-a-secret"), false);
    assert.equal(JSON.stringify(body).includes("evil-order"), false);
    assert.equal(JSON.stringify(body).includes("ord-b"), false);
    assert.equal(JSON.stringify(body).includes("injected"), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(mutations, 0);
  assert.equal(calls.every((call) => call.keyId === "key-a"), true);
  assert.equal(calls.some((call) => call.path.endsWith("/ord-1") && call.query === ""), true);
  assert.equal(calls.some((call) => call.query === "?limit=100&subaccount=0"), true);
  assert.equal(calls.some((call) => call.path.endsWith("/historical/orders") && call.query === "?ticker=SAFE-MKT&limit=100" && !call.query.includes("subaccount")), true);
  assert.equal(queries.some((query) => query.params.includes(USER_B)), false);
  assert.equal(queries.some((query) => query.params.includes("vault-b")), false);
  assert.equal((await guard.read(CONNECTION_A))?.state, "upgrade_rejected");
  assert.equal((await guard.read(CONNECTION_A))?.residualRiskAcceptedAt, "2026-10-11T00:00:00.000Z");
  assert.equal((await guard.read(CONNECTION_B))?.orderId, "ord-b");
});
