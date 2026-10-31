import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { ProductionSupervisor, type StopBlockers, type WorkerHandle } from "../lib/v13-production/control";
import { ProductionExecutor } from "../lib/v13-production/executor";
import type { Account } from "../lib/v13-production/ledger";
import { createProductionRouter } from "./productionRouter";
import { sanitizePublic } from "../lib/v13-production/sanitize";

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

function flat(): StopBlockers {
  return { openPositionCount: 0, unresolvedIntentCount: 0, unknownIntentCount: 0, dispatchedIntentCount: 0 };
}

function harness(options?: {
  start?: () => Promise<void>;
  blockers?: () => Promise<StopBlockers>;
  status?: () => Promise<unknown>;
}) {
  let creates = 0;
  let starts = 0;
  let stops = 0;
  let scheduled = false;
  let emergencyStops = 0;
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
  const supervisor = new ProductionSupervisor({
    createWorker: async () => {
      creates += 1;
      return worker;
    },
    readStopBlockers: options?.blockers ?? (async () => flat()),
  });
  const app = express();
  app.use(express.json());
  app.use("/api", createProductionRouter({
    control: supervisor,
    status: options?.status ?? (async () => supervisor.view()),
    positions: async () => ({ positions: [] }),
    orders: async () => ({ orders: [] }),
    fills: async () => ({ fills: [] }),
    trades: async () => ({ trades: [] }),
    latestTrade: async () => ({ unresolved: false, latestCompleted: null }),
  }));
  return {
    app, supervisor, worker,
    counts: () => ({ creates, starts, stops, emergencyStops }),
    noteEmergency: () => { emergencyStops += 1; },
    setScheduled: (value: boolean) => { scheduled = value; },
  };
}

async function listen(app: express.Express) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function call(port: number, path: string, method: string, userId?: string, body?: unknown) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = httpRequest({
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        ...(userId ? { "x-test-user-id": userId } : {}),
        ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode ?? 0, body: text.startsWith("{") ? JSON.parse(text) : {} });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test("unauthenticated and unauthorized production START are denied", async () => {
  process.env.PHASE4_ADMIN_USER_ID = "production-admin";
  const h = harness();
  const server = await listen(h.app);
  try {
    assert.equal((await call(server.port, "/api/production/start", "POST")).status, 401);
    assert.equal((await call(server.port, "/api/production/start", "POST", "other-user")).status, 403);
    assert.equal(h.counts().creates, 0);
    assert.equal(h.counts().starts, 0);
  } finally {
    await server.close();
  }
});

test("START is idempotent and concurrent START creates one worker", async () => {
  process.env.PHASE4_ADMIN_USER_ID = "production-admin";
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered = 0;
  const h = harness({
    start: async () => {
      entered += 1;
      await gate;
      h.setScheduled(true);
    },
  });
  const server = await listen(h.app);
  try {
    const first = call(server.port, "/api/production/start", "POST", "production-admin", {});
    const second = call(server.port, "/api/production/start", "POST", "production-admin", {});
    const deadline = Date.now() + 2_000;
    while (entered < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(h.counts().creates, 1);
    assert.equal(entered, 1);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.body.runtimeStatus, "RUNNING");
    assert.equal(a.body.workerRunning, true);
    assert.equal(b.body.workerRunning, true);
    const again = await call(server.port, "/api/production/start", "POST", "production-admin", {});
    assert.equal(again.body.runtimeStatus, "RUNNING");
    assert.equal(h.counts().creates, 1);
    assert.equal(h.counts().starts, 1);
  } finally {
    await server.close();
  }
});

test("failed ProductionWorker.start does not report RUNNING and does not change authority flags", async () => {
  process.env.PHASE4_ADMIN_USER_ID = "production-admin";
  process.env.KALSHI_INDEX2_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----";
  const before = flags();
  const h = harness({
    start: async () => {
      throw new Error("production_authority_disabled_or_uncommissioned");
    },
  });
  const server = await listen(h.app);
  try {
    const response = await call(server.port, "/api/production/start", "POST", "production-admin", {});
    assert.equal(response.status, 200);
    assert.equal(response.body.runtimeStatus, "BLOCKED");
    assert.equal(response.body.workerRunning, false);
    assert.equal(response.body.blockedReason, "production_authority_disabled_or_uncommissioned");
    assert.equal(h.worker.isScheduled(), false);
    assert.deepEqual(flags(), before);
    assert.equal(response.body.killSwitch, undefined);
    const text = JSON.stringify(response.body);
    assert.equal(text.includes("PRIVATE KEY"), false);
    assert.equal(text.includes("not-a-real-key"), false);
  } finally {
    await server.close();
  }
});

test("STOP while flat calls ProductionWorker.stop and does not engage emergency stop", async () => {
  process.env.PHASE4_ADMIN_USER_ID = "production-admin";
  const h = harness();
  const server = await listen(h.app);
  try {
    assert.equal((await call(server.port, "/api/production/start", "POST", "production-admin")).body.runtimeStatus, "RUNNING");
    const stopped = await call(server.port, "/api/production/stop", "POST", "production-admin", {});
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.runtimeStatus, "STOPPED");
    assert.equal(stopped.body.workerRunning, false);
    assert.equal(stopped.body.refused, false);
    assert.equal(h.counts().stops, 1);
    assert.equal(h.counts().emergencyStops, 0);
    assert.equal(JSON.stringify(stopped.body).includes("emergency"), false);
  } finally {
    await server.close();
  }
});

test("STOP is blocked while an owned position or unresolved intent exists", async () => {
  process.env.PHASE4_ADMIN_USER_ID = "production-admin";
  for (const blockers of [
    { ...flat(), openPositionCount: 1 },
    { ...flat(), unresolvedIntentCount: 1 },
    { ...flat(), unknownIntentCount: 1 },
    { ...flat(), dispatchedIntentCount: 1 },
  ]) {
    const h = harness({ blockers: async () => blockers });
    const server = await listen(h.app);
    try {
      await call(server.port, "/api/production/start", "POST", "production-admin");
      const stopped = await call(server.port, "/api/production/stop", "POST", "production-admin");
      assert.equal(stopped.status, 409);
      assert.equal(stopped.body.runtimeStatus, "RUNNING");
      assert.equal(stopped.body.workerRunning, true);
      assert.equal(stopped.body.refused, true);
      assert.equal(typeof stopped.body.reason, "string");
      assert.equal(h.counts().stops, 0);
      assert.equal(h.worker.isScheduled(), true);
    } finally {
      await server.close();
    }
  }
});

test("runtime status follows the worker and public responses contain no secrets", async () => {
  process.env.PHASE4_ADMIN_USER_ID = "production-admin";
  const secret = "-----BEGIN PRIVATE KEY-----\nsuper-secret\n-----END PRIVATE KEY-----";
  const h = harness({
    status: async () => sanitizePublic({
      runtimeStatus: h.supervisor.view().runtimeStatus,
      workerRunning: h.supervisor.view().workerRunning,
      privateKey: secret,
      nested: { apiKey: "key-id", championId: "v13-champion-2-c52-confirm53" },
    }),
  });
  const server = await listen(h.app);
  try {
    const idle = await call(server.port, "/api/production/status", "GET", "production-admin");
    assert.equal(idle.body.runtimeStatus, "STOPPED");
    assert.equal(idle.body.workerRunning, false);
    await call(server.port, "/api/production/start", "POST", "production-admin");
    const running = await call(server.port, "/api/production/status", "GET", "production-admin");
    assert.equal(running.body.runtimeStatus, "RUNNING");
    assert.equal(running.body.workerRunning, true);
    const text = JSON.stringify(running.body);
    assert.equal(text.includes("PRIVATE KEY"), false);
    assert.equal(text.includes("super-secret"), false);
    assert.equal(text.includes("key-id"), false);
    const nested = running.body.nested as { championId?: string };
    assert.equal(nested.championId, "v13-champion-2-c52-confirm53");
  } finally {
    await server.close();
  }
});

test("entry loss recheck and kill switch stay in front of submit without a new order", () => {
  const executor = readFileSync("src/lib/v13-production/executor.ts", "utf8");
  const prepareEntry = executor.slice(executor.indexOf("async prepareEntry"), executor.indexOf("async prepareExit"));
  const prepareExit = executor.slice(executor.indexOf("async prepareExit"), executor.indexOf("async dispatch"));
  const dispatch = executor.slice(executor.indexOf("async dispatch"), executor.indexOf("async cancel"));
  const final = dispatch.slice(dispatch.indexOf("const final = async"));
  const entryRecheck = final.slice(final.indexOf("if (i.kind === \"ENTRY\")"));
  assert.match(prepareEntry, /gate\(tx, a\)/);
  assert.equal(prepareEntry.includes("gate(tx, a, true)"), false);
  assert.match(prepareExit, /gate\(tx, a, true\)/);
  assert.match(prepareExit, /reduceOnly: true/);
  assert.match(prepareExit, /planFractionalIocExit\(\{ ownedHundredths:qty\.toString\(\)/);
  assert.match(prepareExit, /quantityVersion:EXIT_QUANTITY_VERSION,quantityHundredths:plan\.plan\.plannedHundredths/);
  assert.equal(prepareExit.includes("qty / 100n"), false);
  assert.equal(prepareExit.includes("Math.ceil"), false);
  assert.match(prepareExit, /production_exit_not_owned/);
  assert.match(dispatch, /gate\(tx, a, i\.kind === "EXIT", id\)/);
  assert.match(entryRecheck, /remainingLossBudgetAllowsEntry/);
  assert.match(entryRecheck, /live_money_entry_exceeds_remaining_loss_budget/);
  assert.equal(entryRecheck.includes("INSERT INTO"), false);
  assert.ok(final.indexOf("remainingLossBudgetAllowsEntry") < final.indexOf("this.exchange.submit"));
  assert.match(executor, /!a\.kill_switch/);
  assert.match(executor, /manual_kill_switch === false/);
  assert.match(executor, /live_execution_enabled === true/);
  assert.match(executor, /!a\.blocked_reason \|\| allowBlockedExit/);
});

test("master and account kill switches block the only production mutation gate", async () => {
  const microLive = readFileSync("src/lib/microLive.ts", "utf8");
  const shadow = readFileSync("src/lib/shadowLive.ts", "utf8");
  const startup = readFileSync("src/index.ts", "utf8");
  const transport = readFileSync("src/lib/v13-production/transport.ts", "utf8");
  const funding = readFileSync("src/lib/microLivePairFunding.ts", "utf8");
  assert.equal(microLive.includes("live_execution_config"), false);
  assert.match(shadow, /execution_must_remain_disabled/);
  assert.match(shadow, /liveExecutionEnabled: false/);
  assert.equal(startup.includes("ProductionExecutor"), false);
  assert.equal(startup.includes("ProductionWorker"), false);
  assert.match(transport, /ProductionExecutor\.isFinalFence/);
  assert.match(funding, /!live\.liveExecutionEnabled/);

  const names = [
    "NODE_ENV", "LIVE_EXECUTION_ENABLED", "V13_PRODUCTION_EXECUTION_ENABLED",
    "MICRO_LIVE_ACCOUNT_MODE", "KALSHI_BOT_SUBACCOUNT",
  ] as const;
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.NODE_ENV = "production";
  process.env.LIVE_EXECUTION_ENABLED = "true";
  process.env.V13_PRODUCTION_EXECUTION_ENABLED = "true";
  process.env.MICRO_LIVE_ACCOUNT_MODE = "exclusive";
  process.env.KALSHI_BOT_SUBACCOUNT = "1";
  try {
    const executor = new ProductionExecutor({} as never, { mode: "LIVE" } as never);
    const account = (overrides: Partial<Account> = {}): Account => ({
      id: "acct", policy_id: "policy", subaccount: "1", exchange_index: "2",
      key_fingerprint: "a".repeat(64), commissioning_digest: "b".repeat(64),
      kill_switch: false, execution_enabled: true, commissioned: true,
      minimum_exit_micros: 10000, fee_artifact_digest: "c".repeat(64),
      cash_precision_verified: true, cash_micros: "25000000", reserved_micros: "0",
      initial_cash_micros: "25000000", blocked_reason: null, reconciled_at: new Date(),
      revision: "1", ...overrides,
    });
    const tx = (master: { manual_kill_switch: boolean; live_execution_enabled: boolean } | null) => ({
      query: async (sql: string) => {
        if (sql.includes("v13_production_intent")) return { rows: [] };
        if (sql.includes("live_execution_config")) return { rows: master ? [master] : [] };
        return { rows: [] };
      },
    });
    await assert.rejects(
      () => executor.gate(tx({ manual_kill_switch: true, live_execution_enabled: false }) as never, account()),
      /production_master_kill_switch_or_flag/,
    );
    await assert.rejects(
      () => executor.gate(tx({ manual_kill_switch: true, live_execution_enabled: true }) as never, account()),
      /production_master_kill_switch_or_flag/,
    );
    await assert.rejects(
      () => executor.gate(tx({ manual_kill_switch: false, live_execution_enabled: true }) as never, account({ kill_switch: true })),
      /production_authority_disabled_or_uncommissioned/,
    );
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});
