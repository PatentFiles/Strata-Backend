/** Fixed operational categories only. Never attach response fields or alter
 * the established refusal code, fee authority, fingerprints, or send fences. */
export const OWNED_FEE_UNVERIFIED = "production_event_fee_evidence_unverified";
export type OwnedFeeFailureStage =
  | "market_identity_before_event_read" | "market_identity" | "clock"
  | "event_identity" | "series_identity" | "series_fee_terms"
  | "event_fee_override" | "market_fee_fields" | "close_time"
  | "latest_expiration" | "optional_expiration" | "series_fee_schedule"
  | "event_fee_schedule" | "metadata_capture";

const diagnostics = new WeakMap<object, OwnedFeeFailureStage>();
export function ownedFeeFailure(stage: OwnedFeeFailureStage): Error {
  const error = new Error(OWNED_FEE_UNVERIFIED);
  diagnostics.set(error, stage);
  return error;
}
export function getOwnedFeeFailureStage(error: unknown): OwnedFeeFailureStage | undefined {
  return error !== null && typeof error === "object" ? diagnostics.get(error) : undefined;
}
