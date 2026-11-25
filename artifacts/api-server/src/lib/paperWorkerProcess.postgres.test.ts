import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
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

test("restricted standalone paper command commits a cycle and releases its lease on SIGTERM", { timeout: 15000 }, async () => {
  const target = new URL(url!);
  const actual = (await pool.query("SELECT current_database() AS name, current_user AS username, host(inet_server_addr()) AS host, inet_server_port() AS port")).rows[0];
  assert.deepEqual(actual, { name: target.pathname.slice(1), username: "v13_test", host: "127.0.0.1", port: Number(target.port) });
  const assertUnsafeRoleRefused=async(database:string)=>{
    const privileged = spawn(process.execPath, [resolve("dist/paperWorkerMain.mjs")], {
      env: {
        NODE_ENV: "production", NODE_OPTIONS: process.env.NODE_OPTIONS,
        STRATA_PAPER_DATABASE_URL: database,
        V13_ENTRY_POLICY_RUNTIME_APPROVED: V13_ENTRY_POLICY_VERSION,
        FORWARD_TEST_PRODUCTION_WORKER_ENABLED: "true",
      },
      stdio:["ignore","pipe","pipe"],
    });
    let denial="";
    privileged.stderr.on("data",v=>{denial=(denial+v).slice(-2000);});
    try {
      assert.deepEqual(await once(privileged,"close"),[1,null]);
      assert.match(denial,/paper_database_role_not_isolated/);
    } finally {
      if(privileged.exitCode===null&&privileged.signalCode===null)privileged.kill("SIGKILL");
    }
  };
  await assertUnsafeRoleRefused(target.href);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM forward_test_engine")).rows[0].n,0);
  // Use a separate login, not SET ROLE in a privileged child connection.
  await pool.query(readFileSync("../../docs/strata-paper-cutover/reviewed-role.sql","utf8"));
  await pool.query(`
    CREATE ROLE strata_paper_test LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
    GRANT strata_paper_runtime TO strata_paper_test;
  `);
  const roleCheck=await pool.connect();
  try {
    await roleCheck.query("SET ROLE strata_paper_test");
    await assert.rejects(roleCheck.query("INSERT INTO public.forward_test_engine(id,enabled) VALUES('other-engine',true)"),{code:"42501"});
    await assert.rejects(roleCheck.query("SELECT 1 FROM public.v13_production_intent LIMIT 1"),{code:"42501"});
  } finally {
    await roleCheck.query("RESET ROLE");
    roleCheck.release();
  }
  const paperUrl = new URL(target);
  paperUrl.username = "strata_paper_test";
  // Named group membership must not obscure a separate column-level grant.
  await pool.query("GRANT SELECT (id) ON public.v13_production_observation TO strata_paper_test");
  try { await assertUnsafeRoleRefused(paperUrl.href); }
  finally { await pool.query("REVOKE SELECT (id) ON public.v13_production_observation FROM strata_paper_test"); }
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
  // Intercept only the three expected public GET shapes. The disposable
  // runner's network fence still forbids external sockets and all secrets.
  const ticker = "KXBTC15M-PAPER-ACL-FIXTURE";
  const preload = `globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    if (init?.signal?.aborted) init.signal.throwIfAborted();
    if (init?.method && init.method !== "GET") throw Error("fixture_refuses_non_get");
    const now = Date.now(); const open = Math.floor(now / 900000) * 900000;
    const market = {ticker:"${ticker}",status:"active",floor_strike:60000,
      open_time:new Date(open).toISOString(),close_time:new Date(open+900000).toISOString(),
      yes_ask_dollars:"0.45",no_ask_dollars:"0.56"};
    if(url.href === "https://api.exchange.coinbase.com/products/BTC-USD/ticker")
      return Response.json({price:"60000",time:new Date(now).toISOString()});
    if(url.origin === "https://external-api.kalshi.com" && url.pathname === "/trade-api/v2/markets")
      return Response.json({markets:[market]});
    if(url.href === "https://external-api.kalshi.com/trade-api/v2/markets/${ticker}")
      return Response.json({market});
    throw Error("fixture_refuses_unexpected_url");
  };`;
  const child = spawn(process.execPath, [
    "--import", `data:text/javascript,${encodeURIComponent(preload)}`, resolve("dist/paperWorkerMain.mjs"),
  ], {
    env: {
      NODE_ENV: "production",
      NODE_OPTIONS: process.env.NODE_OPTIONS,
      STRATA_PAPER_DATABASE_URL: paperUrl.href,
      V13_ENTRY_POLICY_RUNTIME_APPROVED: V13_ENTRY_POLICY_VERSION,
      FORWARD_TEST_PRODUCTION_WORKER_ENABLED: "true",
      STRATA_SHADOW_EVALUATION_WRITES_ENABLED: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (v) => { logs = (logs + v).slice(-5000); });
  const exited = once(child, "exit");
  const shadow = async () => (await pool.query("SELECT count(*)::int AS n FROM v13_strategy_shadow_evaluation WHERE market_ticker=$1 AND execution_authority IS FALSE",[ticker])).rows[0].n;
  const engine = async () => (await pool.query("SELECT lease_owner,last_successful_cycle_at FROM forward_test_engine WHERE id='v1.3-paper'")).rows[0];
  try {
    let row;
    for (let i = 0; i < 160; i++) {
      row = await engine();
      if ((row?.last_successful_cycle_at && row.lease_owner && await shadow() > 0) || child.exitCode !== null) break;
      await delay(50);
    }
    assert.ok(row?.lease_owner, logs);
    assert.ok(row.last_successful_cycle_at, logs);
    assert.ok(await shadow() > 0, logs);
    const committed = await pool.query("SELECT signal FROM forward_test_evaluations WHERE market_ticker=$1", [ticker]);
    assert.ok(committed.rows.some(row => row.signal === "PASS"), logs);
    assert.match(logs, /Strategy evaluation producer scheduler enabled/);
    child.kill("SIGTERM");
    assert.deepEqual(await exited, [0, null], logs);
    assert.equal((await engine())?.lease_owner, null);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM v13_production_intent")).rows[0].n, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited.catch(() => {});
  }
});
