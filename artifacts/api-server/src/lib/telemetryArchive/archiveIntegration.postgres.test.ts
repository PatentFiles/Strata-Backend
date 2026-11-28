import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pool} from '@workspace/db';
import {randomUUID} from 'node:crypto';
import {normalizeLiveDecision,writeLiveDecisionBatch} from '../v13-production/liveDecisionAnalytics';
import {archiveOne,readTelemetryHealth} from './archiveWorker';
import {claimArchiveBatch,readArchiveRecords,enqueueExistingJournal} from './archiveRepository';
import {encodeTelemetryArchive,verifyAndReplayTelemetry,type ArchivePayload} from './archiveCodec';
import type {ArchiveBatch} from './archiveRepository';

const URL=process.env.V13_DISPOSABLE_DATABASE_URL;
assert.match(URL??'',/^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/);
assert.equal(process.env.DATABASE_URL,URL);assert.equal(process.env.NODE_ENV,'test');
const A='10000000-0000-4000-8000-000000000001',B='20000000-0000-4000-8000-000000000002';
const sha='a'.repeat(40),day=new Date().toISOString().slice(0,10);
const input=(ownerId:string,accountId:string,n:number)=>({
 ownerId,accountId,releaseSha:sha,observedAtMs:Date.now()-100_000+n*120,
 stage:'OBSERVATION' as const,outcome:'PASS' as const,reasonCode:'telemetry_test_pass',
 configuredStakeCents:500,facts:{btcPrice:60000+n,target:60010,velocity:0},
});
class FakeLock{
 writes=new Map<string,{data:Buffer;payload:ArchivePayload;version:string}>();
 dropReceiptOnce=false;corruptRestore=false;
 async preflight(){}
 async upload(batch:ArchiveBatch,payload:ArchivePayload){
  let v=this.writes.get(batch.objectKey);
  if(!v){v={data:Buffer.from(payload.body),payload,version:randomUUID()};this.writes.set(batch.objectKey,v);}
  assert.equal(v.payload.sha256,payload.sha256);
  if(this.dropReceiptOnce){this.dropReceiptOnce=false;throw Error('simulated_s3_network_timeout_after_commit');}
  return {versionId:v.version,key:batch.objectKey,sha256:v.payload.sha256,
   sourceSha256:v.payload.sourceSha256,bytes:v.data.byteLength};
 }
 async restore(receipt:{key:string}){
  const v=this.writes.get(receipt.key);if(!v)throw Error('not_found');
  const buf=Buffer.from(v.data);if(this.corruptRestore)buf[buf.length-1]^=1;
  return buf;
 }
}
before(async()=>{
 await pool.query(`CREATE TABLE public.v13_production_account(
  id text PRIMARY KEY,owner_user_id uuid NOT NULL,subaccount integer,exchange_index integer);
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  `);
 await pool.query(`INSERT INTO public.v13_production_account(id,owner_user_id,subaccount,exchange_index)
    VALUES ('account-a',$1,1,2),('account-b',$2,1,2)`,[A,B]);
 await pool.query(readFileSync('../../lib/db/drizzle/0050_strata_live_decision_history.sql','utf8'));
 await pool.query(readFileSync('../../supabase/migrations/20261127230000_durable_live_telemetry_archive.sql','utf8'));
});
after(()=>pool.end());
test('journal outbox is same-transaction, private, and does not grant financial or exchange authority',async()=>{
 const e=normalizeLiveDecision(input(A,'account-a',1))!;
 const c=await pool.connect();
 try{
  await c.query('BEGIN');await writeLiveDecisionBatch(c,[e]);
  const within=await c.query(`SELECT event_id FROM private.strata_telemetry_archive_queue_v1 WHERE event_id=$1`,[e.id]);
  assert.equal(within.rows.length,1);
  await c.query('ROLLBACK');
  const after=await pool.query(`SELECT event_id FROM private.strata_telemetry_archive_queue_v1 WHERE event_id=$1`,[e.id]);
  assert.equal(after.rows.length,0);
 }finally{c.release();}
 const role=await pool.query(`SELECT has_table_privilege('authenticated','private.strata_telemetry_archive_queue_v1','SELECT') AS browser,
 has_table_privilege('strata_telemetry_archiver','public.v13_production_account','UPDATE') AS money,
 has_table_privilege('strata_telemetry_archiver','private.strata_telemetry_archive_queue_v1','INSERT') AS writer`);
 assert.equal(role.rows[0].browser,false);assert.equal(role.rows[0].money,false);
 assert.equal(role.rows[0].writer,true);
});
test('atomic archive from two owners, stable object keys and replay with exact ack',async()=>{
 for(let i=0;i<15;i++){
  assert.equal(await writeLiveDecisionBatch(pool,[normalizeLiveDecision(input(A,'account-a',i))!]),1);
  assert.equal(await writeLiveDecisionBatch(pool,[normalizeLiveDecision(input(B,'account-b',i))!]),1);
 }
 const fake=new FakeLock();
 const a=await archiveOne(pool,fake);
 assert.equal(a.status,'archived');
 const b=await archiveOne(pool,fake);
 assert.equal(b.status,'archived');
 assert.equal(fake.writes.size,2);
 const counts=await pool.query(`SELECT owner_user_id,count(*)::int AS n,
  count(*) FILTER(WHERE archive_confirmed_at IS NOT NULL)::int AS archived
  FROM private.strata_telemetry_archive_queue_v1 GROUP BY owner_user_id`);
 assert.equal(counts.rows.length,2);
 for(const row of counts.rows){assert.equal(row.n,15);assert.equal(row.archived,15);}
 const health=await readTelemetryHealth(pool);
 assert.equal(health.pending,'0');
 // No capture heartbeat has been issued yet: honest coverage is UNKNOWN.
 assert.equal(health.status,'UNKNOWN');assert.equal(health.captureComplete,false);
});
test('lost upload acknowledgement never overwrites object, never acknowledges uncertain batch',async()=>{
 const e=normalizeLiveDecision(input(A,'account-a',20))!;
 await writeLiveDecisionBatch(pool,[e]);
 const fake=new FakeLock();fake.dropReceiptOnce=true;
 const rejected=await archiveOne(pool,fake);
 assert.equal(rejected.status,'retry');
 assert.equal(fake.writes.size,1);
 const beforeAck=await pool.query(`SELECT archive_confirmed_at FROM private.strata_telemetry_archive_queue_v1 WHERE event_id=$1`,[e.id]);
 assert.equal(beforeAck.rows[0].archive_confirmed_at,null);
 await pool.query(`UPDATE private.strata_telemetry_archive_batch_v1 SET retry_after=clock_timestamp()-interval '1 second'
  WHERE state='RETRY'`);
 const good=await archiveOne(pool,fake);
 assert.equal(good.status,'archived',JSON.stringify(good));
 assert.equal(fake.writes.size,1);
 const confirmed=await pool.query(`SELECT archive_confirmed_at FROM private.strata_telemetry_archive_queue_v1 WHERE event_id=$1`,[e.id]);
 assert.ok(confirmed.rows[0].archive_confirmed_at);
});
test('corrupt remote restore cannot ack and subsequent exact retry recovers',async()=>{
 const e=normalizeLiveDecision(input(A,'account-a',30))!;
 await writeLiveDecisionBatch(pool,[e]);
 const fake=new FakeLock();fake.corruptRestore=true;
 assert.equal((await archiveOne(pool,fake)).status,'retry');
 const prior=await pool.query(`SELECT archive_confirmed_at FROM private.strata_telemetry_archive_queue_v1 WHERE event_id=$1`,[e.id]);
 assert.equal(prior.rows[0].archive_confirmed_at,null);
 fake.corruptRestore=false;
 await pool.query(`UPDATE private.strata_telemetry_archive_batch_v1 SET retry_after=clock_timestamp()-interval '1 second'
  WHERE state='RETRY'`);
 assert.equal((await archiveOne(pool,fake)).status,'archived');
});
test('lease expiry after staged upload reclaims exact batch and resists duplicate event IDs',async()=>{
 const e=normalizeLiveDecision(input(B,'account-b',50))!;
 await writeLiveDecisionBatch(pool,[e]);
 const first=await claimArchiveBatch(pool)!;assert.ok(first);
 const original=await readArchiveRecords(pool,first);
 const fake=new FakeLock();
 const p=encodeTelemetryArchive(first,original);
 await fake.upload(first,p);
 await pool.query(`UPDATE private.strata_telemetry_archive_batch_v1
  SET leased_until=clock_timestamp()-interval '1 second' WHERE id=$1`,[first.id]);
 const resumed=await archiveOne(pool,fake);
 assert.equal(resumed.status,'archived',JSON.stringify(resumed));
 assert.equal(fake.writes.size,1);
 const row=await pool.query(`SELECT count(*)::int AS n FROM private.strata_telemetry_archive_batch_v1 WHERE id=$1`,[first.id]);
 assert.equal(row.rows[0].n,1);
 const requeued=await enqueueExistingJournal(pool);
 assert.equal(requeued,0);
});
test('capture/queue health flags missing source and retry backlog',async()=>{
 const e=normalizeLiveDecision(input(A,'account-a',70))!;
 await writeLiveDecisionBatch(pool,[e]);
 const health=await readTelemetryHealth(pool);
 assert.equal(health.status,'UNKNOWN',JSON.stringify(health));assert.equal(health.captureComplete,false);assert.equal(health.pending,'1');
 await pool.query(`DELETE FROM private.strata_telemetry_archive_queue_v1 WHERE event_id=$1`,[e.id]);
 const missing=await readTelemetryHealth(pool);
 assert.equal(missing.status,'WARNING');assert.ok(missing.sourceJournalSampleMissing>0);
 assert.equal(await enqueueExistingJournal(pool),1);
});
test('tampered gzip, mismatched batch owner, changed body are rejected before replay',()=>{
 const scope={batchId:randomUUID(),ownerId:A,day,createdAt:new Date().toISOString()};
 const event={id:randomUUID(),owner_user_id:A,execution_account_id:'account-a',
  observed_at:new Date().toISOString(),recorded_at:new Date().toISOString()};
 const p=encodeTelemetryArchive(scope,[event]);
 assert.equal(verifyAndReplayTelemetry(scope,p),1);
 const broken={...p,body:Buffer.from(p.body)};broken.body[8]^=1;
 assert.throws(()=>verifyAndReplayTelemetry(scope,broken),/corrupt_compressed_hash/);
 assert.throws(()=>verifyAndReplayTelemetry({...scope,ownerId:B},p),/manifest_mismatch/);
 assert.throws(()=>encodeTelemetryArchive(scope,[{...event,owner_user_id:B}]),/record_scope_invalid/);
});
