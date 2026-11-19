/** Explicit unmounted loader for the offline stopped-cash diagnostic. All
 * application queries run under read-only REPEATABLE READ. Quota remains the
 * separate existing provider adapter and is not part of either DB snapshot. */
import {digest,type Request} from '../v13-production/types';
import {dedicatedSignerFingerprint} from './commissioning';
import {loadedMaterial} from './inAppProtectiveRelease';
import {readNeverPostedReleaseHistory} from './neverPostedReleaseHistory';
import {OWNER_SIGNED_PROOF_ACCOUNT_SQL} from './ownerSignedExchangeReleaseProof';
import {readStoppedCashDatabaseLeg,type QueryOnly} from './stoppedCashDiagnosticAdapters';
import type {StoppedCashDiagnosticHeld} from './stoppedCashDiagnosticPrototype';

const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const FP=/^[a-f0-9]{64}$/;
const BAD_FREEZE='production_external_cash_mismatch';
const NUM=/^(0|[1-9][0-9]{0,18})$/;
const AMOUNT=/^(0|-?[1-9][0-9]{0,18})$/;
const SHA=/^[a-f0-9]{40}$/;
type Options={connect:Parameters<typeof readStoppedCashDatabaseLeg>[0];
 releaseSha:()=>string;isScheduled:(owner:string,account:string)=>boolean};

export const STOPPED_CASH_DIAGNOSTIC_SCOPE_SQL=`
WITH scoped AS (${OWNER_SIGNED_PROOF_ACCOUNT_SQL})
SELECT s.*,a.initial_cash_micros::text,a.cash_micros::text AS cash_micros_text,a.reserved_micros::text AS reserved_micros_text,a.execution_enabled,
 w.state AS lease_state,w.arm_requested,w.account_kill AS lease_account_kill,w.credential_fingerprint AS lease_credential_fingerprint,
 EXISTS(SELECT 1 FROM public.v13_production_position p WHERE p.account_id=a.id AND p.quantity_hundredths<>0) AS position_exists
FROM scoped s JOIN public.v13_production_account a ON a.id=s.id
JOIN private.kalshi_account_worker_lease w ON w.execution_account_id=s.id AND w.owner_user_id=a.owner_user_id
LIMIT 2`;

export const STOPPED_CASH_DIAGNOSTIC_LEDGER_SQL=`
SELECT
 (SELECT count(*) FROM public.v13_production_position p
   WHERE p.account_id=$1 AND p.quantity_hundredths<>0)::text AS open_positions,
 (SELECT coalesce(sum(p.basis_micros),0) FROM public.v13_production_position p WHERE p.account_id=$1)::text AS basis,
 (SELECT coalesce(sum(p.realized_pnl_micros),0) FROM public.v13_production_position p WHERE p.account_id=$1)::text AS position_pnl,
 e.event_id,e.digest,e.cash_delta_micros::text,e.pnl_micros::text,e.xmin::text AS row_revision
FROM (SELECT 1) anchor LEFT JOIN public.v13_production_event e ON e.account_id=$1
ORDER BY e.event_id NULLS LAST LIMIT 3001`;

function object(v:unknown):v is Record<string,unknown>{return !!v&&typeof v==='object'&&!Array.isArray(v);}
const text=(x:unknown)=>typeof x==='string'?x:'';
async function readHeader(q:QueryOnly,owner:string,options:Options){
 const {rows}=await q.query(STOPPED_CASH_DIAGNOSTIC_SCOPE_SQL,[owner]);
 if(rows.length!==1)return null;
 const row=rows[0]!,id=text(row.id),sha=options.releaseSha(),fingerprint=text(row.key_fingerprint);
 if(!id||!SHA.test(sha)||row.owner_id!==owner||row.blocked_reason!==BAD_FREEZE||
   row.diagnostic_held!==true||row.lease_state!=='released'||row.arm_requested!==false||row.lease_account_kill!==false||
   // Require the stored policy label only; this diagnostic does not validate policy signatures.
   row.position_exists!==false||row.commissioned!==true||row.cash_precision_verified!==true||row.policy_state!=='APPROVED'||
   typeof row.kill_switch!=='boolean'||typeof row.execution_enabled!=='boolean'||
   !NUM.test(text(row.initial_cash_micros))||!NUM.test(text(row.cash_micros_text))||row.reserved_micros_text!=='0'||
   !FP.test(fingerprint)||row.lease_credential_fingerprint!==fingerprint||!object(row.hold_revision)||['account','policy','lease','fence','credential','financial','provider','key','vault']
      .some(k=>typeof (row.hold_revision as Record<string,unknown>)[k]!=='string')||
   options.isScheduled(owner,id)!==false)return null;
 return {row,id,sha,fingerprint};
}

export function createStoppedCashDiagnosticLoader(options:Options){
 return Object.freeze({
  async loadHeld(owner:string):Promise<StoppedCashDiagnosticHeld|null>{
   if(!UUID.test(owner))return null;
   return readStoppedCashDatabaseLeg(options.connect,async q=>{
    const a=await readHeader(q,owner,options);if(!a)return null;
    const h=await readNeverPostedReleaseHistory(q,a.id,false,{expiredExitOwnerId:owner});
    const included=new Set(h.expectedRequests.map(r=>r.clientOrderId));
    const expectedOrders=[];
    for(let i=0;i<h.rows.length;i++){
     const row=h.rows[i]!,request=h.requests[i] as Request; if(!included.has(request.clientOrderId))continue;
     const orderId=text(row.exchange_order_id),created=new Date(row.created_at as string|Date).getTime();
     if(!orderId||row.terminal!==true||row.client_order_id!==request.clientOrderId||
        !Number.isSafeInteger(created)||created<=0||!NUM.test(String(row.filled_hundredths)))return null;
     expectedOrders.push({request,orderId,filledHundredths:String(row.filled_hundredths),createdAtMs:created});
    }
    const {rows:e}=await q.query(STOPPED_CASH_DIAGNOSTIC_LEDGER_SQL,[a.id]);
    if(e.length<1||e.length>3000||e.some(r=>r.open_positions!=='0'))return null;
    const basis=text(e[0]!.basis),pnl=text(e[0]!.position_pnl);
    if(!NUM.test(basis)||!AMOUNT.test(pnl))return null;
    const eventRows=e.length===1&&e[0]!.event_id===null?[]:e;
    if(eventRows.some(r=>!text(r.event_id)||!FP.test(text(r.digest))||
      !AMOUNT.test(text(r.cash_delta_micros))||!AMOUNT.test(text(r.pnl_micros))||!text(r.row_revision)))return null;
    const r=a.row;
    return {owner,id:a.id,armRequested:false,leaseState:'released',scheduled:false,freeze:BAD_FREEZE,
     executionEnabled:r.execution_enabled as boolean,killSwitch:r.kill_switch as boolean,leaseAccountKill:false,
     subaccount:1,exchangeIndex:2,cashMicros:text(r.cash_micros_text),initialCashMicros:text(r.initial_cash_micros),reservedMicros:'0',
     commissioned:true,cashPrecisionVerified:true,approvedPolicy:true,positionCount:0,outstandingCount:0,reservationCount:0,
     releaseSha:a.sha,holdFence:digest({revision:r.hold_revision,leaseCredentialFingerprint:r.lease_credential_fingerprint}),keyFingerprint:a.fingerprint,historyDigest:digest({intents:h.historyDigest,events:e}),
     requests:h.requests,expectedOrders,neverPosted:h.neverPosted.map(n=>({clientOrderId:n.clientOrderId,requestDigest:n.requestDigest,receiptDigest:n.observationDigest})),
     events:eventRows.map(r=>({id:text(r.event_id),digest:text(r.digest),cashDeltaMicros:text(r.cash_delta_micros),realizedPnlMicros:text(r.pnl_micros)})),
     closedPositionBasisMicros:basis,closedPositionPnlMicros:pnl};
   });
  },
  async verifiedMaterial(owner:string,accountId:string,fingerprint:string){
   if(!UUID.test(owner)||!FP.test(fingerprint))return null;
   return readStoppedCashDatabaseLeg(options.connect,async q=>{
    const a=await readHeader(q,owner,options);
    if(!a||a.id!==accountId||a.fingerprint!==fingerprint)return null;
    const secret=await loadedMaterial(q,a.row);
    return secret&&dedicatedSignerFingerprint(secret.keyId,secret.privateKey)===fingerprint?secret:null;
   });
  }
 });
}
