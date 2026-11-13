import assert from "node:assert/strict";
import test from "node:test";
import {
  BOUNDED_RUN_TEST_CAP_MICROS, LIVE_TEST_CAP_MICROS, SESSION_CAP_MICROS,
  withinLiveTestCap, withinAllInLiveTestCap,
} from "./microLiveFeeCap";

test("settlement-loss cap accepts exactly $1 and rejects one micro-dollar more", () => {
  assert.equal(withinLiveTestCap(0, 80, 0, 200_000), true);
  assert.equal(withinLiveTestCap(0, 80, 0, 200_001), false);
});

test("committed cash and entry fees cannot be spent twice", () => {
  assert.equal(withinLiveTestCap(40, 40, 100_000, 100_000), true);
  assert.equal(withinLiveTestCap(41, 40, 100_000, 100_000), false);
});

test("unknown, fractional, negative and unsafe fee ceilings fail closed", () => {
  for (const fee of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(withinLiveTestCap(0, 40, 0, fee), false);
  }
  assert.equal(withinLiveTestCap(Number.MAX_SAFE_INTEGER, 0, 0, 0), false);
});

test("one-session $25 cumulative bound includes existing debit and fees without relaxing $1 per entry", () => {
  assert.equal(withinLiveTestCap(0, 40, 0, 600_000), true);
  assert.equal(withinLiveTestCap(0, 40, 0, 600_001), false);
  assert.equal(withinLiveTestCap(2_400, 40, 0, 600_000, SESSION_CAP_MICROS), true);
  assert.equal(withinLiveTestCap(2_400, 40, 1, 600_000, SESSION_CAP_MICROS), false);
  assert.equal(withinLiveTestCap(0, 0, 0, 0, NaN), false);
});

test("cash-risk cap includes negative exit cash and accepts verified zero", () => {
  assert.equal(withinAllInLiveTestCap(40, 600_000, 0), true);
  assert.equal(withinAllInLiveTestCap(40, 600_000, 1), false);
  assert.equal(withinAllInLiveTestCap(40, 500_000, 100_000), true);
  assert.equal(withinAllInLiveTestCap(40, 500_000, 100_001), false);
  for (const invalid of [NaN, Infinity, -1, 0.5]) {
    assert.equal(withinAllInLiveTestCap(40, 500_000, invalid), false);
  }
});

test("the next bounded run uses $5 all-in while the default per-entry cap stays $1", () => {
  const exact = [400, 700_000, 300_000] as const;
  assert.equal(withinAllInLiveTestCap(...exact, BOUNDED_RUN_TEST_CAP_MICROS), true);
  assert.equal(withinAllInLiveTestCap(400, 700_000, 300_001, BOUNDED_RUN_TEST_CAP_MICROS), false);
  assert.equal(withinAllInLiveTestCap(400, 700_000, 300_001), false,
    "the legacy/default cap remains exactly $1");
  assert.equal(LIVE_TEST_CAP_MICROS, 1_000_000);
  assert.equal(withinLiveTestCap(0, 40, 0, 600_000), true);
  assert.equal(withinLiveTestCap(0, 40, 0, 600_001), false,
    "raising the bounded all-in cap must not raise the per-entry $1 cap");
});