import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pool, type PoolClient } from "@workspace/db";
import { ProductionLedger, identity, type Account } from "./ledger";
import type { Snapshot } from "./types";

// Imported by acceptance.test.ts, which owns the shared pool's shutdown.
// Never run against a connected application database or create a new cluster.
const disposableUrl = process.env.V13_DISPOSABLE_DATABASE_URL;
assert.match(disposableUrl ?? "", /^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/,
  "fresh disposable PostgreSQL required for projection concurrency tests");
assert.equal(process.env.DATABASE_URL, disposableUrl);

const originalSql = "SELECT * FROM v13_production_intent WHERE account_id=$1 ORDER BY created_at,id FOR UPDATE";
const intentColumns = ["id", "account_id", "evaluation_id", "crossing_key", "parent_id", "kind", "market", "side",
  "state", "request", "decision", "policy_hash", "fee_fingerprint", "capability_digest", "client_order_id",
  "exchange_order_id", "reserved_micros", "exit_fee_micros", "filled_hundredths", "terminal", "cancel_attempted",
  "dispatch_at", "created_at"];

/** Capture the SQL from the real method, without executing other ledger work.
 * A copied SQL literal could keep passing after the production query changes.
 */
async function captureReconciliationSql(): Promise<string> {
  const stopped = new Error("projection_query_captured");
  const account: Account = {
    id: "a", policy_id: "fixture", subaccount: "1", exchange_index: "2", key_fingerprint: "b".repeat(64),
    commissioning_digest: null, kill_switch: false, execution_enabled: true, commissioned: false,
    minimum_exit_micros: null, fee_artifact_digest: null, cash_precision_verified: true,
    cash_micros: "0", reserved_micros: "0", initial_cash_micros: "0", blocked_reason: null,
    reconciled_at: null, revision: "1",
  };
  const snapshot: Snapshot = {
    identity: identity(account), authenticated: true, complete: true, cashExact: true,
    unexplainedCashActivity: false, cashMicros: "0", observedAtMs: 1_000, historyFromMs: 0,
    orders: [], fills: [], settlements: [], positions: [],
  };
  class CapturingLedger extends ProductionLedger {
    captured: { sql: string; args: unknown[] }[] = [];
    override async transaction<T>(body: (tx: PoolClient, a: Account) => Promise<T>): Promise<T> {
      const tx = { query: async (sql: string, args: unknown[]) => {
        this.captured.push({ sql, args });
        throw stopped;
      } };
      return body(tx as unknown as PoolClient, account);
    }
    override async freeze(): Promise<void> { /* The deliberate capture failure is local to this test. */ }
  }
  const ledger = new CapturingLedger(pool, account.id);
  await assert.rejects(ledger.reconcile(snapshot, "1", 1_000), error => error === stopped);
  assert.equal(ledger.captured.length, 1);
  const captured = ledger.captured[0]!;
  assert.deepEqual(captured.args, [account.id]);
  assert.match(captured.sql, /CASE WHEN state='BLOCKED' AND terminal IS TRUE THEN NULL ELSE decision END AS decision/);
  assert.match(captured.sql, /FROM v13_production_intent WHERE account_id=\$1 ORDER BY created_at,id FOR UPDATE$/);
  return captured.sql;
}

type Row = Record<string, unknown>;
function projected(row: Row, variant: string): Row {
  return variant === "projected" && row.state === "BLOCKED" && row.terminal === true
    ? { ...row, decision: null } : row;
}

test("reconciliation projection preserves PostgreSQL rows, locks and concurrent tuple versions", async t => {
  const sqls = { original: originalSql, projected: await captureReconciliationSql() };
  const clients: PoolClient[] = [];
  const schema = `projection_${randomUUID().replaceAll("-", "")}`;
  let schemaCreated = false;
  try {
    for (let index = 0; index < 4; index++) clients.push(await pool.connect());
    const [db, reader, writer, probe] = clients as [PoolClient, PoolClient, PoolClient, PoolClient];
    await db.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    // LIKE preserves the current column types/order/defaults/checks/indexes,
    // without copying foreign keys into unrelated public acceptance fixtures.
    await db.query(`CREATE TABLE "${schema}".v13_production_intent
      (LIKE public.v13_production_intent INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
    await db.query(`CREATE TABLE "${schema}".v13_production_account
      (id text PRIMARY KEY, revision bigint NOT NULL DEFAULT 0)`);
    for (const client of clients) {
      await client.query(`SET search_path TO "${schema}", pg_catalog`);
      await client.query("SET statement_timeout='10s'; SET lock_timeout='8s'");
    }
    await db.query("INSERT INTO v13_production_account(id) VALUES('a'),('other')");
    const readerPid = Number((await reader.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    const writerPid = Number((await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    const serverVersion = (await db.query("SHOW server_version")).rows[0].server_version;
    const serverVersionNum = (await db.query("SHOW server_version_num")).rows[0].server_version_num;
    t.diagnostic(`PROJECTION_POSTGRES_SERVER ${JSON.stringify({ serverVersion, serverVersionNum })}`);

    async function insert(id: string, state = "BLOCKED", terminal = true, kind = "ENTRY", accountId = "a") {
      await db.query(`INSERT INTO v13_production_intent
        (id,account_id,evaluation_id,crossing_key,parent_id,kind,market,side,state,request,decision,
         policy_hash,fee_fingerprint,capability_digest,client_order_id,reserved_micros,exit_fee_micros,terminal,created_at)
        VALUES($1,$2,$3,$4,$5,$6,'LOCAL-PROJECTION','YES',$7,$8,$9,'policy','fee','capability',$10,0,0,$11,'2026-01-02T00:00:00Z')`,
      [id, accountId, kind === "ENTRY" ? `evaluation-${id}` : null, kind === "ENTRY" ? `crossing-${id}` : null,
        kind === "EXIT" ? `parent-${id}` : null, kind, state,
        JSON.stringify({ market: "LOCAL-PROJECTION", side: "YES", action: kind === "ENTRY" ? "BUY" : "SELL",
          contracts: 1, limitMicros: 500_000, timeInForce: "IOC", reduceOnly: kind === "EXIT", clientOrderId: `client-${id}` }),
        JSON.stringify({ marker: "old", payload: "x".repeat(16_384) }), `client-${id}`, terminal]);
    }
    async function reset(state = "BLOCKED", terminal = true) {
      await db.query("TRUNCATE v13_production_intent");
      await insert("target", state, terminal);
    }
    async function begin(client: PoolClient, isolation: "READ COMMITTED" | "REPEATABLE READ" = "READ COMMITTED") {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    }
    async function lockAccount(client: PoolClient) {
      await client.query("SELECT * FROM v13_production_account WHERE id='a' FOR UPDATE");
    }
    async function waitForLock(pid: number) {
      const deadline = Date.now() + 5_000;
      do {
        const row = (await db.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0];
        if (row?.wait_event_type === "Lock") return;
        await delay(10);
      } while (Date.now() < deadline);
      assert.fail(`backend ${pid} did not wait for the expected row lock`);
    }
    async function nowait(sql: string, args: unknown[], shouldBeLocked: boolean) {
      await begin(probe);
      try {
        if (shouldBeLocked) await assert.rejects(probe.query(sql, args), { code: "55P03" });
        else await probe.query(sql, args);
      } finally { await probe.query("ROLLBACK"); }
    }
    // Attach rejection handlers immediately, including when an assertion fails
    // before the pending query is awaited. Timeouts also bound failure cleanup.
    function pendingQuery(client: PoolClient, sql: string, args?: unknown[]) {
      return client.query(sql, args).then(result => ({ result, error: null }),
        (error: unknown) => ({ result: null, error }));
    }
    async function finish(query: ReturnType<typeof pendingQuery>) {
      const outcome = await query;
      if (outcome.error) throw outcome.error;
      assert.ok(outcome.result);
      return outcome.result;
    }
    async function check(name: string, run: () => Promise<void>) {
      await t.test(name, async () => {
        try { await run(); }
        finally { await Promise.all([reader, writer, probe].map(client => client.query("ROLLBACK"))); }
      });
    }

    await check("same 23 columns, JSONB type, account scope and complete state/kind/terminal truth table", async () => {
      let count = 0;
      for (const state of ["PREPARED", "DISPATCHED", "UNKNOWN", "TERMINAL", "BLOCKED"])
        for (const terminal of [false, true]) for (const kind of ["ENTRY", "EXIT"])
          await insert(String(count++).padStart(3, "0"), state, terminal, kind);
      await insert("foreign", "BLOCKED", true, "ENTRY", "other");
      await db.query("UPDATE v13_production_intent SET created_at='2026-01-01T00:00:00Z' WHERE id='019'");
      const original = await db.query(originalSql, ["a"]), current = await db.query(sqls.projected, ["a"]);
      assert.equal(original.rows.length, 20);
      assert.deepEqual(current.rows, original.rows.map(row => projected(row, "projected")));
      assert.deepEqual(current.fields.map(field => [field.name, field.dataTypeID]),
        original.fields.map(field => [field.name, field.dataTypeID]));
      assert.deepEqual(current.fields.map(field => field.name), intentColumns);
      assert.deepEqual(Object.keys(current.rows[0]!), intentColumns);
      assert.equal(current.fields.find(field => field.name === "decision")!.dataTypeID, 3802);
      assert.equal(current.rows.filter(row => row.decision === null).length, 2);
      assert.deepEqual(current.rows.map(row => row.id), ["019", ...Array.from({ length: 19 }, (_, i) => String(i).padStart(3, "0"))]);
    });
    await check("unused BLOCKED JSON is omitted and used states retain null, scalar, array and object values", async () => {
      for (const decision of [null, 1, "text", [], {}, { nested: { valid: true } }]) {
        for (const state of ["BLOCKED", "TERMINAL", "PREPARED"]) {
          await reset(state, true);
          await db.query("UPDATE v13_production_intent SET decision=$1", [JSON.stringify(decision)]);
          const original = (await db.query(originalSql, ["a"])).rows;
          assert.deepEqual((await db.query(sqls.projected, ["a"])).rows, original.map(row => projected(row, "projected")));
        }
      }
    });
    for (const [variant, sql] of Object.entries(sqls)) {
      await check(`${variant}: every own-account row stays locked, foreign rows stay unlocked and rollback preserves stored decision`, async () => {
        await reset();
        await insert("exit-blocked", "BLOCKED", true, "EXIT");
        await insert("active", "PREPARED", false);
        await insert("foreign", "BLOCKED", true, "ENTRY", "other");
        const before = (await db.query("SELECT * FROM v13_production_intent ORDER BY id")).rows;
        await begin(reader); await lockAccount(reader);
        const rows = (await reader.query(sql, ["a"])).rows;
        assert.equal(rows.length, 3);
        await nowait("SELECT id FROM v13_production_account WHERE id=$1 FOR UPDATE NOWAIT", ["a"], true);
        for (const row of rows) await nowait("SELECT id FROM v13_production_intent WHERE id=$1 FOR UPDATE NOWAIT", [row.id], true);
        await nowait("SELECT id FROM v13_production_intent WHERE id=$1 FOR UPDATE NOWAIT", ["foreign"], false);
        await reader.query("UPDATE v13_production_intent SET reserved_micros=7 WHERE id='target'");
        await reader.query("ROLLBACK");
        assert.deepEqual((await db.query("SELECT * FROM v13_production_intent ORDER BY id")).rows, before);
        await nowait("SELECT id FROM v13_production_intent WHERE id=$1 FOR UPDATE NOWAIT", ["target"], false);
      });
    }
    const transitions: [string, boolean, string, boolean][] = [
      ["BLOCKED", true, "PREPARED", false], ["BLOCKED", true, "TERMINAL", true],
      ["BLOCKED", true, "DISPATCHED", false], ["BLOCKED", true, "UNKNOWN", false],
      ["PREPARED", false, "BLOCKED", true], ["TERMINAL", true, "BLOCKED", true],
      ["BLOCKED", true, "BLOCKED", false], ["BLOCKED", false, "BLOCKED", true],
    ];
    for (const [variant, sql] of Object.entries(sqls)) {
      for (const [oldState, oldTerminal, newState, newTerminal] of transitions) {
        await check(`${variant}: READ COMMITTED EPQ ${oldState}/${oldTerminal} to ${newState}/${newTerminal}`, async () => {
          await reset(oldState, oldTerminal); await begin(writer);
          await writer.query("UPDATE v13_production_intent SET state=$1,terminal=$2,decision=$3 WHERE id='target'",
            [newState, newTerminal, JSON.stringify({ marker: "updated" })]);
          await begin(reader); await lockAccount(reader);
          const pending = pendingQuery(reader, sql, ["a"]);
          await waitForLock(readerPid);
          await writer.query("COMMIT");
          const rows = (await finish(pending)).rows;
          const stored = (await db.query("SELECT * FROM v13_production_intent WHERE id='target'")).rows;
          assert.deepEqual(rows, stored.map(row => projected(row, variant)));
          assert.equal(rows[0]!.state, newState); assert.equal(rows[0]!.terminal, newTerminal);
          await nowait("SELECT id FROM v13_production_intent WHERE id=$1 FOR UPDATE NOWAIT", ["target"], true);
        });
      }
    }
    for (const [variant, sql] of Object.entries(sqls)) {
      await check(`${variant}: concurrent writer rollback returns the original BLOCKED tuple`, async () => {
        await reset(); await begin(writer);
        await writer.query("UPDATE v13_production_intent SET state='PREPARED',terminal=false,decision='{}' WHERE id='target'");
        await begin(reader); await lockAccount(reader);
        const pending = pendingQuery(reader, sql, ["a"]);
        await waitForLock(readerPid); await writer.query("ROLLBACK");
        assert.deepEqual((await finish(pending)).rows,
          (await db.query("SELECT * FROM v13_production_intent WHERE id='target'")).rows.map(row => projected(row, variant)));
      });
      await check(`${variant}: REPEATABLE READ retains serialization failure 40001`, async () => {
        await reset(); await begin(writer);
        await writer.query("UPDATE v13_production_intent SET state='TERMINAL',decision='{}' WHERE id='target'");
        await begin(reader, "REPEATABLE READ"); await lockAccount(reader);
        const pending = pendingQuery(reader, sql, ["a"]);
        await waitForLock(readerPid); await writer.query("COMMIT");
        const outcome = await pending;
        assert.equal((outcome.error as { code?: string } | null)?.code, "40001");
      });
      await check(`${variant}: an ordinary writer respects the account lock until reader commit`, async () => {
        await reset(); await begin(reader); await lockAccount(reader); await reader.query(sql, ["a"]);
        await begin(writer);
        const pending = pendingQuery(writer, "SELECT * FROM v13_production_account WHERE id='a' FOR UPDATE");
        await waitForLock(writerPid); await reader.query("COMMIT"); await finish(pending);
        await writer.query("UPDATE v13_production_intent SET state='TERMINAL',decision='{}' WHERE id='target'");
        await writer.query("COMMIT");
        const rows = (await db.query(sql, ["a"])).rows;
        assert.equal(rows[0]!.state, "TERMINAL"); assert.deepEqual(rows[0]!.decision, {});
      });
      await check(`${variant}: later SQL failure rolls back scalars and releases locks without rewriting omitted decision`, async () => {
        await reset();
        const before = (await db.query("SELECT * FROM v13_production_intent")).rows;
        await begin(reader); await lockAccount(reader); await reader.query(sql, ["a"]);
        await reader.query("UPDATE v13_production_intent SET reserved_micros=7 WHERE id='target'");
        await assert.rejects(reader.query("SELECT 1/0"), { code: "22012" });
        await reader.query("ROLLBACK");
        assert.deepEqual((await db.query("SELECT * FROM v13_production_intent")).rows, before);
        await nowait("SELECT id FROM v13_production_account WHERE id=$1 FOR UPDATE NOWAIT", ["a"], false);
        await nowait("SELECT id FROM v13_production_intent WHERE id=$1 FOR UPDATE NOWAIT", ["target"], false);
      });
    }
  } finally {
    // ROLLBACKs run concurrently so either side of a failed lock assertion can
    // release the other. Restore session settings before returning pool clients.
    await Promise.allSettled(clients.map(client => client.query("ROLLBACK")));
    try {
      if (schemaCreated) await clients[0]!.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await Promise.all(clients.map(async client => {
        try { await client.query("RESET search_path; RESET statement_timeout; RESET lock_timeout"); }
        finally { client.release(); }
      }));
    }
  }
});
