/**
 * #165 V5 alternate issuer collector; genuine Railway TLS fetch only, no uploads.
 * It is not an Edge capture, fee grant, owner release or order authorizer.
 * The shared project-wide issuer cooldown is atomically enforced across egresses.
 */
import {createHash} from "node:crypto";
import {pool} from "@workspace/db";
export const V5_URL="https://kalshi.com/docs/kalshi-fee-schedule.pdf";
export const V5_VERSION="issuer_pdf_55m_signed_api_recheck_v2";
const MAX_BYTES=2_000_000, LEASE_MS=55*60_000;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const accountPattern=/^strata-account-[a-f0-9]{24}$/;
const HASH=/^[a-f0-9]{64}$/;
type Db={query(sql:string,args?:unknown[]):Promise<{rows:Record<string,unknown>[]}>};
type Deps={db?:Db;fetcher?:typeof fetch;clock?:()=>number;enabled?:()=>boolean;target?:()=>string};
const no=(reason:string,retryAt:string|null=null)=>({ok:false as const,reason,retryAt,
  tradingAuthorized:false as const,ordersSubmitted:false as const});
const sha=(b:Buffer)=>createHash("sha256").update(b).digest("hex");
const timestamp=(x:unknown)=>x instanceof Date?x.toISOString():String(x??"");
const can=(d:Deps)=>(d.enabled??(()=>process.env.STRATA_V5_RAILWAY_CAPTURE_ENABLED==="true"))();
const target=(d:Deps)=>(d.target??(()=>process.env.STRATA_V5_RAILWAY_ACCOUNT_ID??""))();
const ports=(d:Deps)=>process.env.NODE_ENV==="test"||(!d.db&&!d.fetcher&&!d.clock&&!d.enabled&&!d.target);
const selectLatest=String.raw`SELECT content_sha256,original_bytes,byte_length,effective_date,
 captured_at,expires_at,canonical_url,source_kind,policy_version
 FROM private.strata_railway_official_fee_capture_v5
 WHERE execution_account_id=$1 AND expires_at>now() AND captured_at<=now()
 ORDER BY captured_at DESC,capture_id DESC LIMIT 1`;
export async function readIndependentOfficialFeeV5(d:Deps={}):Promise<
 |{ok:true;digest:string;normalizedText:string;originalCapturedAt:string;effectiveDate:string;tradingAuthorized:false}
 |ReturnType<typeof no>>{
 if(!ports(d)||!can(d)||!accountPattern.test(target(d)))return no("v5_source_disabled_or_wrong_account");
 let rows:Record<string,unknown>[];
 try{rows=(await (d.db??pool).query(selectLatest,[target(d)])).rows;}
 catch{return no("v5_issuer_store_unavailable");}
 if(rows.length!==1)return no("v5_genuine_issuer_capture_missing");
 const r=rows[0]!,now=(d.clock??Date.now)();
 const b=r.original_bytes,at=Date.parse(timestamp(r.captured_at)),ex=Date.parse(timestamp(r.expires_at));
 if(!Buffer.isBuffer(b)||b.length<100||b.length>MAX_BYTES||r.byte_length!==b.length||
    r.canonical_url!==V5_URL||r.source_kind!=="railway_canonical_https_direct"||
    r.policy_version!==V5_VERSION||!HASH.test(String(r.content_sha256))||
    sha(b)!==r.content_sha256||!Number.isFinite(at)||at>now||now-at>=LEASE_MS||
    !Number.isFinite(ex)||ex!==at+LEASE_MS||ex<=now)
   return no("v5_issuer_capture_corrupted_or_expired");
 try{
  const [{extractFeeScheduleDocumentText},{parseDynamicKalshiPublication}]=await Promise.all([
    import("../microLiveFeeArtifact"),import("./dynamicOfficialFeeSchedule")]);
  const raw=await extractFeeScheduleDocumentText(b);
  if(!raw)return no("v5_issuer_pdf_unparseable");
  const normalizedText=raw.replace(/\s+/g," ").trim();
  const parsed=parseDynamicKalshiPublication(normalizedText,now);
  if(!parsed.ok||parsed.effectiveDate!==timestamp(r.effective_date).slice(0,10))
    return no("v5_issuer_fee_model_or_effective_date_changed");
  return {ok:true,digest:String(r.content_sha256),normalizedText,
    originalCapturedAt:new Date(at).toISOString(),effectiveDate:parsed.effectiveDate,
    tradingAuthorized:false};
 }catch{return no("v5_issuer_pdf_verification_failed");}
}
async function boundedPdf(res:Response):Promise<Buffer|null>{
 const len=res.headers.get("content-length");
 if(len!==null&&(!/^\d{1,8}$/.test(len)||Number(len)>MAX_BYTES))return null;
 if(!res.body)return null;
 const reader=res.body.getReader(),parts:Buffer[]=[];let count=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;
   count+=value.byteLength;if(count>MAX_BYTES){await reader.cancel();return null;}
   parts.push(Buffer.from(value));}}
 finally{reader.releaseLock();}
 const b=Buffer.concat(parts,count);
 return b.length>=100&&b.subarray(0,5).toString()==="%PDF-"&&
   b.subarray(Math.max(0,b.length-2048)).includes(Buffer.from("%%EOF"))?b:null;
}
function retryAfter(raw:string|null,now:number):string|null{
 if(!raw||raw.length>96)return null;
 let t=NaN;
 if(/^\d{1,8}$/.test(raw))t=now+Math.min(86_400_000,Number(raw)*1000);
 else if(/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(raw))
  t=Math.min(now+86_400_000,Date.parse(raw));
 return Number.isFinite(t)&&t>=now?new Date(t).toISOString():null;
}
/** Only a signed-in owner whose JWT passed AAL2 can invoke this from HTTP.
 * No caller-supplied bytes, URL, policy, account ID, or fee rate are accepted.
 */
export async function captureIndependentOfficialFeeV5(ownerId:string,d:Deps={}){
 if(!ports(d)||!can(d)||!accountPattern.test(target(d))||!UUID.test(ownerId))
   return no("v5_owner_or_feature_unavailable");
 const db=d.db??pool as Db,now=d.clock??Date.now;
 try{
  const owner=await db.query(String.raw`SELECT id FROM public.v13_production_account
    WHERE owner_user_id=$1::uuid AND id=$2 AND subaccount=1 AND exchange_index=2
      AND commissioned=true LIMIT 2`,[ownerId,target(d)]);
  if(owner.rows.length!==1)return no("v5_exact_commissioned_owner_required");
  const cached=await readIndependentOfficialFeeV5(d);
  if(cached.ok && Date.parse(cached.originalCapturedAt)+50*60_000>now())return {ok:true as const,reason:"v5_previous_real_capture_reused",
   digest:cached.digest,originalCapturedAt:cached.originalCapturedAt,effectiveDate:cached.effectiveDate,
   tradingAuthorized:false as const,ordersSubmitted:false as const};
  if(!cached.ok && cached.reason!=="v5_genuine_issuer_capture_missing")return no(cached.reason);
  // Account-scoped persisted circuit; never a provider request during 429 backoff.
  const circuit=await db.query("SELECT next_attempt_at FROM private.strata_railway_fee_retry_v5 WHERE execution_account_id=$1",[target(d)]);
  if(circuit.rows.length>1)return no("v5_circuit_state_invalid");
  const due=circuit.rows[0] ? Date.parse(timestamp(circuit.rows[0].next_attempt_at)) : 0;
  if(circuit.rows.length && (!Number.isFinite(due)||due>now()))
    return no("v5_issuer_circuit_open",Number.isFinite(due)?new Date(due).toISOString():null);
  const claim=await db.query(String.raw`UPDATE public.strata_official_fee_capture_throttle
    SET next_allowed_at=clock_timestamp()+interval '30 minutes'
    WHERE id=true AND next_allowed_at<=clock_timestamp() RETURNING next_allowed_at`);
  if(claim.rows.length!==1){
   const lease=await db.query("SELECT next_allowed_at FROM public.strata_official_fee_capture_throttle WHERE id=true");
   return no("v5_issuer_shared_cooldown",timestamp(lease.rows[0]?.next_allowed_at));
  }
  let res:Response;
  try{res=await (d.fetcher??globalThis.fetch)(V5_URL,{
   method:"GET",cache:"no-store",redirect:"error",headers:{Accept:"application/pdf","Cache-Control":"no-cache"},
   signal:AbortSignal.timeout(12_000) });}
  catch{return no("v5_independent_issuer_network_unavailable");}
  const retry=res.status===429?retryAfter(res.headers.get("retry-after"),now()):null;
  const status=await db.query(String.raw`UPDATE public.strata_official_fee_capture_throttle
    SET last_provider_http_status=$1,last_provider_at=clock_timestamp(),
      last_provider_retry_at=CASE WHEN $1=429 THEN GREATEST(next_allowed_at,COALESCE($2::timestamptz,next_allowed_at)) ELSE NULL END,
      next_allowed_at=CASE WHEN $1=429 THEN GREATEST(next_allowed_at,COALESCE($2::timestamptz,next_allowed_at)) ELSE next_allowed_at END
    WHERE id=true RETURNING next_allowed_at`,[res.status,retry]);
  if(status.rows.length!==1)return no("v5_upstream_status_provenance_unavailable");
  if(res.status===429){
   // First genuine rejection waits >=30m; subsequent authentic 429s wait
   // 60m,120m,... up to 6h. This independent circuit cannot shorten
   // the shared issuer-provided Retry-After deadline.
   await db.query(String.raw`INSERT INTO private.strata_railway_fee_retry_v5
     (execution_account_id,consecutive_429,next_attempt_at,last_http_status)
     VALUES($1,1,GREATEST(now()+interval '30 minutes',$2::timestamptz),429)
     ON CONFLICT(execution_account_id) DO UPDATE
       SET consecutive_429=LEAST(6,private.strata_railway_fee_retry_v5.consecutive_429+1),
           next_attempt_at=GREATEST(private.strata_railway_fee_retry_v5.next_attempt_at,
             now()+make_interval(mins=>LEAST(360,30*(1<<LEAST(4,private.strata_railway_fee_retry_v5.consecutive_429)))),
             $2::timestamptz),
           last_http_status=429,updated_at=clock_timestamp()`,[target(d),timestamp(status.rows[0]?.next_allowed_at)]);
  }
  if(res.status!==200)return no("v5_issuer_http_"+res.status,
    res.status===429?timestamp(status.rows[0]?.next_allowed_at):null);
  if(res.redirected||res.url!==V5_URL||res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()!=="application/pdf")
    return no("v5_issuer_identity_or_type_invalid");
  let b:Buffer|null;
  try{b=await boundedPdf(res);}catch{return no("v5_issuer_pdf_truncated");}
  if(!b)return no("v5_issuer_pdf_truncated");
  const capturedAt=now(); // Real provider byte-download completion; NEVER post-storage timestamp.
  const [{extractFeeScheduleDocumentText},{parseDynamicKalshiPublication}]=await Promise.all([
   import("../microLiveFeeArtifact"),import("./dynamicOfficialFeeSchedule")]);
  let raw:string|null;
  try{raw=await extractFeeScheduleDocumentText(b);}catch{return no("v5_issuer_pdf_parse_failed");}
  const parsed=raw?parseDynamicKalshiPublication(raw.replace(/\s+/g," ").trim(),capturedAt):null;
  if(!parsed?.ok)return no(parsed?.reason??"v5_issuer_pdf_parse_failed");
  const digest=sha(b),captured=new Date(capturedAt).toISOString();
  const write=await db.query(String.raw`INSERT INTO private.strata_railway_official_fee_capture_v5
    (execution_account_id,source_kind,policy_version,canonical_url,content_sha256,original_bytes,
     byte_length,effective_date,captured_at,expires_at)
    VALUES($1,'railway_canonical_https_direct',$2,$3,$4,$5,$6,$7::date,$8::timestamptz,$9::timestamptz)
    RETURNING capture_id`,[target(d),V5_VERSION,V5_URL,digest,b,b.length,
      parsed.effectiveDate,captured,new Date(capturedAt+LEASE_MS).toISOString()]);
  if(write.rows.length!==1)return no("v5_evidence_immutable_write_failed");
  // Genuine verified publisher bytes reset only THIS account's collector circuit.
  await db.query(String.raw`INSERT INTO private.strata_railway_fee_retry_v5
    (execution_account_id,consecutive_429,next_attempt_at,last_http_status)
    VALUES($1,0,now(),200)
    ON CONFLICT(execution_account_id) DO UPDATE
      SET consecutive_429=0,next_attempt_at=now(),
      last_http_status=200,updated_at=clock_timestamp()`,[target(d)]);

  return {ok:true as const,reason:"v5_genuine_railway_issuer_capture_recorded",
    digest,originalCapturedAt:captured,effectiveDate:parsed.effectiveDate,
    tradingAuthorized:false as const,ordersSubmitted:false as const};
 }catch{return no("v5_issuer_capture_or_database_unavailable");}
}
