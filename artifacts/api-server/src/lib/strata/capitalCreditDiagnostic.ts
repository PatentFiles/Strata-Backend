import {KalshiApiError} from '../kalshiAccountClient';
/** Fixed identifiers only. Never provider text/body, SQL, receipt/account values,
 * credential material, request URLs, headers, or stack traces. */
export const CAPITAL_STAGES=['preview','local_ledger','retained_history','restricted_signer','transfer_signer','locked_signers','signed_trade_history','transfer_history','receipt_registry','locked_scope','final_ledger','apply','commit'] as const;
export type CapitalStage=typeof CAPITAL_STAGES[number];
const stages=new Set<string>(CAPITAL_STAGES);
const sqlStates=new Set(['55P03','57014','40P01','40001','42501','42P01','42703','42883','23503','23505','23514','25P02','08000','08003','08006','08001','08004','08P01']);
const providerTypes=new Set(['NOT_CONFIGURED','INVALID_CREDENTIALS','NETWORK_ERROR','HTTP_ERROR','INVALID_JSON','INVALID_RESPONSE']);
const httpStatuses=new Set([400,401,403,404,408,409,422,429,500,502,503,504]);
const publicCodes=new Set(['capital_transfer_signer_scope_unverified','capital_transfer_signer_unavailable','capital_transfer_signer_fingerprint_mismatch','capital_account_cas_failed','capital_account_or_history_changed','capital_account_scope_unverified','capital_attempt_not_pending','capital_checkpoint_ledger_not_conserved','capital_checkpoint_missing_or_ambiguous','capital_checkpoint_unverified','capital_claim_unknown','capital_commit_unknown','capital_credit_recorded','capital_credit_refused','capital_existing_attempt_requires_readback','capital_explicit_scope_consent_required','capital_finalization_unknown','capital_open_exposure','capital_owner_canceled_exact_repair','capital_owner_scope_unavailable','capital_pending_repair_canceled_or_refused','capital_policy_unverified','capital_preview_scope_changed','capital_production_override_forbidden','capital_receipt_already_registered','capital_receipt_does_not_explain_cash','capital_receipt_write_failed','capital_rollback_unknown','capital_scope_changed','capital_signed_evidence_expired','capital_signed_evidence_unavailable_or_stale','capital_signed_history_unverified','capital_signer_changed','capital_signer_unavailable','capital_stopped_account_required','capital_stopped_worker_required','capital_transfer_checkpoint_boundary_ambiguous','capital_transfer_history_bound_exceeded','capital_transfer_page_unverified','capital_transfer_pagination_unverified','capital_transfer_receipt_unverified','capital_transfer_unique_inbound_required','capital_verified_provider_receipt_recorded']);
const internalCodes=new Set(['release_history_bound_exceeded','financial_intent_unreadable','release_history_client_identity_ambiguous','release_never_posted_financial_event_conflict','release_never_posted_evidence_invalid_or_contradictory','production_money_conservation_failed','production_final_account_changed_or_unproven','production_final_history_gap','production_final_order_changed','production_final_unreconciled_fill','production_final_unreconciled_settlement','production_final_position_changed']);
export type CapitalDiagnostic={stage:CapitalStage;failureCode:string;sqlState?:string;providerType?:string;providerStatus?:number};
class CapitalStageFailure extends Error{constructor(readonly diagnostic:CapitalDiagnostic){super(publicCodes.has(diagnostic.failureCode)?diagnostic.failureCode:'capital_credit_refused');Object.freeze(diagnostic);}}
export function capitalFailureDiagnostic(error:unknown,fallback:CapitalStage):CapitalDiagnostic{
 const stage=stages.has(fallback)?fallback:'preview';
 try{
  if(error instanceof CapitalStageFailure)return {...error.diagnostic};
  const e=error&&typeof error==='object'?error as {message?:unknown;code?:unknown}:{};
  const message=e.message,code=e.code;
  const result:CapitalDiagnostic={stage,failureCode:typeof message==='string'&&(internalCodes.has(message)||publicCodes.has(message))?message:'capital_internal_failure'};
  if(typeof code==='string'&&sqlStates.has(code))result.sqlState=code;
  if(error instanceof KalshiApiError){const type=error.type,status=error.status;if(providerTypes.has(type))result.providerType=type;if(typeof status==='number'&&httpStatuses.has(status))result.providerStatus=status;result.failureCode='capital_provider_read_failed';}
  return result;
 }catch{return {stage,failureCode:'capital_internal_failure'};}
}
export async function capitalStage<T>(stage:CapitalStage,work:()=>Promise<T>):Promise<T>{
 try{return await work();}catch(error){
  throw new CapitalStageFailure(capitalFailureDiagnostic(error,stage));
 }
}
export function logCapitalFailure(error:unknown,stage:CapitalStage){const diagnostic=capitalFailureDiagnostic(error,stage);try{console.warn('capital_credit_failed',diagnostic);}catch{}return diagnostic;}

export function capitalPublicReason(error:unknown){try{const message=error instanceof Error?error.message:undefined;return typeof message==='string'&&publicCodes.has(message)?message:'capital_credit_refused';}catch{return 'capital_credit_refused';}}
