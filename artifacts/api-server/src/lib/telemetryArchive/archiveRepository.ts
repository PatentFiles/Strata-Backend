import {randomUUID} from 'node:crypto';
import type {ArchiveRecord,ArchiveScope,ArchivePayload} from './archiveCodec';

export type QueryResult={rows:Record<string,unknown>[];rowCount?:number|null};
export type ArchiveQuery={query:(sql:string,values?:unknown[])=>Promise<QueryResult>};
export type ArchiveClient=ArchiveQuery&{release:(error?:Error)=>void};
export type ArchiveDatabase=ArchiveQuery&{connect:()=>Promise<ArchiveClient>};
export type ArchiveBatch=ArchiveScope&{id:string;objectKey:string;leaseToken:string;
 attempts:number;eventCount:number;state:'LEASED'|'RETRY'|'ARCHIVED'};
type Receipt={versionId:string;key:string;sha256:string;sourceSha256:string;bytes:number};
const MAX=256;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const batchFrom=(row:Record<string,unknown>):ArchiveBatch=>({
 id:String(row.id),batchId:String(row.id),ownerId:String(row.owner_user_id),
 day:String(row.observed_day),createdAt:String(row.created_at),
 objectKey:String(row.object_key),leaseToken:String(row.lease_token),
 attempts:Number(row.attempts),eventCount:Number(row.event_count),
 state:String(row.state) as ArchiveBatch['state'],
});
async function transaction<T>(db:ArchiveDatabase,run:(tx:ArchiveClient)=>Promise<T>):Promise<T>{
 const tx=await db.connect();let committed=false,discard:Error|undefined;
 try{
  await tx.query('BEGIN');
  await tx.query("SET LOCAL statement_timeout='6s'");
  await tx.query("SET LOCAL lock_timeout='750ms'");
  const result=await run(tx);
  await tx.query('COMMIT');committed=true;return result;
 }catch(e){try{await tx.query('ROLLBACK');}catch{discard=Error('archive_rollback_unknown');}throw e;}
 finally{tx.release(discard);}
}
const rowCount=(r:QueryResult)=>Number(r.rowCount??r.rows.length);
export async function claimArchiveBatch(db:ArchiveDatabase,limit=MAX):Promise<ArchiveBatch|null>{
 if(!Number.isInteger(limit)||limit<1||limit>MAX)throw Error('telemetry_archive_limit_invalid');
 return transaction(db,async tx=>{
  const existing=await tx.query(`SELECT id,owner_user_id,observed_day::text,created_at::text,object_key,lease_token,attempts,event_count,state
   FROM private.strata_telemetry_archive_batch_v1
   WHERE (state='RETRY' AND retry_after<=clock_timestamp())
      OR (state='LEASED' AND leased_until<=clock_timestamp())
   ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`);
  const token=randomUUID();
  if(existing.rows.length){
   const b=existing.rows[0]!;
   const renewed=await tx.query(`UPDATE private.strata_telemetry_archive_batch_v1
    SET state='LEASED',lease_token=$2,leased_until=clock_timestamp()+interval '3 minutes',
       attempts=attempts+1,last_error_code=NULL
    WHERE id=$1 AND state IN ('LEASED','RETRY')
    RETURNING id,owner_user_id,observed_day::text,created_at::text,object_key,lease_token,attempts,event_count,state`,
    [b.id,token]);
   if(renewed.rows.length!==1)throw Error('telemetry_archive_reclaim_race');
   return batchFrom(renewed.rows[0]!);
  }
  const seed=await tx.query(`SELECT event_id,owner_user_id,observed_day::text
   FROM private.strata_telemetry_archive_queue_v1
   WHERE archive_batch_id IS NULL ORDER BY recorded_at,event_id
   LIMIT 1 FOR UPDATE SKIP LOCKED`);
  if(!seed.rows.length)return null;
  const owner=String(seed.rows[0]!.owner_user_id),day=String(seed.rows[0]!.observed_day);
  if(!UUID.test(owner)||!/^\d{4}-\d{2}-\d{2}$/.test(day))throw Error('telemetry_archive_seed_invalid');
  const claimed=await tx.query(`SELECT event_id FROM private.strata_telemetry_archive_queue_v1
   WHERE archive_batch_id IS NULL AND owner_user_id=$1::uuid AND observed_day=$2::date
   ORDER BY recorded_at,event_id LIMIT $3 FOR UPDATE SKIP LOCKED`,[owner,day,limit]);
  const ids=claimed.rows.map(x=>String(x.event_id));
  if(!ids.length||ids.length>limit)throw Error('telemetry_archive_claim_empty');
  const id=randomUUID(),key=`telemetry/v1/${owner}/${day}/batch-${id}.jsonl.gz`;
  const ins=await tx.query(`INSERT INTO private.strata_telemetry_archive_batch_v1
   (id,owner_user_id,observed_day,state,lease_token,leased_until,event_count,object_key)
   VALUES ($1,$2::uuid,$3::date,'LEASED',$4,clock_timestamp()+interval '3 minutes',$5,$6)
   RETURNING id,owner_user_id,observed_day::text,created_at::text,object_key,lease_token,attempts,event_count,state`,
   [id,owner,day,token,ids.length,key]);
  if(ins.rows.length!==1)throw Error('telemetry_archive_batch_insert_failed');
  const update=await tx.query(`UPDATE private.strata_telemetry_archive_queue_v1
    SET archive_batch_id=$1
    WHERE event_id=ANY($2::uuid[]) AND archive_batch_id IS NULL
    RETURNING event_id`,[id,ids]);
  if(rowCount(update)!==ids.length)throw Error('telemetry_archive_membership_race');
  return batchFrom(ins.rows[0]!);
 });
}
export async function readArchiveRecords(db:ArchiveQuery,batch:ArchiveBatch):Promise<ArchiveRecord[]>{
 const response=await db.query(`SELECT to_jsonb(d) AS event
  FROM private.strata_telemetry_archive_queue_v1 q
  JOIN private.strata_live_decision_log_v1 d ON d.id=q.event_id
  WHERE q.archive_batch_id=$1 AND q.owner_user_id=$2::uuid
    AND d.owner_user_id=q.owner_user_id AND q.observed_day=$3::date
  ORDER BY q.recorded_at,q.event_id LIMIT 257`,
  [batch.batchId,batch.ownerId,batch.day]);
 const items=response.rows.map(x=>x.event as ArchiveRecord);
 if(items.length!==batch.eventCount)throw Error('telemetry_archive_source_missing_or_mismatched');
 return items;
}
export async function commitArchiveBatch(
 db:ArchiveDatabase,batch:ArchiveBatch,payload:ArchivePayload,receipt:Receipt,
):Promise<void>{
 if(receipt.key!==batch.objectKey||receipt.sha256!==payload.sha256||
  receipt.sourceSha256!==payload.sourceSha256||receipt.bytes!==payload.body.byteLength||
  !receipt.versionId||receipt.versionId.length>300||payload.recordCount!==batch.eventCount)
  throw Error('telemetry_archive_verified_receipt_mismatch');
 await transaction(db,async tx=>{
  const locked=await tx.query(`SELECT id,state,event_count FROM private.strata_telemetry_archive_batch_v1
   WHERE id=$1 AND lease_token=$2 AND leased_until>clock_timestamp() FOR UPDATE`,
   [batch.id,batch.leaseToken]);
  if(locked.rows.length!==1||locked.rows[0]!.state!=='LEASED'||
   Number(locked.rows[0]!.event_count)!==batch.eventCount)
   throw Error('telemetry_archive_lease_lost');
  const rows=await tx.query(`UPDATE private.strata_telemetry_archive_queue_v1
   SET archive_confirmed_at=clock_timestamp()
   WHERE archive_batch_id=$1 AND archive_confirmed_at IS NULL RETURNING event_id`,[batch.id]);
  if(rowCount(rows)!==batch.eventCount)throw Error('telemetry_archive_ack_count_mismatch');
  const committed=await tx.query(`UPDATE private.strata_telemetry_archive_batch_v1 SET
    state='ARCHIVED',archived_at=clock_timestamp(),object_version_id=$3,
    compressed_sha256=$4,uncompressed_sha256=$5,compressed_bytes=$6,
    last_error_code=NULL
    WHERE id=$1 AND lease_token=$2 AND state='LEASED' RETURNING id`,
    [batch.id,batch.leaseToken,receipt.versionId,receipt.sha256,receipt.sourceSha256,receipt.bytes]);
  if(committed.rows.length!==1)throw Error('telemetry_archive_ack_lost');
 });
}
export async function rejectArchiveBatch(db:ArchiveDatabase,batch:ArchiveBatch,reason:string):Promise<boolean>{
 if(!/^[a-z0-9_]{3,100}$/.test(reason))throw Error('telemetry_archive_failure_code_invalid');
 const delay=Math.min(3600,Math.round(10*Math.pow(2,Math.min(batch.attempts,8))));
 const result=await db.query(`UPDATE private.strata_telemetry_archive_batch_v1
   SET state='RETRY',leased_until=clock_timestamp(),
    retry_after=clock_timestamp()+($3::int * interval '1 second'),last_error_code=$4
   WHERE id=$1 AND lease_token=$2 AND state='LEASED' RETURNING id`,
   [batch.id,batch.leaseToken,delay,reason]);
 return result.rows.length===1;
}
export async function enqueueExistingJournal(db:ArchiveQuery,limit=500):Promise<number>{
 if(!Number.isInteger(limit)||limit<1||limit>500)throw Error('telemetry_archive_backfill_limit_invalid');
 const result=await db.query(`WITH candidate AS MATERIALIZED (
  SELECT d.id,d.owner_user_id,d.execution_account_id,
    (d.observed_at AT TIME ZONE 'UTC')::date observed_day,d.recorded_at
  FROM private.strata_live_decision_log_v1 d
  WHERE NOT EXISTS (SELECT 1 FROM private.strata_telemetry_archive_queue_v1 q WHERE q.event_id=d.id)
  ORDER BY d.observed_at,d.id LIMIT $1
 ) INSERT INTO private.strata_telemetry_archive_queue_v1
  (event_id,owner_user_id,execution_account_id,observed_day,recorded_at)
 SELECT id,owner_user_id,execution_account_id,observed_day,recorded_at FROM candidate
 ON CONFLICT(event_id) DO NOTHING RETURNING event_id`,[limit]);
 return result.rows.length;
}
export async function readArchiveHealth(db:ArchiveQuery){
 const q=await db.query(`SELECT
  count(*) FILTER (WHERE archive_confirmed_at IS NULL)::bigint::text AS awaiting_archive,
  count(*) FILTER (WHERE archive_confirmed_at IS NOT NULL)::bigint::text AS archived_records,
  min(recorded_at) FILTER (WHERE archive_confirmed_at IS NULL)::text AS oldest_pending,
  (SELECT count(*)::bigint::text FROM private.strata_telemetry_archive_batch_v1
    WHERE state='RETRY') AS retry_batches,
  (SELECT count(*)::bigint::text FROM private.strata_telemetry_archive_batch_v1
    WHERE state='LEASED' AND leased_until<clock_timestamp()) AS stale_leases
 FROM private.strata_telemetry_archive_queue_v1`);
 const h=await db.query(`SELECT instance_id,observed_at::text,accepted,confirmed,overflow,
   retry_exhausted,rejected,invalid,pending
  FROM private.strata_telemetry_capture_health_v1 ORDER BY observed_at DESC LIMIT 10`);
 const gap=await db.query(`SELECT count(*)::int AS misses FROM (
  SELECT d.id FROM private.strata_live_decision_log_v1 d
  ORDER BY d.observed_at DESC,d.id DESC LIMIT 1000
 ) sampled LEFT JOIN private.strata_telemetry_archive_queue_v1 q ON q.event_id=sampled.id
 WHERE q.event_id IS NULL`);
 return {queue:q.rows[0]??null,heartbeats:h.rows,missingRecentEvents:Number(gap.rows[0]?.misses??0)};
}
