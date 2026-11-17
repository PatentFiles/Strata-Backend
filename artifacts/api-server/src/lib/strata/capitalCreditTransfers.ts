import {digest} from '../v13-production/types';
export const CREDIT_CONFIRM='I_RECORD_THIS_VERIFIED_PAST_FUNDING_CREDIT_AS_CAPITAL_NOT_PROFIT_V1';
export const CREDIT_CANCEL='I_CANCEL_MY_PENDING_CAPITAL_CREDIT_REPAIR_V1';
export type CapitalTransfer={transferId:string;fromSubaccount:number;toSubaccount:number;amountCents:number;createdAtMs:number;exchangeIndex:number};
export type TransferGet=(path:string,query:string)=>Promise<unknown>;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
/** Official applied-transfer history, not a POST acknowledgment. Missing pages or
 * identity ambiguity cannot establish a capital credit. No transfer writes. */
export async function readCapitalTransfers(get:TransferGet,now:number):Promise<CapitalTransfer[]>{
 const all:CapitalTransfer[]=[],ids=new Set<string>(),cursors=new Set<string>();let cursor='';
 for(let page=0;page<50;page++){
  const raw=await get('/trade-api/v2/portfolio/subaccounts/transfers','?limit=100'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
  if(!object(raw)||!Array.isArray(raw.transfers)||typeof raw.cursor!=='string'||raw.transfers.length>100)throw Error('capital_transfer_page_unverified');
  for(const x of raw.transfers){
   if(!object(x)||typeof x.transfer_id!=='string'||! /^[A-Za-z0-9_-]{8,128}$/.test(x.transfer_id)||ids.has(x.transfer_id)||
    !Number.isSafeInteger(x.from_subaccount)||Number(x.from_subaccount)<0||Number(x.from_subaccount)>63||
    !Number.isSafeInteger(x.to_subaccount)||Number(x.to_subaccount)<0||Number(x.to_subaccount)>63||x.from_subaccount===x.to_subaccount||
    !Number.isSafeInteger(x.amount_cents)||Number(x.amount_cents)<=0||Number(x.amount_cents)>2500000||
    !Number.isSafeInteger(x.created_ts)||Number(x.created_ts)<=0||Number(x.created_ts)*1000>now||
    !Number.isSafeInteger(x.exchange_index)||Number(x.exchange_index)<0)throw Error('capital_transfer_receipt_unverified');
   ids.add(x.transfer_id);all.push({transferId:x.transfer_id,fromSubaccount:Number(x.from_subaccount),toSubaccount:Number(x.to_subaccount),amountCents:Number(x.amount_cents),createdAtMs:Number(x.created_ts)*1000,exchangeIndex:Number(x.exchange_index)});
  }
  if(raw.cursor==='')return all;
  if(raw.cursor.length>2048||cursors.has(raw.cursor)||raw.transfers.length===0)throw Error('capital_transfer_pagination_unverified');
  cursors.add(raw.cursor);cursor=raw.cursor;
 }
 throw Error('capital_transfer_history_bound_exceeded');
}
export function uniqueCapitalTransfer(rows:CapitalTransfer[],checkpointMs:number){
 if(rows.some(r=>r.exchangeIndex===2&&(r.fromSubaccount===1||r.toSubaccount===1)&&r.createdAtMs===Math.floor(checkpointMs/1000)*1000))throw Error('capital_transfer_checkpoint_boundary_ambiguous');
 const after=rows.filter(r=>r.exchangeIndex===2&&(r.fromSubaccount===1||r.toSubaccount===1)&&r.createdAtMs>checkpointMs);
 if(after.length!==1||after[0].fromSubaccount!==0||after[0].toSubaccount!==1)throw Error('capital_transfer_unique_inbound_required');
 return {...after[0],receiptDigest:digest(after[0])};
}
