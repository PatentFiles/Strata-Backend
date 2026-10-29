import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { observeIdlePoolErrors } from "./poolErrors";

test("idle pool errors are observed without leaking the error or client", async () => {
  const pool = new pg.Pool(); // Never connects.
  const events: Record<string, string | number>[] = [];
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  observeIdlePoolErrors(pool, event => events.push(event));
  const error = Object.assign(new Error("postgres://user:secret@host/database"), {code:"ECONNRESET"});
  assert.doesNotThrow(() => pool.emit("error", error, {password:"secret"}));
  assert.deepEqual(events, [{level:"error",event:"database_idle_client_error",code:"ECONNRESET",totalCount:0,idleCount:0,waitingCount:0}]);
  assert.equal(pool.query, originalQuery);
  assert.equal(pool.connect, originalConnect);
  pool.emit("error", Object.assign(new Error("secret"),{code:"sensitive-code"}));
  assert.equal(events[1].code,"UNKNOWN");
  await pool.end();
  await assert.rejects(pool.query("select 1"), /after calling end/);
});
