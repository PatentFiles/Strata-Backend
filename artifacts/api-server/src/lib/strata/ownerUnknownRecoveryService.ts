import {fenceOwnerUnknownForAccounting} from './ownerUnknownRecoveryFence';
import {createHeldUnknownAccountingRecovery} from './ownerUnknownRecoveryHeld';
import {OWNER_UNKNOWN_ACCOUNTING_CONFIRMATION,ownerUnknownEvidenceDigest} from './ownerUnknownRecoveryPlan';

export const OWNER_UNKNOWN_PROTECTION_ACKNOWLEDGMENT =
 'I_UNDERSTAND_KILL_HALTS_PROTECTIVE_AUTOMATION_AND_DOES_NOT_CANCEL_OR_LIQUIDATE';
export type UnknownRecoveryDependencies = Parameters<typeof createHeldUnknownAccountingRecovery>[0];
type Body = Record<string, unknown>;
const uuid = (x: unknown): x is string => typeof x === 'string' &&
 /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(x);
const fail = (reason: string) => ({ok:false,reason,ordersSubmitted:false,workerStarted:false,
 tradingAuthorized:false,riskFreezeCleared:false,accountingCommitted:false});
function fields(body: unknown, allowed: string[]): body is Body {
 return !!body && typeof body === 'object' && !Array.isArray(body) &&
  Object.keys(body).length === allowed.length && Object.keys(body).every(k => allowed.includes(k));
}
/** Trusted server composition only. No ambient DB, signer, provider or supervisor.
 * The owner comes exclusively from verified AAL2 middleware, never the body.
 * Fence and accounting are separate explicit actions, with no automatic retry.
 */
export function createOwnerUnknownRecoveryService(deps: UnknownRecoveryDependencies) {
 const recover = createHeldUnknownAccountingRecovery(deps);
 return {
  async fence(ownerId: string, body: unknown) {
   if (!uuid(ownerId) || !fields(body, ['targetIntentId','confirmation','protectiveAutomationAcknowledgment']) ||
    !uuid(body.targetIntentId) || body.confirmation !== OWNER_UNKNOWN_ACCOUNTING_CONFIRMATION ||
    body.protectiveAutomationAcknowledgment !== OWNER_UNKNOWN_PROTECTION_ACKNOWLEDGMENT)
    return fail('recovery_exact_fence_confirmation_required');
   return fenceOwnerUnknownForAccounting({ownerId,targetIntentId:body.targetIntentId,
    confirmation:body.confirmation},deps);
  },
  async reconcile(ownerId: string, body: unknown) {
   if (!uuid(ownerId) || !fields(body, ['targetIntentId','fenceReceiptId','confirmation']) ||
    !uuid(body.targetIntentId) || !uuid(body.fenceReceiptId) ||
    body.confirmation !== OWNER_UNKNOWN_ACCOUNTING_CONFIRMATION)
    return fail('recovery_exact_accounting_confirmation_required');
   return recover({ownerId,targetIntentId:body.targetIntentId,fenceReceiptId:body.fenceReceiptId,
    confirmation:body.confirmation});
  },
  async receipt(ownerId: string, receiptId: string) {
   if (!uuid(ownerId) || !uuid(receiptId)) return fail('recovery_receipt_identity_invalid');
   try {
    // One statement observes the committed receipt and present state in the same
    // MVCC snapshot. Absence is NOT proof that an uncertain transaction aborted.
    const result = await deps.db.query(`SELECT o.id,o.account_id,o.kind,o.payload,o.digest,o.observed_at,
     a.owner_user_id::text,a.revision::text,a.reserved_micros::text,a.kill_switch,a.execution_enabled,
     w.state AS lease_state,w.account_kill,w.arm_requested,w.fencing_token::text,
     i.id AS target_intent_id,i.state AS intent_state,i.terminal AS intent_terminal,
     i.reserved_micros::text AS intent_reserved_micros,
     NOT EXISTS(SELECT 1 FROM public.v13_production_position p WHERE p.account_id=a.id
      AND p.quantity_hundredths<>0) AS local_positions_flat,
     NOT EXISTS(SELECT 1 FROM public.v13_production_intent j WHERE j.account_id=a.id
      AND (NOT j.terminal OR j.state IN ('PREPARED','DISPATCHED','UNKNOWN') OR j.reserved_micros<>0)) AS local_history_terminal
     FROM public.v13_production_observation o
     JOIN public.v13_production_account a ON a.id=o.account_id AND a.owner_user_id=$1::uuid
     JOIN private.kalshi_account_worker_lease w ON w.execution_account_id=a.id AND w.owner_user_id=a.owner_user_id
     JOIN public.v13_production_intent i ON i.account_id=a.id AND i.id=o.payload->>'targetIntentId'
     WHERE o.id=$2 AND o.kind IN ('OWNER_UNKNOWN_ACCOUNTING_KILL_FENCE','OWNER_UNKNOWN_ACCOUNTING_RECONCILIATION')`,
     [ownerId,receiptId]);
    if (result.rows.length !== 1) return {...fail('recovery_receipt_not_observed'),accountingCommitted:null,outcomeUnknown:true,retryAuthorized:false};
    const r = result.rows[0]!, p = r.payload as Body;
    if (!p || typeof p !== 'object' || Array.isArray(p) || ownerUnknownEvidenceDigest(p) !== r.digest ||
     p.ownerId !== ownerId || p.accountId !== r.account_id || p.targetIntentId !== r.target_intent_id ||
     p.tradingAuthorized !== false) return {...fail('recovery_receipt_binding_invalid'),accountingCommitted:null,outcomeUnknown:true,retryAuthorized:false};
    const accounting = r.kind === 'OWNER_UNKNOWN_ACCOUNTING_RECONCILIATION';
    const uint = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(v);
    const digest = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
    const validPayload = accounting
     ? fields(p,['ownerId','accountId','targetIntentId','killReceiptId','priorRevision','fencingToken',
        'holdDigest','historyDigest','snapshotDigest','observedAtMs','tradingAuthorized','riskFreezeCleared']) &&
       uuid(p.killReceiptId) && uint(p.priorRevision) && uint(p.fencingToken) &&
       [p.holdDigest,p.historyDigest,p.snapshotDigest].every(digest) &&
       typeof p.observedAtMs === 'number' && Number.isSafeInteger(p.observedAtMs) && p.observedAtMs > 0 &&
       p.observedAtMs <= 8640000000000000 && p.riskFreezeCleared === false
     : fields(p,['ownerId','accountId','targetIntentId','priorToken','nextToken','priorRevision','nextRevision',
        'financialStateChanged','tradingAuthorized']) &&
       uint(p.priorToken) && uint(p.nextToken) && BigInt(p.nextToken) === BigInt(p.priorToken)+1n &&
       uint(p.priorRevision) && uint(p.nextRevision) && BigInt(p.nextRevision) === BigInt(p.priorRevision)+1n &&
       p.financialStateChanged === false;
    if (!validPayload || r.id !== receiptId || r.owner_user_id !== ownerId || !uuid(r.target_intent_id))
     return {...fail('recovery_receipt_binding_invalid'),accountingCommitted:null,outcomeUnknown:true,retryAuthorized:false};
    const token = accounting ? p.fencingToken : p.nextToken;
    const expectedRevision = accounting ? (BigInt(p.priorRevision as string)+1n).toString() : p.nextRevision;
    const unchanged = r.revision === expectedRevision && r.fencing_token === token;
    const killed = r.kill_switch === true && r.execution_enabled === false && r.lease_state === 'killed' &&
     r.account_kill === true && r.arm_requested === false && deps.isScheduled(ownerId,String(r.account_id)) === false;
    const terminalFlat = r.intent_terminal === true && r.intent_reserved_micros === '0' &&
     r.reserved_micros === '0' && r.local_positions_flat === true && r.local_history_terminal === true;
    const fenceTargetUnresolved = r.intent_state === 'UNKNOWN' && r.intent_terminal === false &&
     uint(r.intent_reserved_micros) && BigInt(r.intent_reserved_micros)>0n;
    const currentVerified = unchanged && killed && (accounting ? terminalFlat : fenceTargetUnresolved);
    return {ok:currentVerified,reason:currentVerified ? 'recovery_committed_receipt_observed' :
      'recovery_receipt_current_state_changed',receiptId,accountId:r.account_id,
     targetIntentId:r.target_intent_id,receiptKind:r.kind,observedAt:r.observed_at,
     receiptCommitted:true,accountingCommitted:accounting,outcomeUnknown:false,retryAuthorized:false,
     currentStateMatchesReceipt:unchanged,executionRemainsKilled:killed,
     localAccountingTerminalAndFlat:terminalFlat,ordersSubmitted:false,workerStarted:false,
     tradingAuthorized:false,riskFreezeCleared:false};
   } catch { return {...fail('recovery_receipt_read_unavailable'),accountingCommitted:null,outcomeUnknown:true,retryAuthorized:false}; }
  },
 };
}
export type OwnerUnknownRecoveryPort = ReturnType<typeof createOwnerUnknownRecoveryService>;
