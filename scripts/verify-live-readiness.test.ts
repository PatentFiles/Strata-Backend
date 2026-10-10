import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assessSingletonLinkage, assertSelect, COMMISSIONING_LINKAGE_FIELDS,
  readinessExitCode, verifyShadowConfig,
} from "./verify-live-readiness";

function completeLinkage(): Record<string, unknown> {
  return {
    micro_live_run_id: "synthetic-run",
    micro_live_funding_anchor_subaccount: 1, micro_live_funding_anchor_exchange_index: 2,
    micro_live_funding_anchor_transfer_id: "synthetic-transfer",
    micro_live_funding_anchor_transfer_at: "2026-10-07T12:00:00Z",
    micro_live_funding_anchor_amount_cents: 2500, micro_live_pair_cash_baseline_micros: "25000000",
    micro_live_pair_cash_baseline_run_id: "synthetic-run",
    micro_live_pair_cash_baseline_at: "2026-10-07T12:00:01Z",
    micro_live_pair_cash_baseline_evidence_digest: "a".repeat(64),
    micro_live_account_activity_checkpoint_subaccount: 1,
    micro_live_account_activity_checkpoint_exchange_index: 2,
    micro_live_account_activity_checkpoint_run_id: "synthetic-run",
    micro_live_account_activity_checkpoint_cursor: "synthetic-cursor",
    micro_live_account_activity_checkpoint_at: "2026-10-07T12:00:02Z",
    micro_live_account_activity_checkpoint_evidence_digest: "b".repeat(64),
    micro_live_restricted_api_key_id: "synthetic-key", micro_live_restricted_key_fingerprint: "c".repeat(64),
  };
}
test("every one of the 17 missing fields prevents a verified linkage", () => {
  for (const field of COMMISSIONING_LINKAGE_FIELDS) {
    const row = completeLinkage(); row[field] = null;
    const result = assessSingletonLinkage(row);
    assert.equal(result.status, "INCOMPLETE", field);
    assert.ok(result.lines.join("\n").includes(field));
    assert.ok(!result.lines.join("\n").includes("synthetic-key"));
  }
});
test("checkpoint on wrong pair/run or with invalid digest/time refuses", () => {
  for (const [field, value] of [
    ["micro_live_account_activity_checkpoint_subaccount", 0],
    ["micro_live_account_activity_checkpoint_exchange_index", 0],
    ["micro_live_account_activity_checkpoint_run_id", "other-run"],
    ["micro_live_account_activity_checkpoint_evidence_digest", "invalid"],
    ["micro_live_account_activity_checkpoint_at", "not-a-date"],
    ["micro_live_account_activity_checkpoint_at", "2026-10-07T11:00:00Z"],
  ] as const) {
    const row = completeLinkage(); row[field] = value;
    assert.equal(assessSingletonLinkage(row).status, "MISMATCH", field);
  }
  assert.equal(assessSingletonLinkage(completeLinkage()).status, "VERIFIED");
});
test("blocked/incomplete verdicts exit nonzero and never imply authority", () => {
  assert.equal(readinessExitCode("MISMATCH", "INCOMPLETE", []), 2);
  assert.equal(readinessExitCode("VERIFIED", "VERIFIED", ["owner action pending"]), 2);
  assert.equal(readinessExitCode("VERIFIED", "VERIFIED", []), 0);
});
test("SELECT guard still refuses mutations and locking queries", () => {
  assert.doesNotThrow(() => assertSelect("select id from micro_live_config where id=$1"));
  for (const sql of ["UPDATE micro_live_config SET manual_kill_switch=false",
    "select id from micro_live_config for update", "select 1; delete from micro_live_config"]) {
    assert.throws(() => assertSelect(sql), /DATABASE_QUERY_REFUSED/);
  }
});
test("global kill switch OFF is a blocking mismatch even when execution flag is false", async () => {
  const result = await verifyShadowConfig({
    async query() { return { rows: [{ live_execution_enabled: false, manual_kill_switch: false }] }; },
    async end() {},
  });
  assert.equal(result.status, "MISMATCH");
});
test("credential-stripped CLI fails closed without opening a DB or signing HTTP", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "./verify-live-readiness.ts"], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    env: { PATH: process.env.PATH, NODE_ENV: "test" }, encoding: "utf8",
  });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /DATABASE_URL: MISSING/);
  assert.match(result.stdout, /READINESS PREREQUISITES: BLOCKED/);
  assert.match(result.stdout, /EXECUTION AUTHORITY: NONE/);
  assert.match(result.stdout, /Kalshi reads were not started/);
});
