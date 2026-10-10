import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db, pool, forwardTestEngineTable, forwardTestWindowTable,
  forwardTestPositionTable, forwardTestEvaluationTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { V13_ENTRY_POLICY_VERSION, V13_CHAMPION_PARAMETER_HASH } from "@workspace/v13-strategy";
import { ensureWorkerEngine, acquireWorkerLease, releaseWorkerLease } from "./forwardTestRepository";
import { runForwardTestCycle, startServerForwardTestWorker } from "./forwardTestWorker";
import type { BtcObservation, MarketObservation } from "./forwardTestFeeds";
import { executeQualifiedV13Trigger } from "./microLive";

assert.match(process.env.V13_DISPOSABLE_DATABASE_URL ?? "",
  /^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/);
assert.equal(process.env.DATABASE_URL, process.env.V13_DISPOSABLE_DATABASE_URL);
after(() => pool.end());
let previousEngine: string | null = null;

async function fixture() {
  const id = randomUUID(), engineId = `ENTRY-POLICY-${id}`, ticker = `KXBTC15M-ENTRY-${id}`;
  if (previousEngine) {
    await db.update(forwardTestEngineTable).set({ enabled: false })
      .where(eq(forwardTestEngineTable.id, previousEngine));
  }
  await ensureWorkerEngine(engineId);
  await db.update(forwardTestEngineTable).set({ enabled: true }).where(eq(forwardTestEngineTable.id, engineId));
  let owner = `owner-${id}`, lease = (await acquireWorkerLease(owner, engineId))!;
  assert.ok(lease);
  previousEngine = engineId;
  let time = Date.now();
  const starts = time - 1000, ends = time + 900000;
  async function observe(buffer: number, options: {
    btc?: Partial<BtcObservation>; market?: Partial<MarketObservation>; concurrent?: boolean;
  } = {}) {
    time += 2000;
    const now = new Date(time);
    const btc: BtcObservation = { price: 100000 + buffer, providerAt: now, receivedAt: now, ...options.btc };
    const market: MarketObservation = {
      ticker, target: 100000, startsAt: new Date(starts), endsAt: new Date(ends),
      yesAsk: .52, noAsk: .52, yesBid: .5, noBid: .5, yesPrice: .51, noPrice: .51,
      status: "open", result: null, fetchedAt: now, ...options.market,
    };
    const cycle = () => runForwardTestCycle({ owner, epoch: lease.leaseEpoch, engineId,
      now, feeds: { btc: async () => btc, market: async () => market } });
    return options.concurrent ? Promise.all(Array.from({ length: 8 }, cycle)) : [await cycle()];
  }
  async function window() {
    return (await db.select().from(forwardTestWindowTable).where(eq(forwardTestWindowTable.ticker, ticker)))[0]!;
  }
  async function positions() {
    return db.select().from(forwardTestPositionTable).where(eq(forwardTestPositionTable.marketTicker, ticker));
  }
  async function restart() {
    assert.ok(await releaseWorkerLease(owner, lease.leaseEpoch, engineId));
    owner = `restarted-${id}`; lease = (await acquireWorkerLease(owner, engineId))!; assert.ok(lease);
  }
  async function rejectFirst() {
    await observe(-1);
    await observe(1);
    const row = await window();
    assert.equal(row.firstCrossOccurred, true); assert.equal(row.crossingConsumed, false);
    assert.equal(row.crossingDirection, "UP"); assert.equal(row.entryPolicyVersion, V13_ENTRY_POLICY_VERSION);
    assert.equal((await positions()).length, 0);
    return row;
  }
  return { ticker, engineId, observe, window, positions, restart, rejectFirst };
}

for (const [signal, buffer] of [["SCOUT", -10], ["CONFIRM", -25]] as const) {
  test(`rejected first crossing then fresh qualifying ${signal} enters once without changing first observation`, async () => {
    const f = await fixture(), first = await f.rejectFirst();
    const [entry] = await f.observe(buffer);
    assert.equal(entry.error, null); assert.equal(entry.signal, signal);
    const [pos] = await f.positions(), win = await f.window();
    assert.equal(pos.triggerType, signal); assert.equal(pos.crossingKey, `${f.ticker}:first`);
    assert.equal(pos.entryPolicyVersion, V13_ENTRY_POLICY_VERSION);
    assert.equal(pos.strategyParameterHash, V13_CHAMPION_PARAMETER_HASH);
    assert.equal(win.crossingAt?.getTime(), first.crossingAt?.getTime());
    assert.equal(win.crossingDirection, "UP"); assert.equal(win.crossingConsumed, true);
    const [source] = await db.select().from(forwardTestEvaluationTable)
      .where(eq(forwardTestEvaluationTable.id, entry.evaluationId!));
    assert.equal(source.qualifyingTrigger, true); assert.equal(source.crossingConsumed, true);
    assert.equal(source.entryPolicyVersion, V13_ENTRY_POLICY_VERSION);
  });
}
test("drift and zero touch do not consume; departure uses shared zero classification", async () => {
  const f = await fixture();
  await f.rejectFirst();
  await f.observe(10); // same positive side, not a new crossing
  assert.equal((await f.positions()).length, 0);
  await f.observe(0); assert.equal((await f.window()).crossingConsumed, false);
  await f.observe(-10);
  assert.equal((await f.positions()).length, 1);
});
test("overpriced Scout/Confirm and unsupported zero momentum leave claim available", async () => {
  for (const [buffer, price] of [[-10, .53], [-25, .54]] as const) {
    const f = await fixture(); await f.rejectFirst();
    await f.observe(buffer, { market: { noAsk: price } });
    assert.equal((await f.positions()).length, 0);
    assert.equal((await f.window()).crossingConsumed, false);
    await f.observe(1); await f.observe(-10);
    assert.equal((await f.positions()).length, 1);
  }
  const f = await fixture();
  await f.observe(-10); await f.observe(1); await f.observe(-10); // net velocity = zero
  assert.equal((await f.positions()).length, 0);
  assert.equal((await f.window()).crossingConsumed, false);
});
test("malformed/stale BTC, stale quotes, missing offer, expired/future windows do not consume", async () => {
  const options = [
    { btc: { price: Number.NaN } },
    { btc: { providerAt: new Date(0) } },
    { btc: { receivedAt: new Date(0) } },
    { market: { fetchedAt: new Date(0) } },
    { market: { noAsk: null } },
    { market: { endsAt: new Date(0) } },
    { market: { startsAt: new Date(8640000000000000) } },
    { market: { target: Number.NaN } },
  ];
  for (const option of options) {
    const f = await fixture(); await f.rejectFirst();
    const [result] = await f.observe(-10, option);
    assert.ok(result.error); assert.equal((await f.positions()).length, 0);
    assert.equal((await f.window()).crossingConsumed, false);
  }
});
test("eight concurrent cycles cannot double Scout/Confirm or replay after close and restart", async () => {
  const f = await fixture(); await f.rejectFirst();
  await f.observe(-10, { concurrent: true });
  assert.equal((await f.positions()).length, 1);
  await f.observe(10); // closes held DOWN; never simultaneously opens UP
  assert.equal((await f.positions())[0]!.status, "CLOSED");
  await f.restart(); await f.observe(-25);
  assert.equal((await f.positions()).length, 1);
  assert.equal((await f.window()).crossingConsumed, true);
});
test("restart before entry preserves available claim despite first-observed marker", async () => {
  const f = await fixture(); await f.rejectFirst(); await f.restart(); await f.observe(-25);
  assert.equal((await f.positions()).length, 1);
});
test("NULL-policy pre-existing windows never upgrade or relabel when later crossing qualifies", async () => {
  const f = await fixture();
  await db.insert(forwardTestWindowTable).values({ ticker: f.ticker, target: 100000,
    firstCrossOccurred: true, previousBuffer: 1, currentSide: "UP",
    crossingKey: `${f.ticker}:first`, crossingDirection: "UP", crossingAt: new Date(1) });
  await f.observe(1); await f.observe(-10);
  assert.equal((await f.positions()).length, 0);
  const row = await f.window();
  assert.equal(row.entryPolicyVersion, null); assert.equal(row.crossingAt?.getTime(), 1);
  assert.equal(row.crossingConsumed, false);
});
test("position insert failure rolls back evaluation and consumption; retry may enter", async () => {
  const f = await fixture(); await f.rejectFirst();
  const count = async () => (await pool.query(
    "SELECT count(*) FROM forward_test_evaluations WHERE market_ticker=$1", [f.ticker])).rows[0].count;
  const before = await count();
  await pool.query(`CREATE FUNCTION fail_entry_policy_insert() RETURNS trigger LANGUAGE plpgsql AS
    $$ BEGIN RAISE EXCEPTION 'synthetic_position_failure'; END $$;
    CREATE TRIGGER fail_entry_policy_insert BEFORE INSERT ON forward_test_positions
    FOR EACH ROW EXECUTE FUNCTION fail_entry_policy_insert()`);
  try {
    const [result] = await f.observe(-10);
    assert.ok(result.error); // Drizzle wraps the injected PostgreSQL cause.
    assert.equal(await count(), before); assert.equal((await f.positions()).length, 0);
    assert.equal((await f.window()).crossingConsumed, false);
  } finally {
    await pool.query("DROP TRIGGER fail_entry_policy_insert ON forward_test_positions; DROP FUNCTION fail_entry_policy_insert()");
  }
  await f.observe(-10); assert.equal((await f.positions()).length, 1);
});
test("v2 paper opportunity gives no authority to existing micro-live approvals", async () => {
  const f = await fixture(); await f.rejectFirst();
  const [entry] = await f.observe(-10);
  const prior = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "development";
    const result = await executeQualifiedV13Trigger(entry.evaluationId!);
    assert.equal(result.reason, "entry_policy_revision_requires_separate_review");
    assert.equal((await pool.query("SELECT count(*) FROM micro_live_orders")).rows[0].count, "0");
  } finally { process.env.NODE_ENV = prior; }
});
test("incidental startup remains inert without explicit revision review even when old worker flag is enabled", async () => {
  const oldEnv = process.env.NODE_ENV, oldFlag = process.env.FORWARD_TEST_WORKER_ENABLED;
  const oldReview = process.env.V13_ENTRY_POLICY_RUNTIME_APPROVED;
  let reads = 0;
  try {
    process.env.NODE_ENV = "development"; process.env.FORWARD_TEST_WORKER_ENABLED = "true";
    for (const review of [undefined, "unreviewed", "v13-first-observed-cross-v1"]) {
      if (review === undefined) delete process.env.V13_ENTRY_POLICY_RUNTIME_APPROVED;
      else process.env.V13_ENTRY_POLICY_RUNTIME_APPROVED = review;
      const worker = startServerForwardTestWorker({
        btc: async () => { reads++; throw Error("must_not_read"); },
        market: async () => { reads++; throw Error("must_not_read"); },
      });
      assert.equal(worker.running, false); await worker.stop();
    }
    assert.equal(reads, 0);
  } finally {
    if (oldEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnv;
    if (oldFlag === undefined) delete process.env.FORWARD_TEST_WORKER_ENABLED; else process.env.FORWARD_TEST_WORKER_ENABLED = oldFlag;
    if (oldReview === undefined) delete process.env.V13_ENTRY_POLICY_RUNTIME_APPROVED;
    else process.env.V13_ENTRY_POLICY_RUNTIME_APPROVED = oldReview;
  }
});
test("review-only additive SQL preserves historical data and rejects NULL-policy shadow entry ambiguity", async () => {
  const schema = `entry_policy_upgrade_${randomUUID().replaceAll("-", "")}`;
  const c = await pool.connect();
  try {
    await c.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};
      CREATE TABLE forward_test_windows(ticker text, first_cross_occurred boolean, crossing_consumed boolean);
      CREATE TABLE forward_test_evaluations(id text, strategy_parameter_set_id text, strategy_parameter_hash text);
      CREATE TABLE forward_test_positions(id text, strategy_parameter_set_id text, strategy_parameter_hash text);
      CREATE TABLE v13_live_money_policy(id text, policy_hash text);
      CREATE TABLE v13_strategy_shadow_evaluation(
        first_cross boolean NOT NULL, previous_buffer float8, signed_buffer float8,
        would_enter boolean NOT NULL, qualifying_trigger boolean NOT NULL,
        signal text, direction text, entry_offer float8,
        CONSTRAINT v13_strategy_shadow_eval_entry_check CHECK(
          NOT would_enter OR (first_cross AND qualifying_trigger AND
            signal IN ('SCOUT','CONFIRM') AND direction IN ('UP','DOWN') AND entry_offer IS NOT NULL)));
      INSERT INTO forward_test_windows VALUES('historical',true,false);
      INSERT INTO forward_test_evaluations VALUES('historical',NULL,NULL);
      INSERT INTO forward_test_positions VALUES('historical',NULL,NULL);
      INSERT INTO v13_live_money_policy VALUES('historical','unchanged');
      INSERT INTO v13_strategy_shadow_evaluation VALUES(false,-1,10,false,true,'SCOUT','UP',.5)`);
    const tables = ["forward_test_windows", "forward_test_evaluations", "forward_test_positions",
      "v13_live_money_policy", "v13_strategy_shadow_evaluation"];
    const before = await Promise.all(tables.map(async t => (await c.query(`SELECT to_jsonb(t) data FROM ${t} t`)).rows));
    await c.query(readFileSync(resolve(process.cwd(), "../../docs/sql/c52-entry-policy-review-only.sql"), "utf8"));
    for (const [i, t] of tables.entries()) {
      const rows = (await c.query(`SELECT to_jsonb(t) data FROM ${t} t`)).rows;
      assert.equal(rows[0].data.entry_policy_version, null);
      delete rows[0].data.entry_policy_version;
      assert.deepEqual(rows, before[i]);
    }
    for (const version of [null, "unreviewed"]) {
      await assert.rejects(c.query(`INSERT INTO v13_strategy_shadow_evaluation
        VALUES(false,-1,10,true,true,'SCOUT','UP',.5,$1)`, [version]), { code: "23514" });
    }
    await c.query(`INSERT INTO v13_strategy_shadow_evaluation
      VALUES(false,-1,10,true,true,'SCOUT','UP',.5,$1)`, [V13_ENTRY_POLICY_VERSION]);
  } finally {
    await c.query(`ROLLBACK; RESET search_path; DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    c.release();
  }
});
