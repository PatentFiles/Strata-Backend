import {durableReleaseMatch} from './durableFeeReleaseBinding';
import {HISTORICAL_FEE_VERSION,HISTORICAL_SOURCE_KIND,historicalBaselineEnabled} from './historicalOwnerFeeBaseline';
/** Server-only candidate consumers; no route accepts authority substitutions. */
import {createHash} from 'node:crypto';import {pool} from '@workspace/db';
import {deployedGitSha} from './deployedGitSha';import {probeCurrentKalshiFeeApi} from './twoSourceFeeEvidence';
import {verifyDurableOwnerFee,DURABLE_FEE_VERSION} from './durableOwnerFeePolicy';
export const parseDurableFeeSource=(source:string)=>/^strata-durable-owner-fee:\/\/([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/i.exec(source)?.[1]??null;
type Query={query(sql:string,args?:unknown[]):Promise<{rows:Record<string,unknown>[]}>};
export async function verifyDurableProtectiveAuthority(owner:string,account:string,sha:string,db:Query=pool){
 if(process.env.STRATA_DURABLE_OWNER_FEE_ENABLED!=='true'||!/^[a-f0-9]{40}$/.test(sha))return {ok:false as const};
 try{const r=await db.query(`SELECT m.model_id::text,m.source_capture_id::text,m.source_kind,m.historical_baseline_id,m.official_source_digest,m.approved_policy_hash,
 m.owner_user_id,m.execution_account_id,m.release_commit_sha,$3::text AS authorized_release_sha
 FROM private.strata_durable_owner_fee_model m JOIN private.strata_durable_owner_fee_state s USING(model_id)
 JOIN public.v13_production_account a ON a.id=m.execution_account_id AND a.owner_user_id=m.owner_user_id
 JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
 WHERE m.owner_user_id=$1::uuid AND m.execution_account_id=$2 AND ${durableReleaseMatch('$3')}
 AND ((m.genuine_source_verified=true AND m.source_kind='FRESH_CANONICAL_CAPTURE' AND m.policy_version=$4) OR ($6::boolean AND m.genuine_source_verified=false AND m.source_kind='OWNER_ATTESTED_HISTORICAL_BASELINE' AND m.policy_version=$5 AND EXISTS(SELECT 1 FROM private.strata_durable_historical_baseline b WHERE b.baseline_id=m.historical_baseline_id AND b.content_sha256=m.official_source_digest))) AND m.formula_version='standard-quadratic-0.07-v1'
 AND s.known_publication_change=false AND p.state='APPROVED' AND p.policy_hash=m.approved_policy_hash
 AND p.fee_source_url='strata-durable-owner-fee://'||m.model_id::text
 AND p.fee_policy_version=m.policy_version AND p.fee_formula_version=m.formula_version
 AND a.fee_artifact_digest=m.official_source_digest AND a.commissioned=true AND a.subaccount=1 AND a.exchange_index=2
 FOR SHARE OF m,s,a,p`,[owner,account,sha,DURABLE_FEE_VERSION,HISTORICAL_FEE_VERSION,historicalBaselineEnabled()]);
 if(r.rows.length!==1)return {ok:false as const};
 return {ok:true as const,authorityFingerprint:createHash('sha256').update(JSON.stringify(r.rows[0])).digest('hex'),validForMs:5000};
 }catch{return {ok:false as const};}
}
export async function verifyDurableFeeStage(owner:string,account:string,source:string,intent:'ENTRY'|'PROTECTIVE_EXIT',ticker?:string){
 if(process.env.STRATA_DURABLE_OWNER_FEE_ENABLED!=='true')return {ok:false as const,reason:'durable_fee_feature_disabled'};
 if(!parseDurableFeeSource(source))return {ok:false as const,reason:'durable_source_invalid'};
 try{const r=await pool.query(`SELECT p.policy_hash FROM public.v13_production_account a
 JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
 WHERE a.id=$1 AND a.owner_user_id=$2::uuid AND p.fee_source_url=$3 AND p.state='APPROVED'`,[account,owner,source]);
 if(r.rows.length!==1)return {ok:false as const,reason:'durable_policy_scope_unverified'};
 let selected=ticker;
 if(!selected){const observation=await probeCurrentKalshiFeeApi();if(!observation.ok)return {ok:false as const,reason:observation.reason};selected=observation.marketTicker;}
 if(!selected)return {ok:false as const,reason:'durable_exact_market_missing'};
 return verifyDurableOwnerFee(pool,{owner,account,sha:deployedGitSha(),policyHash:String(r.rows[0].policy_hash)},selected,intent);
 }catch{return {ok:false as const,reason:'durable_source_or_market_unavailable'};}
}
