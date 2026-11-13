import assert from "node:assert/strict";
import test from "node:test";
import {createSingleFlightAnalyticsCache} from "./readOnlyAnalyticsCache";

test("concurrent analytics requests share one read", async () => {
  let calls = 0;
  let finish: (result: number) => void = () => {};
  const load = createSingleFlightAnalyticsCache(() => {
    calls++;
    return new Promise<number>(resolve => { finish = resolve; });
  }, 30_000);
  const one = load();
  const two = load();
  await Promise.resolve();
  assert.equal(calls, 1);
  finish(42);
  assert.deepEqual(await Promise.all([one, two]), [42, 42]);
  assert.equal(await load(), 42);
  assert.equal(calls, 1);
});

test("expiry refreshes; rejected refresh is never cached and no stale success is served", async () => {
  let now = 1_000;
  let calls = 0;
  const load = createSingleFlightAnalyticsCache(async () => {
    calls++;
    if (calls === 2) throw new Error("database unavailable");
    return calls;
  }, 100, () => now);
  assert.equal(await load(), 1);
  now += 101;
  await assert.rejects(load(), /database unavailable/);
  assert.equal(await load(), 3);
});

test("analytics cache rejects invalid and excessive TTLs", () => {
  assert.throws(() => createSingleFlightAnalyticsCache(async () => 1, 0), RangeError);
  assert.throws(() => createSingleFlightAnalyticsCache(async () => 1, 300_001), RangeError);
});
