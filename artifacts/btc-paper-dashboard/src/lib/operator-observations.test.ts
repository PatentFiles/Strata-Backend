import assert from "node:assert/strict";
import test from "node:test";
import { observationIsCurrent, observedFlag } from "./operator-observations";

test("cached, expired, missing and future-dated observations are not current", () => {
  const fresh = { authenticated: true, hasData: true, isError: false, updatedAt: 100_000, now: 100_001 };
  assert.equal(observationIsCurrent(fresh), true);
  for (const patch of [
    { authenticated: false }, { hasData: false }, { isError: true },
    { updatedAt: 0 }, { now: 115_001 }, { updatedAt: 100_002 },
  ]) assert.equal(observationIsCurrent({ ...fresh, ...patch }), false);
});
test("stale cached execution flags cannot look currently disabled or enabled", () => {
  assert.equal(observedFlag(false, false), "unverified (stale data)");
  assert.equal(observedFlag(true, false), "unverified (stale data)");
  assert.equal(observedFlag(undefined, false), "unavailable");
  assert.equal(observedFlag(false, true), "disabled");
  assert.equal(observedFlag(true, true), "enabled");
});
