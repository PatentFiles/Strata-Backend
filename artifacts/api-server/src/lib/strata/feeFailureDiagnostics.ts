/** Whitelisted, immutable diagnostics only. Never read/serialize raw errors,
 * URLs, bodies, headers, credentials or grant identifiers. No trading authority. */
const phases=new Set(["provider_transport","provider_validation","candidate_validation","authorization","database"]);
const reasons=new Set([
 "provider_http_rejected","provider_response_invalid","provider_request_failed","provider_read_timeout","provider_cooldown",
 "exact_market_identity_invalid","exact_market_detail_not_current","market_event_identity_invalid","market_target_ambiguous",
 "market_listing_incomplete","market_listing_empty","no_current_open_kxbtc15m_market","exact_market_not_in_complete_open_listing","series_event_fee_mismatch",
 "market_or_event_fee_override_unreviewed","market_lifecycle_unverified","fee_change_schedule_unverified","market_fee_evidence_stale","official_api_metadata_unavailable",
 "fee_reference_vectors_invalid","observation_clock_invalid","live_api_fee_source_not_verified","live_api_fee_source_identity_invalid","live_api_fee_observation_stale",
 "api_fee_owner_or_stage_invalid","exact_order_market_required","api_fee_source_url_invalid","api_fee_order_market_mismatch",
 "api_fee_database_review_unavailable","api_fee_independent_reviews_missing_or_ambiguous","api_fee_source_identity_mismatch",
 "api_fee_grant_missing_invalid_or_expired","api_fee_observation_not_verified","api_fee_observation_stale_or_wrong_market",
 "api_fee_owner_consent_missing_or_revoked","api_fee_owner_or_clock_invalid","api_fee_technical_admin_review_missing_or_ambiguous",
 "standing_fee_stage_identity_invalid","standing_model_consent_or_live_policy_missing","standing_fee_lease_unavailable",
]);
function endpoint(path:unknown):string|null {
 if(typeof path!=="string")return null;
 if(/^\/markets\?series_ticker=KXBTC15M&status=open&limit=100(?:&cursor=[^&]*)?$/.test(path))return "markets_listing";
 if(/^\/markets\/KXBTC15M-[A-Za-z0-9-]+$/.test(path))return "market_detail";
 if(path==="/series/KXBTC15M")return "series_detail";
 if(path==="/series/fee_changes?series_ticker=KXBTC15M&show_historical=false")return "series_fee_changes";
 if(/^\/events\/KXBTC15M-[A-Za-z0-9-]+$/.test(path))return "event_detail";
 if(/^\/events\/fee_changes\?event_ticker=KXBTC15M-[A-Za-z0-9-]+&limit=100$/.test(path))return "event_fee_changes";
 return null;
}
export type FeeFailureDiagnostics=Readonly<{version:1;phase:string;reason:string;endpoint:string|null;httpStatus:number|null}>;
const captured=new WeakMap<object,FeeFailureDiagnostics>();
export function getFeeFailureDiagnostics(value:unknown):FeeFailureDiagnostics|undefined {
 return value!==null&&(typeof value==="object"||typeof value==="function")?captured.get(value):undefined;
}
export function annotateFeeFailure<T extends object>(target:T,
 details:{phase:string;reason:string;path?:string;httpStatus?:number},source?:unknown):T {
 try {
  const inherited=getFeeFailureDiagnostics(source);
  const diagnostic=inherited??Object.freeze({version:1 as const,
   phase:phases.has(details.phase)?details.phase:"unknown",
   reason:reasons.has(details.reason)?details.reason:"fee_failure_unclassified",
   endpoint:endpoint(details.path),
   httpStatus:Number.isInteger(details.httpStatus)&&details.httpStatus!>=100&&details.httpStatus!<=599?details.httpStatus!:null});
  captured.set(target,diagnostic);
 }catch{/* Optional diagnostics cannot change the returned decision/error. */}
 return target;
}
