/** Real HTTP admission boundary, deliberately no DB/provider/laboratory imports.
 * This is not a production release implementation. Never replace missing
 * qualification with caller-provided flags or independent-review impersonation.
 */
export const OWNER_ONLY_RECOVERY_CONFIRMATION='Recover my stopped account without an independent reviewer. Do not ARM or START trading.';
const blockers=Object.freeze(['protected_release_assurance_issuer_not_configured','actual_writer_barrier_unqualified','current_production_evidence_unverified']);
export function ownerOnlyRecoveryAdmission(ownerId:string,body:unknown){
 const deny=(reason:string,extra:Record<string,unknown>={})=>({ok:false as const,reason,released:false,tradingAuthorized:false,workerStarted:false,armed:false,stateChanged:false,independentHumanReview:false,...extra});
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
 if(!uuid.test(ownerId))return deny('authenticated_owner_required');
 if(!body||typeof body!=='object'||Array.isArray(body))return deny('exact_owner_recovery_request_required');
 const b=body as Record<string,unknown>;
 if(Object.keys(b).length!==2||Object.keys(b).some(k=>!['requestId','confirmation'].includes(k))||typeof b.requestId!=='string'||!uuid.test(b.requestId)||b.confirmation!==OWNER_ONLY_RECOVERY_CONFIRMATION)return deny('exact_owner_recovery_request_required');
 // Do not touch account state or return ready while these are absent. The
 // disposable atomic composition is intentionally not imported by this module.
 return deny('owner_only_recovery_not_qualified',{blockers:[...blockers],retryAuthorized:false});
}
