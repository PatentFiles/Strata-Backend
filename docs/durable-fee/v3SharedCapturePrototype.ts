/** ISOLATED PROTOTYPE ONLY. No route/issuer wiring. Never acquires a capture,
 * changes a retry lease, or turns a source proof into owner/order authority. */
import {createHash} from 'node:crypto';
import {pool} from '@workspace/db';
import {verifyOfficialFeePdfBytes,CANONICAL_FEE_SCHEDULE_URL} from '../microLiveFeeArtifact';
import {verifyMonetaryFeeContract} from './monetaryFeeContract';
const LEASE=55*60_000;
type Db={query(sql:string,args?:unknown[]):Promise<{rows:Record<string,unknown>[]}>};
type Deps={db?:Db;clock?:()=>number;fetcher?:typeof fetch;enabled?:boolean;target?:string};
const deny=(reason:string)=>({ok:false as const,reason,monetaryFeeAuthorized:false as const,tradingAuthorized:false as const});
export async function verifyV3InitialSharedCapture(owner:string,account:string,d:Deps={}){
 if(process.env.NODE_ENV!=='test'&&Object.keys(d).length)return deny('production_override_forbidden');
 if(!(d.enabled??(process.env.STRATA_V3_INITIAL_SHARED_CAPTURE_ENABLED==='true'&&process.env.STRATA_V5_RAILWAY_CAPTURE_ENABLED==='true')))
  return deny('shared_capture_feature_disabled');
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(owner)||!/^strata-account-[a-f0-9]{24}$/.test(account)||
 account!==(d.target??process.env.STRATA_V5_RAILWAY_ACCOUNT_ID))return deny('exact_owner_account_required');
 const db=d.db??pool,clock=d.clock??Date.now;
 try{
  // Existing immutable private producer table only. No caller bytes/URL/digest.
  const result=await db.query(`SELECT c.content_sha256,c.original_bytes,c.byte_length,
   c.effective_date,c.captured_at,c.expires_at,c.canonical_url,c.source_kind,c.policy_version
   FROM private.strata_railway_official_fee_capture_v5 c
   JOIN public.v13_production_account a ON a.id=c.execution_account_id
   WHERE a.owner_user_id=$1::uuid AND a.id=$2 AND a.commissioned=true
   AND a.subaccount=1 AND a.exchange_index=2
   ORDER BY c.captured_at DESC,c.capture_id DESC LIMIT 1`,[owner,account]);
  if(result.rows.length!==1)return deny('genuine_capture_missing');
  const r=result.rows[0],bytes=r.original_bytes,now=clock();
  const captured=Date.parse(String(r.captured_at)),expiry=Date.parse(String(r.expires_at));
  if(!Number.isSafeInteger(now)||!Buffer.isBuffer(bytes)||bytes.length<100||bytes.length>2_000_000||
   r.byte_length!==bytes.length||r.canonical_url!==CANONICAL_FEE_SCHEDULE_URL||
   r.source_kind!=='railway_canonical_https_direct'||r.policy_version!=='issuer_pdf_55m_signed_api_recheck_v2'||
   !Number.isFinite(captured)||captured>now||now-captured>=LEASE||expiry!==captured+LEASE||
   createHash('sha256').update(bytes).digest('hex')!==r.content_sha256)return deny('capture_invalid_or_expired');
  // Strict existing V3 July-2026 formula/document parser, not dynamic V4 acceptance.
  const parsed=await verifyOfficialFeePdfBytes(bytes);
  if(!parsed.ok||parsed.digest!==r.content_sha256||String(r.effective_date).slice(0,10)!==parsed.effectiveDate)return deny('strict_v3_document_unverified');
  const proof=await verifyMonetaryFeeContract('STEP_9',undefined,d.fetcher??globalThis.fetch,clock,
   async()=>({ok:true,digest:parsed.digest,diagnostic:{httpStatus:200,contentType:'application/pdf',
    finalOrigin:'https://kalshi.com',finalPathname:'/docs/kalshi-fee-schedule.pdf',retryAfterSeconds:null,networkAttempts:0}}));
  // Never extend original lease, including while fresh API observations run.
  if(clock()>=expiry||clock()<captured)return deny('capture_expired_during_verification');
  if(!proof.ok)return {...proof,ok:false as const};
  return {...proof,ok:true as const,sourceKind:'stored_genuine_canonical_capture' as const,
   originalCapturedAt:new Date(captured).toISOString(),captureExpiresAt:new Date(expiry).toISOString(),
   publicationFetchedNow:false as const,policyApproved:false as const,tradingAuthorized:false as const};
 }catch{return deny('shared_capture_unavailable');}
}
