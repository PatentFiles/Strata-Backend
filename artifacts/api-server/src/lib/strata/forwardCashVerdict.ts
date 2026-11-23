/** Current-only projection. No e7 provider port can certify pending cash completeness. */
export function forwardCashVerdict(input:unknown){
 const b=input&&typeof input==='object'?input as Record<string,unknown>:null;
 const balanceMatchesLocal=b?.status==='balance_matches_local_cash_history_unverified'?true:
  b?.status==='balance_differs_from_local_cash_history_unverified'?false:null;
 const at=b?.observedAt;
 const verified=balanceMatchesLocal!==null&&typeof at==='string'&&Number.isFinite(Date.parse(at))&&
  new Date(Date.parse(at)).toISOString()===at;
 return {ok:false as const,status:'forward_only_unverified' as const,
  reason:verified?'pending_cash_and_exchange_exposure_completeness_unverified':'authenticated_current_data_unverified',
  observedAt:verified?at:null,balanceMatchesLocal:verified?balanceMatchesLocal:null,
  stoppedLocalScopeVerified:verified,pendingCashCompletenessVerified:false as const,
  authenticatedExchangeFlat:false as const,historyReplayed:false as const,holdCleared:false as const,
  accountWritesPerformed:false as const,observationPersisted:false as const,
  ordersSubmitted:false as const,tradingAuthorized:false as const};
}
