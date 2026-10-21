import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { ProductionSupervisor, type StopBlockers, type WorkerHandle } from "../lib/v13-production/control";
import { assertDirectSessionDatabase, tryAcquireProductionWorkerLock } from "../lib/strata/instanceLock";
import { verifySupabaseAccessToken } from "../lib/strata/supabaseAuth";
import { createStrataRouter } from "./strataRouter";

const SUPABASE_URL = "https://project.supabase.co";
const DEVELOPER_ID = "11111111-1111-4111-8111-111111111111";
const STANDARD_ID = "22222222-2222-4222-8222-222222222222";
const ADMIN_ID = "33333333-3333-4333-8333-333333333333";

const FLAG_NAMES = [
  "LIVE_EXECUTION_ENABLED",
  "V13_PRODUCTION_EXECUTION_ENABLED",
  "KALSHI_API_ENVIRONMENT",
  "MICRO_LIVE_ACCOUNT_MODE",
  "KALSHI_BOT_SUBACCOUNT",
  "KALSHI_INDEX2_API_KEY_ID",
  "KALSHI_INDEX2_PRIVATE_KEY",
] as const;

function flags(): Record<string, string | undefined> {
  return Object.fromEntries(FLAG_NAMES.map((name) => [name, process.env[name]]));
}

async function signingKeys(): Promise<{ privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"]; keys: JWTVerifyGetKey }> {
  const pair = await generateKeyPair("RS256");
  const jwk = await exportJWK(pair.publicKey);
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { privateKey: pair.privateKey, keys: createLocalJWKSet({ keys: [jwk] }) };
}

async function token(privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"], options: {
  sub: string;
  aal?: string;
  issuer?: string;
  audience?: string;
  expires?: string;
}): Promise<string> {
  return new SignJWT({ aal: options.aal ?? "aal2", role: "authenticated" })
    .setProtectedHeader({ alg: "RS256" })
    .setSubject(options.sub)
    .setIssuer(options.issuer ?? `${SUPABASE_URL}/auth/v1`)
    .setAudience(options.audience ?? "authenticated")
    .setIssuedAt()
    .setExpirationTime(options.expires ?? "10m")
    .sign(privateKey);
}

function roleOf(subject: string): Promise<string | null> {
  if (subject === DEVELOPER_ID) return Promise.resolve("DEVELOPER");
  if (subject === STANDARD_ID) return Promise.resolve("STANDARD");
  if (subject === ADMIN_ID) return Promise.resolve("ADMIN");
  return Promise.resolve(null);
}

function harness(options?: { start?: () => Promise<void> }) {
  let creates = 0;
  let starts = 0;
  let stops = 0;
  let emergencyStops = 0;
  let scheduled = false;
  const worker: WorkerHandle = {
    async start() {
      starts += 1;
      if (options?.start) await options.start();
      else scheduled = true;
    },
    stop() {
      stops += 1;
      scheduled = false;
    },
    isScheduled: () => scheduled,
  };
  const blockers: StopBlockers = {
    openPositionCount: 0, unresolvedIntentCount: 0, unknownIntentCount: 0, dispatchedIntentCount: 0,
  };
  const supervisor = new ProductionSupervisor({
    createWorker: async () => {
      creates += 1;
      return worker;
    },
    readStopBlockers: async () => blockers,
  });
  return {
    supervisor,
    counts: () => ({ creates, starts, stops, emergencyStops }),
    noteEmergency: () => { emergencyStops += 1; },
  };
}

function listen(app: express.Express) {
  const server = app.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => ({
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }));
}

function call(port: number, path: string, method: string, bearer?: string, body?: unknown) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = httpRequest({
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode ?? 0, body: text.startsWith("{") ? JSON.parse(text) as Record<string, unknown> : {} });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test("missing, invalid, expired and wrong-issuer Supabase tokens are denied", async () => {
  const { privateKey, keys } = await signingKeys();
  const h = harness();
  const app = express();
  app.use(express.json());
  app.use("/api/strata", createStrataRouter({
    verifyToken: (value) => verifySupabaseAccessToken(value, { supabaseUrl: SUPABASE_URL, keys }),
    roleOf,
    control: h.supervisor,
    status: async () => h.supervisor.view(),
    positions: async () => ({ positions: [] }),
    orders: async () => ({ orders: [] }),
    fills: async () => ({ fills: [] }),
    trades: async () => ({ trades: [] }),
    latestTrade: async () => ({ unresolved: false, latestCompleted: null }),
    forwardTestStatus: async () => ({ engineMode: "PAPER" }),
    forwardTestHistory: async () => ({ positions: [] }),
    phase4State: async () => ({}),
    microLiveState: async () => ({}),
    emergencyStop: async () => {
      h.noteEmergency();
      return { killSwitch: "ON" };
    },
  }));
  const server = await listen(app);
  try {
    assert.equal((await call(server.port, "/api/strata/production/start", "POST")).status, 401);
    // The modern dashboard calls the Strata namespace with Supabase JWTs.
    // Missing auth must not disclose the CF Benchmarks read-only feed.
    const referencePath = "/api/strata/forward-test/settlement-reference";
    assert.equal((await call(server.port, referencePath, "GET")).status, 401);
    assert.equal((await call(server.port, referencePath, "GET", "bad-token")).status, 401);
    assert.equal((await call(server.port, "/api/strata/production/start", "POST", "not-a-jwt")).status, 401);
    const expired = await token(privateKey, { sub: DEVELOPER_ID, expires: "-1m" });
    assert.equal((await call(server.port, "/api/strata/production/start", "POST", expired)).status, 401);
    const wrongIssuer = await token(privateKey, { sub: DEVELOPER_ID, issuer: "https://evil.example/auth/v1" });
    assert.equal((await call(server.port, "/api/strata/production/start", "POST", wrongIssuer)).status, 401);
    const aal1 = await token(privateKey, { sub: DEVELOPER_ID, aal: "aal1" });
    assert.equal((await call(server.port, "/api/strata/production/start", "POST", aal1)).status, 401);
    assert.equal((await call(server.port, referencePath, "GET", aal1)).status, 401);

    // A standard owner's valid AAL2 token can now read the route without
    // a Clerk session, signer, trade permission, or any database mutation.
    const standardJwt = await token(privateKey, { sub: STANDARD_ID });
    const ref = await call(server.port, referencePath, "GET", standardJwt);
    assert.equal(ref.status, 200);
    assert.equal(ref.body.indexId, "BRTI");
    assert.equal(ref.body.readOnly, true);
    assert.equal(ref.body.paperOnly, true);
    assert.equal(ref.body.tradingAuthority, false);
    assert.equal(ref.body.comparison, null);
    assert.equal(ref.body.spotComparison, null);
    assert.equal(typeof ref.body.sourceFresh, "boolean");
    assert.equal(typeof ref.body.instantSourceFresh, "boolean");
    assert.equal(h.counts().creates, 0);
    assert.equal(h.counts().emergencyStops, 0);
  } finally {
    await server.close();
  }
});

test("STANDARD cannot control production and DEVELOPER reaches the worker gate", async () => {
  const { privateKey, keys } = await signingKeys();
  const h = harness({
    start: async () => { throw new Error("production_authority_disabled_or_uncommissioned"); },
  });
  const app = express();
  app.use(express.json());
  app.use("/api/strata", createStrataRouter({
    verifyToken: (value) => verifySupabaseAccessToken(value, { supabaseUrl: SUPABASE_URL, keys }),
    roleOf,
    control: h.supervisor,
    status: async () => h.supervisor.view(),
    positions: async () => ({ positions: [] }),
    orders: async () => ({ orders: [] }),
    fills: async () => ({ fills: [] }),
    trades: async () => ({ trades: [] }),
    latestTrade: async () => ({ unresolved: false, latestCompleted: null }),
    forwardTestStatus: async () => ({ engineMode: "PAPER" }),
    forwardTestHistory: async () => ({ positions: [] }),
    phase4State: async () => ({}),
    microLiveState: async () => ({}),
    emergencyStop: async () => {
      h.noteEmergency();
      return { killSwitch: "ON" };
    },
  }));
  const server = await listen(app);
  const before = flags();
  try {
    const standard = await token(privateKey, { sub: STANDARD_ID });
    assert.equal((await call(server.port, "/api/strata/production/start", "POST", standard, {})).status, 403);
    assert.equal(h.counts().creates, 0);
    const developer = await token(privateKey, { sub: DEVELOPER_ID });
    const started = await call(server.port, "/api/strata/production/start", "POST", developer, {});
    assert.equal(started.status, 200);
    assert.equal(started.body.runtimeStatus, "BLOCKED");
    assert.equal(started.body.workerRunning, false);
    assert.equal(h.counts().starts, 1);
    assert.deepEqual(flags(), before);
    const admin = await token(privateKey, { sub: ADMIN_ID });
    const adminStart = await call(server.port, "/api/strata/production/start", "POST", admin, {});
    assert.equal(adminStart.status, 200);
    assert.equal(adminStart.body.runtimeStatus, "BLOCKED");
    assert.equal(h.counts().starts, 2);
    const stopped = await call(server.port, "/api/strata/production/stop", "POST", developer, {});
    assert.equal(stopped.body.runtimeStatus, "BLOCKED");
    assert.equal(h.counts().stops, 0);
    assert.equal(h.counts().emergencyStops, 0);
    const emergency = await call(server.port, "/api/strata/micro-live/emergency-stop", "POST", developer, { disable: true });
    assert.equal(emergency.status, 200);
    assert.equal(h.counts().emergencyStops, 1);
  } finally {
    await server.close();
  }
});

test("a direct session database URL is accepted and a transaction pooler is refused", async () => {
  assert.doesNotThrow(() => assertDirectSessionDatabase("postgresql://postgres@db.example.supabase.co:5432/postgres"));
  assert.throws(() => assertDirectSessionDatabase("postgresql://postgres@aws.pooler.supabase.com:6543/postgres"), /production_database_pooler_refused/);
  assert.throws(() => assertDirectSessionDatabase("not a url"), /production_database_url_invalid/);
  const acquired = await tryAcquireProductionWorkerLock({
    query: async () => ({ rows: [{ locked: false }] }),
  });
  assert.equal(acquired, false);
});
