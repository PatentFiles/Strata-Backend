import assert from "node:assert/strict";
import test from "node:test";
import { cleanupOwnedAnalyticsPostgres } from "./analyticsDrainPostgresLifecycle.mjs";
function fixture(startup, states, pid, stopResult = 0, pidAfterStop = false) {
  const calls = []; let removed = false;
  return { calls, removed: () => removed, run: () => cleanupOwnedAnalyticsPostgres({ startup,
    hasPid() { calls.push("pid"); return pid; },
    status() { calls.push("status"); return states.shift(); },
    stop() { calls.push("stop"); pid = pidAfterStop; return stopResult; },
    remove() { calls.push("remove"); removed = true; },
  }) };
}
test("no startup attempt needs no PostgreSQL process check", () => {
  const f = fixture("not_attempted", [], false); f.run(); assert.equal(f.removed(), true); assert.deepEqual(f.calls, ["remove"]);
});
for (const startup of ["started", "uncertain"]) {
  test(`${startup}: observed server is stopped and verified before removal`, () => {
    const f = fixture(startup, [0, 3], true); f.run(); assert.equal(f.removed(), true); assert.ok(f.calls.indexOf("stop") < f.calls.indexOf("remove"));
  });
}
test("known successful start that already exited is verified stopped", () => {
  const f = fixture("started", [3], false); f.run(); assert.equal(f.removed(), true); assert.equal(f.calls.includes("stop"), false);
});
for (const scenario of ["start nonzero", "start timeout", "startup signal"]) {
  test(`${scenario}: absent PID after uncertain startup retains directory`, () => {
    const f = fixture("uncertain", [3], false); assert.throws(f.run, /startup_uncertain/); assert.equal(f.removed(), false);
  });
}
test("uncertain startup with PID still attempts owned shutdown even if status is unavailable", () => {
  const f = fixture("uncertain", [null, 3], true); f.run(); assert.equal(f.removed(), true);
});
test("failed stop never deletes the directory", () => {
  const f = fixture("started", [0], true, 1); assert.throws(f.run, /stop_failed/); assert.equal(f.removed(), false);
});
test("successful stop without confirmed stopped status retains the directory", () => {
  const f = fixture("started", [0, 0], true); assert.throws(f.run, /stop_unconfirmed/); assert.equal(f.removed(), false);
});
test("successful stop with retained PID retains the directory", () => {
  const f = fixture("started", [0, 3], true, 0, true); assert.throws(f.run, /stop_unconfirmed/); assert.equal(f.removed(), false);
});
test("status timeout after known startup retains the directory", () => {
  const f = fixture("started", [null], false); assert.throws(f.run, /stop_unconfirmed/); assert.equal(f.removed(), false);
});
