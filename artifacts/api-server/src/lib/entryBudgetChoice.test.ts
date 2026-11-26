import assert from 'node:assert/strict';
import test from 'node:test';
import { V13_CHAMPION_PARAMETER_HASH, V13_CHAMPION_PARAMETER_SET } from '@workspace/v13-strategy';
import { cashRiskFeeFingerprint, cashRiskModelFingerprint, ENTRY_CASH_RISK_VERSION } from './v13EntryCashRisk';
import { computeV13LiveMoneyPolicyHash, type V13ApprovedLiveMoneyPolicy } from './v13LiveMoneyRisk';
import { ENTRY_BUDGET_CHOICE_VERSION, entryBudgetTermsDigest, previewApprovedEntryBudget } from './entryBudgetChoice';

function fixture(grossCents = 50_000, allInCents = 62_500, controllingGross = 500_000, controllingAllIn = 625_000) {
  const now = Date.parse('2026-10-07T03:10:00Z');
  const p: V13ApprovedLiveMoneyPolicy = {
    id: 'policy', version: 3, supersedesPolicyId: null, state: 'APPROVED', strategyVersion: 'V1.3',
    strategyParameterSetId: V13_CHAMPION_PARAMETER_SET.id, strategyParameterHash: V13_CHAMPION_PARAMETER_HASH,
    championSelectionReviewId: 'review', championSelectionEvidenceHash: 'a'.repeat(64),
    championSelectedBy: 'operator', championSelectedAt: new Date(now - 10000), capitalLimitCents: 1_000_000,
    maxEntryStakeCents: controllingGross, maxEntryAllInCents: controllingAllIn, maxOpenPositions: 1,
    maxDailyLossCents: 800_000, maxTotalLossCents: 900_000, maxQuoteAgeMs: 5000, maxFeeEvidenceAgeMs: 5000,
    feePolicyVersion: 'approved-fixture', feeSourceUrl: 'https://example.invalid/fee',
    feeFormulaVersion: 'quadratic-fixture', requireFullDepth: true, entryTimeInForce: 'IOC',
    entryLimitSource: 'SIGNAL_REFERENCE_OFFER', policyHash: null,
    createdBy: 'operator', approvedBy: 'operator', approvedAt: new Date(now - 10000),
  };
  const hash = computeV13LiveMoneyPolicyHash(p);
  p.policyHash = hash;
  const scope = { ownerId: 'owner', accountId: 'account', credentialFingerprint: 'a'.repeat(64),
    releaseSha: 'b'.repeat(40), policyHash: hash, policyRevision: p.version, stakeRevision: 7,
    feeApprovalId: 'fee-current', feeApprovalDigest: 'c'.repeat(64) };
  const terms = { version: ENTRY_BUDGET_CHOICE_VERSION, choiceId: 'choice', choiceRevision: 1,
    scope: {...scope}, grossCents, allInCents };
  const approvalDigest = entryBudgetTermsDigest(terms);
  const model = { version: ENTRY_CASH_RISK_VERSION, policyHash: hash, marketTicker: 'KXBTC15M-TEST-000',
    side: 'NO' as const, artifactDigest: 'c'.repeat(64), gridDigest: 'd'.repeat(64),
    feeMetadataDigest: 'e'.repeat(64), seriesDigest: 'f'.repeat(64) };
  const cashRisk = { ...model, modelFingerprint: cashRiskModelFingerprint(model),
    entryCashDebitPerContractMicros: 1_000_000, entryTradeFeePerContractMicros: 17_500, exitLossPerContractMicros: 999_000 };
  const feeEvidence = { policyVersion: p.feePolicyVersion!, sourceUrl: p.feeSourceUrl!, formulaVersion: p.feeFormulaVersion!,
    verifiedAtMs: now - 20, fingerprint: '', cashRisk, contracts: 10_000, limitPrice: .51,
    reservedEntryFeeCents: 17_500, reservedExitFeeCents: 999_000 };
  feeEvidence.fingerprint = cashRiskFeeFingerprint(feeEvidence);
  return {
    requestedChoice: { choiceId: 'choice', choiceRevision: 1 }, currentScope: scope,
    currentConfiguredGrossCents: controllingGross, choice: {...terms, approvalDigest},
    trustedBudgetApproval: {approvalDigest, scope: {...scope}, approvedAtMs: now - 100, expiresAtMs: now + 100,
      revokedAtMs: null as number|null},
    trustedFeeApproval: {scope: {...scope}, policyVersion: p.feePolicyVersion!, sourceUrl: p.feeSourceUrl!,
      formulaVersion: p.feeFormulaVersion!, feeArtifactDigest: model.artifactDigest, verifiedAtMs: now - 100, expiresAtMs: now + 100, revokedAtMs: null as number|null},
    preflight: { policy: p, strategyParameterSetId: p.strategyParameterSetId, strategyParameterHash: p.strategyParameterHash,
      signal: 'SCOUT' as const, direction: 'DOWN' as const, referenceOffer: .51, bestAskDollars: '0.5100',
      askLevels: [{priceDollars: '0.5100', availableContracts: '9081.44'}], feeEvidence,
      quoteAgeMs: 100, nowMs: now, availableCashCents: 1_000_000, capitalRemainingCents: 1_000_000,
      openPositions: 0, realizedDailyLossCents: 0, realizedTotalLossCents: 0, configuredStakeCents: controllingGross },
  };
}

test('selected $5, $500 and $5k gross choices remain bounded by separate approved all-in limits', () => {
  for (const [gross, allIn, qty, total] of [[500,625,3,600],[50000,62500,312,62369],[500000,625000,3126,624888]]) {
    const x = fixture(gross, allIn), original = structuredClone(x);
    const result = previewApprovedEntryBudget(x);
    assert.deepEqual(result, {ok:true, previewOnly:true, choiceId:'choice', choiceRevision:1,
      grossCents:gross, allInCents:allIn, requestedContracts:qty, modeledGrossCents:qty*51, modeledAllInCents:total});
    assert.ok(Object.isFrozen(result));
    assert.deepEqual(x, original);
  }
});
test('underfunding and loss caps still reduce modeled quantity', () => {
  const x = fixture();
  x.preflight.availableCashCents = 250;
  x.preflight.realizedDailyLossCents = 799_800;
  const result = previewApprovedEntryBudget(x);
  assert.ok(result.ok);
  assert.equal(result.requestedContracts, 1);
  assert.equal(result.modeledAllInCents, 200);
});
test('shallow eligible book, above-limit depth and stale evidence never add quantity', () => {
  const x = fixture();
  x.preflight.askLevels = [{priceDollars:'0.5100',availableContracts:'1.99'},
    {priceDollars:'0.5200',availableContracts:'50000'}];
  const result = previewApprovedEntryBudget(x);
  assert.ok(result.ok);
  assert.equal(result.requestedContracts, 1);
  x.preflight.quoteAgeMs = 5001;
  assert.equal(previewApprovedEntryBudget(x).ok, false);
  x.preflight.quoteAgeMs = 250;
  x.preflight.feeEvidence.verifiedAtMs = x.preflight.nowMs - 5001;
  assert.equal(previewApprovedEntryBudget(x).ok, false);
});
test('choice/ref and fixed all-in approval cannot be bypassed through client terms', () => {
  const x = fixture();
  x.requestedChoice.choiceRevision++;
  assert.deepEqual(previewApprovedEntryBudget(x), {ok:false,reason:'budget_approval_unavailable'});
  x.requestedChoice.choiceRevision--;
  x.choice.allInCents++;
  x.choice.approvalDigest = entryBudgetTermsDigest(x.choice);
  assert.deepEqual(previewApprovedEntryBudget(x), {ok:false,reason:'budget_approval_unavailable'});
});
test('tenant, release, key, fee, policy and stake drift all fail closed', () => {
  for (const key of ['ownerId','accountId','releaseSha','credentialFingerprint','feeApprovalId','feeApprovalDigest','policyHash','policyRevision','stakeRevision'] as const) {
    const x = fixture();
    Object.assign(x.currentScope, {[key]: typeof x.currentScope[key] === 'number' ? Number(x.currentScope[key])+1 : 'z'});
    assert.deepEqual(previewApprovedEntryBudget(x), {ok:false,reason:'budget_scope_mismatch'});
  }
});
test('budget and fee approvals are independent and fail on expiry or revocation', () => {
  const x = fixture();
  x.trustedBudgetApproval.revokedAtMs = 1;
  assert.deepEqual(previewApprovedEntryBudget(x), {ok:false,reason:'budget_approval_unavailable'});
  x.trustedBudgetApproval.revokedAtMs = null;
  x.trustedFeeApproval.expiresAtMs = x.preflight.nowMs;
  assert.deepEqual(previewApprovedEntryBudget(x), {ok:false,reason:'budget_fee_approval_unavailable'});
  x.trustedFeeApproval.expiresAtMs++;
  x.trustedFeeApproval.feeArtifactDigest = 'e'.repeat(64);
  assert.deepEqual(previewApprovedEntryBudget(x), {ok:false,reason:'budget_fee_approval_unavailable'});
  x.trustedFeeApproval.feeArtifactDigest = 'c'.repeat(64);
  x.trustedFeeApproval.policyVersion = 'different-model';
  assert.deepEqual(previewApprovedEntryBudget(x), {ok:false,reason:'budget_fee_approval_unavailable'});
});
test('a separately approved choice cannot expand the controlling stake or all-in policy', () => {
  assert.deepEqual(previewApprovedEntryBudget(fixture(500_001,625_000)), {ok:false,reason:'budget_outside_approved_envelope'});
  assert.deepEqual(previewApprovedEntryBudget(fixture(500_000,625_001)), {ok:false,reason:'budget_outside_approved_envelope'});
  assert.deepEqual(previewApprovedEntryBudget(fixture(500_000,499_999)), {ok:false,reason:'budget_outside_approved_envelope'});
});

test('approved $100/$200/$250 choices under a synthetic $500 maximum and one-cent overage refusal', () => {
  for (const [gross, allIn, count, plannedAllIn] of [
    [10_000,12_500,62,12_394], [20_000,25_000,125,24_988], [25_000,31_250,156,31_185],
  ]) {
    const result = previewApprovedEntryBudget(fixture(gross,allIn,50_000,62_500));
    assert.ok(result.ok);
    assert.equal(result.requestedContracts,count);
    assert.equal(result.modeledAllInCents,plannedAllIn);
  }
  assert.deepEqual(previewApprovedEntryBudget(fixture(50_001,62_500,50_000,62_500)),
    {ok:false,reason:'budget_outside_approved_envelope'});
});
