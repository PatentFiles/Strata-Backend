import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const source = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
const paper = fileURLToPath(new URL("../dist/paperWorkerMain.mjs", import.meta.url));

test("the API never imports or starts the paper scheduler", () => {
  assert.doesNotMatch(source("../src/index.ts"), /forwardTestWorker|startServerForwardTestWorker\s*\(/);
});

test("the deployed paper bundle contains no live execution or wake module", () => {
  const bundle = source("../dist/paperWorkerMain.mjs");
  assert.doesNotMatch(bundle, /src\/lib\/(?:microLive\.ts|forwardTestSignalWake\.ts|v13-production\/(?:worker|executor)\.ts|strata\/personalExecution\.ts)|processMicroLiveForwardTestCycle|notifyCommittedForwardSignal/);
  assert.match(bundle, /startServerForwardTestWorker/);
});

test("the deployed paper command fails closed before database or exchange access", () => {
  const bin = source("../dist/paperWorkerMain.mjs");
  const version = bin.match(/V13_ENTRY_POLICY_VERSION\s*=\s*"([^"]+)"/)?.[1];
  assert.ok(version, "expected the compiled entry-policy version");
  const env = { NODE_ENV: "production", V13_ENTRY_POLICY_RUNTIME_APPROVED: version };
  const cases = [
    [{ NODE_ENV: "production" }, /entry_policy_approval_missing/],
    [env, /production_signal_worker_disabled/],
    [{ ...env, FORWARD_TEST_PRODUCTION_WORKER_ENABLED: "true" }, /paper_database_url_required/],
    [{
      ...env, FORWARD_TEST_PRODUCTION_WORKER_ENABLED: "true",
      DATABASE_URL: "do-not-read-api-database", STRATA_PAPER_DATABASE_URL: "do-not-read-paper-database",
    }, /paper_inherited_api_database_url/],
  ];
  for (const [testEnv, expected] of cases) {
    const result = spawnSync(process.execPath, [paper], { env: testEnv, encoding: "utf8", timeout: 4000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, expected);
    assert.doesNotMatch(result.stderr, /do-not-read/);
  }
});
