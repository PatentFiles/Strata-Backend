import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { test, after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { V13_ENTRY_POLICY_VERSION } from "@workspace/v13-strategy";
import { pool } from "@workspace/db";

const url = process.env.V13_DISPOSABLE_DATABASE_URL;
assert.match(url ?? "", /^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/);
assert.equal(process.env.DATABASE_URL, url);
assert.equal(process.env.NODE_ENV, "test");
assert.match(process.env.NODE_OPTIONS ?? "", /offline-network-fence\.cjs/);
after(() => pool.end());

test("standalone paper command owns a disposable lease and releases it on SIGTERM", { timeout: 15000 }, async () => {
  const target = new URL(url!);
  const actual = (await pool.query("SELECT current_database() AS name, current_user AS username, host(inet_server_addr()) AS host, inet_server_port() AS port")).rows[0];
  assert.deepEqual(actual, { name: target.pathname.slice(1), username: "v13_test", host: "127.0.0.1", port: Number(target.port) });
  // Use a separate login, not SET ROLE in a privileged child connection.
  await pool.query(`
    CREATE ROLE strata_paper_test LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
    GRANT USAGE ON SCHEMA public TO strata_paper_test;
    GRANT SELECT, INSERT, UPDATE ON forward_test_engine, forward_test_windows,
      forward_test_positions TO strata_paper_test;
    GRANT SELECT, INSERT ON forward_test_evaluations, forward_test_btc_points,
      forward_test_book_snapshots TO strata_paper_test;
  `);
  const paperUrl = new URL(target);
  paperUrl.username = "strata_paper_test";
  const protectedTables = [
    "v13_production_account", "v13_production_intent", "v13_production_position",
    "v13_production_event", "strata_direct_entry_source",
  ];
  for (const table of protectedTables) {
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      const result = await pool.query("SELECT has_table_privilege($1,$2,$3) AS allowed", [
        "strata_paper_test", table, privilege,
      ]);
      assert.equal(result.rows[0].allowed, false, `${table} ${privilege}`);
    }
  }
  const child = spawn(process.execPath, [resolve("dist/paperWorkerMain.mjs")], {
    env: {
      NODE_ENV: "production",
      NODE_OPTIONS: process.env.NODE_OPTIONS,
      STRATA_PAPER_DATABASE_URL: paperUrl.href,
      V13_ENTRY_POLICY_RUNTIME_APPROVED: V13_ENTRY_POLICY_VERSION,
      FORWARD_TEST_PRODUCTION_WORKER_ENABLED: "true",
      STRATA_SHADOW_EVALUATION_WRITES_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (v) => { logs = (logs + v).slice(-5000); });
  const exited = once(child, "exit");
  const engine = async () => (await pool.query("SELECT lease_owner FROM forward_test_engine WHERE id='v1.3-paper'")).rows[0];
  try {
    let row;
    for (let i = 0; i < 160; i++) {
      row = await engine();
      if (row?.lease_owner || child.exitCode !== null) break;
      await delay(50);
    }
    assert.ok(row?.lease_owner, logs);
    assert.match(logs, /Strategy evaluation producer scheduler enabled/);
    child.kill("SIGTERM");
    assert.deepEqual(await exited, [0, null], logs);
    assert.equal((await engine())?.lease_owner, null);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM v13_production_intent")).rows[0].n, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited.catch(() => {});
    await pool.query("DROP OWNED BY strata_paper_test; DROP ROLE strata_paper_test");
  }
});
