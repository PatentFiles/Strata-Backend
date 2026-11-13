import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after } from "node:test";
import express from "express";
import { db, liveExecutionConfigTable, pool } from "@workspace/db";
import router from "./phase4";

if (!/^shadow_test_[a-f0-9]{24}$/.test(process.env.SHADOW_TEST_ISOLATED_SCHEMA ?? "")) {
  throw new Error("Phase 4 route tests require a disposable isolated schema");
}

const saved = {
  nodeEnv: process.env.NODE_ENV,
  admin: process.env.PHASE4_ADMIN_USER_ID,
  keyId: process.env.KALSHI_API_KEY_ID,
  privateKey: process.env.KALSHI_API_PRIVATE_KEY,
  kalshiEnvironment: process.env.KALSHI_API_ENVIRONMENT,
  fetch: globalThis.fetch,
};

after(async () => {
  for (const [key, value] of [
    ["NODE_ENV", saved.nodeEnv],
    ["PHASE4_ADMIN_USER_ID", saved.admin],
    ["KALSHI_API_KEY_ID", saved.keyId],
    ["KALSHI_API_PRIVATE_KEY", saved.privateKey],
    ["KALSHI_API_ENVIRONMENT", saved.kalshiEnvironment],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = saved.fetch;
  await pool.end();
});

test("production Phase 4 GETs require the configured Clerk admin and only read Kalshi", async () => {
  process.env.NODE_ENV = "production";
  process.env.PHASE4_ADMIN_USER_ID = "test-production-admin";
  process.env.KALSHI_API_ENVIRONMENT = "production";
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.KALSHI_API_KEY_ID = "test-key-id";
  process.env.KALSHI_API_PRIVATE_KEY =
    privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://external-api.kalshi.com");
    assert.equal(init?.method, "GET");
    assert.ok([
      "/trade-api/v2/portfolio/balance",
      "/trade-api/v2/portfolio/orders",
      "/trade-api/v2/portfolio/positions",
      "/trade-api/v2/portfolio/fills",
    ].includes(url.pathname), "account route must use only allowlisted GET paths");
    requests.push(url.pathname);
    const payload: Record<string, unknown> = url.pathname.endsWith("/balance")
      ? { balance: 2500 }
      : url.pathname.endsWith("/orders") ? { orders: [] }
      : url.pathname.endsWith("/positions") ? { market_positions: [] }
      : { fills: [] };
    return { ok: true, status: 200, json: async () => payload } as Response;
  }) as typeof fetch;

  await db.insert(liveExecutionConfigTable).values({
    id: "singleton", mode: "SHADOW_LIVE", liveExecutionEnabled: false,
    manualKillSwitch: true, shadowCapitalLimit: 25, shadowCapitalRemaining: 25,
    shadowMaxStakePerTrade: 5, shadowMaxOpenPositions: 1, shadowMaxTotalLoss: 25,
  });

  const app = express();
  app.use("/api", router);
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    async function call(path: string, userId?: string, method = "GET") {
      return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
        const req = httpRequest({
          hostname: "127.0.0.1", port, path: `/api/phase4/${path}`, method,
          headers: userId ? { "x-test-user-id": userId } : {},
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString();
            resolve({
              status: res.statusCode ?? 0,
              body: text.startsWith("{") ? JSON.parse(text) : {},
            });
          });
        });
        req.on("error", reject);
        req.end();
      });
    }

    for (const path of ["account", "state"]) {
      assert.equal((await call(path)).status, 401, `${path} must reject anonymous access`);
      assert.equal((await call(path, "test-other-user")).status, 403,
        `${path} must reject a signed-in non-admin`);
    }
    assert.equal(requests.length, 0, "rejected users cannot reach Kalshi");

    const account = await call("account", "test-production-admin");
    assert.equal(account.status, 200);
    assert.equal(account.body.status, "CONNECTED");
    assert.deepEqual(requests.sort(), [
      "/trade-api/v2/portfolio/balance", "/trade-api/v2/portfolio/fills",
      "/trade-api/v2/portfolio/orders", "/trade-api/v2/portfolio/positions",
    ].sort());
    const state = await call("state", "test-production-admin");
    assert.equal(state.status, 200);
    assert.equal((state.body.config as Record<string, unknown>).liveExecutionEnabled, false);
    assert.equal((state.body.config as Record<string, unknown>).manualKillSwitch, true);
    assert.equal((state.body.config as Record<string, unknown>).shadowCapitalLimit, 25);

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.equal((await call("account", "test-production-admin", method)).status, 404);
    }
    for (const [path, method] of [
      ["shadow/mode", "POST"], ["shadow/limits", "PATCH"], ["shadow/scan", "POST"],
    ]) {
      assert.equal((await call(path, "test-production-admin", method)).status, 404,
        "production shadow mutation routes must remain disabled");
    }
    assert.equal(requests.length, 4, "no production mutation route may reach Kalshi");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});