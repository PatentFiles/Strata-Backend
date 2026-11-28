import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {S3Client,PutObjectCommand,HeadObjectCommand,GetObjectCommand,
 GetBucketVersioningCommand,GetObjectLockConfigurationCommand} from '@aws-sdk/client-s3';
import {S3ObjectLockArchive} from './s3Archive';
import {encodeTelemetryArchive,verifyAndReplayTelemetry} from './archiveCodec';
import {scoreRecordedBots} from './botResearchMetrics';

const owner='10000000-0000-4000-8000-000000000001';
const today=new Date().toISOString().slice(0,10);
const scope={batchId:randomUUID(),ownerId:owner,day:today,createdAt:new Date().toISOString()};
const row={id:randomUUID(),owner_user_id:owner,execution_account_id:'a',
 observed_at:new Date().toISOString(),recorded_at:new Date().toISOString(),
 stage:'OBSERVATION',outcome:'PASS',facts:{botId:'warren-buffett-delayed-cross-v1'}};
function remote({lock=true,corrupt=false}={}){
 const saved=new Map<string,{body:Buffer;meta:Record<string,string>;version:string;until:Date}>();
 const calls:string[]=[];
 return {calls,saved,client:{async send(command:unknown):Promise<any>{
  if(command instanceof GetBucketVersioningCommand)return {Status:'Enabled'};
  if(command instanceof GetObjectLockConfigurationCommand)
   return {ObjectLockConfiguration:{ObjectLockEnabled:lock?'Enabled':'Disabled'}};
  if(command instanceof PutObjectCommand){
   const input=command.input;
   const key=String(input.Key);calls.push('PUT');
   if(saved.has(key)){const e=new Error('exists') as Error&{$metadata:{httpStatusCode:number}};
    e.$metadata={httpStatusCode:412};throw e;}
   saved.set(key,{body:Buffer.from(input.Body as Buffer),meta:input.Metadata??{},
    version:randomUUID(),until:input.ObjectLockRetainUntilDate!});return {VersionId:saved.get(key)!.version};
  }
  if(command instanceof HeadObjectCommand){
   const s=saved.get(String(command.input.Key));if(!s)throw Error('not found');
   return {Metadata:s.meta,ContentLength:s.body.length,ObjectLockMode:'COMPLIANCE',
    ObjectLockRetainUntilDate:s.until,VersionId:s.version};
  }
  if(command instanceof GetObjectCommand){
   const s=saved.get(String(command.input.Key));if(!s)throw Error('not found');
   return {Body:{async transformToByteArray(){
    const data=Buffer.from(s.body);if(corrupt)data[data.length-1]^=1;return data;}}};
  }
  throw Error('unexpected command');
 }} as unknown as S3Client};
}
test('S3 Object Lock compliance preflight rejects insufficient bucket protections',async()=>{
 const insufficient=remote({lock:false});
 const store=new S3ObjectLockArchive(insufficient.client,'strata-immutable-fixture',365);
 await assert.rejects(store.preflight(),/object_lock/);
});
test('immutable object upload + exact version pin + GET restore + lost response retry',async()=>{
 const mock=remote();
 const store=new S3ObjectLockArchive(mock.client,'strata-immutable-fixture',365);
 await store.preflight();
 const body=encodeTelemetryArchive(scope,[row]);
 const batch={...scope,id:scope.batchId,objectKey:`telemetry/v1/${owner}/${today}/batch-${scope.batchId}.jsonl.gz`,
  leaseToken:randomUUID(),attempts:1,eventCount:1,state:'LEASED' as const};
 const first=await store.upload(batch,body);
 assert.equal(first.sha256,body.sha256);
 const restored=await store.restore(first);
 assert.equal(verifyAndReplayTelemetry(scope,{...body,body:restored}),1);
 const repeated=await store.upload(batch,body);
 assert.equal(repeated.versionId,first.versionId);
 assert.equal(mock.calls.filter(x=>x==='PUT').length,2);
 assert.equal(mock.saved.size,1);
});
test('restore corruption refuses different bytes despite matching object metadata',async()=>{
 const mock=remote({corrupt:true});
 const store=new S3ObjectLockArchive(mock.client,'strata-immutable-fixture',365);
 const body=encodeTelemetryArchive(scope,[row]);
 const batch={...scope,id:scope.batchId,objectKey:`telemetry/v1/${owner}/${today}/batch-${scope.batchId}.jsonl.gz`,
  leaseToken:randomUUID(),attempts:1,eventCount:1,state:'LEASED' as const};
 const receipt=await store.upload(batch,body);
 await assert.rejects(store.restore(receipt),/hash_mismatch/);
});
test('research comparison uses only recorded bot, confirmed closed net P&L, and actual fill prices',()=>{
 const id='warren-buffett-delayed-cross-v1';
 const base={row_id:'intent:1',observed_at:'2026-11-20T08:00:00Z',
  record_type:'LEDGER_INTENT' as const,status:'SETTLED_WIN',submitted_orders:1,fill_count:'1',
  bot_id:id,bot_source:'RECORDED_INTENT',
  details:{intentId:'1',intentKind:'ENTRY',closedTradeNetPnlMicros:'950000',
   closedTradeTotalFeesMicros:'50000',quotedEntryOffer:0.45,
   entryFillPriceMicros:'460000',filledHundredths:'100'}};
 const good={...base};
 const loss={...base,row_id:'intent:2',observed_at:'2026-11-21T08:00:00Z',
  status:'SETTLED_LOSS',details:{...base.details,intentId:'2',closedTradeNetPnlMicros:'-250000'}};
 const uncertain={...base,row_id:'intent:3',observed_at:'2026-11-22T08:00:00Z',
  status:'SUBMISSION_UNCERTAIN',details:{intentId:'3',intentKind:'ENTRY',closedTradeNetPnlMicros:null}};
 const inferred={...base,row_id:'intent:4',bot_source:'SELECTION_HISTORY_INFERRED'};
 const metrics=scoreRecordedBots([good,loss,uncertain,inferred]);
 assert.equal(metrics.length,1);const result=metrics[0]!;
 assert.equal(result.closedTrades,2);assert.equal(result.netPnlMicros,'700000');
 assert.equal(result.maxRealizedDrawdownMicros,'250000');
 assert.equal(result.wins,1);assert.equal(result.losses,1);
 assert.equal(result.meanAdverseEntrySlippageMicros,'10000');
});
