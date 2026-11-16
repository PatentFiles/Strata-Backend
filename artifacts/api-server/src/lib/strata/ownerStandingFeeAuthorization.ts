/**
 * Durable, explicitly owner-consented monetary permission for ONE exact
 * release/account/policy. It does not extend or rewrite short-lived V3 records.
 * The genuine official issuer publication AND current Kalshi exact-market
 * metadata are reverified before every new order; no saved digest alone may
 * authorize an entry.
 *
 * A consent expires in 24h (not indefinite): after expiry new entries close.
 * A separately proven reduce-only emergency exit may use the immutable
 * historical consent and fresh actual issuer fee terms, never entry authority.
 */
import {createHash,randomUUID} from 'node:crypto';
import {pool} from '@workspace/db';
import {deployedGitSha} from './deployedGitSha';
import {configuredOwnerSelfScope,ownerSelfEnrollmentAllowed} from './ownerSelfReviewMode';
import {parseV3FeeSource,V3_FEE_POLICY_VERSION,V3_FEE_FORMULA_VERSION,
 V3_FEE_PUBLICATION_URL,V3_FEE_AUTHORITY_SCOPE,V3_FEE_GRANT_CONFIRM} from './ownerFeeV3Authority';
import {verifyMonetaryFeeContract} from './monetaryFeeContract';
import type {ApiFeeStage} from './apiFeeGrantEligibility';

export const OWNER_STANDING_FEE_CONFIRM='I_AUTHORIZE_MY_OWN_STANDING_OFFICIAL_KALSHI_FEE_MODEL_V1';
export const OWNER_STANDING_FEE_REVOKE='I_REVOKE_MY_OWN_STANDING_OFFICIAL_KALSHI_FEE_MODEL_V1';
export const OWNER_STANDING_FEE_MAX_AGE_MS=24*60*60*1000;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{40}$/;
const HEX=/^[a-f0-9]{64}$/;
const MARKET=/^KXBTC15M-[A-Za-z0-9-]+$/;
type Row=Record<string,unknown>;
type Query={query(sql:string,args?:unknown[]):Promise<{rows:Row[]}>};
type Tx=Query&{release(error?:Error):void};
type Db=Query&{connect():Promise<Tx>};
type Deps={
 db?:Db;sha?:()=>string;clock?:()=>number;
 verify?:typeof verifyMonetaryFeeContract;
 scope?:typeof configuredOwnerSelfScope;
 enabled?:()=>boolean;
};
const fail=(reason:string)=>({ok:false as const,reason,
 monetaryFeeAuthorized:false as const,tradingAuthorized:false as const,
 ordersSubmitted:false as const,workerStarted:false as const});
const txt=(x:unknown)=>typeof x==='string'?x:'';
const time=(v:unknown)=>v instanceof Date?v.getTime():Date.parse(String(v??''));
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const allowed=(deps:Deps)=>(deps.enabled??(()=>process.env.STRATA_OWNER_STANDING_FEE_ENABLED==='true'))();
const getSha=(deps:Deps)=>(deps.sha??deployedGitSha)().toLowerCase();
const clock=(deps:Deps)=>(deps.clock??Date.now)();
const checked=(deps:Deps,stage:ApiFeeStage,ticker?:string)=>
 (deps.verify??verifyMonetaryFeeContract)(stage,ticker);
const sourceConfirmation=(owner:string,account:string,sha:string,policy:string,id:string,bytes:string)=>
 digest({kind:'OWNER_STANDING_FEE_V1',owner,account,sha,policy,id,bytes,
  confirmation:OWNER_STANDING_FEE_CONFIRM});
export type StandingFeeIdentity={
 consentId:string;ownerId:string;accountId:string;sourceAuthorityId:string;
 sourceUrl:string;sourceDigest:string;sha:string;policyHash:string;
 marketTicker:string;verifiedAtMs:number;validUntil:string;
};
export type StandingFeeResult=
 | ReturnType<typeof fail>
 | {ok:true;reason:'owner_standing_monetary_fee_current';monetaryFeeAuthorized:true;
    tradingAuthorized:false;ordersSubmitted:false;workerStarted:false;identity:StandingFeeIdentity};

/** Only call this for actual owner V3 fee policies. A legacy reviewed V2
 * source never qualifies and cannot borrow owner identity.
 */
export async function verifyOwnerStandingFee(
 ownerId:string,stage:ApiFeeStage,sourceUrl:string,marketTicker?:string,
 deps:Deps&{transaction?:Query}={}
):Promise<StandingFeeResult>{
 const sha=getSha(deps),id=parseV3FeeSource(sourceUrl);
 if(!allowed(deps))return fail('owner_standing_fee_feature_disabled');
 if(!UUID.test(ownerId)||!SHA.test(sha)||!id||
  !['STEP_9','STEP_11','ORDER_ENTRY'].includes(stage)||
  (stage==='ORDER_ENTRY'&&!MARKET.test(txt(marketTicker))))
  return fail('owner_standing_fee_identity_or_stage_invalid');
 const db=deps.transaction??deps.db??pool;
 // Read and lock source consent before the official provider request. A final
 // executor TX retains these FOR SHARE locks through signed IOC POST so owner
 // revocation takes the conflicting FOR UPDATE lock.
 try{
  const grant=await db.query(`SELECT s.consent_id::text,s.owner_user_id::text,
     s.execution_account_id,s.source_authority_id::text,
     s.approved_policy_hash,s.official_source_digest,s.expires_at,
     s.consent_digest,s.release_commit_sha
   FROM private.strata_owner_standing_fee_v1 s
   JOIN private.strata_owner_fee_authority_v3 g
     ON g.authority_id=s.source_authority_id
     AND g.owner_user_id=s.owner_user_id
     AND g.execution_account_id=s.execution_account_id
     AND g.release_commit_sha=s.release_commit_sha
     AND g.official_source_digest=s.official_source_digest
   JOIN private.strata_owner_fee_evidence_v3 e
     ON e.attestation_id=g.attestation_id
     AND e.owner_user_id=g.owner_user_id
     AND e.execution_account_id=g.execution_account_id
     AND e.release_commit_sha=g.release_commit_sha
     AND e.source_digest=g.official_source_digest
   JOIN public.v13_production_account a ON a.id=s.execution_account_id
     AND a.owner_user_id=s.owner_user_id AND a.subaccount=1 AND a.exchange_index=2
   JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
   WHERE s.owner_user_id=$1::uuid AND s.release_commit_sha=$2
     AND s.source_authority_id=$3::uuid AND p.state='APPROVED'
     AND p.policy_hash=s.approved_policy_hash
     AND p.fee_source_url=$4
     AND p.fee_policy_version=$5 AND p.fee_formula_version=$6
     AND s.fee_policy_version=$5 AND s.formula_version=$6
     AND s.confirmation=$7 AND s.scope=$8
     AND g.confirmation=$9
     AND g.official_source_url=$10
     AND g.revoked_at IS NULL AND e.revoked_at IS NULL
     AND s.revoked_at IS NULL AND s.consented_at<=clock_timestamp()
     AND s.expires_at>clock_timestamp()+interval '30 seconds'
     AND g.issued_at<=s.consented_at
   LIMIT 2 FOR SHARE OF s,g,e,a,p`,
   [ownerId,sha,id,sourceUrl,V3_FEE_POLICY_VERSION,V3_FEE_FORMULA_VERSION,
    OWNER_STANDING_FEE_CONFIRM,V3_FEE_AUTHORITY_SCOPE,V3_FEE_GRANT_CONFIRM,
    V3_FEE_PUBLICATION_URL]);
  if(grant.rows.length!==1)return fail('owner_standing_fee_missing_revoked_or_expired');
  const row=grant.rows[0]!;
  const account=txt(row.execution_account_id),policy=txt(row.approved_policy_hash);
  const bytes=txt(row.official_source_digest);
  if(!UUID.test(txt(row.consent_id))||!HEX.test(policy)||!HEX.test(bytes)||
    row.consent_digest!==sourceConfirmation(ownerId,account,sha,policy,id,bytes))
   return fail('owner_standing_fee_record_integrity_unverified');
  const began=clock(deps);
  if(!Number.isSafeInteger(began)||began<=0)return fail('owner_standing_fee_clock_invalid');
  const actual=await checked(deps,stage,marketTicker);
  const ended=clock(deps),observedAt=time(actual.verifiedAt);
  if(!actual.ok||actual.monetaryFeeAuthorized!==true||
    actual.sourceDigest!==bytes||actual.stage!==stage||
    !MARKET.test(txt(actual.marketTicker))||
    (marketTicker!==undefined&&actual.marketTicker!==marketTicker)||
    !Number.isSafeInteger(ended)||ended<began||ended-began>15_000||
    !Number.isFinite(observedAt)||observedAt>ended+1000||ended-observedAt>15_000)
   return fail('owner_standing_fee_current_issuer_model_or_market_unverified');
  if(time(row.expires_at)<=ended+30_000)
   return fail('owner_standing_fee_consent_expired_during_provider_read');
  return {ok:true,reason:'owner_standing_monetary_fee_current',
    monetaryFeeAuthorized:true,tradingAuthorized:false,
    ordersSubmitted:false,workerStarted:false,
    identity:{consentId:txt(row.consent_id),ownerId,accountId:account,
      sourceAuthorityId:id,sourceUrl,sourceDigest:bytes,sha,
      policyHash:policy,marketTicker:txt(actual.marketTicker),
      verifiedAtMs:observedAt,validUntil:String(row.expires_at)}};
 }catch{return fail('owner_standing_fee_database_or_provider_unavailable');}
}

/** A genuine old V3 authorization (even when its short 15-min entry grant
 * expired) is fee provenance, never renewed trading authority. Only a
 * separate locked, ownership/position-validated reduce-only protective path
 * may consume it after obtaining REAL current official issuer market fees.
 */
export async function verifyOwnerV3ProtectiveFee(
 ownerId:string,accountId:string,sourceUrl:string,ticker:string,
 deps:Deps&{transaction?:Query}={}
){
 const sha=getSha(deps),id=parseV3FeeSource(sourceUrl);
 if(!UUID.test(ownerId)||!SHA.test(sha)||!id||!MARKET.test(ticker)||!accountId)
  return fail('owner_protective_fee_identity_invalid');
 if(!allowed(deps))return fail('owner_protective_fee_feature_disabled');
 try{
  const db=deps.transaction??deps.db??pool;
  const rows=await db.query(`SELECT g.official_source_digest AS source_digest
   FROM private.strata_owner_fee_authority_v3 g
   JOIN private.strata_owner_fee_evidence_v3 e ON e.attestation_id=g.attestation_id
     AND e.owner_user_id=g.owner_user_id AND e.execution_account_id=g.execution_account_id
     AND e.release_commit_sha=g.release_commit_sha AND e.source_digest=g.official_source_digest
   JOIN public.v13_production_account a
     ON a.id=g.execution_account_id AND a.owner_user_id=g.owner_user_id
   JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
   WHERE g.authority_id=$1::uuid AND g.owner_user_id=$2::uuid
     AND g.execution_account_id=$3 AND g.release_commit_sha=$4
     AND g.official_source_url=$5 AND g.confirmation=$6
     AND e.owner_confirmation='I_AUTHORIZE_MY_OWN_OFFICIAL_KALSHI_FEE_EVIDENCE_V3'
     AND p.state='APPROVED' AND p.fee_source_url=$7
     AND p.fee_policy_version=$8 AND p.fee_formula_version=$9
     AND a.fee_artifact_digest=g.official_source_digest
     AND a.commissioned=true AND a.subaccount=1 AND a.exchange_index=2
   LIMIT 2 FOR SHARE OF g,e,a,p`,
   [id,ownerId,accountId,sha,V3_FEE_PUBLICATION_URL,V3_FEE_GRANT_CONFIRM,
    sourceUrl,V3_FEE_POLICY_VERSION,V3_FEE_FORMULA_VERSION]);
  if(rows.rows.length!==1)return fail('owner_protective_historical_fee_provenance_missing');
  const bytes=txt(rows.rows[0]?.source_digest);
  if(!HEX.test(bytes))return fail('owner_protective_issuer_digest_invalid');
  const started=clock(deps);
  const actual=await checked(deps,'ORDER_ENTRY',ticker);
  const ended=clock(deps),observed=time(actual.verifiedAt);
  if(!actual.ok||!actual.monetaryFeeAuthorized||actual.stage!=='ORDER_ENTRY'||
    actual.sourceDigest!==bytes||actual.marketTicker!==ticker||
    ended<started||ended-started>15_000||
    !Number.isFinite(observed)||observed>ended+1000||ended-observed>15_000)
   return fail('owner_protective_current_issuer_fee_unverified');
  return {ok:true as const,reason:'owner_protective_issuer_fee_verified' as const,
   sourceDigest:bytes,verifiedAtMs:observed,
   monetaryFeeAuthorized:true as const,tradingAuthorized:false as const,
   ordersSubmitted:false as const,workerStarted:false as const};
 }catch{return fail('owner_protective_fee_provider_or_database_unavailable');}
}

export async function ownerStandingFeeStatus(owner:string,deps:Deps={}){
 const sha=getSha(deps);
 if(!UUID.test(owner)||!SHA.test(sha))return fail('owner_standing_fee_identity_invalid');
 try{
  const db=deps.db??pool;
  const r=await db.query(`SELECT a.id AS account_id,p.policy_hash,p.fee_source_url,
    s.consent_id::text,s.expires_at,s.revoked_at,s.source_authority_id::text
   FROM public.v13_production_account a
   JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
   LEFT JOIN private.strata_owner_standing_fee_v1 s
     ON s.owner_user_id=a.owner_user_id AND s.execution_account_id=a.id
     AND s.release_commit_sha=$2 AND s.approved_policy_hash=p.policy_hash
     AND s.revoked_at IS NULL
   WHERE a.owner_user_id=$1::uuid AND a.subaccount=1 AND a.exchange_index=2
     AND p.state='APPROVED' ORDER BY s.consented_at DESC NULLS LAST LIMIT 2`,[owner,sha]);
  if(r.rows.length!==1)return fail('owner_standing_fee_status_ambiguous');
  const row=r.rows[0]!,expiry=time(row.expires_at);
  return {ok:true as const,reason:'owner_standing_fee_status',
   accountId:txt(row.account_id),sha,policyHash:txt(row.policy_hash),
   sourceUrl:txt(row.fee_source_url),
   consentId:row.consent_id??null,
   sourceAuthorityId:row.source_authority_id??null,
   expiresAt:row.expires_at??null,
   consentCurrent:row.revoked_at===null&&Number.isFinite(expiry)&&expiry>clock(deps)+30_000,
   featureEnabled:allowed(deps),tradingAuthorized:false as const,
   ordersSubmitted:false as const};
 }catch{return fail('owner_standing_fee_status_unavailable');}
}

/** Bounded AAL2 owner grant: real provider proof, approved policy and immutable
 * original source provenance. Permits daily owner re-consent without a
 * separate human or recreating the original V3 15-minute source grant.
 */
export async function authorizeOwnerStandingFee(owner:string,raw:unknown,deps:Deps={}){
 const b=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Row:{};
 const sha=getSha(deps);
 const id=txt(b.sourceAuthorityId),account=txt(b.accountId),policy=txt(b.policyHash);
 if(!allowed(deps))return fail('owner_standing_fee_feature_disabled');
 if(!UUID.test(owner)||!SHA.test(sha)||b.expectedSha!==sha||
  !UUID.test(id)||!account||!HEX.test(policy)||b.confirmation!==OWNER_STANDING_FEE_CONFIRM||
  Object.keys(b).length!==5||Object.keys(b).some(k=>![
   'expectedSha','sourceAuthorityId','accountId','policyHash','confirmation'].includes(k)))
  return fail('owner_standing_fee_explicit_owner_scope_consent_required');
 if(!ownerSelfEnrollmentAllowed(owner,account,(deps.scope??configuredOwnerSelfScope)()))
  return fail('owner_standing_fee_account_not_enabled');
 if(process.env.NODE_ENV!=='test'&&
  (deps.db||deps.verify||deps.sha||deps.clock||deps.scope||deps.enabled))
  return fail('owner_standing_fee_production_override_forbidden');
 const started=clock(deps);
 let observation:Awaited<ReturnType<typeof verifyMonetaryFeeContract>>;
 try{observation=await checked(deps,'STEP_9');}
 catch{return fail('owner_standing_fee_official_provider_unavailable');}
 const current=clock(deps);
 if(!observation.ok||!observation.monetaryFeeAuthorized||
  !HEX.test(txt(observation.sourceDigest))||!MARKET.test(txt(observation.marketTicker))||
  current<started||current-started>15_000)
  return fail('owner_standing_fee_official_monetary_proof_invalid');
 const db=deps.db??pool as unknown as Db;
 let tx:Tx|null=null,done=false,attempted=false,discard:Error|undefined;
 try{
  tx=await db.connect();await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await tx.query("SET LOCAL lock_timeout='1500ms'");
  await tx.query("SET LOCAL statement_timeout='12000ms'");
  const rows=await tx.query(`SELECT a.id,p.policy_hash,p.fee_source_url,
      g.official_source_digest,g.authority_id::text
   FROM public.v13_production_account a
   JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
   JOIN private.strata_owner_fee_authority_v3 g ON g.owner_user_id=a.owner_user_id
     AND g.execution_account_id=a.id AND g.release_commit_sha=$3
   JOIN private.strata_owner_fee_evidence_v3 e ON e.attestation_id=g.attestation_id
     AND e.owner_user_id=g.owner_user_id AND e.execution_account_id=g.execution_account_id
     AND e.release_commit_sha=g.release_commit_sha AND e.source_digest=g.official_source_digest
   WHERE a.owner_user_id=$1::uuid AND a.id=$2
     AND a.commissioned=true AND a.subaccount=1 AND a.exchange_index=2
     AND a.blocked_reason IS NULL AND p.state='APPROVED'
     AND p.policy_hash=$4 AND p.fee_policy_version=$5 AND p.fee_formula_version=$6
     AND p.fee_source_url=$7 AND g.authority_id=$8::uuid
     AND g.policy_version=$5 AND g.formula_version=$6
     AND g.scope=$9 AND g.confirmation=$10
     AND g.revoked_at IS NULL AND e.revoked_at IS NULL
     AND e.owner_confirmation='I_AUTHORIZE_MY_OWN_OFFICIAL_KALSHI_FEE_EVIDENCE_V3'
     AND a.fee_artifact_digest=g.official_source_digest
   FOR UPDATE OF a FOR SHARE OF p,g,e`,
   [owner,account,sha,policy,V3_FEE_POLICY_VERSION,V3_FEE_FORMULA_VERSION,
    'strata-owner-fee-v3://kxbtc15m/'+id,V3_FEE_AUTHORITY_SCOPE,V3_FEE_GRANT_CONFIRM]);
  if(rows.rows.length!==1||rows.rows[0]!.official_source_digest!==observation.sourceDigest)
   return fail('owner_standing_fee_source_or_approved_policy_changed');
  if(clock(deps)-started>15_000)return fail('owner_standing_fee_monetary_read_expired');
  const existing=await tx.query(`SELECT consent_id,expires_at
     FROM private.strata_owner_standing_fee_v1
     WHERE owner_user_id=$1::uuid AND execution_account_id=$2
       AND release_commit_sha=$3 AND approved_policy_hash=$4
       AND revoked_at IS NULL FOR UPDATE`,[owner,account,sha,policy]);
  if(existing.rows.length>1)return fail('owner_standing_fee_prior_consent_ambiguous');
  if(existing.rows.length===1){
   if(time(existing.rows[0]!.expires_at)>clock(deps))
    return fail('owner_standing_fee_existing_consent_still_active');
   const expired=await tx.query(`UPDATE private.strata_owner_standing_fee_v1
      SET revoked_at=clock_timestamp(),revocation_reason='expired_owner_consent_superseded'
      WHERE consent_id=$1 AND revoked_at IS NULL AND expires_at<=clock_timestamp()
      RETURNING consent_id`,[existing.rows[0]!.consent_id]);
   if(expired.rows.length!==1)return fail('owner_standing_fee_prior_expiry_changed');
  }
  const issuedAt=new Date(clock(deps));
  const end=new Date(issuedAt.getTime()+OWNER_STANDING_FEE_MAX_AGE_MS);
  const consentId=randomUUID();
  const signed=sourceConfirmation(owner,account,sha,policy,id,txt(observation.sourceDigest));
  const saved=await tx.query(`INSERT INTO private.strata_owner_standing_fee_v1
      (consent_id,owner_user_id,execution_account_id,release_commit_sha,
       approved_policy_hash,source_authority_id,official_source_digest,
       fee_policy_version,formula_version,scope,confirmation,consent_digest,
       consented_at,expires_at)
     VALUES($1,$2::uuid,$3,$4,$5,$6::uuid,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING consent_id::text,expires_at`,
   [consentId,owner,account,sha,policy,id,observation.sourceDigest,
    V3_FEE_POLICY_VERSION,V3_FEE_FORMULA_VERSION,V3_FEE_AUTHORITY_SCOPE,
    OWNER_STANDING_FEE_CONFIRM,signed,issuedAt.toISOString(),end.toISOString()]);
  if(saved.rows.length!==1)return fail('owner_standing_fee_consent_not_recorded');
  const event={kind:'OWNER_STANDING_FEE_CONSENT_V1',owner,account,sha,policy,
    sourceAuthorityId:id,sourceDigest:observation.sourceDigest,
    consentId,expiresAt:end.toISOString(),confirmation:OWNER_STANDING_FEE_CONFIRM};
  await tx.query(`INSERT INTO public.v13_production_observation
    (id,account_id,kind,payload,digest)
    VALUES($1,$2,'OWNER_STANDING_FEE_CONSENT_V1',$3::jsonb,$4)`,
    [randomUUID(),account,JSON.stringify(event),digest(event)]);
  attempted=true;await tx.query('COMMIT');done=true;
  return {ok:true as const,reason:'owner_standing_fee_consent_recorded' as const,
    consentId,expiresAt:end.toISOString(),monetaryFeeAuthorized:false as const,
    tradingAuthorized:false as const,ordersSubmitted:false as const,workerStarted:false as const};
 }catch{
  if(attempted){discard=Error('owner_standing_fee_commit_unknown');
   return {...fail('owner_standing_fee_commit_outcome_unknown'),outcomeUnknown:true,retryAuthorized:false};}
  return fail('owner_standing_fee_write_unavailable');
 }finally{
  if(tx){if(!done&&!discard)try{await tx.query('ROLLBACK');}catch{discard=Error('owner_standing_fee_rollback_unknown');}
   tx.release(discard);}
 }
}
export async function revokeOwnerStandingFee(owner:string,raw:unknown,deps:Deps={}){
 const b=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Row:{};
 const sha=getSha(deps);
 if(!UUID.test(owner)||!UUID.test(txt(b.consentId))||b.confirmation!==OWNER_STANDING_FEE_REVOKE||
  !SHA.test(sha)||Object.keys(b).length!==2)return fail('owner_standing_fee_explicit_revoke_required');
 const db=deps.db??pool as unknown as Db;
 let tx:Tx|null=null,done=false,attempted=false,discard:Error|undefined;
 try{
  tx=await db.connect();await tx.query('BEGIN');
  await tx.query("SET LOCAL lock_timeout='1500ms'");
  const claimed=await tx.query(`UPDATE private.strata_owner_standing_fee_v1
    SET revoked_at=clock_timestamp(),revocation_reason='authenticated_owner_revocation'
    WHERE consent_id=$1::uuid AND owner_user_id=$2::uuid
      AND release_commit_sha=$3 AND revoked_at IS NULL
    RETURNING consent_id::text,execution_account_id`,[b.consentId,owner,sha]);
  if(claimed.rows.length!==1)return fail('owner_standing_fee_not_current');
  const receipt={owner,account:claimed.rows[0]!.execution_account_id,
    sha,consentId:b.consentId,kind:'OWNER_STANDING_FEE_REVOKE_V1'};
  await tx.query(`INSERT INTO public.v13_production_observation
   (id,account_id,kind,payload,digest)
   VALUES($1,$2,'OWNER_STANDING_FEE_REVOKE_V1',$3::jsonb,$4)`,
   [randomUUID(),receipt.account,JSON.stringify(receipt),digest(receipt)]);
  attempted=true;await tx.query('COMMIT');done=true;
  return {ok:true as const,reason:'owner_standing_fee_revoked' as const,
    revoked:true as const,ordersSubmitted:false as const,tradingAuthorized:false as const};
 }catch{
  if(attempted){discard=Error('owner_standing_revoke_commit_unknown');
   return {...fail('owner_standing_fee_revoke_outcome_unknown'),outcomeUnknown:true,retryAuthorized:false};}
  return fail('owner_standing_fee_revocation_unavailable');
 }finally{if(tx){if(!done&&!discard)try{await tx.query('ROLLBACK');}catch{discard=Error('owner_standing_rollback_unknown');}tx.release(discard);}}
}
