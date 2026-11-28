import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';

export type ArchiveRecord={id:string;owner_user_id:string;execution_account_id:string;
 observed_at:string;recorded_at:string;[key:string]:unknown};
export type ArchiveScope={batchId:string;ownerId:string;day:string;createdAt:string};
export type ArchivePayload={body:Buffer;sha256:string;sourceSha256:string;recordCount:number;
 firstEventId:string;lastEventId:string};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const DAY=/^\d{4}-\d{2}-\d{2}$/;
const sha=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex');
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export function canonical(value:unknown):string{
 if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'){
  if(typeof value==='number'&&!Number.isFinite(value))throw Error('telemetry_nonfinite_number');
  return JSON.stringify(value);
 }
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(object(value))return '{'+Object.keys(value).sort().map(k=>
  JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
 throw Error('telemetry_non_json_value');
}
export function encodeTelemetryArchive(scope:ArchiveScope,records:ArchiveRecord[]):ArchivePayload{
 if(!UUID.test(scope.batchId)||!UUID.test(scope.ownerId)||!DAY.test(scope.day)||
  !Number.isFinite(Date.parse(scope.createdAt))||!records.length||records.length>1000)
  throw Error('telemetry_archive_scope_invalid');
 const seen=new Set<string>(),lines:string[]=[];
 for(const record of records){
  if(!UUID.test(record.id)||seen.has(record.id)||record.owner_user_id!==scope.ownerId||
    typeof record.execution_account_id!=='string'||record.execution_account_id.length>200||
    typeof record.observed_at!=='string'||!Number.isFinite(Date.parse(record.observed_at))||
    new Date(record.observed_at).toISOString().slice(0,10)!==scope.day)
   throw Error('telemetry_archive_record_scope_invalid');
  seen.add(record.id);
  const row=canonical(record);
  if(Buffer.byteLength(row,'utf8')>32*1024)throw Error('telemetry_archive_record_too_large');
  lines.push(row);
 }
 const source=Buffer.from(
  // Never spread a lease-bearing ArchiveBatch: attempts/token change on replay.
  canonical({schema:'STRATA_IMMUTABLE_LIVE_OBSERVATIONS_V1',batchId:scope.batchId,
    ownerId:scope.ownerId,day:scope.day,createdAt:scope.createdAt,count:records.length})+'\n'+
  lines.join('\n')+'\n','utf8');
 if(source.byteLength>16*1024*1024)throw Error('telemetry_archive_batch_too_large');
 // Node's gzip encoder emits a deterministic zero MTIME header.
 const body=gzipSync(source,{level:6});
 return {body,sha256:sha(body),sourceSha256:sha(source),recordCount:records.length,
  firstEventId:records[0]!.id,lastEventId:records[records.length-1]!.id};
}
/** Read-only archive replay: every row remains in the observation domain.
 * No live ledger, risk policy, or order-table write is available here. */
export function verifyAndReplayTelemetry(
 scope:ArchiveScope,payload:ArchivePayload,receive:(record:ArchiveRecord)=>void=()=>{},
):number{
 if(payload.body.byteLength>16*1024*1024||sha(payload.body)!==payload.sha256)
  throw Error('telemetry_archive_corrupt_compressed_hash');
 const source=gunzipSync(payload.body,{maxOutputLength:16*1024*1024});
 if(sha(source)!==payload.sourceSha256)throw Error('telemetry_archive_corrupt_source_hash');
 const lines=source.toString('utf8').split('\n');
 if(lines.pop()!=='')throw Error('telemetry_archive_missing_final_newline');
 const header=JSON.parse(lines.shift()??'null') as Record<string,unknown>;
 if(!object(header)||header.schema!=='STRATA_IMMUTABLE_LIVE_OBSERVATIONS_V1'||
  header.batchId!==scope.batchId||header.ownerId!==scope.ownerId||
  header.day!==scope.day||header.createdAt!==scope.createdAt||
  header.count!==payload.recordCount||lines.length!==payload.recordCount)
  throw Error('telemetry_archive_manifest_mismatch');
 const seen=new Set<string>(),verified:ArchiveRecord[]=[];
 for(const line of lines){
  const row=JSON.parse(line) as ArchiveRecord;
  if(!object(row)||!UUID.test(row.id)||row.owner_user_id!==scope.ownerId||
   seen.has(row.id)||typeof row.observed_at!=='string'||
   !Number.isFinite(Date.parse(row.observed_at))||
   new Date(row.observed_at).toISOString().slice(0,10)!==scope.day)
   throw Error('telemetry_archive_replay_scope_mismatch');
  seen.add(row.id);verified.push(row);
 }
 if(verified.length===0||(payload.firstEventId&&verified[0]?.id!==payload.firstEventId)||
  (payload.lastEventId&&verified[verified.length-1]?.id!==payload.lastEventId))
  throw Error('telemetry_archive_replay_identity_mismatch');
 // Emit only after the entire archive and identities pass verification.
 for(const row of verified)receive(row);
 return seen.size;
}
