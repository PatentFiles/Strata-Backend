import test from "node:test";
import assert from "node:assert/strict";
import { shadowOpportunityRecordingEnabled } from "./forwardTestCadence";

test("zero-authority shadow recording remains enabled by default", () => {
  assert.equal(shadowOpportunityRecordingEnabled({}), true);
  assert.equal(shadowOpportunityRecordingEnabled({STRATA_V13_SHADOW_OPPORTUNITY_RECORDING_ENABLED: "true"}), true);
});

test("literal false suppresses only optional shadow-opportunity writes", () => {
  assert.equal(shadowOpportunityRecordingEnabled({STRATA_V13_SHADOW_OPPORTUNITY_RECORDING_ENABLED: "false"}), false);
  assert.equal(shadowOpportunityRecordingEnabled({STRATA_V13_SHADOW_OPPORTUNITY_RECORDING_ENABLED: "FALSE"}), true);
});
