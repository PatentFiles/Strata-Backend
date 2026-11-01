import {digest,type Request} from '../v13-production/types';
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
export async function readNeverPostedReleaseHistory(db:Query,accountId:string,lock=false){
 const rows=(await db.query(`SELECT i.*,i.xmin::text AS row_revision FROM public.v13_production_intent i
  WHERE account_id=$1 ORDER BY created_at,id LIMIT 1001 ${lock?'FOR SHARE':''}`,[accountId])).rows;
 if(rows.length>MAX_HISTORY)throw Error('release_history_bound_exceeded');
 const requests:Request[]=[];
 for(const row of rows){const r=json(row.request);if(!object(r))throw Error('financial_intent_unreadable');requests.push(r as Request);}
 if(requests.some(r=>typeof r.clientOrderId!=='string'||!r.clientOrderId)||new Set(requests.map(r=>r.clientOrderId)).size!==requests.length)throw Error('release_history_client_identity_ambiguous');
 const candidates=rows.filter(r=>r.kind==='ENTRY'&&r.state==='BLOCKED');
 if(!candidates.length)return {rows,requests,expectedRequests:requests,neverPosted:[],historyDigest:digest(rows)};
 const ids=candidates.map(r=>String(r.id));
 const observations=(await db.query(`SELECT id,account_id,kind,payload,digest,observed_at,xmin::text AS row_revision
  FROM public.v13_production_observation WHERE account_id=$1
  AND kind IN ('PROVEN_NOT_POSTED','POST_ATTEMPT','POST_UNCERTAIN') AND payload->>'id'=ANY($2::text[])
  ORDER BY id LIMIT 3001 ${lock?'FOR SHARE':''}`,[accountId,ids])).rows;
 if(observations.length>3000)throw Error('release_history_bound_exceeded');
 const events=(await db.query(`SELECT 1 AS present FROM public.v13_production_event
  WHERE account_id=$1 AND intent_id=ANY($2::text[]) LIMIT 1 ${lock?'FOR SHARE':''}`,[accountId,ids])).rows;
 if(events.length)throw Error('release_never_posted_financial_event_conflict');
 const neverPosted=[];
 for(const i of candidates){
  const r=json(i.request) as Row,d=json(i.decision);
  const matches=observations.filter(o=>{const p=json(o.payload);return object(p)&&p.id===i.id;});
  const receipt=matches[0],payload=receipt?json(receipt.payload):null;
  if(i.account_id!==accountId||i.terminal!==true||i.exchange_order_id!==null||!zero(i.filled_hundredths)||!zero(i.reserved_micros)||
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
 const excluded=new Set(neverPosted.map(x=>x.clientOrderId));
 return {rows,requests,expectedRequests:requests.filter(r=>!excluded.has(r.clientOrderId)),neverPosted,
  historyDigest:digest({rows,observations})};
}
