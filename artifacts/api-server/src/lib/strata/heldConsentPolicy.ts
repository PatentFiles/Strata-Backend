/** Consent is a receipt, never an account/worker control transition. */
export const HELD_CONSENT_CONFIRM='I_RECORD_EXACT_SHA_OWNER_CONSENT_WHILE_MY_ACCOUNT_REMAINS_DISABLED_AND_KILLED';
export type ConsentRow=Record<string,unknown>;
export function heldConsentScope(row:ConsentRow){
 return row.execution_enabled===false&&row.kill_switch===true&&row.worker_state==='killed'&&
  row.arm_requested===false&&row.worker_kill===true&&row.blocked_reason===null&&
  row.commissioned===true&&row.cash_precision_verified===true&&String(row.reserved_micros)==='0';
}
export function exactConsentReceipt(rows:ConsentRow[],qualification:string){
 if(rows.length>1)return 'AMBIGUOUS' as const;
 if(rows.length===0)return 'NOT_OBSERVED' as const;
 const row=rows[0]!;
 if(row.revoked_at!=null)return 'REVOKED' as const;
 return row.qualification_id===qualification?'RECORDED':'DIFFERENT_QUALIFICATION';
}
export const HELD_CONSENT_RESULT={ok:true as const,reason:'owner_consent_recorded_account_still_held',
 accountEnabled:false as const,tradingAuthorized:false as const,ordersSubmitted:false as const,
 independentReleaseRequired:true as const};
