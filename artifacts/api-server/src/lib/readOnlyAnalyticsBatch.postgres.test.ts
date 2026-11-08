import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { readFileSync, realpathSync } from "node:fs";
import { join, basename } from "node:path";
import { createConnection } from "node:net";
import { pool, type PoolClient } from "@workspace/db";
import { aggregateForwardTestStatistics } from "./forwardTestRepository";
import { createSingleFlightAnalyticsCache } from "./readOnlyAnalyticsCache";

// No ambient database or CI service is accepted. Only this runner's new cluster.
const root = process.env.ANALYTICS_DISPOSABLE_ROOT ?? "";
const socket = process.env.ANALYTICS_DISPOSABLE_SOCKET ?? "";
assert.match(basename(root), /^strata-analytics-pg-/);
assert.equal(realpathSync(socket), join(realpathSync(root), "socket"));
const marker = JSON.parse(readFileSync(join(root, "owned-cluster.json"), "utf8"));
assert.equal(marker.nonce, process.env.ANALYTICS_DISPOSABLE_NONCE);
assert.equal(marker.socket, socket);
assert.equal(process.env.DATABASE_URL, process.env.ANALYTICS_DISPOSABLE_URL);
const url = new URL(process.env.DATABASE_URL!);
assert.equal(url.hostname, ""); assert.equal(url.searchParams.get("host"), socket);
assert.equal(url.pathname, "/analytics_drain"); assert.equal(url.searchParams.get("user"), "analytics_test");
assert.throws(() => createConnection({ host: "127.0.0.1", port: 5432 }), /non_owned_socket_denied/);
assert.throws(() => createConnection({ host: "example.com", port: 443 }), /non_owned_socket_denied/);
assert.throws(() => fetch("https://example.com"), /fetch_denied/);

const tables = ["forward_test_evaluations", "forward_test_windows", "forward_test_positions"] as const;
type QueryRecord = { text: string; settled: boolean; error?: unknown };
const queries: QueryRecord[] = [];
const realQuery = pool.query;
// Observe the real driver promises without replacing, delaying or racing them.
pool.query = function (this: typeof pool, ...args: unknown[]) {
  const arg = args[0] as string | { text?: string };
  const text = typeof arg === "string" ? arg : arg?.text ?? "";
  const promise = Reflect.apply(realQuery, this, args);
  if (/^select\b/i.test(text) && tables.some(table => text.includes(`"${table}"`))) {
    const record: QueryRecord = { text, settled: false }; queries.push(record);
    void promise.then(() => { record.settled = true; }, (error: unknown) => { record.settled = true; record.error = error; });
  }
  return promise;
} as typeof pool.query;
let admin: PoolClient, blocker: PoolClient;
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
async function until<T>(check: () => Promise<T>, ready: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 2_000;
  do {
    const value = await check(); if (ready(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new Error(`Bounded wait failed: ${label}`);
}
const observe = <T>(promise: Promise<T>) => promise.then(
  value => ({ status: "fulfilled" as const, value }),
  error => ({ status: "rejected" as const, error }),
);
async function rejectIs(promise: Promise<unknown>, expected: unknown) {
  const outcome = await observe(promise); assert.equal(outcome.status, "rejected");
  if (outcome.status === "rejected") assert.equal(outcome.error, expected);
}
async function blockedOn(table: string) {
  return until(() => admin.query<{ pid: number; query: string }>(
    `SELECT pid, query FROM pg_stat_activity WHERE datname=current_database()
     AND application_name='analytics-aggregate' AND state='active' AND wait_event_type='Lock'
     AND query LIKE $1`, [`%from "${table}"%`]), result => result.rows.length === 1, `one held ${table} query`);
}
async function activeAggregateCount() {
  const { rows } = await admin.query<{ count: number }>(
    `SELECT count(*)::integer AS count FROM pg_stat_activity WHERE datname=current_database()
     AND application_name='analytics-aggregate' AND state='active'`);
  return rows[0].count;
}
async function reset() {
  await blocker.query("ROLLBACK");
  await admin.query(tables.map(table => `DROP TABLE IF EXISTS ${table}, ${table}_missing CASCADE`).join(";"));
  await admin.query(`
    CREATE TABLE forward_test_evaluations (qualifying_trigger boolean, signal text);
    CREATE TABLE forward_test_windows (fixture integer);
    CREATE TABLE forward_test_positions (engine_id text, status text, pnl double precision);
    INSERT INTO forward_test_evaluations VALUES (true,'SCOUT'),(true,'SCOUT'),(true,'CONFIRM'),(false,'PASS'),(false,'SCOUT'),(true,'WATCH');
    INSERT INTO forward_test_windows VALUES (1),(2),(3);
    INSERT INTO forward_test_positions VALUES ('paper','SETTLED',2.5),('paper','CLOSED',-1),('paper','CLOSED',0),('paper','OPEN',null),('other','SETTLED',7),('other','OPEN',null);
  `);
  queries.length = 0;
}
const common = { evaluationCount: 6, windowsObserved: 3, triggerCount: 3, scoutTriggers: 2, confirmTriggers: 1 };
const expectedPaper = { wins: 1, losses: 2, ...common, openPaperPositionCount: 1, completedPaperForwardTests: 3, cumulativePaperPnl: 1.5 };
const expectedAll = { wins: 2, losses: 2, ...common, openPaperPositionCount: 2, completedPaperForwardTests: 4, cumulativePaperPnl: 8.5 };

before(async () => {
  admin = await pool.connect(); blocker = await pool.connect();
  await admin.query("SET application_name='analytics-control'");
  await blocker.query("SET application_name='analytics-blocker'");
  const { rows } = await admin.query(`SELECT current_database() AS db, current_user AS username,
    inet_server_addr() IS NULL AS unix_socket, current_setting('listen_addresses') AS listen,
    current_setting('statement_timeout') AS statement_timeout, current_setting('lock_timeout') AS lock_timeout,
    current_setting('idle_in_transaction_session_timeout') AS idle_timeout`);
  assert.deepEqual(rows[0], { db: "analytics_drain", username: "analytics_test", unix_socket: true,
    listen: "", statement_timeout: "8s", lock_timeout: "7s", idle_timeout: "15s" });
});
after(async () => {
  pool.query = realQuery;
  if (blocker) { await blocker.query("ROLLBACK"); blocker.release(); }
  if (admin) admin.release();
  await pool.end();
});

test("real SQL preserves all aggregate values, global counts, engine filter and empty results", { timeout: 8_000 }, async () => {
  await reset();
  assert.deepEqual(await aggregateForwardTestStatistics("paper"), expectedPaper);
  assert.deepEqual(await aggregateForwardTestStatistics(), expectedAll);
  assert.deepEqual(await aggregateForwardTestStatistics(""), expectedAll);
  assert.deepEqual(await aggregateForwardTestStatistics("missing"), {
    wins: 0, losses: 0, ...common, openPaperPositionCount: 0, completedPaperForwardTests: 0, cumulativePaperPnl: 0,
  });
  await admin.query(`TRUNCATE ${tables.join(",")}`);
  assert.deepEqual(await aggregateForwardTestStatistics("paper"), {
    wins: 0, losses: 0, evaluationCount: 0, windowsObserved: 0, triggerCount: 0, scoutTriggers: 0,
    confirmTriggers: 0, openPaperPositionCount: 0, completedPaperForwardTests: 0, cumulativePaperPnl: 0,
  });
  assert.equal(queries.length, 15);
});

for (const failedIndex of [0, 1, 2]) {
  for (const finish of ["unlock", "cancel"] as const) {
    test(`real sibling ${failedIndex} fails promptly; stalled work drains by ${finish} before retry`, { timeout: 8_000 }, async () => {
      await reset();
      const missing = tables[failedIndex], held = tables[(failedIndex + 1) % 3];
      await admin.query(`ALTER TABLE ${missing} RENAME TO ${missing}_missing`);
      await blocker.query("BEGIN");
      await blocker.query(`LOCK TABLE ${held} IN ACCESS EXCLUSIVE MODE`);
      const read = createSingleFlightAnalyticsCache(() => aggregateForwardTestStatistics("paper"), 60_000);
      let firstError: unknown;
      try {
        const started = performance.now();
        let firstErrorAt = 0;
        const first = observe(read()).then(outcome => { if (outcome.status === "rejected") firstErrorAt = performance.now(); return outcome; });
        const heldQuery = await blockedOn(held);
        const outcome = await first;
        assert.equal(outcome.status, "rejected");
        if (outcome.status !== "rejected") throw new Error("Expected missing relation failure");
        firstError = outcome.error;
        const failedRecord = queries.find(query => query.error);
        assert.ok(failedRecord);
        assert.equal((firstError as { cause: unknown }).cause, failedRecord.error); // Exact original pg error preserved as cause.
        assert.equal((failedRecord.error as { code: string }).code, "42P01");
        assert.ok(firstErrorAt - started < 2_000, "bounded failure watchdog, not a latency benchmark");
        assert.equal(queries.length, 3);
        for (let i = 0; i < 30; i++) await rejectIs(read(), firstError);
        assert.equal(queries.length, 3);
        assert.equal((await blockedOn(held)).rows[0].pid, heldQuery.rows[0].pid);
        await until(async () => queries.filter(query => !query.text.includes(`from "${held}"`)).every(query => query.settled), Boolean, "unblocked siblings finish");
        await blockedOn(held);
        assert.equal(queries.filter(query => !query.settled).length, 1);
        await admin.query(`ALTER TABLE ${missing}_missing RENAME TO ${missing}`);
        if (finish === "cancel") {
          const cancelling = admin.query<{ cancelled: boolean }>("SELECT pg_cancel_backend($1) AS cancelled", [heldQuery.rows[0].pid]);
          // Merely issuing cancellation has not yet settled the raw query promise.
          await rejectIs(read(), firstError); assert.equal(queries.length, 3);
          assert.equal((await cancelling).rows[0].cancelled, true);
          await until(async () => queries.every(query => query.settled), Boolean, "all raw promises settle after cancellation");
          await until(activeAggregateCount, count => count === 0, "owned backend no longer active after cancellation");
          const { rows } = await admin.query("SELECT count(*)::integer AS count FROM pg_locks WHERE pid=$1 AND NOT granted", [heldQuery.rows[0].pid]);
          assert.equal(rows[0].count, 0);
          const cancelledRecord = queries.find(query => (query.error as { code?: string })?.code === "57014");
          assert.ok(cancelledRecord); assert.notEqual(cancelledRecord.error, failedRecord.error);
          await flush();
          const retry = read(); // A new batch is permitted only after observed drainage.
          await blockedOn(held); assert.equal(queries.length, 6);
          await until(async () => queries.slice(3).filter(query => !query.text.includes(`from "${held}"`)).every(query => query.settled), Boolean, "retry unblocked siblings finish");
          await blockedOn(held);
          assert.equal(await activeAggregateCount(), 1); // No old query overlaps the newly held one.
          await blocker.query("ROLLBACK");
          assert.deepEqual(await retry, expectedPaper);
        } else {
          await blocker.query("ROLLBACK");
          await until(async () => queries.every(query => query.settled), Boolean, "all raw promises settle after unlock");
          await flush();
          assert.deepEqual(await read(), expectedPaper);
          assert.equal(queries.length, 6);
        }
        assert.deepEqual(await read(), expectedPaper); assert.equal(queries.length, 6);
        assert.equal(await activeAggregateCount(), 0);
      } finally {
        await blocker.query("ROLLBACK");
        await admin.query(`ALTER TABLE IF EXISTS ${missing}_missing RENAME TO ${missing}`);
        await until(activeAggregateCount, count => count === 0, "case cleanup drains owned work");
      }
    });
  }
}

test("a caller-only deadline leaves the real locked query owned and retry callers coalesced", { timeout: 8_000 }, async () => {
  await reset(); await blocker.query("BEGIN"); await blocker.query("LOCK TABLE forward_test_evaluations IN ACCESS EXCLUSIVE MODE");
  const read = createSingleFlightAnalyticsCache(() => aggregateForwardTestStatistics("paper"), 60_000);
  try {
    const underlying = read(); const held = await blockedOn(tables[0]);
    const timeout = new Error("caller-only deadline");
    await rejectIs(Promise.race([underlying, Promise.reject(timeout)]), timeout);
    const callers = Array.from({ length: 30 }, () => read());
    await flush(); assert.equal(queries.length, 3);
    assert.equal((await blockedOn(tables[0])).rows[0].pid, held.rows[0].pid);
    await until(async () => queries.filter(query => !query.text.includes('from "forward_test_evaluations"')).every(query => query.settled), Boolean, "deadline-case unblocked siblings finish");
    await blockedOn(tables[0]);
    assert.equal(queries.filter(query => !query.settled).length, 1);
    await blocker.query("ROLLBACK");
    assert.deepEqual(await underlying, expectedPaper);
    for (const value of await Promise.all(callers)) assert.deepEqual(value, expectedPaper);
    assert.equal(queries.length, 3); assert.equal(await activeAggregateCount(), 0);
  } finally { await blocker.query("ROLLBACK"); }
});
