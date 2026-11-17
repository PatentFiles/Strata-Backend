/** Non-authorizing diagnostics. Never include provider text, SQL, credentials or stack traces. */
export const OWNER_ACTIVATION_STAGES = ['outcome_readback','owner_scope','fee_preflight','signed_evidence','transaction_begin','deadline_guard','locked_scope','locked_owner_scope','locked_history','account_checks','owner_review','locked_fee','grant_check','ledger_proof','sha_approval','lease_release','account_enable','audit_write','precommit_freshness','commit'] as const;
export type OwnerActivationStage = typeof OWNER_ACTIVATION_STAGES[number];
const SAFE_FAILURE_CODES = new Set([
 'release_owner_scope_unverified','release_scope_unverified','release_reserved_cash_unverified',
 'release_worker_lease_not_unique','release_worker_binding_unverified','release_stopped_disarmed_scope_required',
 'release_absent_lease_fence_unverified','release_history_bound_exceeded','financial_intent_unreadable',
 'release_history_client_identity_ambiguous','release_never_posted_financial_event_conflict',
 'release_never_posted_evidence_invalid_or_contradictory','owner_renewal_reconciled_history_unverified',
 'release_empty_history_financial_records_present','release_empty_history_signed_exposure',
 'release_signer_unverified','release_complete_signed_evidence_required','release_signed_scope_cash_unverified',
 'release_empty_history_signed_activity','release_signed_evidence_stale',
 'production_money_conservation_failed','production_final_account_changed_or_unproven','production_final_history_gap',
 'production_final_order_changed','production_final_unreconciled_fill',
 'production_final_unreconciled_settlement','production_final_position_changed'
]);
const SAFE_SQLSTATES = new Set(['55P03','57014','40P01','40001','42501','42P01','42703','42883','23503','23505','23514','25P02','08000','08003','08006','08001','08004','08P01']);
export function ownerActivationFailureDiagnostic(error: unknown, stage: OwnerActivationStage) {
 try{
 const e = error && typeof error === 'object' ? error as {message?:unknown;code?:unknown} : {};
 const message = e.message;
 const code = e.code;
 return { stage, failureCode: typeof message === 'string' && SAFE_FAILURE_CODES.has(message) ? message : 'activation_internal_failure',
  ...(typeof code === 'string' && SAFE_SQLSTATES.has(code) ? {sqlState:code} : {}) };
 }catch{return {stage,failureCode:'activation_internal_failure'};}
}
