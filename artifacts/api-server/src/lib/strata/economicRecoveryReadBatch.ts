import type {PoolClient} from '@workspace/db';
import {requireProof} from '../v13-production/types';

type Row=Record<string,unknown>;
type Query={query(sql:string,args?:unknown[]):Promise<{rows:Row[]}>};
type OwnerRead=readonly [sql:string,values:(string|null)[]];

/** Receives only module-authored read statements. Native clients send each
 * SELECT in the original lock order in one simple-protocol message. Each gets
 * its own PostgreSQL snapshot after the preceding statement completes. */
export async function orderedOwnerReads(tx:Query,batch:boolean,reads:OwnerRead[]){
 if(!batch)return (index:number)=>tx.query(reads[index]![0],reads[index]![1]);
 const native=tx as Query&Pick<PoolClient,'escapeLiteral'>;
 const sql=reads.map(([statement,values])=>{
  if(!/^\s*(SELECT|WITH)\s/i.test(statement)||statement.includes(';'))throw Error('owner_release_read_set_invalid');
  return statement.replace(/\$(\d+)/g,(_token,index:string)=>{
   const value=values[Number(index)-1];
   if(value===null)return 'NULL';
   if(typeof value!=='string')throw Error('owner_release_read_set_invalid');
   return native.escapeLiteral(value);
  });
 }).join(';\n');
 const results:unknown=await native.query(sql);
 if(!Array.isArray(results)||results.length!==reads.length||
    !results.every(r=>r?.command==='SELECT'&&Array.isArray(r.rows)))throw Error('owner_release_read_set_invalid');
 return async(index:number):Promise<{rows:Record<string,unknown>[]}>=>results[index];
}

type ReadSpec=Readonly<{name:string;table:string;scope:string;order:readonly string[];limit:number;immutable?:boolean;columns?:readonly string[];extra?:string;unscoped?:boolean}>;
const HISTORY:readonly ReadSpec[]=[
 {name:'events',table:'public.v13_production_event',scope:'account_id',order:['event_id'],limit:3000},
 {name:'positions',table:'public.v13_production_position',scope:'account_id',order:['id'],limit:1000},
 {name:'markers',table:'private.strata_emergency_exit_reservations',scope:'execution_account_id',order:['reservation_id'],limit:1000},
 {name:'receipts',table:'private.strata_protective_exit_reconciliations',scope:'execution_account_id',order:['reservation_id'],limit:1000},
];
const MONEY:readonly ReadSpec[]=[
 {name:'topups',table:'private.kalshi_owner_topups',scope:'execution_account_id',order:[],limit:1000},
 {name:'allocations',table:'private.kalshi_owner_shard_allocations',scope:'execution_account_id',order:[],limit:1000},
 {name:'transfers',table:'private.kalshi_owner_pilot_transfers',scope:'execution_account_id',order:[],limit:1000},
 {name:'withdrawals',table:'private.strata_manual_profit_withdrawals',scope:'execution_account_id',order:[],limit:1000},
 {name:'maintenance',table:'private.strata_auto_withdrawal_maintenance',scope:'execution_account_id',order:[],limit:1000},
];
const FAIL='economic_discharge_batch_read_unverified';
const obj=(v:unknown):v is Row=>v!==null&&typeof v==='object'&&!Array.isArray(v);
/** This is transport batching, not a new recovery/authority system. The same
 * bounded account-scoped rows and xmin revisions are reread. Materialized CTE
 * dependencies retain the old table lock order. No lock is removed, no cached
 * value is accepted, and the caller keeps the original five-second deadline.
 * All table/column names below are module constants, never request inputs. */
function statement(specs:readonly ReadSpec[],lock:boolean,afterCleanIntents=false):string{
 const ctes=specs.map((s,i)=>`r${i} AS MATERIALIZED (
  SELECT ${s.columns?s.columns.map(c=>'t.'+c).join(','):'t.*'},t.xmin::text AS row_revision FROM ${s.table} t
  WHERE ${s.unscoped?'true':'t.'+s.scope+'=$1'}${s.extra?' AND '+s.extra:''}${i?' AND (SELECT count(*) FROM r'+(i-1)+')>=0':''}
  ${afterCleanIntents&&i>=2?"AND NOT EXISTS(SELECT 1 FROM r1 WHERE state='BLOCKED' AND kind IN ('ENTRY','EXIT'))":''}
  ${s.order.length?'ORDER BY '+s.order.map(k=>'t.'+k).join(','):''}
  LIMIT ${s.limit+1} ${lock&&!s.immutable?'FOR SHARE OF t':''})`);
 return 'WITH '+ctes.join(',\n')+'\n'+specs.map((s,i)=>`SELECT '${s.name}'::text AS section,
  (SELECT jsonb_object_agg(a.attname,a.atttypid::integer) FROM pg_catalog.pg_attribute a
   WHERE a.attrelid='${s.table}'::regclass AND a.attnum>0 AND NOT a.attisdropped${s.columns?" AND a.attname IN ("+s.columns.map(c=>"'"+c+"'").join(',')+")":''})
   || jsonb_build_object('row_revision',25) AS types,
  COALESCE((SELECT jsonb_agg((SELECT jsonb_object_agg(e.key,e.value)
    FROM jsonb_each_text(to_jsonb(r)) e)${s.order.length?' ORDER BY '+s.order.map(k=>'r.'+k).join(','):''})
    FROM r${i} r),'[]'::jsonb) AS records`).join('\nUNION ALL\n');
}
/** JSON numeric aggregation alone rounds int8 values above 2^53. Every SQL
 * cell is therefore encoded as text first; native scalar types are restored
 * using trusted catalog OIDs. JSON payloads use the same JSON.parse semantics
 * as node-postgres. Bigints/numerics remain strings and dates remain Dates,
 * preserving the existing exact history/scope hashes. New unsupported database
 * types fail closed instead of silently changing the financial projection. */
export function decodeEconomicBatchCell(oid:unknown,value:unknown):unknown{
 requireProof(Number.isInteger(oid),FAIL);
 if(value===null)return null;
 requireProof(typeof value==='string',FAIL);
 switch(oid){
  case 20: case 1700: requireProof(/^-?\d+(?:\.\d+)?$/.test(value),FAIL);return value;
  case 21: case 23: {const n=Number(value);requireProof(/^-?\d+$/.test(value)&&Number.isSafeInteger(n),FAIL);return n;}
  case 16: requireProof(value==='true'||value==='false',FAIL);return value==='true';
  case 25: case 1043: case 1042: case 2950: return value;
  case 1184: {const d=new Date(value);requireProof(Number.isFinite(d.getTime()),FAIL);return d;}
  case 114: case 3802: return JSON.parse(value);
  default: throw Error(FAIL);
 }
}
async function read(db:Query,account:string,specs:readonly ReadSpec[],lock:boolean,afterCleanIntents=false,extra:unknown[]=[]){
 const result=await db.query(statement(specs,lock,afterCleanIntents),[account,...extra]);
 requireProof(result.rows.length===specs.length,FAIL);
 const output:Record<string,Row[]>={};
 for(const spec of specs){
  const matches=result.rows.filter(r=>r.section===spec.name);requireProof(matches.length===1,FAIL);
  const {types,records}=matches[0]!;requireProof(obj(types)&&Array.isArray(records)&&records.length<=spec.limit+1,FAIL);
  const keys=Object.keys(types).sort();requireProof(keys.includes('row_revision'),FAIL);
  output[spec.name]=records.map(raw=>{
   requireProof(obj(raw)&&JSON.stringify(Object.keys(raw).sort())===JSON.stringify(keys),FAIL);
   return Object.fromEntries(keys.map(k=>[k,decodeEconomicBatchCell(types[k],raw[k])]));
  });
 }
 return output;
}
export async function readEconomicHistoryBatch(db:Query,account:string,lock:boolean){
 const r=await read(db,account,HISTORY,lock);
 return {events:r.events!,positions:r.positions!,markers:r.markers!,receipts:r.receipts!};
}
export async function readEconomicPendingMoneyBatch(db:Query,account:string,lock:boolean){
 const r=await read(db,account,MONEY,lock);
 return MONEY.map(s=>r[s.name]!);
}

/** Opt-in for the discharge writer. Share locks retain the same order:
 * immutable history tables first, then the existing pending-money set. */
export async function readLockedDischargeHistoryAndMoney(db:Query,account:string){
 const r=await read(db,account,[...HISTORY,...MONEY],true);
 return {events:r.events!,positions:r.positions!,markers:r.markers!,receipts:r.receipts!,pendingMoney:MONEY.map(s=>r[s.name]!)};
}


/** Only the already-locked reserve writer uses this. Historical discharge
 * rows are immutable, account-bound and separately validated; intent rows
 * retain their SHARE locks. If existing BLOCKED intents need supplemental
 * no-send proof, the SQL intentionally skips downstream row locks so the
 * caller can keep the original supplemental→history→money lock order. */
const DISCHARGE_HISTORY:readonly ReadSpec[]=[
 {name:'abstractDischarges',table:'private.strata_economic_exit_discharge',scope:'execution_account_id',order:['request_id'],limit:1000,immutable:true},
 {name:'intents',table:'public.v13_production_intent',scope:'account_id',order:['created_at','id'],limit:1000},
 ...HISTORY,...MONEY,
];
export async function readLockedDischargeFullHistory(db:Query,account:string){
 const r=await read(db,account,DISCHARGE_HISTORY,true,true);
 const intents=r.intents!,discharges=r.abstractDischarges!;
 requireProof(intents.length<=1000,'release_history_bound_exceeded');
 requireProof(discharges.length<=1000,'economic_discharge_history_capacity');
 const supplemental=intents.some(i=>i.state==='BLOCKED'&&(i.kind==='ENTRY'||i.kind==='EXIT'));
 return {intents,discharges,downstream:supplemental?null:{
  events:r.events!,positions:r.positions!,markers:r.markers!,receipts:r.receipts!,pendingMoney:MONEY.map(s=>r[s.name]!)},
 };
}

// Same bounded supplemental evidence and same lock order as the sequential
// path. IDs are parameters from the already-locked intent rows, never SQL.
const BLOCKED_DISCHARGE:readonly ReadSpec[]=[
 {name:'observations',table:'public.v13_production_observation',scope:'account_id',order:['id'],limit:3000,
  columns:['id','account_id','kind','payload','digest','observed_at'],
  extra:"t.kind IN ('PROVEN_NOT_POSTED','POST_ATTEMPT','POST_UNCERTAIN','CANCEL_ATTEMPT') AND t.payload->>'id'=ANY($2::text[])"},
 {name:'events',table:'public.v13_production_event',scope:'account_id',order:[],limit:0,columns:['event_id'],
  extra:"t.intent_id=ANY($2::text[])"},
 {name:'markers',table:'private.strata_emergency_exit_reservations',scope:'execution_account_id',unscoped:true,
  order:['reservation_id'],limit:1000,extra:"NOT EXISTS(SELECT 1 FROM r1) AND t.client_order_id=ANY($3::text[])",
  columns:['reservation_id','owner_user_id','execution_account_id','client_order_id','state','trading_authorized','market_ticker','reducing_side',
   'quantity_hundredths','order_request_json','order_digest','worker_holder_id','worker_fencing_token']},
 {name:'localNoSends',table:'private.strata_protective_exit_local_no_send',scope:'execution_account_id',unscoped:true,
  order:['reservation_id'],limit:1000,extra:"NOT EXISTS(SELECT 1 FROM r1) AND t.client_order_id=ANY($4::text[])"},
];
type DischargeDownstream=Awaited<ReturnType<typeof readLockedDischargeHistoryAndMoney>>;
export function readLockedBlockedDischargeEvidence(db:Query,account:string,ids:string[],exitClients:string[],dispatchedClients:string[],includeDownstream=false){
 return readBlockedDischargeEvidence(db,account,ids,exitClients,dispatchedClients,true,includeDownstream);
}
export async function readBlockedDischargeEvidence(db:Query,account:string,ids:string[],exitClients:string[],dispatchedClients:string[],lock:boolean,includeDownstream=false){
 requireProof(!includeDownstream||lock,FAIL);
 // Once the supplemental rows have locked, continue in exactly the same
 // downstream table order. A conflicting event still skips downstream reads.
 const specs=includeDownstream?[...BLOCKED_DISCHARGE,...[...HISTORY,...MONEY].map(s=>({...s, name:'downstream_'+s.name,
  extra:'NOT EXISTS(SELECT 1 FROM r1)'}))]:BLOCKED_DISCHARGE;
 const r=await read(db,account,specs,lock,false,[ids,exitClients,dispatchedClients]);
 const downstream:DischargeDownstream|null=includeDownstream&&r.events!.length===0?{
  events:r.downstream_events!,positions:r.downstream_positions!,markers:r.downstream_markers!,receipts:r.downstream_receipts!,
  pendingMoney:MONEY.map(s=>r['downstream_'+s.name]!)}:null;
 const textColumn=(x:unknown)=>x===null?null:String(x);
 return {observations:r.observations!,events:r.events!,downstream,
  markers:r.markers!.map(x=>({...x,worker_fencing_token:textColumn(x.worker_fencing_token)})),
  localNoSends:r.localNoSends!.map(x=>({...x,worker_fencing_token:textColumn(x.worker_fencing_token),
   quantity_hundredths:textColumn(x.quantity_hundredths),limit_micros:textColumn(x.limit_micros)}))};
}
