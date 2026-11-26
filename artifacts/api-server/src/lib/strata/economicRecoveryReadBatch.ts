import {requireProof} from '../v13-production/types';

type Row=Record<string,unknown>;
type Query={query(sql:string,args?:unknown[]):Promise<{rows:Row[]}>};
type ReadSpec=Readonly<{name:string;table:string;scope:string;order:readonly string[];limit:number}>;
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
function statement(specs:readonly ReadSpec[],lock:boolean):string{
 const ctes=specs.map((s,i)=>`r${i} AS MATERIALIZED (
  SELECT t.*,t.xmin::text AS row_revision FROM ${s.table} t
  WHERE t.${s.scope}=$1${i?' AND (SELECT count(*) FROM r'+(i-1)+')>=0':''}
  ${s.order.length?'ORDER BY '+s.order.map(k=>'t.'+k).join(','):''}
  LIMIT ${s.limit+1} ${lock?'FOR SHARE OF t':''})`);
 return 'WITH '+ctes.join(',\n')+'\n'+specs.map((s,i)=>`SELECT '${s.name}'::text AS section,
  (SELECT jsonb_object_agg(a.attname,a.atttypid::integer) FROM pg_catalog.pg_attribute a
   WHERE a.attrelid='${s.table}'::regclass AND a.attnum>0 AND NOT a.attisdropped)
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
async function read(db:Query,account:string,specs:readonly ReadSpec[],lock:boolean){
 const result=await db.query(statement(specs,lock),[account]);
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
