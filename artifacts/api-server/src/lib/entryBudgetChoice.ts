import { createHash } from 'node:crypto';
import { preflightV13LiveMoneyEntry, type V13LiveMoneyEntryPreflightInput } from './v13LiveMoneyEntryPreflight';
import { computeV13LiveMoneyPolicyHash, V13_MAX_ENTRY_STAKE_CENTS, V13_MIN_ENTRY_STAKE_CENTS } from './v13LiveMoneyRisk';

/** Offline, inactive contract. Neither this module nor its result can submit or approve an order. */
export const WALLET_ENTRY_BUDGET_LADDER = Object.freeze([500,1500,2500,5000,10000,15000,20000,25000,50000] as const);
export const ENTRY_BUDGET_CHOICE_VERSION = 'V13_ENTRY_BUDGET_CHOICE_V1' as const;

type Scope = Readonly<{
  ownerId: string;
  accountId: string;
  credentialFingerprint: string;
  releaseSha: string;
  policyHash: string;
  policyRevision: number;
  stakeRevision: number;
  feeApprovalId: string;
  feeApprovalDigest: string;
}>;

type Terms = Readonly<{
  version: typeof ENTRY_BUDGET_CHOICE_VERSION;
  choiceId: string;
  choiceRevision: number;
  scope: Scope;
  grossCents: number;
  allInCents: number;
}>;

export type EntryBudgetChoice = Terms & Readonly<{ approvalDigest: string }>;
export type VerifiedBudgetApproval = Readonly<{
  approvalDigest: string;
  scope: Scope;
  approvedAtMs: number;
  expiresAtMs: number;
  revokedAtMs: number | null;
}>;

export type VerifiedFeeApproval = Readonly<{
  scope: Scope;
  policyVersion: string;
  sourceUrl: string;
  formulaVersion: string;
  feeArtifactDigest: string;
  verifiedAtMs: number;
  expiresAtMs: number;
  revokedAtMs: number | null;
}>;

const sha256 = (v: string) => /^[a-f0-9]{64}$/.test(v);
const sha40 = (v: string) => /^[a-f0-9]{40}$/.test(v);
const id = (v: string) => /^[A-Za-z0-9._:-]{1,128}$/.test(v);
const pos = (v: number) => Number.isSafeInteger(v) && v > 0;
const clock = (v: number) => Number.isSafeInteger(v) && v >= 0;
const scopeWire = (s: Scope) => [
  s.ownerId, s.accountId, s.credentialFingerprint, s.releaseSha, s.policyHash, s.policyRevision,
  s.stakeRevision, s.feeApprovalId, s.feeApprovalDigest,
];
const sameScope = (a: Scope, b: Scope) => JSON.stringify(scopeWire(a)) === JSON.stringify(scopeWire(b));
const validScope = (s: Scope) =>
  id(s.ownerId) && id(s.accountId) && sha256(s.credentialFingerprint) && sha40(s.releaseSha) &&
  sha256(s.policyHash) && pos(s.policyRevision) && pos(s.stakeRevision) &&
  id(s.feeApprovalId) && sha256(s.feeApprovalDigest);
const validWindow = (start: number, expiry: number, revoked: number | null, now: number) =>
  clock(now) && clock(start) && clock(expiry) && start <= now && now < expiry && revoked === null;

/** Digest for matching a separately persisted trusted approval. This is not a signature or consent. */
export function entryBudgetTermsDigest(t: Terms): string {
  return createHash('sha256').update(JSON.stringify([
    t.version, t.choiceId, t.choiceRevision, scopeWire(t.scope), t.grossCents, t.allInCents,
  ])).digest('hex');
}

export type OfflineBudgetPreviewInput = Readonly<{
  requestedChoice: Readonly<{ choiceId: string; choiceRevision: number }>;
  currentScope: Scope;
  currentConfiguredGrossCents: number;
  choice: EntryBudgetChoice;
  trustedBudgetApproval: VerifiedBudgetApproval;
  trustedFeeApproval: VerifiedFeeApproval;
  preflight: V13LiveMoneyEntryPreflightInput;
}>;

export type OfflineBudgetPreview = Readonly<{
  ok: true;
  previewOnly: true;
  choiceId: string;
  choiceRevision: number;
  grossCents: number;
  allInCents: number;
  requestedContracts: number;
  modeledGrossCents: number;
  modeledAllInCents: number;
}> | Readonly<{ ok: false; reason: string }>;

/**
 * All records except the choice reference must be obtained from authenticated server-side readers
 * for the same snapshot. Never populate the trusted inputs from a client payload. Until those readers,
 * immutability, transactional revocation checks and final-wire binding exist, do not mount this helper.
 */
function verifyBudgetTerms(x: OfflineBudgetPreviewInput): {ok:true} | {ok:false;reason:string} {
  const p = x.preflight.policy, c = x.choice, f = x.trustedFeeApproval;
  const reject = (reason: string) => ({ ok: false as const, reason });
  if (Object.hasOwn(x.preflight, 'configuredStakeCents') &&
      x.preflight.configuredStakeCents !== x.currentConfiguredGrossCents) {
    return reject('configured_stake_scope_mismatch');
  }
  if (!validScope(x.currentScope) || p.state !== 'APPROVED' ||
      p.policyHash !== x.currentScope.policyHash || p.version !== x.currentScope.policyRevision ||
      computeV13LiveMoneyPolicyHash(p) !== p.policyHash ||
      !sameScope(c.scope, x.currentScope) || !sameScope(f.scope, x.currentScope) ||
      !sameScope(x.trustedBudgetApproval.scope, x.currentScope)) {
    return reject('budget_scope_mismatch');
  }
  if (c.version !== ENTRY_BUDGET_CHOICE_VERSION || !id(c.choiceId) || !pos(c.choiceRevision) ||
      x.requestedChoice.choiceId !== c.choiceId || x.requestedChoice.choiceRevision !== c.choiceRevision ||
      !sha256(c.approvalDigest) || entryBudgetTermsDigest(c) !== c.approvalDigest ||
      c.approvalDigest !== x.trustedBudgetApproval.approvalDigest ||
      !validWindow(x.trustedBudgetApproval.approvedAtMs, x.trustedBudgetApproval.expiresAtMs,
        x.trustedBudgetApproval.revokedAtMs, x.preflight.nowMs)) {
    return reject('budget_approval_unavailable');
  }
  if (!validWindow(f.verifiedAtMs, f.expiresAtMs, f.revokedAtMs, x.preflight.nowMs) ||
      f.policyVersion !== p.feePolicyVersion || f.sourceUrl !== p.feeSourceUrl || f.formulaVersion !== p.feeFormulaVersion ||
      x.preflight.feeEvidence.policyVersion !== f.policyVersion || x.preflight.feeEvidence.formulaVersion !== f.formulaVersion ||
      x.preflight.feeEvidence.sourceUrl !== f.sourceUrl ||
      !sha256(f.feeArtifactDigest) || x.preflight.feeEvidence.cashRisk?.artifactDigest !== f.feeArtifactDigest ||
      x.preflight.feeEvidence.cashRisk?.policyHash !== p.policyHash) {
    return reject('budget_fee_approval_unavailable');
  }
  if (!pos(x.currentConfiguredGrossCents) || x.currentConfiguredGrossCents > p.maxEntryStakeCents ||
      !pos(c.grossCents) || c.grossCents < V13_MIN_ENTRY_STAKE_CENTS || c.grossCents > V13_MAX_ENTRY_STAKE_CENTS ||
      c.grossCents > x.currentConfiguredGrossCents ||
      !pos(c.allInCents) || c.allInCents < c.grossCents ||
      c.allInCents > p.maxEntryAllInCents || c.allInCents > p.capitalLimitCents) {
    return reject('budget_outside_approved_envelope');
  }
  return {ok:true};
}

export function previewApprovedEntryBudget(x: OfflineBudgetPreviewInput): OfflineBudgetPreview {
  const terms = verifyBudgetTerms(x);
  if (!terms.ok) return terms;
  const c = x.choice;
  const reject = (reason: string): OfflineBudgetPreview => ({ ok: false, reason });
  // Pure preview: clipping a budget input cannot increase risk, does not rewrite the policy,
  // and does not claim that the underlying available capital has changed.
  const result = preflightV13LiveMoneyEntry({
    ...x.preflight,
    requireCashRisk: true,
    configuredStakeCents: c.grossCents,
    capitalRemainingCents: Math.min(x.preflight.capitalRemainingCents, c.allInCents),
  });
  if (!result.ok) return reject(result.reason);
  if (!result.cashRisk || result.plannedAllInCents > c.allInCents || result.plan.worstCaseGrossCents > c.grossCents) {
    return reject('budget_planner_exceeds_approved_choice');
  }
  return Object.freeze({
    ok: true, previewOnly: true, choiceId: c.choiceId, choiceRevision: c.choiceRevision,
    grossCents: c.grossCents, allInCents: c.allInCents,
    requestedContracts: result.plan.contracts, modeledGrossCents: result.plan.worstCaseGrossCents,
    modeledAllInCents: result.plannedAllInCents,
  });
}

// Staging-only display; neither sets nor recommends a funding amount. The full
// approved reservation is a ceiling, not the native minimum for a smaller fill.
export function describeApprovedEntryBudgetFunding(x: OfflineBudgetPreviewInput) {
  if (!verifyBudgetTerms(x).ok) return null;
  const i = x.preflight, p = i.policy, full = x.choice.allInCents;
  const amounts = [p.capitalLimitCents, i.capitalRemainingCents, i.availableCashCents,
    p.maxDailyLossCents, p.maxTotalLossCents, i.realizedDailyLossCents, i.realizedTotalLossCents,
    p.maxOpenPositions, i.openPositions];
  if (!amounts.every(v => Number.isSafeInteger(v) && v >= 0) ||
      i.capitalRemainingCents > p.capitalLimitCents || p.maxOpenPositions < 1) return null;
  const capitalAlreadyCountedCents = p.capitalLimitCents - i.capitalRemainingCents;
  const policyCapitalForFullReservationCents = capitalAlreadyCountedCents + full;
  const policyDailyLossForFullReservationCents=i.realizedDailyLossCents+full;
  const policyTotalLossForFullReservationCents=i.realizedTotalLossCents+full;
  if (![policyCapitalForFullReservationCents,policyDailyLossForFullReservationCents,
    policyTotalLossForFullReservationCents].every(Number.isSafeInteger)) return null;
  const headroom = {
    unreservedCashCents:i.availableCashCents,
    remainingCapitalCents:i.capitalRemainingCents,
    remainingDailyLossCents:Math.max(0,p.maxDailyLossCents-i.realizedDailyLossCents),
    remainingTotalLossCents:Math.max(0,p.maxTotalLossCents-i.realizedTotalLossCents),
  };
  const shortfalls = {
    cashCents:Math.max(0,full-headroom.unreservedCashCents),
    capitalCents:Math.max(0,full-headroom.remainingCapitalCents),
    dailyLossCents:Math.max(0,full-headroom.remainingDailyLossCents),
    totalLossCents:Math.max(0,full-headroom.remainingTotalLossCents),
  };
  return {
    fullReservationCents:full, policyCapitalLimitCents:p.capitalLimitCents,
    policyCapitalForFullReservationCents, headroom, shortfalls,
    policyDailyLossLimitCents:p.maxDailyLossCents,policyTotalLossLimitCents:p.maxTotalLossCents,
    realizedDailyLossCents:i.realizedDailyLossCents,realizedTotalLossCents:i.realizedTotalLossCents,
    policyDailyLossForFullReservationCents,policyTotalLossForFullReservationCents,
    positionSlotAvailable:i.openPositions<p.maxOpenPositions,
  };
}
