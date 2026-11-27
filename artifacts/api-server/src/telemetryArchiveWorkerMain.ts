import pg from 'pg';
import {poolConfig} from '@workspace/db/pool-config';
import {setTimeout as sleep} from 'node:timers/promises';
import {archiveOne,readTelemetryHealth} from './lib/telemetryArchive/archiveWorker';
import {archiveStoreFromEnvironment} from './lib/telemetryArchive/s3Archive';
import {enqueueExistingJournal} from './lib/telemetryArchive/archiveRepository';
import {verifyAndReplayTelemetry} from './lib/telemetryArchive/archiveCodec';
import type {ArchiveQuery,ArchiveBatch} from './lib/telemetryArchive/archiveRepository';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const safeLog=(event:string,details:Record<string,unknown>)=>
 console.log(JSON.stringify({event,at:new Date().toISOString(),...details}));
async function main(){
 const env=process.env,args=process.argv.slice(2);
 const statusOnly=args.length===1&&args[0]==='--status';
 const backfillOnce=args.length===1&&args[0]==='--backfill-once';
 const verifyOne=args.length===2&&args[0]==='--verify-one'&&UUID.test(args[1]??'');
 const ordinary=args.length===0;
 if(!ordinary&&!statusOnly&&!backfillOnce&&!verifyOne)
  throw Error('telemetry_archive_command_not_allowed');
 if(env.NODE_ENV!=='production'||
  env.STRATA_TELEMETRY_ARCHIVER_SERVICE!=='ARCHIVER_ONLY')
  throw Error('telemetry_archive_service_boundary_required');
 if(ordinary&&env.STRATA_TELEMETRY_ARCHIVE_ENABLED!=='true')
  throw Error('telemetry_archive_worker_not_authorized');
 if(backfillOnce&&env.STRATA_ARCHIVE_BACKFILL_APPROVED!=='true')
  throw Error('telemetry_archive_backfill_not_authorized');
 if(!env.STRATA_ARCHIVE_DATABASE_URL)throw Error('telemetry_archive_private_database_required');
 const db=new pg.Pool({...poolConfig(env.STRATA_ARCHIVE_DATABASE_URL,env),
  max:2,idleTimeoutMillis:15_000,connectionTimeoutMillis:3000});
 const controller=new AbortController(),stop=()=>controller.abort();
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
 try{
  const dbRole=await db.query<{current_user:string}>('SELECT current_user::text');
  if(dbRole.rows[0]?.current_user!=='strata_telemetry_archiver')
   throw Error('telemetry_archive_db_role_not_least_privilege');
  const schema=await db.query(`SELECT to_regclass('private.strata_telemetry_archive_queue_v1') IS NOT NULL AS ready`);
  if(schema.rows[0]?.ready!==true)throw Error('telemetry_archive_schema_not_applied');
  if(statusOnly){
   safeLog('telemetry_archive_status',await readTelemetryHealth(db));return;
  }
  if(backfillOnce){
   const rows=await enqueueExistingJournal(db,500);
   safeLog('telemetry_archive_backfill', {rows});return;
  }
  const storage=archiveStoreFromEnvironment(env);await storage.preflight();
  if(verifyOne){
   const r=await db.query(`SELECT id,owner_user_id,observed_day::text,
    created_at::text,event_count,object_key,object_version_id,compressed_sha256,
    uncompressed_sha256,compressed_bytes FROM private.strata_telemetry_archive_batch_v1
    WHERE id=$1 AND state='ARCHIVED' LIMIT 1`,[args[1]]);
   const b=r.rows[0];
   if(!b)throw Error('telemetry_archive_verify_batch_not_found');
   const batch={batchId:String(b.id),ownerId:String(b.owner_user_id),
    day:String(b.observed_day),createdAt:String(b.created_at)};
   const receipt={key:String(b.object_key),versionId:String(b.object_version_id),
    sha256:String(b.compressed_sha256),sourceSha256:String(b.uncompressed_sha256),
    bytes:Number(b.compressed_bytes)};
   const body=await storage.restore(receipt);
   const count=verifyAndReplayTelemetry(batch,{body,sha256:receipt.sha256,
     sourceSha256:receipt.sourceSha256,recordCount:Number(b.event_count),
     firstEventId:'',lastEventId:''}); // IDs are verified by archive payload only in active writer.
   safeLog('telemetry_archive_restored', {batchId:batch.batchId,records:count,bytes:body.length});
   return;
  }
  let lastHealth=0;
  safeLog('telemetry_archive_started',{writer:'S3_OBJECT_LOCK_COMPLIANCE',databaseRole:'strata_telemetry_archiver'});
  while(!controller.signal.aborted){
   try{
    const result=await archiveOne(db,storage);
    if(result.status==='archived')safeLog('telemetry_archive_batch_archived',
     {batchId:result.batchId,records:result.count,bytes:result.bytes});
    else if(result.status==='retry')safeLog('telemetry_archive_retry',result);
    if(Date.now()-lastHealth>60_000){
     lastHealth=Date.now();
     const health=await readTelemetryHealth(db);
     if(health.status!=='OK')console.warn(JSON.stringify({event:'telemetry_archive_gap_or_capture_unknown',...health}));
     else safeLog('telemetry_archive_healthy',health);
    }
    await sleep(result.status==='idle'?1500:200,undefined,{signal:controller.signal});
   }catch(e){
    if(controller.signal.aborted)break;
    console.warn('telemetry_archive_cycle_failure',e instanceof Error?e.name:'Unknown');
    await sleep(4000,undefined,{signal:controller.signal}).catch(()=>{});
   }
  }
 }finally{
  process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  await db.end();
 }
}
main().catch(e=>{console.error('telemetry_archive_startup_refused',
 e instanceof Error?e.message:'unknown');process.exitCode=1;});
