/**
 * Single-owner V3 fee final-send fence. AAL2 owner fee authority is distinct
 * from legacy REVIEWED_API_V2 human review records. No client can issue
 * its own reviewer identity or fee digest.
 *
 * This guard deliberately requires the executor's already-open financial
 * transaction: the acquired FOR SHARE locks remain held until the executor
 * resolves its one signed IOC POST. A revocation takes FOR UPDATE of the
 * same immutable V3 grant and therefore serializes with a submitted order.
 *
 * This component does not activate an account, forgive a KILL, re-enable
 * any worker, grant protective exits or automatically retry an UNKNOWN send.
 */
import type {PoolClient} from '@workspace/db';
import {parseV3FeeSource,verifyOwnerV3FeeAuthority,
 V3_FEE_POLICY_VERSION,V3_FEE_FORMULA_VERSION,V3_FEE_PUBLICATION_URL,
 V3_FEE_AUTHORITY_SCOPE,V3_FEE_GRANT_CONFIRM} from './ownerFeeV3Authority';
import {checkContinuousEligibility,hasContinuousGrantHistory} from './continuousExecutionAuthorization';
import {FINAL_MONETARY_ACCOUNT_FENCE_SQL} from './guardedMonetaryFeeWire';
import {deployedGitSha} from './deployedGitSha';

type Tx=Pick<PoolClient,'query'>;
const HEX=/^[a-f0-9]{64}$/;
const SHA=/^[a-f0-9]{40}$/;
const MARKET=/^KXBTC15M-[A-Za-z0-9-]+$/;
const ORDER_URL='https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders';

/** Strict account/lease/credential/policy lock from existing monetary guard,
 * with the owner V3 evidence and revocable authority locked in this SAME TX.
 * The provider observation is separately reverified immediately before POST.
 */
export const FINAL_OWNER_V3_ACCOUNT_FENCE_SQL=
 FINAL_MONETARY_ACCOUNT_FENCE_SQL.replace(
  '\n FOR SHARE OF a,p,live,c,lease',
  `\n AND EXISTS (
   SELECT 1 FROM private.strata_owner_fee_authority_v3 g
   JOIN private.strata_owner_fee_evidence_v3 e ON e.attestation_id=g.attestation_id
    AND e.owner_user_id=g.owner_user_id
    AND e.execution_account_id=g.execution_account_id
   WHERE g.authority_id=$11::uuid AND g.owner_user_id=a.owner_user_id
    AND g.execution_account_id=a.id AND g.release_commit_sha=$12
    AND g.policy_version='strata_owner_official_monetary_fee_v3'
    AND g.formula_version='standard-quadratic-0.07-v1'
    AND g.official_source_url='https://kalshi.com/docs/kalshi-fee-schedule.pdf'
    AND g.scope='KXBTC15M:INDEX2:SUBACCOUNT1'
    AND g.authorized_stages @> ARRAY['ORDER_ENTRY']::text[]
    AND g.confirmation='I_APPROVE_MY_OWN_VERIFIED_MONETARY_FEE_GRANT_V3'
    AND g.revoked_at IS NULL AND g.issued_at<=now()
    AND g.expires_at>clock_timestamp()+interval '30 seconds'
    AND e.revoked_at IS NULL AND e.expires_at>clock_timestamp()+interval '30 seconds'
    AND e.release_commit_sha=$12 AND e.source_digest=$8
    AND e.source_digest=g.official_source_digest
    AND e.verification_stage='STEP_9'
    AND e.source_kind='official_kalshi_server_verified_v3'
    AND e.owner_confirmation='I_AUTHORIZE_MY_OWN_OFFICIAL_KALSHI_FEE_EVIDENCE_V3'
   FOR SHARE OF g,e
 )
 FOR SHARE OF a,p,live,c,lease`
 );
if(!FINAL_OWNER_V3_ACCOUNT_FENCE_SQL.includes('FOR SHARE OF g,e')){
 throw Error('v3_final_fee_lock_query_not_constructed');
}

export function createGuardedOwnerV3FeeFetch(
 ownerId:string,accountId:string,sourceUrl:string,transport:typeof fetch,
 policyHash:string,keyFingerprint:string,fencingToken:number,holderId:string,feeDigest:string,
 deps:{
  borrowTransaction:()=>Tx|null;
  verify?:typeof verifyOwnerV3FeeAuthority;
  sha?:()=>string;
  currentStanding?:(tx:Tx,owner:string,sha:string)=>Promise<boolean>;
  hasHistory?:(tx:Tx,owner:string,sha:string)=>Promise<boolean>;
 } ,
):typeof fetch{
 const authorityId=parseV3FeeSource(sourceUrl);
 if(!authorityId||!accountId||!HEX.test(policyHash)||!HEX.test(keyFingerprint)||
  !HEX.test(feeDigest)||!Number.isSafeInteger(fencingToken)||fencingToken<=0||
  !holderId||holderId.length>200||!deps?.borrowTransaction)
  throw Error('owner_v3_fee_account_or_authority_identity_invalid');
 return async(request,init)=>{
  const method=(init?.method??(request instanceof Request?request.method:'GET')).toUpperCase();
  if(method!=='POST')return transport(request,{...init,redirect:'error'});
  if(init?.method!=='POST'||typeof request!=='string'||request!==ORDER_URL||
   typeof init.body!=='string')throw Error('owner_v3_fee_order_endpoint_invalid');
  let order:Record<string,unknown>;
  try{
   const parsed:unknown=JSON.parse(init.body);
   if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('invalid');
   order=parsed as Record<string,unknown>;
  }catch{throw Error('owner_v3_fee_order_body_invalid');}
  const ticker=order.ticker;
  if(typeof ticker!=='string'||!MARKET.test(ticker)||order.subaccount!==1||
   order.exchange_index!==2)throw Error('owner_v3_fee_wrong_exchange_or_market');
  if(order.reduce_only!==true&&order.reduce_only!==false)
   throw Error('owner_v3_fee_reduce_only_unverified');
  if(order.time_in_force!=='immediate_or_cancel'||
   order.self_trade_prevention_type!=='taker_at_cross'||order.post_only!==false||
   order.expiration_time!==undefined||
   typeof order.client_order_id!=='string'||
   !/^v13p-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(order.client_order_id)||
   (order.side!=='bid'&&order.side!=='ask')||
   typeof order.count!=='string'||!/^\d{1,9}\.\d{2}$/.test(order.count)||
   !Number.isFinite(Number(order.count))||Number(order.count)<=0||
   typeof order.price!=='string'||!/^0\.\d{4}$/.test(order.price)||
   Number(order.price)<=0)
   throw Error('owner_v3_fee_order_shape_invalid');
  const sha=(deps.sha??deployedGitSha)();
  if(!SHA.test(sha))throw Error('owner_v3_fee_current_release_sha_unavailable');
  const tx=deps.borrowTransaction();
  if(!tx)throw Error('owner_v3_fee_final_executor_transaction_required');
  const isEntry=order.reduce_only===false;
  // Missing, revoked or expired standing grant may not fall back to a
  // historic exit release for a new position. Exit-only orders never grant
  // entry authority.
  if(isEntry){
   if(process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE!=='true')
    throw Error('owner_v3_protective_exit_release_disabled');
   const history=await (deps.hasHistory??hasContinuousGrantHistory)(tx,ownerId,sha);
   const authorized=history&&await (deps.currentStanding??checkContinuousEligibility)(tx,ownerId,sha);
   if(!authorized)throw Error('owner_v3_standing_entry_authority_not_current');
  }
  const locked=await tx.query(FINAL_OWNER_V3_ACCOUNT_FENCE_SQL,[
   ownerId,accountId,keyFingerprint,policyHash,sourceUrl,fencingToken,holderId,
   feeDigest,V3_FEE_POLICY_VERSION,V3_FEE_FORMULA_VERSION,authorityId,sha
  ]);
  if(locked.rows.length!==1)throw Error('owner_v3_fee_final_account_or_source_closed');
  // Re-check REAL issuer publication + exact live market after the immutable
  // monetary authority has been locked. Do not accept the browser's quote.
  const assessment=await (deps.verify??verifyOwnerV3FeeAuthority)(
   ownerId,'ORDER_ENTRY',sourceUrl,ticker);
  if(!assessment.ok||
   assessment.identity.authorityId!==authorityId||
   assessment.identity.sourceDigest!==feeDigest||
   assessment.identity.sourceUrl!==sourceUrl||
   assessment.identity.releaseCommitSha!==sha||
   assessment.identity.marketTicker!==ticker)
   throw Error('owner_v3_fee_current_provider_evidence_unverified');
  // Transport is called exactly once. Any error after invocation is UNKNOWN;
  // the caller's ledger must reconcile it, never blindly resubmit.
  return transport(request,{...init,redirect:'error'});
 };
}
