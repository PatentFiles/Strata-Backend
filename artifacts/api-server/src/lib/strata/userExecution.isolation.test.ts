import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { V13_CHAMPION_PARAMETER_HASH, V13_CHAMPION_PARAMETER_SET, V13_ENTRY_POLICY_VERSION } from "@workspace/v13-strategy";
import { computeV13LiveMoneyPolicyHash, V13_MAX_ENTRY_STAKE_CENTS, type V13ApprovedLiveMoneyPolicy, type V13LiveMoneyRiskInput } from "../v13LiveMoneyRisk";
import { decryptCredential, encryptCredential, publicConnectionView } from "./userCredentialCipher";
import { assembleKalshiUserRead, normalizeKalshiMoney } from "./kalshiUserRead";
import { applyPresetToDraft, canEditPreset, presetFieldError, type SharedPreset } from "./sharedPresets";
import { changeConfiguredStake, controlAccount, emptyUserExecutionView, grossSpendWithinConfiguredStake, independentRiskDecisions, legacyClaimPreconditions, policyAuthorityChange, viewForCaller, type ScopedAccount } from "./userExecutionScope";
import { UserWorkerRegistry } from "./userWorkerRegistry";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

function account(ownerUserId: string | null, patch: Partial<ScopedAccount> = {}): ScopedAccount {
  return {
    id: ownerUserId === null ? "legacy" : `acct-${ownerUserId}`,
    ownerUserId,
    connectionId: ownerUserId === null ? null : `conn-${ownerUserId}`,
    subaccount: 1,
    exchangeIndex: 2,
    commissioned: false,
    executionEnabled: false,
    killSwitch: true,
    cashCents: ownerUserId === null ? 2500 : 20_000,
    reservedCents: 0,
    capitalRemainingCents: 15_000,
    configuredStakeCents: 2500,
    stakeRevision: 1,
    approvedMaxEntryStakeCents: 10_000,
    policyApproved: true,
    policyVersion: 1,
    workerRunning: false,
    openPositionCount: 0,
    preparedIntentCount: 0,
    dispatchedIntentCount: 0,
    unknownIntentCount: 0,
    unresolvedOrderCount: 0,
    realizedDailyLossCents: 0,
    realizedTotalLossCents: 0,
    realizedPnlCents: 0,
    minimumExitApproved: false,
    primaryCashCents: 50_000,
    primaryPortfolioValueCents: 60_000,
    portfolioValueCents: 20_000,
    positions: [{ id: `pos-${ownerUserId}` }],
    orders: [{ id: `ord-${ownerUserId}` }],
    fills: [{ id: `fill-${ownerUserId}` }],
    settlements: [{ id: `set-${ownerUserId}` }],
    reconciledAt: "2026-10-11T00:00:00.000Z",
    commissioningState: "COMMISSIONED_DISARMED",
    ...patch,
  };
}

function preset(creator = USER_B): SharedPreset {
  return {
    id: "preset-1",
    name: "Shared launch",
    description: "Configuration only",
    creatorUserId: creator,
    creatorDisplayName: "Operator B",
    capitalLimitCents: 15000,
    maxEntryStakeCents: 150,
    maxEntryAllInCents: 200,
    maxDailyLossCents: 500,
    maxTotalLossCents: 1500,
    maxQuoteAgeMs: 1000,
    maxFeeEvidenceAgeMs: 1000,
    minimumExitMicros: 10000,
    revision: 1,
    createdAt: "2026-10-11T00:00:00.000Z",
    updatedAt: "2026-10-11T00:00:00.000Z",
  };
}

function policy(id: string, stake: number): V13ApprovedLiveMoneyPolicy {
  const row: V13ApprovedLiveMoneyPolicy = {
    id,
    version: 1,
    supersedesPolicyId: null,
    state: "APPROVED",
    strategyVersion: "V1.3",
    strategyParameterSetId: V13_CHAMPION_PARAMETER_SET.id,
    strategyParameterHash: V13_CHAMPION_PARAMETER_HASH,
    entryPolicyVersion: V13_ENTRY_POLICY_VERSION,
    championSelectionReviewId: "03376f2cc125ed649858f19d9aa910e9ff9a57c8",
    championSelectionEvidenceHash: V13_CHAMPION_PARAMETER_HASH,
    championSelectedBy: "operator",
    championSelectedAt: new Date("2026-10-11T21:16:01.312Z"),
    capitalLimitCents: 3_000_000,
    maxEntryStakeCents: stake,
    maxEntryAllInCents: stake + 9_000,
    maxOpenPositions: 1,
    maxDailyLossCents: 3_000_000,
    maxTotalLossCents: 3_000_000,
    maxQuoteAgeMs: 1000,
    maxFeeEvidenceAgeMs: 1000,
    feePolicyVersion: "micro-live-standing-fee-policy-v1",
    feeSourceUrl: "https://kalshi.com/docs/kalshi-fee-schedule.pdf",
    feeFormulaVersion: "standard-quadratic-0.07-v1",
    requireFullDepth: true,
    entryTimeInForce: "IOC",
    entryLimitSource: "SIGNAL_REFERENCE_OFFER",
    policyHash: null,
    createdBy: "operator",
    approvedBy: "operator",
    approvedAt: new Date("2026-10-11T21:16:01.312Z"),
  };
  row.policyHash = computeV13LiveMoneyPolicyHash(row);
  return row;
}

function risk(row: V13ApprovedLiveMoneyPolicy, cash: number, daily: number, total: number, gross: number): V13LiveMoneyRiskInput {
  return {
    policy: row,
    plannedGrossCents: gross,
    reservedEntryFeeCents: 100,
    reservedExitFeeCents: 100,
    availableCashCents: cash,
    capitalRemainingCents: cash,
    openPositions: 0,
    realizedDailyLossCents: daily,
    realizedTotalLossCents: total,
    quoteAgeMs: 100,
    feeEvidenceAgeMs: 100,
    feePolicyVersion: row.feePolicyVersion!,
    feeSourceUrl: row.feeSourceUrl!,
    feeFormulaVersion: row.feeFormulaVersion!,
    feeEvidenceFingerprint: "verified-market-fee-evidence",
    fullDepthProven: true,
  };
}

test("a user cannot read or control another user's execution account", () => {
  const a = account(USER_A, { cashCents: 20_000, configuredStakeCents: 2500, realizedDailyLossCents: 100, realizedPnlCents: 40 });
  const b = account(USER_B, { cashCents: 500_000, configuredStakeCents: 25_000, realizedDailyLossCents: 900, realizedPnlCents: -15, primaryCashCents: 800_000 });
  const legacy = account(null);
  const own = viewForCaller(USER_A, a);
  const foreign = viewForCaller(USER_A, b);
  const unassigned = viewForCaller(USER_A, legacy);
  assert.equal(own.botCashCents, 20_000);
  assert.equal(foreign.executionAccountExists, false);
  assert.equal(foreign.botCashCents, null);
  assert.equal(foreign.primaryCashCents, null);
  assert.deepEqual(foreign.positions, []);
  assert.deepEqual(foreign.orders, []);
  assert.deepEqual(foreign.fills, []);
  assert.deepEqual(foreign.settlements, []);
  assert.equal(foreign.realizedPnlCents, null);
  assert.equal(unassigned.botCashCents, null);
  assert.notEqual(unassigned.botCashCents, 2500);
  for (const action of ["READ", "ARM", "DISARM", "START", "STOP", "KILL", "STAKE", "POLICY"] as const) {
    assert.equal(controlAccount(USER_A, b, action).ok, false);
  }
  const legacyStart = controlAccount(USER_A, legacy, "START");
  assert.equal(legacyStart.ok, false);
  if (!legacyStart.ok) assert.equal(legacyStart.reason, "legacy_unassigned_not_startable");
  assert.equal(changeConfiguredStake(USER_A, b, 300).ok, false);
  const changed = changeConfiguredStake(USER_A, a, 3000);
  assert.equal(changed.ok, true);
  assert.equal(b.configuredStakeCents, 25_000);
  assert.equal(own.maxOpenPositions, 1);
  assert.equal(V13_MAX_ENTRY_STAKE_CENTS, 2_500_000);
});

test("configured stake is a per-user gross maximum and fees stay in the all-in gate", () => {
  const adam = account(USER_A, { cashCents: 20_000, approvedMaxEntryStakeCents: 10_000, configuredStakeCents: 2500 });
  const rob = account(USER_B, { cashCents: 500_000, approvedMaxEntryStakeCents: 50_000, configuredStakeCents: 25_000 });
  assert.equal(changeConfiguredStake(USER_B, rob, 30_000).ok, true);
  assert.equal(adam.configuredStakeCents, 2500);
  assert.equal(grossSpendWithinConfiguredStake(2500, 2500), true);
  assert.equal(grossSpendWithinConfiguredStake(2500, 2501), false);
  const decisions = independentRiskDecisions([
    risk(policy("a", 10_000), 20_000, 0, 0, 2500),
    risk(policy("b", 50_000), 500_000, 2_999_900, 2_999_900, 25_000),
  ]);
  assert.equal(decisions[0]?.ok, true);
  assert.equal(decisions[1]?.ok, false);
  assert.equal(decisions[0]?.ok, true);
});

test("shared presets are visible, attributed, and apply only to the caller's draft", () => {
  const shared = preset(USER_B);
  assert.equal(canEditPreset(shared, USER_A), false);
  assert.equal(canEditPreset(shared, USER_B), true);
  assert.equal(shared.creatorDisplayName, "Operator B");
  const blocked = presetFieldError({ ...shared, positions: [] });
  assert.equal(blocked, "preset_contains_account_state");
  assert.equal(presetFieldError({ ...shared, privateKey: "secret" }), "preset_contains_account_state");
  const bAccount = account(USER_B);
  const before = bAccount.configuredStakeCents;
  const applied = policyAuthorityChange(USER_A, account(USER_A), shared);
  assert.equal(applied.ok, true);
  if (applied.ok) {
    assert.equal(applied.approved, false);
    assert.equal(applied.armed, false);
    assert.equal(applied.started, false);
    assert.equal(applied.draft.ownerUserId, USER_A);
    assert.equal(applied.draft.capitalLimitCents, 15000);
    assert.equal(applied.draft.maxOpenPositions, 1);
    assert.equal(applied.draft.state, "DRAFT");
  }
  assert.equal(policyAuthorityChange(USER_A, bAccount, shared).ok, false);
  assert.equal(bAccount.configuredStakeCents, before);
  const draft = applyPresetToDraft(USER_A, shared, "acct-a");
  assert.equal("positions" in draft, false);
  assert.equal("privateKey" in draft, false);
});

test("credential ciphertext is not a public field and Kalshi reads do not invent KYC", () => {
  const key = Buffer.alloc(32, 7);
  const secret = encryptCredential("-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----", key);
  assert.equal(decryptCredential(secret, key).includes("secret"), true);
  const view = publicConnectionView({ apiKeyId: "key", privateKey: "hidden", encryptedPrivateKey: "hidden" });
  assert.equal("privateKey" in view, false);
  assert.equal("encryptedPrivateKey" in view, false);
  const basic = assembleKalshiUserRead({
    credentialVerified: true,
    limits: { usage_tier: "basic" },
    numberedSubaccountAvailable: false,
    primary: { balance_dollars: "12.34", portfolio_value: "15.00", kyc_pending: true, withdrawable: "9.00" },
    botSubaccount: null,
    activity: { positions: [{ ticker: "KXBTC15M", privateKey: "nope" }] },
  });
  assert.equal(basic.credentialVerified, true);
  assert.equal(basic.botEligible, false);
  assert.equal(basic.botEligibilityReason, "ADVANCED_API_TIER_REQUIRED");
  assert.equal(basic.primary.cashCents, 1234);
  assert.equal(basic.primary.portfolioValueCents, 1500);
  assert.equal("kyc_pending" in basic, false);
  assert.equal(JSON.stringify(basic).includes("withdrawable"), false);
  assert.equal(JSON.stringify(basic).includes("availableToTrade"), false);
  assert.equal(basic.positions[0] && "privateKey" in (basic.positions[0] as object), false);
  assert.deepEqual(normalizeKalshiMoney({ balance_dollars: "1.00", portfolio_value: "2.00" }), { cashCents: 100, portfolioValueCents: 200 });
  const missing = emptyUserExecutionView(USER_A);
  assert.equal(missing.executionAccountExists, false);
  assert.equal(missing.botCashCents, null);
});

test("one worker per owned account and legacy claim does not assign an owner", () => {
  const registry = new UserWorkerRegistry();
  assert.equal(registry.start("acct-a", USER_A).ok, true);
  assert.equal(registry.start("acct-a", USER_A).ok, false);
  assert.equal(registry.stop("acct-a", USER_B).ok, false);
  assert.equal(registry.start("acct-b", USER_B).ok, true);
  assert.equal(registry.runningCount(), 2);
  assert.equal(registry.get("acct-a")?.running, true);
  const claim = legacyClaimPreconditions(account(null, { openPositionCount: 0 }));
  assert.equal(claim.executable, false);
  assert.equal(claim.reason, "legacy_claim_not_executed");
  assert.equal(account(null).ownerUserId, null);
});

test("user-scope migration is additive and does not rewrite the legacy account", () => {
  const sql = readFileSync("../../lib/db/drizzle/0009_v13_user_scoped_execution.sql", "utf8");
  assert.equal(sql.includes("UPDATE v13_production_account"), false);
  assert.equal(sql.includes("UPDATE v13_live_money_policy"), false);
  assert.equal(sql.includes("INSERT INTO v13_production_account"), false);
  assert.equal(sql.includes("INSERT INTO v13_live_money_policy"), false);
  assert.match(sql, /owner_user_id uuid/);
  assert.match(sql, /v13_shared_preset/);
  assert.equal(sql.includes("live_execution_enabled = true"), false);
});
