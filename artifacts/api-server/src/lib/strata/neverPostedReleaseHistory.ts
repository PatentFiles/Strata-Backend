import {readBlockedDischargeEvidence,type readLockedDischargeHistoryAndMoney} from './economicRecoveryReadBatch';
import {readEconomicExitDischarges,verifyEconomicExitDischargeRows} from './economicExitDischargeScope';
import {digest,type Request} from '../v13-production/types';
import {validateExpiredExitNoSend} from './expiredExitNoSendEvidence';
import {validateLocalExitNoSend} from './localExitNoSendEvidence';
type Row=Record<string,unknown>;
type Query={query(sql:string,args?:unknown[]):Promise<{rows:Row[]}>};
const object=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v);
const json=(v:unknown):unknown=>typeof v==='string'?JSON.parse(v):v;
const zero=(v:unknown)=>String(v)==='0';
const MAX_HISTORY=1000;
/** This is a trusted-ledger consistency proof, not a provider signature.
 * The existing immutable capability binds request/client identity; the exact
 * account's digest-valid no-send receipt identifies that same intent. A reason
 * string or BLOCKED status on its own is never evidence of non-submission. */
export async function readNeverPostedReleaseHistory(db:Query,accountId:string,lock=false,
 diagnostic?:{expiredExitOwnerId:string;batchDischargeEvidence?:boolean},preloaded?:{intents:Row[];discharges:Row[];downstream:Awaited<ReturnType<typeof readLockedDischargeHistoryAndMoney>>|null}){
 if(preloaded&&!lock)throw Error('release_history_preloaded_rows_require_lock');
 const discharges=preloaded?await verifyEconomicExitDischargeRows(db,accountId,preloaded.discharges):await readEconomicExitDischarges(db,accountId,lock,diagnostic?.batchDischargeEvidence===true);
 const finish=<T extends {expectedRequests:Request[];historyDigest:string}>(h:T):T&{economicDischarges?:Row[]}=>{
  if(!discharges.length)return h;
  const clients=new Set(discharges.map(d=>String(d.client_order_id)));
  return {...h,expectedRequests:h.expectedRequests.filter(r=>!clients.has(r.clientOrderId)),economicDischarges:discharges,
   historyDigest:digest({history:h.historyDigest,economicDischarges:discharges})};
 };
 const rows=preloaded?.intents??(await db.query(`SELECT i.*,i.xmin::text AS row_revision FROM public.v13_production_intent i
  WHERE account_id=$1 ORDER BY created_at,id LIMIT 1001 ${lock?'FOR SHARE':''}`,[accountId])).rows;
 if(rows.length>MAX_HISTORY)throw Error('release_history_bound_exceeded');
 const requests:Request[]=[];
 for(const row of rows){const r=json(row.request);if(!object(r))throw Error('financial_intent_unreadable');requests.push(r as Request);}
 if(requests.some(r=>typeof r.clientOrderId!=='string'||!r.clientOrderId)||new Set(requests.map(r=>r.clientOrderId)).size!==requests.length)throw Error('release_history_client_identity_ambiguous');
 // This opt-in validates expired EXIT evidence only; it does not grant any
 // authority. Authorization callers additionally require complete signed
 // history, financial reconciliation, stopped scope and locked revalidation.
 // Default callers retain the existing entry-only contract.
 const candidates=rows.filter(r=>r.state==='BLOCKED'&&(r.kind==='ENTRY'||(diagnostic&&r.kind==='EXIT')));
 if(!candidates.length)return finish({rows,requests,expectedRequests:requests,neverPosted:[],historyDigest:digest(rows)});
 const ids=candidates.map(r=>String(r.id));
 const exits=candidates.filter(i=>i.kind==='EXIT');
 const dispatched=exits.filter(i=>i.dispatch_at!==null);
 const batchEvidence=diagnostic&&(preloaded||(diagnostic.batchDischargeEvidence&&discharges.length>0));
 const batch=batchEvidence?await readBlockedDischargeEvidence(db,accountId,ids,
  exits.map(i=>String(i.client_order_id)),dispatched.map(i=>String(i.client_order_id)),lock,Boolean(preloaded)):null;
 const observations=batch?.observations??(await db.query(`SELECT id,account_id,kind,payload,digest,observed_at,xmin::text AS row_revision
  FROM public.v13_production_observation WHERE account_id=$1
  AND kind IN ('PROVEN_NOT_POSTED','POST_ATTEMPT','POST_UNCERTAIN'${diagnostic?",'CANCEL_ATTEMPT'":''}) AND payload->>'id'=ANY($2::text[])
  ORDER BY id LIMIT 3001 ${lock?'FOR SHARE':''}`,[accountId,ids])).rows;
 if(observations.length>3000)throw Error('release_history_bound_exceeded');
 const events=batch?.events??(await db.query(`SELECT 1 AS present FROM public.v13_production_event
  WHERE account_id=$1 AND intent_id=ANY($2::text[]) LIMIT 1 ${lock?'FOR SHARE':''}`,[accountId,ids])).rows;
 if(events.length)throw Error('release_never_posted_financial_event_conflict');
 const markers=batch?.markers??(exits.length?(await db.query(`SELECT reservation_id,owner_user_id::text AS owner_user_id,
  execution_account_id,client_order_id,state,trading_authorized,market_ticker,reducing_side,
  quantity_hundredths,order_request_json,order_digest,worker_holder_id,worker_fencing_token::text AS worker_fencing_token,xmin::text AS row_revision
  FROM private.strata_emergency_exit_reservations WHERE client_order_id=ANY($1::text[])
  ORDER BY reservation_id LIMIT 1001 ${lock?'FOR SHARE':''}`,[exits.map(i=>String(i.client_order_id))])).rows:[]);
 if(markers.length>MAX_HISTORY)throw Error('release_history_bound_exceeded');
 const localNoSends=batch?.localNoSends??(dispatched.length?(await db.query(`SELECT n.*,n.worker_fencing_token::text AS worker_fencing_token,
  n.quantity_hundredths::text AS quantity_hundredths,n.limit_micros::text AS limit_micros,n.xmin::text AS row_revision
  FROM private.strata_protective_exit_local_no_send n WHERE client_order_id=ANY($1::text[])
  ORDER BY reservation_id LIMIT 1001 ${lock?'FOR SHARE':''}`,[dispatched.map(i=>String(i.client_order_id))])).rows:[]);
 if(localNoSends.length>MAX_HISTORY)throw Error('release_history_bound_exceeded');
 const neverPosted=[];
 for(const i of candidates){
  const r=json(i.request) as Row,d=json(i.decision);
  const matches=observations.filter(o=>{const p=json(o.payload);return object(p)&&p.id===i.id;});
  const receipt=matches[0],payload=receipt?json(receipt.payload):null;
  if(i.kind==='EXIT'&&i.dispatch_at!==null){
   const n=validateLocalExitNoSend(i,rows,matches,markers,localNoSends,accountId,diagnostic!.expiredExitOwnerId);
   neverPosted.push({intentId:String(i.id),clientOrderId:String(i.client_order_id),requestDigest:digest(r),
    capabilityDigest:String(i.capability_digest),observationId:`local-no-send:${n.reservation_id}`,observationDigest:String(n.evidence_sha256)});
   continue;
  }
  if(i.kind==='EXIT')validateExpiredExitNoSend(i,rows,matches,markers,accountId,diagnostic!.expiredExitOwnerId);
  else if(i.account_id!==accountId||i.terminal!==true||i.exchange_order_id!==null||!zero(i.filled_hundredths)||!zero(i.reserved_micros)||
    i.parent_id!==null||i.cancel_attempted!==false||r.clientOrderId!==i.client_order_id||r.clientOrderId!==`v13p-${i.id}`||
    r.market!==i.market||!/^KXBTC15M-[A-Za-z0-9-]+$/.test(String(r.market))||r.quantityVersion!==undefined||r.quantityHundredths!==undefined||r.side!==i.side||!['YES','NO'].includes(String(r.side))||r.action!=='BUY'||r.reduceOnly!==false||r.timeInForce!=='IOC'||
    !Number.isSafeInteger(r.contracts)||Number(r.contracts)<1||Number(r.contracts)>999999999||
    !Number.isSafeInteger(r.limitMicros)||Number(r.limitMicros)<100||Number(r.limitMicros)>999900||Number(r.limitMicros)%100!==0||
    !object(d)||i.capability_digest!==digest({id:i.id,request:r,decision:d,policyHash:i.policy_hash,fee:i.fee_fingerprint})||
    matches.length!==1||!receipt||receipt.account_id!==accountId||receipt.kind!=='PROVEN_NOT_POSTED'||!object(payload)||
    receipt.digest!==digest(payload)||typeof payload.reason!=='string'||!payload.reason.length)
   throw Error('release_never_posted_evidence_invalid_or_contradictory');
  neverPosted.push({intentId:String(i.id),clientOrderId:String(i.client_order_id),requestDigest:digest(r),
   capabilityDigest:String(i.capability_digest),observationId:String(receipt.id),observationDigest:String(receipt.digest)});
 }
 // Reuse only this transaction’s freshly locked evidence, after validation.
 if(preloaded&&batch?.downstream)preloaded.downstream=batch.downstream;
 const excluded=new Set(neverPosted.map(x=>x.clientOrderId));
 return finish({rows,requests,expectedRequests:requests.filter(r=>!excluded.has(r.clientOrderId)),neverPosted,
  historyDigest:exits.length?digest({rows,observations,markers,...(localNoSends.length?{localNoSends}:{})}):digest({rows,observations})});
}
