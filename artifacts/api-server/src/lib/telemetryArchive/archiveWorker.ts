import {encodeTelemetryArchive,verifyAndReplayTelemetry,type ArchivePayload} from './archiveCodec';
import {claimArchiveBatch,readArchiveRecords,commitArchiveBatch,rejectArchiveBatch,readArchiveHealth,
 type ArchiveDatabase,type ArchiveBatch} from './archiveRepository';
import type {VerifiedReceipt} from './s3Archive';

export type ArchiveObjectStore={
 preflight():Promise<void>;
 upload(batch:ArchiveBatch,payload:ArchivePayload):Promise<VerifiedReceipt>;
 restore(receipt:VerifiedReceipt):Promise<Buffer>;
};
export type ArchiveCycle=
 {status:'idle'}|
 {status:'archived';count:number;batchId:string;bytes:number}|
 {status:'retry';batchId:string;reason:string};

const reason=(err:unknown):string=>{
 const m=err instanceof Error?err.message:'';
 const allowed=new Set([
  'telemetry_archive_source_missing_or_mismatched',
  'telemetry_archive_record_scope_invalid',
  'telemetry_archive_record_too_large',
  'telemetry_archive_batch_too_large',
  'telemetry_archive_corrupt_compressed_hash',
  'telemetry_archive_corrupt_source_hash',
  'telemetry_archive_manifest_mismatch',
  'telemetry_archive_replay_scope_mismatch',
  'telemetry_archive_replay_identity_mismatch',
  'telemetry_archive_verified_receipt_mismatch',
  'telemetry_archive_lease_lost',
  's3_archive_readback_or_retention_unverified',
  's3_archive_restore_hash_mismatch',
 ]);
 return allowed.has(m)?m:'telemetry_archive_external_or_database_failure';
};
/** Isolated from trading engine; one remote object upload per finite, idempotent
 * leased batch. It never holds a database transaction across a remote request. */
export async function archiveOne(db:ArchiveDatabase,store:ArchiveObjectStore):Promise<ArchiveCycle>{
 const batch=await claimArchiveBatch(db);
 if(!batch)return {status:'idle'};
 try{
  const rows=await readArchiveRecords(db,batch);
  const payload=encodeTelemetryArchive(batch,rows);
  const receipt=await store.upload(batch,payload);
  const downloaded=await store.restore(receipt);
  const recovered:ArchivePayload={...payload,body:downloaded};
  const ids:string[]=[];
  const verified=verifyAndReplayTelemetry(batch,recovered,r=>{ids.push(r.id);});
  if(verified!==rows.length||rows.some((r,i)=>r.id!==ids[i]))
   throw Error('telemetry_archive_replay_identity_mismatch');
  await commitArchiveBatch(db,batch,payload,receipt);
  return {status:'archived',count:rows.length,batchId:batch.id,bytes:receipt.bytes};
 }catch(e){
  if(process.env.NODE_ENV==='test')console.warn('archive_test_failure',e instanceof Error?e.message:'unknown');
  const code=reason(e);
  try{await rejectArchiveBatch(db,batch,code);}
  catch{/* Lease expiry and reclaims retain the queue. */ }
  return {status:'retry',batchId:batch.id,reason:code};
 }
}
export function evaluateArchiveHealth(
 value:Awaited<ReturnType<typeof readArchiveHealth>>,now=Date.now(),
){
 const queue=value.queue??{};
 const pending=BigInt(String(queue.awaiting_archive??0));
 const retries=BigInt(String(queue.retry_batches??0));
 const stale=BigInt(String(queue.stale_leases??0));
 const oldest=typeof queue.oldest_pending==='string'?
  Date.parse(queue.oldest_pending):NaN;
 const ageSeconds=Number.isFinite(oldest)?Math.max(0,Math.floor((now-oldest)/1000)):0;
 const latest=typeof value.heartbeats[0]?.observed_at==='string'?
  Date.parse(value.heartbeats[0].observed_at):NaN;
 const captureUnknown=!Number.isFinite(latest)||now-latest>120_000;
 const unhealthy=value.missingRecentEvents>0||retries>0n||stale>0n||
  ageSeconds>300||value.heartbeats.some(h=>
   Number(h.overflow)>0||Number(h.retry_exhausted)>0||Number(h.invalid)>0);
 return {status:unhealthy?'WARNING' as const:captureUnknown?'UNKNOWN' as const:'OK' as const,
  captureComplete:false as const,pending:pending.toString(),retryBatches:retries.toString(),
  staleLeases:stale.toString(),oldestPendingSeconds:ageSeconds,
  sourceJournalSampleMissing:value.missingRecentEvents,
  latestHeartbeatAt:value.heartbeats.length?value.heartbeats[0]?.observed_at:null};
}
export async function readTelemetryHealth(db:ArchiveDatabase,now=Date.now()){
 return evaluateArchiveHealth(await readArchiveHealth(db),now);
}
