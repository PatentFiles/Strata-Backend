import type {Snapshot} from '../v13-production/types';
import {readStoppedSettledExitDispositions,settledReserveReadinessEnabled,verifyDisposedExitAgainstSnapshot} from './armSettledReserveScope';
export type RuntimeDispositionDb={query(sql:string,params:unknown[]):Promise<{rows:Record<string,unknown>[]}>};
export type RuntimeDispositionInput={accountId:string;ownerId:string;snapshot:Snapshot;nowMs:number;
 currentIntentId?:string|null;lock?:boolean;protectiveMarker?:{reservationId:string;clientId:string;state:"PREPARED"|"UNKNOWN"}};

/** Returns one exact historical pair only after newer full signed observation.
 * Does not require the whole account to be flat: a later real position must
 * still be managed by the independent protective exit. Other callers enforce
 * their existing position, cash, risk, fee, authority and transport fences.
 */
export async function runtimeSettledExitReceipt(db:RuntimeDispositionDb,x:RuntimeDispositionInput){
 if(!settledReserveReadinessEnabled())return null;
 try{
  const s=x.snapshot,age=x.nowMs-s.observedAtMs;
  if(!Number.isSafeInteger(x.nowMs)||!Number.isSafeInteger(s.observedAtMs)||age<0||age>5000||
   s.identity.subaccount!==1||s.identity.exchangeIndex!==2||!s.orders.every(o=>o.terminal))return null;
  const scope=(await db.query(`SELECT key_fingerprint,cash_micros::text AS cash_micros
   FROM public.v13_production_account WHERE id=$1 AND owner_user_id=$2::uuid AND subaccount=1 AND exchange_index=2`,
   [x.accountId,x.ownerId])).rows;
  if(scope.length!==1||scope[0]?.key_fingerprint!==s.identity.keyFingerprint||scope[0]?.cash_micros!==s.cashMicros)return null;
  const rows=await readStoppedSettledExitDispositions(db,x.accountId,x.ownerId,x.lock===true);
  if(rows.length!==1||rows[0]!.exitId===x.currentIntentId)return null;
  const r=rows[0]!;verifyDisposedExitAgainstSnapshot(r,s);
  const marker=x.protectiveMarker;
  if(marker){
   const current=(await db.query(`SELECT m.reservation_id FROM private.strata_emergency_exit_reservations m
    JOIN public.v13_production_intent i ON i.account_id=m.execution_account_id AND i.client_order_id=m.client_order_id
    WHERE m.reservation_id=$1::uuid AND m.execution_account_id=$2 AND m.owner_user_id=$3::uuid AND m.client_order_id=$4
     AND m.state=$5 AND NOT m.trading_authorized AND i.kind='EXIT' AND NOT i.terminal
     AND i.exchange_order_id IS NULL AND i.filled_hundredths=0
     AND (CASE WHEN $5='PREPARED' THEN i.state='PREPARED' ELSE i.state='DISPATCHED' AND i.id=$6 END)
    LIMIT 2${x.lock?' FOR SHARE OF m,i':''}`,[marker.reservationId,x.accountId,x.ownerId,marker.clientId,marker.state,x.currentIntentId??null])).rows;
   if(current.length!==1||current[0]!.reservation_id!==marker.reservationId||marker.reservationId===r.reservationId)return null;
  }
  const remaining=(await db.query(`SELECT
   EXISTS(SELECT 1 FROM public.v13_production_intent i WHERE i.account_id=$1
    AND i.state IN ('DISPATCHED','UNKNOWN') AND i.id<>$2
    AND ($3::text IS NULL OR i.id<>$3 OR i.state<>'DISPATCHED')) AS intents,
   EXISTS(SELECT 1 FROM private.strata_emergency_exit_reservations m
    WHERE m.execution_account_id=$1 AND m.state IN ('PREPARED','DISPATCHED','UNKNOWN') AND m.reservation_id<>$4::uuid
    AND ($5::uuid IS NULL OR m.reservation_id<>$5::uuid)) AS exits`,
    [x.accountId,r.exitId,x.currentIntentId??null,r.reservationId,marker?.reservationId??null])).rows;
  return remaining.length===1&&remaining[0]!.intents===false&&remaining[0]!.exits===false?r:null;
 }catch{return null;}
}
