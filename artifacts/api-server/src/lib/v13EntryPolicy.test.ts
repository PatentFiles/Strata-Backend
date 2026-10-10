import assert from "node:assert/strict";
import test from "node:test";
import {
  V13_ENTRY_POLICY_VERSION, V13_LEGACY_ENTRY_POLICY, entryCrossAvailable,
  previousBufferFromSide, evaluateV13Strategy,
} from "@workspace/v13-strategy";

const observed = { firstCrossOccurred: true, crossingConsumed: false };
test("only explicit v2 can use a later crossing; historical and unknown policies never upgrade", () => {
  assert.equal(entryCrossAvailable(V13_ENTRY_POLICY_VERSION, observed, true), true);
  for (const version of [null, undefined, V13_LEGACY_ENTRY_POLICY, "unreviewed"]) {
    assert.equal(entryCrossAvailable(version, observed, true), false);
  }
});
test("consumption and actual freshness dominate all policy versions", () => {
  for (const version of [null, V13_LEGACY_ENTRY_POLICY, V13_ENTRY_POLICY_VERSION]) {
    assert.equal(entryCrossAvailable(version, { ...observed, crossingConsumed: true }, true), false);
    assert.equal(entryCrossAvailable(version, { ...observed, firstCrossOccurred: false }, false), false);
  }
});
test("zero touch/departure reconstruction matches the shared classifier, not an opening observation", () => {
  const base = { marketTicker: "TEST", target: 100000, btcPrice: 100010,
    velocity: 20, upOffer: .52, downOffer: .53, freshness: "current" as const, position: null };
  for (const [side, buffer] of [["UP", 1], ["DOWN", -1], ["AT", 0], [null, null]] as const) {
    assert.equal(previousBufferFromSide(side), buffer);
    assert.deepEqual(evaluateV13Strategy({ ...base, previousBuffer: previousBufferFromSide(side) }),
      evaluateV13Strategy({ ...base, previousBuffer: buffer }));
  }
  assert.equal(evaluateV13Strategy({ ...base, previousBuffer: 0 }).qualifyingTrigger, true);
  assert.equal(evaluateV13Strategy({ ...base, btcPrice: base.target, previousBuffer: -1 }).freshCross, false);
  assert.equal(evaluateV13Strategy({ ...base, previousBuffer: null }).qualifyingTrigger, false);
  assert.equal(evaluateV13Strategy({ ...base, previousBuffer: 1 }).qualifyingTrigger, false);
});
