import { V13_CHAMPION_PARAMETER_HASH, V13_CHAMPION_PARAMETER_SET } from '@workspace/v13-strategy';
import { cashRiskFeeFingerprint, cashRiskModelFingerprint, ENTRY_CASH_RISK_VERSION } from './v13EntryCashRisk';
import { computeV13LiveMoneyPolicyHash, type V13ApprovedLiveMoneyPolicy } from './v13LiveMoneyRisk';
import { ENTRY_BUDGET_CHOICE_VERSION, entryBudgetTermsDigest } from './entryBudgetChoice';


export function fixture(grossCents = 50_000, allInCents = 62_500, controllingGross = 500_000, controllingAllIn = 625_000) {
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
