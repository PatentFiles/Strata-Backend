export const PREPARED_BOUNDED_RUN_CAP_MICROS = 5_000_000;
export const ARCHIVABLE_UNUSED_RUN_CAP_MICROS = [1_000_000, PREPARED_BOUNDED_RUN_CAP_MICROS] as const;

export type FrozenUnusedRunSnapshot = {
  phase: string;
  runId: string | null;
  requestedPriorRunId: string;
  freezeReason: string | null;
  armedAt: Date | null;
  approvalId: string | null;
  approvalDigest: string | null;
  capMicros: number;
  reservedMicros: number;
  entryAttempted: boolean;
  exitAttempted: boolean;
  accountMode: string | null;
  selectedSubaccount: number | null;
  selectedExchangeIndex?: number | null;
  restrictedApiKeyId?: string | null;
  restrictedKeyFingerprint?: string | null;
  fundingAnchor?: {
    subaccountNumber: number | null;
    exchangeIndex: number | null;
    transferId: string | null;
    transferAt: Date | null;
    amountCents: number | null;
  } | null;
  pairCashBaseline?: {
    subaccountNumber: number | null;
    exchangeIndex: number | null;
    runId: string | null;
    availableCashMicros: string | null;
    capturedAt: Date | null;
    evidenceDigest: string | null;
  } | null;
  activityCheckpoint?: {
    subaccountNumber: number | null;
    exchangeIndex: number | null;
    runId: string | null;
    cursor: string | null;
    capturedAt: Date | null;
    evidenceDigest: string | null;
  } | null;
  accountingUnresolved: boolean;
  databaseMicroLiveEnabled: boolean;
  databaseExecutionEnabled: boolean;
  killSwitchOn: boolean;
  bindingMatches: boolean;
  orderCount: number;
  fillCount: number;
  settlementCount: number;
};

/** A frozen, audited unused run can be archived without waiting for a clock. */
export function frozenUnusedRunBlockReason(snapshot: FrozenUnusedRunSnapshot): string | null {
  if (snapshot.phase !== "FROZEN") return "bounded_run_not_frozen";
  if (!snapshot.runId || snapshot.runId !== snapshot.requestedPriorRunId) {
    return "bounded_run_identity_changed";
  }
  if (!snapshot.armedAt) return "bounded_run_armed_at_missing";
  if (!snapshot.freezeReason?.trim()) return "bounded_run_freeze_reason_missing";
  if (snapshot.freezeReason !== "entry_expired_without_proven_terminal_position" &&
      snapshot.freezeReason !== "operator_froze_unused_run_for_reviewed_transition") {
    return "bounded_run_freeze_reason_not_eligible";
  }
  if (!snapshot.approvalId || !snapshot.approvalDigest) {
    return "bounded_run_original_approval_missing";
  }
  if (!(ARCHIVABLE_UNUSED_RUN_CAP_MICROS as readonly number[]).includes(snapshot.capMicros)) {
    return "bounded_run_original_cap_not_supported";
  }
  if (snapshot.entryAttempted || snapshot.exitAttempted || snapshot.reservedMicros !== 0) {
    return "bounded_run_attempt_or_reservation_exists";
  }
  if (snapshot.orderCount !== 0 || snapshot.fillCount !== 0 || snapshot.settlementCount !== 0) {
    return "bounded_run_ledger_not_empty";
  }
  const legacyPrimaryIdentity = snapshot.accountMode === "primary_nonexclusive" &&
    snapshot.selectedSubaccount === 0 &&
    (snapshot.selectedExchangeIndex === undefined || snapshot.selectedExchangeIndex === null);
  const pair = snapshot.accountMode === "exclusive" &&
    Number.isSafeInteger(snapshot.selectedSubaccount) &&
    snapshot.selectedSubaccount !== null &&
    snapshot.selectedSubaccount >= 1 && snapshot.selectedSubaccount <= 63 &&
    snapshot.selectedExchangeIndex === 2;
  if (!legacyPrimaryIdentity && !pair) return "account_mode_or_pair_changed";
  if (!snapshot.bindingMatches) return "account_mode_or_pair_changed";
  if (pair) {
    const n = snapshot.selectedSubaccount!;
    const baseline = snapshot.pairCashBaseline;
    const funding = snapshot.fundingAnchor;
    const checkpoint = snapshot.activityCheckpoint;
    if (!snapshot.restrictedApiKeyId?.trim() ||
        !snapshot.restrictedKeyFingerprint ||
        !/^[0-9a-f]{64}$/.test(snapshot.restrictedKeyFingerprint) ||
        !funding || funding.subaccountNumber !== n || funding.exchangeIndex !== 2 ||
        !funding.transferId?.trim() || !funding.transferAt ||
        funding.amountCents !== 2500 ||
        !baseline || baseline.subaccountNumber !== n || baseline.exchangeIndex !== 2 ||
        baseline.runId !== snapshot.runId ||
        baseline.availableCashMicros !== "25000000" || !baseline.capturedAt ||
        !baseline.evidenceDigest || !/^[0-9a-f]{64}$/.test(baseline.evidenceDigest) ||
        !checkpoint || checkpoint.subaccountNumber !== n ||
        checkpoint.exchangeIndex !== 2 || checkpoint.runId !== snapshot.runId ||
        !checkpoint.cursor?.trim() || !checkpoint.capturedAt ||
        !checkpoint.evidenceDigest || !/^[0-9a-f]{64}$/.test(checkpoint.evidenceDigest)) {
      return "dedicated_pair_identity_unproven";
    }
  }
  if (snapshot.accountingUnresolved) return "primary_accounting_unresolved";
  if (snapshot.databaseMicroLiveEnabled || snapshot.databaseExecutionEnabled ||
      !snapshot.killSwitchOn) return "new_run_requires_frozen_database_gates";
  return null;
}