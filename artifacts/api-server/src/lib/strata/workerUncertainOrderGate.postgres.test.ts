import assert from "node:assert/strict";
import test, { after } from "node:test";
import { pool } from "@workspace/db";
import { readFileSync } from "node:fs";
import { heartbeatLease } from "./personalExecutionSupervisor";
import { readUnresolvedIntentMode } from "./workerUncertainOrderGate";

const url = process.env.V13_DISPOSABLE_DATABASE_URL;
assert.ok(url && /^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/.test(url), "explicit disposable cluster required");
after(() => pool.end());

test("final-fence uncertainty exemption is exact-account, exact-intent, ENTRY and DISPATCHED only", async () => {
  const db = await pool.connect();
  try {
    await db.query(`CREATE SCHEMA IF NOT EXISTS private;
      CREATE TEMP TABLE v13_production_intent(id text,account_id text,kind text,state text);
      CREATE TABLE IF NOT EXISTS private.strata_emergency_exit_reservations(execution_account_id text,state text);`);
    const query = (sql: string, params: unknown[]) => db.query(sql, params);
    await db.query("INSERT INTO v13_production_intent VALUES('current','account','ENTRY','DISPATCHED')");
    assert.deepEqual(await readUnresolvedIntentMode(query, "account"), {ok:true,mode:"recovery"});
    assert.deepEqual(await readUnresolvedIntentMode(query, "account", "current"), {ok:true,mode:"entries"});
    assert.deepEqual(await readUnresolvedIntentMode(query, "account", "different"), {ok:true,mode:"recovery"});
    for (const [kind,state] of [["ENTRY","UNKNOWN"],["EXIT","DISPATCHED"],["EXIT","UNKNOWN"]]) {
      await db.query("UPDATE v13_production_intent SET kind=$1,state=$2", [kind,state]);
      assert.deepEqual(await readUnresolvedIntentMode(query,"account","current"),{ok:true,mode:"recovery"});
    }
    await db.query("UPDATE v13_production_intent SET kind='ENTRY',state='DISPATCHED'");
    await db.query("INSERT INTO v13_production_intent VALUES('other','account','ENTRY','DISPATCHED')");
    assert.deepEqual(await readUnresolvedIntentMode(query,"account","current"),{ok:true,mode:"recovery"});
    await db.query("UPDATE v13_production_intent SET account_id='foreign' WHERE id='other'");
    assert.deepEqual(await readUnresolvedIntentMode(query,"account","other"),{ok:true,mode:"recovery"});
    for (const state of ["PREPARED","DISPATCHED","UNKNOWN"]) {
      await db.query("DELETE FROM private.strata_emergency_exit_reservations");
      await db.query("INSERT INTO private.strata_emergency_exit_reservations VALUES('account',$1)",[state]);
      assert.deepEqual(await readUnresolvedIntentMode(query,"account","current"),{ok:true,mode:"recovery"});
    }
  } finally { db.release(); }
});


test("final snapshot heartbeat reuses the held worker-lease transaction instead of self-deadlocking",async()=>{
  const holder=await pool.connect(),other=await pool.connect();
  const owner="11111111-1111-4111-8111-111111111111";
  try {
    await holder.query(`CREATE TABLE private.kalshi_account_worker_lease (
      execution_account_id text PRIMARY KEY,owner_user_id uuid,holder_id text,
      fencing_token bigint,state text,account_kill boolean,arm_requested boolean,
      credential_fingerprint text,heartbeat_at timestamptz)`);
    await holder.query(`INSERT INTO private.kalshi_account_worker_lease VALUES
      ('account',$1,'worker',1,'owned',false,true,'fingerprint',now())`,[owner]);
    await holder.query("BEGIN");
    await holder.query("SELECT * FROM private.kalshi_account_worker_lease FOR SHARE");
    await other.query("BEGIN");
    await other.query("SET LOCAL lock_timeout='100ms'");
    const input={executionAccountId:"account",ownerUserId:owner,holderId:"worker",
      fencingToken:1,fingerprint:"fingerprint",now:new Date().toISOString()};
    // Reproduces the old separate-pool path: it cannot upgrade a lease lock
    // held by the final entry transaction, and reports a stale worker fence.
    assert.deepEqual(await heartbeatLease(other,input),{ok:false,reason:"stale_worker_fence"});
    await other.query("ROLLBACK");
    assert.deepEqual(await heartbeatLease(holder,input),{ok:true,armRequested:true});
    await holder.query("COMMIT");
    // Exercise the real helper above; also pin the supervisor routing so a
    // future refactor cannot silently put the final heartbeat back on db.
    const source=readFileSync("src/lib/strata/personalExecutionSupervisor.ts","utf8");
    const body=source.slice(source.indexOf("readSnapshot: async () => {"),source.indexOf("readMarket: async (market, side)"));
    assert.match(body,/heartbeatLease\(snapshotDb,/);
    assert.match(body,/loadRequests\(snapshotDb, input.accountId\)/);
    assert.doesNotMatch(body,/heartbeatLease\(db,/);
  } finally {
    await holder.query("ROLLBACK");await other.query("ROLLBACK");
    holder.release();other.release();
  }
});
