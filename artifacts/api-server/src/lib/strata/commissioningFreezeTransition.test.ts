import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMISSION_OWNED_ACCOUNT_CONFIRMATION,
  commissionOwnedAccount,
  reportOwnedActivation,
} from "./personalAccountActivation";

const ownerId = "11111111-1111-4111-8111-111111111111";
const digest = "a".repeat(64);
const policy = {
  id: "owned-test-account",
  owner_user_id: ownerId,
  commissioned: false,
  execution_enabled: false,
  kill_switch: true,
  blocked_reason: "awaiting_account_commissioning",
  subaccount: 1, exchange_index: 2,
  key_fingerprint: digest, credential_fingerprint: digest,
  cash_precision_verified: true, cash_micros: "25000000",
  reconciled_at: new Date(Date.now() - 10_000).toISOString(),
  verified_funding_at: new Date(Date.now() - 20_000).toISOString(),
  policy_id: "policy-1", policy_state: "APPROVED",
  fee_policy_version: "micro-live-standing-fee-policy-v1",
  fee_source_url: "https://kalshi.com/docs/kalshi-fee-schedule.pdf",
  fee_formula_version: "standard-quadratic-0.07-v1",
  configured_stake_cents: 150, minimum_exit_micros: null,
  fee_artifact_digest: null, commissioning_digest: null, activation_requests: 0,
};

function dbWith(row: Record<string, unknown>) {
  const statements: string[] = [];
  const db = { query: async (sql: string) => {
    statements.push(sql);
    if (sql.includes("personal-activation:readiness")) return { rows: [row] };
    if (sql.includes("SELECT live_execution_enabled, manual_kill_switch"))
      return { rows: [{ live_execution_enabled: true, manual_kill_switch: false }] };
    if (sql.includes("personal-activation:commission")) return { rows: [{ id: row.id }], rowCount: 1 };
    throw Error("unexpected query");
  } };
  return { db, statements };
}

test("explicit commissioning only clears the initial provisioning sentinel", async () => {
  const {db, statements} = dbWith(policy);
  const result = await commissionOwnedAccount(db, {
    ownerUserId: ownerId,
    confirmation: COMMISSION_OWNED_ACCOUNT_CONFIRMATION,
    feeArtifactDigest: digest,
    minimumExitMicros: 10000,
    verifyMonetary: (async () => ({
      ok: true,
      monetaryFeeAuthorized: true,
      sourceDigest: digest,
      stage: "STEP_11",
      reason: "provider_monetary_fee_schedule_and_market_verified",
    })) as never,
    verifyFee: (async () => ({valid: true, digest, verifiedAt: Date.now()})) as never,
  });
  assert.equal(result.ok, true, result.reason);
  const updated = statements.find(sql => sql.includes("personal-activation:commission"));
  assert.ok(updated);
  assert.match(updated, /blocked_reason\s*=\s*CASE[\s\S]*blocked_reason\s*=\s*'awaiting_account_commissioning'\s+THEN\s+NULL[\s\S]*ELSE\s+blocked_reason\s+END/i);
  assert.match(updated, /AND execution_enabled = false/);
  assert.match(updated, /AND kill_switch = true/);
  assert.match(updated, /AND reconciled_at BETWEEN now\(\) - interval '15 minutes'/);
  assert.equal(statements.some(sql => /UPDATE live_execution_config/i.test(sql)), false);
});

test("already commissioned accounts with stale or genuine freezes are not reported live-ready", async () => {
  for (const blockedReason of ["awaiting_account_commissioning", "production_uncertain_order", "production_external_cash_mismatch"]) {
    const { db, statements } = dbWith({
      ...policy, commissioned: true, execution_enabled: true, kill_switch: false,
      fee_artifact_digest: digest, minimum_exit_micros: 10000, blocked_reason: blockedReason,
    });
    const report = await reportOwnedActivation(db, ownerId);
    assert.equal(report.readyForLive, false);
    assert.ok(report.blockers.includes("production_account_frozen"));
    assert.equal(statements.some(sql => /\bUPDATE\b/i.test(sql)), false);
  }
});

test("clean and fully commissioned accounts do not receive the freeze blocker", async () => {
  const { db } = dbWith({
    ...policy, commissioned: true, execution_enabled: true, kill_switch: false,
    fee_artifact_digest: digest, minimum_exit_micros: 10000, blocked_reason: null,
  });
  const report = await reportOwnedActivation(db, ownerId);
  assert.equal(report.blockers.includes("production_account_frozen"), false);
});
