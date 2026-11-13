import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";
import express from "express";
import { createPairCommissioningApprovalRouter } from "./pairCommissioningApproval";

test("owner approval page is scoped, one-use, and does not approve or initialize on preparation", async () => {
  const saved = Object.fromEntries([
    "NODE_ENV", "REPLIT_DEPLOYMENT", "KALSHI_API_ENVIRONMENT",
    "MICRO_LIVE_PRODUCTION_ENABLED", "LIVE_EXECUTION_ENABLED",
    "PHASE4_ADMIN_USER_ID", "REPLIT_DEV_DOMAIN",
  ].map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    NODE_ENV: "development", REPLIT_DEPLOYMENT: "0",
    KALSHI_API_ENVIRONMENT: "production",
    MICRO_LIVE_PRODUCTION_ENABLED: "false", LIVE_EXECUTION_ENABLED: "false",
    PHASE4_ADMIN_USER_ID: "owner", REPLIT_DEV_DOMAIN: "isolated.example.test",
  });
  let actor = "visitor";
  let prepares = 0;
  let approvals = 0;
  let reviews = 0;
  let state: "not_prepared" | "pending" | "reviewed" | "approved" = "not_prepared";
  const app = express();
  app.use(express.json());
  app.use("/api/admin/index2-pair-commissioning", createPairCommissioningApprovalRouter({
    identity: () => ({ userId: actor, sessionId: "owner-session" }),
    view: async () => state === "reviewed" ? ({
      status: state, pair: "(1,2)", allInCapMicros: 1_000_000,
      reviewId: "review-1", pdfDigest: "a".repeat(64),
      reviewSource: "owner_attested_http_429_2026_09_27", sourceAttestedAt: new Date().toISOString(),
      reviewExpiresAt: new Date(Date.now() + 60_000).toISOString(), approvedAt: null,
    }) : state === "approved" ? ({
      status: state, pair: "(1,2)", allInCapMicros: 1_000_000,
      reviewId: "review-1", pdfDigest: "a".repeat(64),
      reviewSource: "owner_attested_http_429_2026_09_27", sourceAttestedAt: new Date().toISOString(),
      reviewExpiresAt: null, approvedAt: new Date().toISOString(),
    }) : ({
      status: state, pair: "(1,2)", allInCapMicros: 1_000_000,
    }),
    prepare: async () => {
      prepares++;
      state = "pending";
      return { status: "pending", reason: "prepared" };
    },
    review: async (bytes, owner, source, attested) => {
      assert.equal(bytes.toString(), "%PDF-isolated-test");
      assert.equal(owner, "owner");
      assert.equal(source, "owner_attested_http_429_2026_09_27");
      assert.equal(attested, true);
      reviews++;
      state = "reviewed";
      return { status: "reviewed", reason: "owner approval required" };
    },
    approve: async (id, owner) => {
      assert.equal(id, "review-1");
      assert.equal(owner, "owner");
      approvals++;
      state = "approved";
      return { status: "approved", reason: "approved" };
    },
  }));
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const root = `http://127.0.0.1:${address.port}/api/admin/index2-pair-commissioning`;
  const headers = {
    host: "isolated.example.test", origin: "https://isolated.example.test",
    "x-forwarded-proto": "https", "content-type": "application/json",
  };
  try {
    assert.equal((await fetch(`${root}/`, { headers })).status, 403);
    actor = "owner";
    const page = await (await fetch(`${root}/`, { headers })).text();
    assert.match(page, /\(1,2\) \$1\.00 fee-inclusive policy/);
    assert.match(page, /Historical FROZEN run remains untouched/);
    const csrf = /csrf="([a-f0-9]{64})"/.exec(page)?.[1];
    assert.ok(csrf);
    const post = (path: string, body: object, overrides = headers) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const payload = JSON.stringify(body);
        const request = httpRequest(`${root}/${path}`, {
          method: "POST", headers: { ...overrides, "content-length": Buffer.byteLength(payload) },
        }, response => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", chunk => { text += chunk; });
          response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text }));
        });
        request.on("error", reject);
        request.end(payload);
      });
    assert.equal((await post("prepare", { csrf, capMicros: 5_000_000 })).status, 403);
    assert.equal(prepares, 0);
    const preparedPage = await (await fetch(`${root}/`, { headers })).text();
    const preparedToken = /csrf="([a-f0-9]{64})"/.exec(preparedPage)?.[1];
    assert.ok(preparedToken);
    const preparedResponse = await post("prepare", { csrf: preparedToken });
    assert.equal(preparedResponse.status, 200, preparedResponse.body);
    assert.equal((await post("prepare", { csrf: preparedToken })).status, 403);
    assert.equal((await post("approve", { csrf: preparedToken, reviewId: "x" })).status, 403);
    assert.equal(prepares, 1);
    assert.equal(approvals, 0);
    const nextPage = await (await fetch(`${root}/`, { headers })).text();
    const nextToken = /csrf="([a-f0-9]{64})"/.exec(nextPage)?.[1];
    assert.ok(nextToken);
    assert.equal((await post("prepare", { csrf: nextToken }, {
      ...headers, origin: "https://attacker.example.test",
    })).status, 403);
    assert.equal(prepares, 1);
    const pendingPage = await (await fetch(`${root}/`, { headers })).text();
    assert.match(pendingPage, /I attest that this exact PDF came from the official Kalshi fee schedule/);
    assert.match(pendingPage, /does not fetch it or claim server verification/);
    const pendingToken = /csrf="([a-f0-9]{64})"/.exec(pendingPage)?.[1];
    assert.ok(pendingToken);
    assert.equal((await post("review", {
      csrf: pendingToken, pdfBase64: Buffer.from("%PDF-isolated-test").toString("base64"),
      source: "owner_attested_http_429_2026_09_27", attestOfficial: false,
    })).status, 403);
    assert.equal(reviews, 0);
    assert.equal((await post("review", {
      csrf: pendingToken, pdfBase64: Buffer.from("%PDF-isolated-test").toString("base64"),
      source: "owner_attested_http_429", attestOfficial: true,
    })).status, 403);
    const retryPage = await (await fetch(`${root}/`, { headers })).text();
    const retryToken = /csrf="([a-f0-9]{64})"/.exec(retryPage)?.[1];
    assert.ok(retryToken);
    assert.equal((await post("review", {
      csrf: retryToken, pdfBase64: Buffer.from("%PDF-isolated-test").toString("base64"),
      source: "owner_attested_http_429_2026_09_27", attestOfficial: true,
    })).status, 200);
    assert.equal(reviews, 1);
    const reviewPage = await (await fetch(`${root}/`, { headers })).text();
    assert.match(reviewPage, /Owner-attested official PDF after canonical-source HTTP 429; not server-fetched/);
    assert.match(reviewPage, /Exact PDF SHA-256: a{64}/);
    assert.match(reviewPage, /Approve only this \$1 fee policy for \(1,2\)/);
    assert.equal(approvals, 0);
  } finally {
    server.close();
    await once(server, "close");
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});