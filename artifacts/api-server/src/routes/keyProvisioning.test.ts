import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { request as httpRequest } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import {
  createKeyProvisioningRouter, keyProvisioningEnabled,
} from "./keyProvisioning";
import {
  type AttemptState, type AttemptStore,
} from "../lib/keyProvisioningAttempt";
import {
  generateRestrictedKalshiKey, type GeneratedKey,
} from "../lib/generateRestrictedKalshiKey";
import { verifyProvisioningRecovery } from "../lib/verifyProvisioningRecovery";

const saved = {
  env: process.env.NODE_ENV, flag: process.env.KALSHI_KEY_PROVISIONING_ENABLED,
  authorization: process.env.KALSHI_KEY_GENERATION_AUTHORIZED,
  devDomain: process.env.REPLIT_DEV_DOMAIN,
  deployment: process.env.REPLIT_DEPLOYMENT,
  admin: process.env.PHASE4_ADMIN_USER_ID, kalshiEnv: process.env.KALSHI_API_ENVIRONMENT,
  id: process.env.KALSHI_PROVISIONING_API_KEY_ID,
  pem: process.env.KALSHI_PROVISIONING_PRIVATE_KEY,
  verifierId: process.env.KALSHI_VERIFIER_API_KEY_ID,
  verifierPem: process.env.KALSHI_VERIFIER_API_PRIVATE_KEY,
  microId: process.env.KALSHI_MICRO_LIVE_API_KEY_ID,
  microPem: process.env.KALSHI_MICRO_LIVE_PRIVATE_KEY,
  fetch: globalThis.fetch,
};
test.after(() => {
  const names = [
    ["NODE_ENV", saved.env], ["KALSHI_KEY_PROVISIONING_ENABLED", saved.flag],
    ["KALSHI_KEY_GENERATION_AUTHORIZED", saved.authorization],
    ["REPLIT_DEV_DOMAIN", saved.devDomain],
    ["REPLIT_DEPLOYMENT", saved.deployment],
    ["PHASE4_ADMIN_USER_ID", saved.admin], ["KALSHI_API_ENVIRONMENT", saved.kalshiEnv],
    ["KALSHI_PROVISIONING_API_KEY_ID", saved.id],
    ["KALSHI_PROVISIONING_PRIVATE_KEY", saved.pem],
    ["KALSHI_VERIFIER_API_KEY_ID", saved.verifierId],
    ["KALSHI_VERIFIER_API_PRIVATE_KEY", saved.verifierPem],
    ["KALSHI_MICRO_LIVE_API_KEY_ID", saved.microId],
    ["KALSHI_MICRO_LIVE_PRIVATE_KEY", saved.microPem],
  ] as const;
  for (const [name, value] of names) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  globalThis.fetch = saved.fetch;
});

function allowDevelopment() {
  process.env.NODE_ENV = "development";
  process.env.REPLIT_DEV_DOMAIN = "owner-dev.replit.dev";
  delete process.env.REPLIT_DEPLOYMENT;
  process.env.KALSHI_KEY_PROVISIONING_ENABLED = "true";
  delete process.env.KALSHI_KEY_GENERATION_AUTHORIZED;
  process.env.PHASE4_ADMIN_USER_ID = "owner";
}
function store(): AttemptStore & { calls: string[]; current: AttemptState | null; recorded: object | null } {
  return {
    calls: [], current: null, recorded: null,
    async state() { return this.current; },
    async prepare() {
      this.calls.push("prepared");
      if (this.current) return null;
      this.current = "prepared";
      this.recorded = {
        attemptId: "00000000-0000-4000-8000-000000000001",
        keyName: "MICRO_LIVE_SUBACCOUNT_1", subaccount: 1,
        scopes: ["read", "write::trade"], createdAt: new Date(),
        state: "prepared",
      };
      return "00000000-0000-4000-8000-000000000001";
    },
    async markAttempted(_id) {
      this.calls.push("attempted");
      if (this.current !== "prepared") return false;
      this.current = "attempted";
      this.recorded = { ...this.recorded, state: "attempted" };
      return true;
    },
    async markOutcome(_id, state) {
      this.calls.push(state);
      this.current = state;
      this.recorded = { ...this.recorded, state };
    },
    async recoveryEligible() {
      const rows = this.recorded ? [this.recorded] : [];
      return rows.length === 1 && this.current === "response_received";
    },
    async markRecovered() {
      if (!(await this.recoveryEligible())) return false;
      this.calls.push("handoff_recovered_verified");
      this.current = "handoff_recovered_verified";
      this.recorded = {
        ...this.recorded, state: this.current, recoveryConfirmedAt: new Date(),
        recoveryReason: "Original in-memory handoff lost after API restart; independently verified",
      };
      return true;
    },
  };
}
type Fixture = Awaited<ReturnType<typeof serve>>;
async function serve(
  storage: AttemptStore,
  generate: () => Promise<GeneratedKey>,
  verifyRecovery: () => Promise<boolean> = async () => false,
) {
  const app = express();
  app.use("/api/admin/key-provisioning",
    express.urlencoded({ extended: false, limit: "1kb" }),
    createKeyProvisioningRouter({
      store: storage, generate, verifyRecovery,
      identity: req => ({
        userId: req.get("x-test-user") ?? null,
        sessionId: req.get("x-test-session") ?? null,
      }),
    }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return { server, port, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
async function call(f: Fixture, method: string, path: string, {
  user = "owner", session = "session-1", body, origin = "same",
  contentType = "application/x-www-form-urlencoded",
  receivedHost = "owner-dev.replit.dev", forwardedHost, forwardedProto = "https",
  fetchSite,
}: {
  user?: string | null; session?: string | null; body?: string; origin?: string | null;
  contentType?: string; receivedHost?: string; forwardedHost?: string;
  forwardedProto?: string; fetchSite?: string;
} = {}) {
  const host = process.env.REPLIT_DEV_DOMAIN!;
  return new Promise<{ status: number; html: string; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1", port: f.port, path, method,
      headers: {
        Host: receivedHost, "x-forwarded-proto": forwardedProto,
        ...(forwardedHost ? { "x-forwarded-host": forwardedHost } : {}),
        ...(fetchSite ? { "sec-fetch-site": fetchSite } : {}),
        ...(user ? { "x-test-user": user } : {}),
        ...(session ? { "x-test-session": session } : {}),
        ...(method === "POST" ? {
          ...(origin !== null ? { Origin: origin === "same" ? `https://${host}` : origin } : {}),
          "Content-Type": contentType,
        } : {}),
      },
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        html: Buffer.concat(chunks).toString(),
        headers: response.headers,
      }));
    });
    request.on("error", reject);
    request.end(body);
  });
}
function nonce(html: string) {
  const token = html.match(/name="csrf" value="([a-f0-9]{64})"/)?.[1];
  assert.ok(token, "owner form must contain a CSRF token");
  return `csrf=${token}`;
}
const fakeKey = (): GeneratedKey => ({
  id: Buffer.from("test-generated-id-12345"),
  pem: Buffer.from("-----BEGIN RSA PRIVATE KEY-----\ntest-only\n-----END RSA PRIVATE KEY-----"),
});

test("owner page restores Generate once but loading the form does not reserve or generate", async () => {
  allowDevelopment();
  process.env.KALSHI_KEY_GENERATION_AUTHORIZED = "true";
  const s = store();
  let generated = 0;
  const f = await serve(s, async () => { generated++; return fakeKey(); });
  try {
    const home = await call(f, "GET", "/api/admin/key-provisioning/");
    assert.equal(home.status, 200);
    assert.match(home.html, /action="\/api\/admin\/key-provisioning\/generate"/);
    assert.match(home.html, /Generate once/);
    assert.doesNotMatch(home.html, /dry-run|\/diagnose|origin_host:/i);
    assert.equal(home.headers["referrer-policy"], "same-origin");
    const form = nonce(home.html);
    const result = await call(f, "POST", "/api/admin/key-provisioning/diagnose", { body: form });
    assert.equal(result.status, 404);
    assert.doesNotMatch(result.html, /Dry-run checks|browser_origin_state|origin_host:/);
    assert.deepEqual(s.calls, []);
    assert.equal(s.current, null);
    assert.equal(generated, 0);
  } finally { await f.close(); }
});

test("only the canonical HTTPS development origin and matching proxy host pass", async () => {
  allowDevelopment();
  process.env.KALSHI_KEY_GENERATION_AUTHORIZED = "true";
  const s = store();
  let generated = 0;
  const f = await serve(s, async () => { generated++; return fakeKey(); });
  try {
    const form = nonce((await call(f, "GET", "/api/admin/key-provisioning/")).html);
    for (const options of [
      { origin: "https://owner-dev.replit.dev.evil.test" },
      { origin: "https://evil.test/owner-dev.replit.dev" },
      { origin: "http://owner-dev.replit.dev" },
      { origin: "" },
      { receivedHost: "evil.test", forwardedHost: "owner-dev.replit.dev" },
      { receivedHost: "owner-dev.replit.dev.evil.test" },
      { forwardedHost: "evil.test" },
      { forwardedHost: "owner-dev.replit.dev, evil.test" },
      { forwardedProto: "http" },
      { forwardedProto: "https, http" },
    ]) {
      const result = await call(f, "POST", "/api/admin/key-provisioning/generate",
        { body: form, ...options });
      assert.equal(result.status, 403);
      assert.equal(result.html, "Forbidden");
    }
    assert.deepEqual(s.calls, []);
    assert.equal(s.current, null);
    assert.equal(generated, 0);
  } finally { await f.close(); }
});

test("opaque, omitted and malformed Origins cannot generate even with same-origin Fetch Metadata", async () => {
  allowDevelopment();
  process.env.KALSHI_KEY_GENERATION_AUTHORIZED = "true";
  const s = store();
  let generated = 0;
  const f = await serve(s, async () => { generated++; return fakeKey(); });
  try {
    const form = nonce((await call(f, "GET", "/api/admin/key-provisioning/")).html);
    for (const origin of [
      "null", null, "https://owner-dev.replit.dev/path?private=value",
      "https://evil.test",
    ]) {
      const result = await call(f, "POST", "/api/admin/key-provisioning/generate",
        { body: form, origin, fetchSite: "same-origin" });
      assert.equal(result.status, 403);
      assert.equal(result.html, "Forbidden");
      assert.doesNotMatch(result.html, /private=value/);
    }
    assert.deepEqual(s.calls, []);
    assert.equal(s.current, null);
    assert.equal(generated, 0);
  } finally { await f.close(); }
});

test("unauthed and non-owner requests are denied; production and disabled flag block every route", async () => {
  allowDevelopment();
  const s = store();
  let generated = 0;
  const f = await serve(s, async () => { generated++; return fakeKey(); });
  try {
    assert.equal((await call(f, "GET", "/api/admin/key-provisioning/", { user: null })).status, 401);
    assert.equal((await call(f, "GET", "/api/admin/key-provisioning/", { user: "other" })).status, 403);
    assert.equal((await call(f, "POST", "/api/admin/key-provisioning/generate", { user: "other" })).status, 403);
    process.env.NODE_ENV = "production";
    assert.equal(keyProvisioningEnabled(), false);
    assert.equal((await call(f, "GET", "/api/admin/key-provisioning/")).status, 404);
    assert.equal((await call(f, "POST", "/api/admin/key-provisioning/generate")).status, 404);
    process.env.NODE_ENV = "development";
    process.env.REPLIT_DEPLOYMENT = "1";
    process.env.KALSHI_KEY_PROVISIONING_ENABLED = "true";
    assert.equal(keyProvisioningEnabled(), false);
    assert.equal((await call(f, "GET", "/api/admin/key-provisioning/")).status, 404);
    delete process.env.REPLIT_DEPLOYMENT;
    process.env.KALSHI_KEY_PROVISIONING_ENABLED = "false";
    assert.equal(keyProvisioningEnabled(), false);
    assert.equal((await call(f, "GET", "/api/admin/key-provisioning/")).status, 404);
    assert.equal(generated, 0);
  } finally { await f.close(); }
});

test("CSRF and cross-origin requests cannot commit an attempt; page has no script or cache", async () => {
  allowDevelopment();
  process.env.KALSHI_KEY_GENERATION_AUTHORIZED = "true";
  const s = store(), f = await serve(s, async () => fakeKey());
  try {
    const home = await call(f, "GET", "/api/admin/key-provisioning/");
    assert.equal(home.status, 200);
    assert.match(String(home.headers["cache-control"]), /no-store.*private/);
    assert.match(String(home.headers["content-security-policy"]), /script-src 'none'/);
    assert.match(String(home.headers["content-security-policy"]), /frame-ancestors 'none'/);
    assert.doesNotMatch(home.html, /<script|<link|<img/i);
    assert.equal(home.headers["access-control-allow-origin"], undefined);
    const form = nonce(home.html);
    assert.equal((await call(f, "POST", "/api/admin/key-provisioning/generate",
      { body: form, origin: "https://evil.example" })).status, 403);
    assert.equal((await call(f, "POST", "/api/admin/key-provisioning/generate",
      { body: "csrf=wrong" })).status, 403);
    assert.deepEqual(s.calls, []);
  } finally { await f.close(); }
});

test("interface enabled with generation gate OFF cannot create or change an attempt or contact Kalshi", async () => {
  allowDevelopment();
  const s = store();
  let networkCalls = 0;
  const f = await serve(s, async () => { networkCalls++; return fakeKey(); });
  try {
    const home = await call(f, "GET", "/api/admin/key-provisioning/");
    assert.equal(home.status, 200);
    assert.match(home.html, /Generation authorization is OFF/);
    const form = nonce(home.html);
    assert.equal((await call(f, "POST", "/api/admin/key-provisioning/generate",
      { body: form, origin: "https://evil.example" })).status, 403);
    assert.equal((await call(f, "POST", "/api/admin/key-provisioning/generate",
      { body: "csrf=invalid" })).status, 403);
    const rejected = await call(f, "POST", "/api/admin/key-provisioning/generate",
      { body: nonce((await call(f, "GET", "/api/admin/key-provisioning/")).html) });
    assert.equal(rejected.status, 403);
    assert.match(rejected.html, /Generation authorization disabled/);
    assert.equal(s.current, null);
    assert.deepEqual(s.calls, []);
    assert.equal(networkCalls, 0);
  } finally { await f.close(); }
});

test("concurrent owner submissions commit before one mocked network call; confirmation wipes retained buffers", async () => {
  allowDevelopment();
  process.env.KALSHI_KEY_GENERATION_AUTHORIZED = "true";
  const s = store();
  const generated = fakeKey();
  let networkCalls = 0;
  const f = await serve(s, async () => {
    networkCalls++;
    assert.equal(s.current, "attempted");
    assert.deepEqual(s.calls.slice(0, 2), ["prepared", "attempted"]);
    return generated;
  });
  try {
    const first = nonce((await call(f, "GET", "/api/admin/key-provisioning/",
      { session: "a" })).html);
    const second = nonce((await call(f, "GET", "/api/admin/key-provisioning/",
      { session: "b" })).html);
    const [a, b] = await Promise.all([
      call(f, "POST", "/api/admin/key-provisioning/generate", { session: "a", body: first }),
      call(f, "POST", "/api/admin/key-provisioning/generate", { session: "b", body: second }),
    ]);
    const success = a.status === 200 ? a : b;
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal(networkCalls, 1);
    assert.match(success.html, /KALSHI_MICRO_LIVE_PRIVATE_KEY/);
    assert.match(success.html, /BEGIN RSA PRIVATE KEY/);
    assert.doesNotMatch(JSON.stringify(s.recorded), /PRIVATE KEY|test-generated-id/);
    assert.equal(s.current, "response_received");
    const chosen = success === a ? "a" : "b";
    const confirmed = await call(f, "POST", "/api/admin/key-provisioning/confirm",
      { session: chosen, body: nonce(success.html) });
    assert.equal(confirmed.status, 200);
    assert.equal(s.current, "handoff_confirmed");
    assert.ok(generated.pem.every(byte => byte === 0));
    assert.ok(generated.id.every(byte => byte === 0));
    assert.doesNotMatch(confirmed.html, /PRIVATE KEY|test-generated-id/);
    assert.equal((await call(f, "GET", "/api/admin/key-provisioning/")).status, 409);
  } finally { await f.close(); }
});

test("lost result and restart retain attempted barrier and never regenerate", async () => {
  allowDevelopment();
  process.env.KALSHI_KEY_GENERATION_AUTHORIZED = "true";
  const s = store();
  let networkCalls = 0;
  const f = await serve(s, async () => {
    networkCalls++;
    throw new Error("synthetic network timeout with no secret");
  });
  try {
    const form = nonce((await call(f, "GET", "/api/admin/key-provisioning/")).html);
    assert.equal((await call(f, "POST", "/api/admin/key-provisioning/generate",
      { body: form })).status, 503);
    assert.equal(s.current, "uncertain");
  } finally { await f.close(); }
  const restarted = await serve(s, async () => { networkCalls++; return fakeKey(); });
  try {
    assert.equal((await call(restarted, "GET", "/api/admin/key-provisioning/")).status, 409);
    assert.equal((await call(restarted, "POST", "/api/admin/key-provisioning/generate",
      { body: "csrf=anything" })).status, 403);
    assert.equal(networkCalls, 1);
  } finally { await restarted.close(); }
});

test("recovery requires owner, same-origin CSRF, one existing response, and one-use confirmation", async () => {
  allowDevelopment();
  process.env.KALSHI_KEY_GENERATION_AUTHORIZED = "false";
  const s = store();
  s.current = "response_received";
  s.recorded = { state: s.current };
  let reads = 0, generations = 0;
  const f = await serve(s, async () => { generations++; return fakeKey(); },
    async () => { reads++; return true; });
  try {
    const path = "/api/admin/key-provisioning/recovery";
    const post = "/api/admin/key-provisioning/recover";
    assert.equal((await call(f, "GET", path, { user: null })).status, 401);
    assert.equal((await call(f, "GET", path, { user: "other" })).status, 403);
    const oldPage = await call(f, "GET", "/api/admin/key-provisioning/");
    assert.equal(oldPage.status, 303);
    assert.equal(oldPage.headers.location, path);
    assert.equal(oldPage.headers["x-provisioning-route"], "root");
    assert.doesNotMatch(oldPage.html, /Provisioning already recorded|Generate once/);
    const form = await call(f, "GET", path);
    assert.equal(form.status, 200);
    assert.equal(form.headers["x-provisioning-route"], "recovery");
    assert.equal(form.headers["referrer-policy"], "same-origin");
    assert.doesNotMatch(form.html, /PRIVATE KEY|test-generated-id/);
    const body = nonce(form.html);
    assert.equal((await call(f, "POST", post, { user: "other", body })).status, 403);
    for (const options of [
      { origin: "null" }, { origin: null }, { origin: "http://owner-dev.replit.dev" },
      { receivedHost: "evil.test" }, { forwardedProto: "http" },
      { body: "csrf=wrong" },
    ]) {
      assert.equal((await call(f, "POST", post, { body, ...options })).status, 403);
    }
    assert.equal(reads, 0);
    const fresh = nonce((await call(f, "GET", path)).html);
    assert.equal((await call(f, "POST", post, { body: fresh })).status, 200);
    assert.equal(reads, 1);
    assert.equal(s.current, "handoff_recovered_verified");
    assert.ok((s.recorded as { recoveryConfirmedAt: Date }).recoveryConfirmedAt instanceof Date);
    assert.match((s.recorded as { recoveryReason: string }).recoveryReason, /restart/);
    assert.equal((await call(f, "POST", post, { body: fresh })).status, 403);
    assert.equal((await call(f, "GET", path)).status, 409);
    assert.equal(reads, 1);
    assert.equal(generations, 0);
  } finally { await f.close(); }
});

test("only the eligible response_received owner is redirected away from the one-shot guard", async () => {
  allowDevelopment();
  process.env.KALSHI_KEY_GENERATION_AUTHORIZED = "false";
  for (const state of ["attempted", "uncertain", "handoff_confirmed"] as const) {
    const s = store();
    s.current = state;
    s.recorded = { state };
    const f = await serve(s, async () => { throw Error("generation forbidden"); });
    try {
      const response = await call(f, "GET", "/api/admin/key-provisioning/");
      assert.equal(response.status, 409);
      assert.match(response.html, /Provisioning already recorded/);
      assert.equal(response.headers.location, undefined);
    } finally { await f.close(); }
  }
});

test("recovery rejects missing, duplicate, wrong-state, unverified, and generation-authorized attempts", async () => {
  allowDevelopment();
  process.env.KALSHI_KEY_GENERATION_AUTHORIZED = "false";
  for (const [label, state, count, verified] of [
    ["missing", null, 0, true],
    ["duplicate", "response_received", 2, true],
    ["wrong state", "attempted", 1, true],
    ["unverified", "response_received", 1, false],
  ] as const) {
    const s = store();
    s.current = state;
    s.recorded = count ? { state } : null;
    s.recoveryEligible = async () => count === 1 && state === "response_received";
    let reads = 0;
    const f = await serve(s, async () => { throw Error("generation forbidden"); },
      async () => { reads++; return verified; });
    try {
      const page = await call(f, "GET", "/api/admin/key-provisioning/recovery");
      if (label === "unverified") {
        assert.equal(page.status, 200);
        const result = await call(f, "POST", "/api/admin/key-provisioning/recover",
          { body: nonce(page.html) });
        assert.equal(result.status, 409);
        assert.equal(reads, 1);
      } else {
        assert.equal(page.status, 409, label);
        assert.equal(reads, 0);
      }
      assert.equal(s.current, state, label);
    } finally { await f.close(); }
  }
  const s = store();
  s.current = "response_received";
  s.recorded = { state: s.current };
  const f = await serve(s, async () => { throw Error("generation forbidden"); },
    async () => true);
  try {
    const form = nonce((await call(f, "GET", "/api/admin/key-provisioning/recovery")).html);
    process.env.KALSHI_KEY_GENERATION_AUTHORIZED = "true";
    assert.equal((await call(f, "POST", "/api/admin/key-provisioning/recover",
      { body: form })).status, 409);
    assert.equal(s.current, "response_received");
  } finally { await f.close(); }
});

test("recovery verifier uses only GET and rejects wrong ID, name count, binding and scopes", async () => {
  allowDevelopment();
  process.env.KALSHI_API_ENVIRONMENT = "production";
  process.env.KALSHI_KEY_GENERATION_AUTHORIZED = "false";
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  process.env.KALSHI_VERIFIER_API_KEY_ID = "verifier";
  process.env.KALSHI_VERIFIER_API_PRIVATE_KEY = pem;
  process.env.KALSHI_MICRO_LIVE_API_KEY_ID = "restricted";
  process.env.KALSHI_MICRO_LIVE_PRIVATE_KEY = pem;
  const correct = {
    name: "MICRO_LIVE_SUBACCOUNT_1", api_key_id: "restricted",
    subaccount: 1, scopes: ["read", "write::trade"],
  };
  let records: object[] = [correct];
  let restrictedReads = 0;
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.method, "GET");
    const url = new URL(String(input));
    assert.equal(url.origin, "https://external-api.kalshi.com");
    const headers = init?.headers as Record<string, string>;
    const listing = url.pathname.endsWith("/api_keys");
    assert.equal(headers["KALSHI-ACCESS-KEY"], listing ? "verifier" : "restricted");
    if (listing) return new Response(JSON.stringify({ api_keys: records }), { status: 200 });
    restrictedReads++;
    assert.equal(url.searchParams.get("subaccount"), "1");
    const list = url.pathname.endsWith("/positions")
      ? { market_positions: [], event_positions: [], cursor: "" }
      : { [url.pathname.split("/").at(-1)!]: [], cursor: "" };
    return new Response(JSON.stringify(url.pathname.endsWith("/balance")
      ? { balance: 0, portfolio_value: 0 } : list), { status: 200 });
  };
  try {
    assert.equal(await verifyProvisioningRecovery(), true);
    assert.equal(restrictedReads, 5);
    for (const altered of [
      { ...correct, api_key_id: "different" },
      { ...correct, name: "OTHER_KEY" },
      { ...correct, subaccount: 0 },
      { ...correct, scopes: ["read", "write"] },
      { ...correct, scopes: ["read", "write::trade", "write"] },
      { ...correct, scopes: ["read"] },
    ]) {
      records = [altered];
      assert.equal(await verifyProvisioningRecovery(), false);
      assert.equal(restrictedReads, 5, "metadata mismatch must not use restricted credential");
    }
    records = [correct, correct];
    assert.equal(await verifyProvisioningRecovery(), false);
    records = [correct];
    process.env.KALSHI_KEY_GENERATION_AUTHORIZED = "true";
    assert.equal(await verifyProvisioningRecovery(), false);
  } finally { globalThis.fetch = saved.fetch; }
});

test("generator sends exactly RSA, name, subaccount, and two narrow scopes, never retries", async () => {
  allowDevelopment();
  process.env.KALSHI_API_ENVIRONMENT = "production";
  process.env.KALSHI_PROVISIONING_API_KEY_ID = "test-provisioning-id";
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.KALSHI_PROVISIONING_PRIVATE_KEY =
    pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    assert.equal(options?.method, "POST");
    assert.deepEqual(JSON.parse(String(options?.body)), {
      name: "MICRO_LIVE_SUBACCOUNT_1", key_type: "rsa",
      scopes: ["read", "write::trade"], subaccount: 1,
    });
    return new Response(JSON.stringify({
      api_key_id: "test-generated-id-12345",
      private_key: fakeKey().pem.toString(),
    }), { status: 201 });
  };
  try {
    await assert.rejects(generateRestrictedKalshiKey(), /Key provisioning disabled/);
    assert.equal(calls, 0, "interface flag alone cannot authorize the network POST");
    process.env.KALSHI_KEY_GENERATION_AUTHORIZED = "true";
    const result = await generateRestrictedKalshiKey();
    assert.equal(calls, 1);
    assert.equal(result.id.toString(), "test-generated-id-12345");
    result.id.fill(0);
    result.pem.fill(0);
  } finally {
    globalThis.fetch = saved.fetch;
  }
});