import assert from "node:assert/strict";
import test from "node:test";
import { forwardTestStartupDecision, isForwardTestWorkerEnabled } from "./forwardTestStartupGate";

const version = "reviewed-entry-policy-test-version";
const production = {
  NODE_ENV: "production",
  V13_ENTRY_POLICY_RUNTIME_APPROVED: version,
  FORWARD_TEST_WORKER_ENABLED: "true",
  FORWARD_TEST_PRODUCTION_WORKER_ENABLED: "true",
};

test("missing production worker flag blocks even when the development flag is true", () => {
  const actual = forwardTestStartupDecision({
    ...production,
    FORWARD_TEST_PRODUCTION_WORKER_ENABLED: undefined,
  }, version);
  assert.deepEqual(actual, {
    ready: false, reason: "production_signal_worker_disabled", mode: "PAPER_ONLY",
  });
  assert.equal(isForwardTestWorkerEnabled("production", "true", undefined), false);
  assert.equal(isForwardTestWorkerEnabled("production", "true", "true"), true);
});

test("reviewed entry policy requires an exact version match with no trimming", () => {
  const missing = forwardTestStartupDecision({
    ...production,
    V13_ENTRY_POLICY_RUNTIME_APPROVED: undefined,
  }, version);
  assert.equal(missing.reason, "entry_policy_approval_missing");
  const whitespace = forwardTestStartupDecision({
    ...production,
    V13_ENTRY_POLICY_RUNTIME_APPROVED: version + " ",
  }, version);
  assert.equal(whitespace.reason, "entry_policy_approval_mismatch");
  assert.equal(whitespace.ready, false);
});

test("false, uppercase and empty production flag values cannot enable the producer", () => {
  for (const flag of ["", "FALSE", "false", "TRUE", "1", " true", "true "]) {
    const result = forwardTestStartupDecision({
      ...production, FORWARD_TEST_PRODUCTION_WORKER_ENABLED: flag,
    }, version);
    assert.equal(result.ready, false, flag);
    assert.equal(result.reason, "production_signal_worker_disabled");
  }
});

test("unsupported environments cannot enable signal production", () => {
  for (const env of ["test", "staging", "preview", ""]) {
    assert.equal(forwardTestStartupDecision({
      ...production, NODE_ENV: env,
    }, version).reason, "unsupported_environment");
  }
});

test("development and production flags remain isolated", () => {
  assert.equal(forwardTestStartupDecision({
    ...production, NODE_ENV: "development", FORWARD_TEST_WORKER_ENABLED: "false",
  }, version).reason, "development_signal_worker_disabled");
  assert.equal(forwardTestStartupDecision({
    ...production, NODE_ENV: "development",
    FORWARD_TEST_WORKER_ENABLED: "true", FORWARD_TEST_PRODUCTION_WORKER_ENABLED: "false",
  }, version).ready, true);
  assert.equal(forwardTestStartupDecision({
    ...production, FORWARD_TEST_WORKER_ENABLED: "false",
  }, version).ready, true);
});

test("exact approved production configuration schedules only a PAPER_ONLY producer", () => {
  const result = forwardTestStartupDecision(production, version);
  assert.deepEqual(result, { ready: true, reason: "ready", mode: "PAPER_ONLY" });
  assert.equal("orderAuthority" in result, false);
});
