/** Isolated synthetic history with the production incident's 173-intent shape.
 * No production identifiers, signatures, receipts or credential material. */
import {createHash,randomUUID} from 'node:crypto';
import {digest} from '../v13-production/types';
import {personalAccountSnapshot} from './personalExchangeRead';
type DB={query(sql:string,args?:unknown[]):Promise<unknown>};
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
export const retainedHistorySchema=`
 ALTER TABLE public.v13_production_intent ADD COLUMN kind text,ADD COLUMN market text,ADD COLUMN side text,
 ADD COLUMN parent_id text,ADD COLUMN decision jsonb,ADD COLUMN policy_hash text,ADD COLUMN fee_fingerprint text,
 ADD COLUMN capability_digest text,ADD COLUMN cancel_attempted boolean,ADD COLUMN exit_fee_micros bigint,ADD COLUMN dispatch_at timestamptz;
 ALTER TABLE public.v13_production_position ADD COLUMN id text;
 ALTER TABLE public.v13_production_event ADD COLUMN intent_id text,ADD COLUMN occurred_at timestamptz;
 ALTER TABLE public.v13_production_observation ADD COLUMN observed_at timestamptz DEFAULT now();
 ALTER TABLE private.strata_emergency_exit_reservations ADD COLUMN reservation_id text,ADD COLUMN owner_user_id uuid,
 ADD COLUMN client_order_id text,ADD COLUMN trading_authorized boolean,ADD COLUMN market_ticker text,
 ADD COLUMN reducing_side text,ADD COLUMN quantity_hundredths bigint,ADD COLUMN order_request_json text,
 ADD COLUMN order_digest text,ADD COLUMN worker_holder_id text,ADD COLUMN worker_fencing_token bigint,
 ADD FOREIGN KEY(execution_account_id) REFERENCES public.v13_production_account(id);
 CREATE TABLE private.strata_protective_exit_reconciliations(reservation_id text,execution_account_id text REFERENCES public.v13_production_account(id));
 CREATE TABLE private.strata_protective_exit_local_no_send(reservation_id text PRIMARY KEY,owner_user_id uuid,
 execution_account_id text REFERENCES public.v13_production_account(id),client_order_id text UNIQUE,order_digest text,
 signer_fingerprint text,market_ticker text,reducing_side text,quantity_hundredths bigint,limit_micros bigint,
 worker_holder_id text,worker_fencing_token bigint,reason text,evidence_sha256 text,recorded_at timestamptz);
 CREATE TABLE public.strata_configured_stake(execution_account_id text PRIMARY KEY,configured_stake_cents integer);
`;
export async function seedSettledCashHistory(db:DB,account:string,owner:string,fingerprint:string,realSchema=false){
 const destination=new URL(process.env.DATABASE_URL??'');
 if(destination.hostname!=='127.0.0.1'||!/^\/(recovery_disposable_\d+|strata_wallets_native_disposable)$/.test(destination.pathname))throw Error('isolated_settled_cash_fixture_required');
 const at=Date.now()-60000,fee='a'.repeat(64),orders:Record<string,unknown>[]=[],fills:Record<string,unknown>[]=[],settlements:Record<string,unknown>[]=[];
 const requests=[];const ids=Array.from({length:173},(_,n)=>realSchema?randomUUID():`recovery-${n}`);
 if(realSchema){
  await db.query("UPDATE private.kalshi_account_worker_lease SET state='owned',released_at=NULL,account_kill=false,holder_id='fixture-worker',fencing_token=22 WHERE execution_account_id=$1",[account]);
 }

 for(let n=0;n<173;n++){
  const posted=n<3,entry=n<46,local=n>=124,marker=!entry&&(n<70||local);
  const id=ids[n]!,market=`KXBTC15M-RECOVERY${posted?n:0}`,clientOrderId=`v13p-${id}`;
  const request={clientOrderId,market,side:'YES' as const,action:entry?'BUY' as const:'SELL' as const,reduceOnly:!entry,timeInForce:'IOC' as const,contracts:3,limitMicros:450000};
  const decision=entry?{}:local?{identity:{subaccount:1,exchangeIndex:2,keyFingerprint:fingerprint}}:
   {ownedEvaluation:{source:{evaluated_at:new Date(at-40000).toISOString()}},policy:{maxQuoteAgeMs:5000}};
  requests.push(request);
  if(realSchema&&entry){
   const bytes=JSON.stringify({syntheticHistoricalFixture:true,n});
   await db.query(`INSERT INTO public.strata_direct_entry_source(id,account_id,market_ticker,crossing_key,observed_at,oldest_source_at,closes_at,evidence_bytes,evidence_sha256)
    VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8)`,[id,account,market+'-'+n,market+'-'+n+':first',new Date(at-60000),new Date(at),bytes,sha(bytes)]);
  }
  await db.query(`INSERT INTO public.v13_production_intent(id,account_id,created_at,request,decision,state,terminal,reserved_micros,
   client_order_id,exchange_order_id,filled_hundredths,kind,market,side,parent_id,cancel_attempted,exit_fee_micros,dispatch_at,
   policy_hash,fee_fingerprint,capability_digest${realSchema?",direct_source_id,crossing_key":""}) VALUES($1,$2,$3,$4,$5,$6,true,0,$7,$8,$9,$10,$11,'YES',$12,false,0,$13,$14,$14,$15${realSchema?",$16,$17":""})`,
  [id,account,new Date(at-50000),request,decision,posted?'TERMINAL':realSchema&&local?'DISPATCHED':'BLOCKED',clientOrderId,posted?`order-${n}`:null,posted?300:0,
   entry?'ENTRY':'EXIT',market,entry?null:ids[0],entry||local?new Date(at-30000):null,fee,digest({id,request,decision,policyHash:fee,fee}),...(realSchema?[entry?id:null,entry?market+'-'+n+':first':null]:[])]);
  if(realSchema&&local)await db.query("UPDATE public.v13_production_intent SET terminal=false WHERE id=$1",[id]);
  // ENTRY preparation retains a zero position row even when it never posts.
  if(realSchema&&entry&&!posted)await db.query("INSERT INTO public.v13_production_position(id,account_id,market,side,quantity_hundredths,basis_micros,realized_pnl_micros) VALUES($1,$2,$3,'YES',0,0,0)",[id,account,market]);
  if(realSchema&&posted)await db.query("INSERT INTO public.v13_production_position(id,account_id,market,side,quantity_hundredths,basis_micros,realized_pnl_micros) VALUES($1,$2,$3,'YES',300,1350000,0)",[id,account,market]);
  const reservationId=marker?randomUUID():null;
  if(marker){
   const raw=JSON.stringify({ticker:market,side:'ask',count:'3.00',price:'0.4500',client_order_id:clientOrderId,
    time_in_force:'immediate_or_cancel',self_trade_prevention_type:'taker_at_cross',post_only:false,reduce_only:true,subaccount:1,exchange_index:2});
   await db.query(`INSERT INTO private.strata_emergency_exit_reservations(execution_account_id,state,reservation_id,owner_user_id,
    client_order_id,trading_authorized,market_ticker,reducing_side,quantity_hundredths,order_request_json,order_digest,worker_holder_id,worker_fencing_token${realSchema?",initial_position_fp,position_observed_at_ms":""})
    VALUES($1,'${realSchema?'PREPARED':'VOID'}',$2,$3,$4,false,$5,'YES',300,$6,$7,'fixture-worker',22${realSchema?",'3.00',$8":""})`,[account,reservationId,owner,clientOrderId,market,raw,sha(raw),...(realSchema?[at-40000]:[])]);
   if(realSchema&&local)await db.query("UPDATE private.strata_emergency_exit_reservations SET state='UNKNOWN' WHERE reservation_id=$1",[reservationId]);
   if(local){
    const evidence={version:1,ownerId:owner,accountId:account,reservationId,clientOrderId,orderDigest:sha(raw),market,side:'YES',
     quantity:'300',limitMicros:450000,signerFingerprint:fingerprint,holderId:'fixture-worker',fencingToken:22,reason:'final_evidence_expired'};
    await db.query(`INSERT INTO private.strata_protective_exit_local_no_send(reservation_id,owner_user_id,execution_account_id,client_order_id,order_digest,signer_fingerprint,market_ticker,reducing_side,quantity_hundredths,limit_micros,worker_holder_id,worker_fencing_token,reason,evidence_sha256,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,'YES',300,450000,'fixture-worker',22,'final_evidence_expired',$8,$9)`,
     [reservationId,owner,account,clientOrderId,sha(raw),fingerprint,market,sha(JSON.stringify(evidence)),new Date(at-20000)]);
   }
   if(realSchema){
    if(local)await db.query("UPDATE public.v13_production_intent SET state='BLOCKED',terminal=true WHERE id=$1",[id]);
    await db.query("UPDATE private.strata_emergency_exit_reservations SET state='VOID' WHERE reservation_id=$1",[reservationId]);
   }
  }
  if(!posted&&!local){
   const payload=entry?{id,reason:'production_final_source_changed_or_expired'}:
    {id,reason:'production_prepared_exit_expired',reservationId,sourceAtMs:at-40000,maxQuoteAgeMs:5000,evidenceObservedAtMs:at-30000,ownedQuantityHundredths:'300'};
   await db.query(`INSERT INTO public.v13_production_observation(id,account_id,kind,payload,digest) VALUES($1,$2,'PROVEN_NOT_POSTED',$3,$4)`,[realSchema?randomUUID():`proof-${n}`,account,payload,digest(payload)]);
  }
  if(posted){
   orders.push({order_id:`order-${n}`,client_order_id:clientOrderId,ticker:market,book_side:'bid',action:'buy',status:'executed',initial_count_fp:'3.00',fill_count_fp:'3.00',yes_price_dollars:'0.4500'});
   fills.push({order_id:`order-${n}`,trade_id:`fill-${n}`,ticker:market,count_fp:'3.00',yes_price_dollars:'0.4500',fee_cost:n===2?'0.0655':'0.0600',created_time:new Date(at-10000).toISOString()});
   settlements.push({ticker:market,yes_count_fp:'3.00',no_count_fp:'0.00',market_result:n===2?'yes':'no',revenue:n===2?300:0,settled_time:new Date(at+n).toISOString()});
  }
 }
 const read=async(_credentials:unknown,observedAtMs:number)=>({ok:true as const,observedAtMs,historicalCoverageComplete:true,cashMicros:'26484500',orders,fills,positions:[],settlements});
 const snapshot=personalAccountSnapshot({subaccount:1,exchangeIndex:2,keyFingerprint:fingerprint},await read(null,Date.now()),requests);
 if(!('identity' in snapshot))throw Error('synthetic_recovery_history_invalid');
 for(let n=0;n<3;n++){
  const f=snapshot.fills.find(f=>f.id===`fill-${n}`)!,s=snapshot.settlements.find(s=>s.market===`KXBTC15M-RECOVERY${n}`)!;
  const basis=BigInt(f.grossMicros)+BigInt(f.feeMicros),pnl=BigInt(s.payoutMicros)-basis;
  await db.query(`INSERT INTO public.v13_production_event(account_id,event_id,digest,kind,payload,cash_delta_micros,pnl_micros,intent_id,occurred_at)
   VALUES($1,$2,$3,'FILL',$4,$5,0,$6,$7),($1,$8,$9,'SETTLEMENT',$10,$11,$12,$6,$13)`,
  [account,`fill:${f.id}`,digest(f),f,String(-basis),ids[n],new Date(f.occurredAtMs),`settlement:${s.id}`,digest(s),s,s.payoutMicros,String(pnl),new Date(s.occurredAtMs)]);
  if(realSchema)await db.query("UPDATE public.v13_production_position SET quantity_hundredths=0,basis_micros=0,realized_pnl_micros=$2 WHERE id=$1",[ids[n],String(pnl)]);
  else await db.query(`INSERT INTO public.v13_production_position(account_id,market,side,quantity_hundredths,basis_micros,realized_pnl_micros,id) VALUES($1,$2,'YES',0,0,$3,$4)`,[account,s.market,String(pnl),`recovery-${n}`]);
 }
 if(!realSchema)await db.query('INSERT INTO public.strata_configured_stake VALUES($1,500)',[account]);
 else await db.query("UPDATE private.kalshi_account_worker_lease SET state='released',released_at=clock_timestamp(),arm_requested=false WHERE execution_account_id=$1",[account]);
 return {read,orders,fills,settlements,settlementEventId:`settlement:${snapshot.settlements.find(s=>s.market==='KXBTC15M-RECOVERY2')!.id}`};
}
