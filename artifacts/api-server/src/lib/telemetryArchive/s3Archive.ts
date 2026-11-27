import {
 S3Client,PutObjectCommand,HeadObjectCommand,GetObjectCommand,
 GetBucketVersioningCommand,GetObjectLockConfigurationCommand,
} from '@aws-sdk/client-s3';
import {createHash} from 'node:crypto';
import type {ArchivePayload} from './archiveCodec';
import type {ArchiveBatch} from './archiveRepository';

const BUCKET=/^[a-z0-9][a-z0-9.-]{2,61}[a-z0-9]$/;
const HASH=/^[a-f0-9]{64}$/;
const sha=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
export type VerifiedReceipt={versionId:string;key:string;sha256:string;
 sourceSha256:string;bytes:number};
export class S3ObjectLockArchive{
 constructor(private readonly client:S3Client,private readonly bucket:string,
  private readonly retentionDays:number){
  if(!BUCKET.test(bucket)||!Number.isInteger(retentionDays)||retentionDays<365||retentionDays>36500)
   throw Error('s3_archive_configuration_invalid');
 }
 /** Preflight is required on every process start, not once at migration time. */
 async preflight(){
  const [version,lock]=await Promise.all([
   this.client.send(new GetBucketVersioningCommand({Bucket:this.bucket})),
   this.client.send(new GetObjectLockConfigurationCommand({Bucket:this.bucket})),
  ]);
  if(version.Status!=='Enabled'||lock.ObjectLockConfiguration?.ObjectLockEnabled!=='Enabled')
   throw Error('s3_object_lock_or_versioning_not_enabled');
 }
 private async head(key:string,sha256:string,sourceSha256:string,bytes:number,
  expectedVersion?:string):Promise<VerifiedReceipt>{
  const result=await this.client.send(new HeadObjectCommand({
   Bucket:this.bucket,Key:key,...(expectedVersion?{VersionId:expectedVersion}:{}),
  }));
  if(result.Metadata?.sha256!==sha256||result.Metadata?.source_sha256!==sourceSha256||
   result.ContentLength!==bytes||result.ObjectLockMode!=='COMPLIANCE'||
   !result.ObjectLockRetainUntilDate||
   result.ObjectLockRetainUntilDate.getTime()<Date.now()+60_000||
   !result.VersionId)throw Error('s3_archive_readback_or_retention_unverified');
  return {versionId:result.VersionId,key,sha256,sourceSha256,bytes};
 }
 async upload(batch:ArchiveBatch,payload:ArchivePayload):Promise<VerifiedReceipt>{
  if(!/^telemetry\/v1\/[0-9a-f-]{36}\/\d{4}-\d{2}-\d{2}\/batch-[0-9a-f-]{36}\.jsonl\.gz$/.test(batch.objectKey)||
    !HASH.test(payload.sha256)||!HASH.test(payload.sourceSha256)||
    !payload.body.byteLength||payload.body.byteLength>16*1024*1024)
   throw Error('s3_archive_object_scope_invalid');
  const retention=new Date(Date.now()+this.retentionDays*86400_000);
  try{
   const saved=await this.client.send(new PutObjectCommand({
    Bucket:this.bucket,Key:batch.objectKey,Body:payload.body,
    ContentType:'application/x-ndjson',ContentEncoding:'gzip',
    ContentLength:payload.body.byteLength,ChecksumSHA256:Buffer.from(payload.sha256,'hex').toString('base64'),
    ServerSideEncryption:'AES256',
    Metadata:{sha256:payload.sha256,source_sha256:payload.sourceSha256,batch_id:batch.id},
    IfNoneMatch:'*',ObjectLockMode:'COMPLIANCE',ObjectLockRetainUntilDate:retention,
   }));
   if(!saved.VersionId)throw Error('s3_archive_version_missing');
   return this.head(batch.objectKey,payload.sha256,payload.sourceSha256,payload.body.byteLength,saved.VersionId);
  }catch(e){
   // A committed upload whose acknowledgment was lost may return 412 on
   // retry. Never overwrite; read back this exact immutable object instead.
   const status=(e as {$metadata?:{httpStatusCode?:number}})?.$metadata?.httpStatusCode;
   if(status!==412&&status!==409)throw e;
   return this.head(batch.objectKey,payload.sha256,payload.sourceSha256,payload.body.byteLength);
  }
 }
 async restore(receipt:VerifiedReceipt):Promise<Buffer>{
  if(!receipt.versionId||!HASH.test(receipt.sha256))throw Error('s3_restore_receipt_invalid');
  await this.head(receipt.key,receipt.sha256,receipt.sourceSha256,receipt.bytes,receipt.versionId);
  const out=await this.client.send(new GetObjectCommand({
   Bucket:this.bucket,Key:receipt.key,VersionId:receipt.versionId,
  }));
  if(!out.Body)throw Error('s3_archive_restore_empty');
  const data=Buffer.from(await out.Body.transformToByteArray());
  if(data.length!==receipt.bytes||sha(data)!==receipt.sha256)
   throw Error('s3_archive_restore_hash_mismatch');
  return data;
 }
}
export function archiveStoreFromEnvironment(env:NodeJS.ProcessEnv=process.env){
 const bucket=env.STRATA_TELEMETRY_S3_BUCKET,region=env.STRATA_TELEMETRY_S3_REGION;
 const days=Number(env.STRATA_TELEMETRY_RETENTION_DAYS);
 if(!bucket||!region||!/^[a-z0-9-]{3,30}$/.test(region)||!env.STRATA_TELEMETRY_RETENTION_DAYS)
  throw Error('telemetry_archive_s3_setup_missing');
 return new S3ObjectLockArchive(new S3Client({region,maxAttempts:3}),bucket,days);
}
