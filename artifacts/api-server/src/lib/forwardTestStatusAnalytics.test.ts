import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createSingleFlightAnalyticsCache } from "./readOnlyAnalyticsCache";

test("wins and losses share the bounded historical aggregate instead of per-status scans", () => {
  const route = readFileSync("src/routes/forwardTest.ts", "utf8");
  const repository = readFileSync("src/lib/forwardTestRepository.ts", "utf8");
  assert.match(repository, /wins: positions\.wins/);
  assert.match(repository, /losses: positions\.losses/);
  assert.doesNotMatch(route, /wins: sql|losses: sql|\[breakdown\]/);
  assert.match(route, /createSingleFlightAnalyticsCache\([\s\S]*?aggregateForwardTestStatistics\(FORWARD_TEST_ENGINE_ID\),\s*60_000/);
  assert.match(route, /getEngineStatus\(\)/); // Heartbeat/lease remain live, outside cache.
});

test("concurrent historical count reads coalesce, expire and do not mask failures", async () => {
  let now=0, reads=0, fail=false;
  const read = createSingleFlightAnalyticsCache(async () => {
    reads++;
    if(fail) throw new Error("database unavailable");
    return {wins:3,losses:2};
  },60_000,()=>now);
  assert.deepEqual(await Promise.all(Array.from({length:20},()=>read())),Array.from({length:20},()=>({wins:3,losses:2})));
  assert.equal(reads,1);
  now=60_000; fail=true;
  await assert.rejects(read(),/database unavailable/);
  fail=false;
  assert.deepEqual(await read(),{wins:3,losses:2});
  assert.equal(reads,3);
});
