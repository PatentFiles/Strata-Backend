/** Explicit accounting recovery, NOT execution authorization. Fail closed on
 * every non-transient hold; never infer that an UNKNOWN order was rejected. */
import {pool, type Pool} from '@workspace/db';
import {ProductionLedger, decodePolicy, identity} from '../v13-production/ledger';
import {canonical,digest,requireProof,type Request} from '../v13-production/types';
import {computeV13LiveMoneyPolicyHash} from '../v13LiveMoneyRisk';
import {loadedMaterial} from './inAppProtectiveRelease';
import {dedicatedSignerFingerprint} from './commissioning';
import {readOwnedKalshiFeeds,personalAccountSnapshot} from './personalExchangeRead';
import {migrationFlatHistoryCheck} from './ownerApiFeePolicyMigration';

export const OWNER_TRANSIENT_RECOVERY_CONFIRM =
 'I_AUTHORIZE_SIGNED_TRANSIENT_DATABASE_FREEZE_RECOVERY_AND_KEEP_MY_ACCOUNT_DISARMED';
export const TRANSIENT_DATABASE_FREEZE = 'timeout exceeded when trying to connect';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
type Row=Record<string,unknown>;
type Deps={db?:Pool;now?:()=>number;read?:typeof readOwnedKalshiFeeds;
 isScheduled:(owner:string,account:string)=>boolean};
const no=(reason:string)=>({ok:false as const,reason,ordersSubmitted:false,
 workerStarted:false,tradingAuthorized:false,riskFreezeCleared:false});
const ACCOUNT=`SELECT a.* FROM public.v13_production_account a
 WHERE a.owner_user_id=$1::uuid AND a.subaccount=1 AND a.exchange_index=2 LIMIT 2`;
const LEASE=`SELECT * FROM private.kalshi_account_worker_lease
 WHERE execution_account_id=$1 AND owner_user_id=$2::uuid FOR UPDATE`;
const HISTORY=`SELECT request FROM public.v13_production_intent WHERE account_id=$1 ORDER BY created_at,id`;
const COUNTS=`SELECT
 (SELECT count(*)::text FROM public.v13_production_intent WHERE account_id=$1 AND
   (NOT terminal OR state IN ('PREPARED','DISPATCHED','UNKNOWN') OR reserved_micros<>0)) intents,
 (SELECT count(*)::text FROM public.v13_production_position WHERE account_id=$1 AND quantity_hundredths<>0) positions,
 (SELECT count(*)::text FROM private.strata_emergency_exit_reservations WHERE execution_account_id=$1
   AND state IN ('PREPARED','DISPATCHED','UNKNOWN')) exits`;
function requests(rows:Row[]):Request[]{return rows.map(r=>{
 const x=typeof r.request==='string'?JSON.parse(r.request):r.request;
 requireProof(x&&typeof x==='object'&&!Array.isArray(x),'recovery_intent_unreadable');return x as Request;
});}
export function transientRecoveryAccountEligible(a:Row,owner:string):boolean{
 return a.owner_user_id===owner && a.blocked_reason===TRANSIENT_DATABASE_FREEZE &&
 a.commissioned===true && a.cash_precision_verified===true && String(a.reserved_micros)==='0' &&
 Number(a.subaccount)===1 && Number(a.exchange_index)===2;
}
export async function recoverOwnerTransientFreeze(owner:string,confirmation:unknown,deps:Deps){
 if(!UUID.test(owner)||confirmation!==OWNER_TRANSIENT_RECOVERY_CONFIRM)
  return no('explicit_owner_transient_recovery_confirmation_required');
 const db=deps.db??pool,now=deps.now??Date.now;
 let clearanceWritten=false;
 try{
  const rows=(await db.query(ACCOUNT,[owner])).rows;
  requireProof(rows.length===1,'recovery_owned_account_missing_or_ambiguous');
  const initial=rows[0]!;
  requireProof(transientRecoveryAccountEligible(initial,owner),'recovery_transient_account_not_eligible');
  const id=String(initial.id);
  requireProof(typeof deps.isScheduled==='function'&&!deps.isScheduled(owner,id),'recovery_worker_must_be_stopped');
  const ledger=new ProductionLedger(db,id);
  // Hold the account and worker fence across evidence collection. No POST or
  // DELETE transport is reachable. A concurrent ARM or final order fence waits.
  return await ledger.transaction(async(tx,a)=>{
   requireProof(transientRecoveryAccountEligible(a as unknown as Row,owner)&&
    a.revision===initial.revision,'recovery_account_changed');
   const leases=(await tx.query(LEASE,[id,owner])).rows;
   requireProof(leases.length===1,'recovery_worker_fence_missing');
   const lease=leases[0]!;
   requireProof(lease.state==='released'&&lease.arm_requested===false&&
    lease.credential_fingerprint===a.key_fingerprint&&!deps.isScheduled(owner,id),
    'recovery_worker_must_be_released_and_disarmed');
   const policies=(await tx.query(`SELECT p.* FROM public.v13_live_money_policy p
    WHERE p.id=$1 AND p.execution_account_id=$2 AND p.created_by=$3 AND p.state='APPROVED' FOR SHARE`,
    [a.policy_id,id,owner])).rows;
   requireProof(policies.length===1,'recovery_current_policy_missing');
   const policy=decodePolicy(policies[0]!);
   requireProof(policy.policyHash===computeV13LiveMoneyPolicyHash(policy),'recovery_policy_changed');
   // Lock credential metadata against revocation/replacement until commit.
   const creds=(await tx.query(`SELECT key_fingerprint FROM private.kalshi_connection_credentials
    WHERE owner_user_id=$1::uuid AND financial_account_id=$2 AND role='restricted_execution'
     AND revoked_at IS NULL AND verified_at IS NOT NULL AND verification_reason='credential_verified'
     AND key_fingerprint=$3 FOR SHARE`,[owner,initial.kalshi_connection_id,a.key_fingerprint])).rows;
   requireProof(creds.length===1,'recovery_current_credential_missing');
   const material=await loadedMaterial(tx,{owner_id:owner,kalshi_connection_id:initial.kalshi_connection_id,key_fingerprint:a.key_fingerprint});
   requireProof(material&&dedicatedSignerFingerprint(material.keyId,material.privateKey)===a.key_fingerprint,
    'recovery_signer_unverified');
   const counts=(await tx.query(COUNTS,[id])).rows;
   requireProof(counts.length===1&&['intents','positions','exits'].every(k=>counts[0]![k]==='0'),
    'recovery_exposure_or_uncertainty_requires_independent_reconciliation');
   const history=requests((await tx.query(HISTORY,[id])).rows);
   const observed=now();
   const feed=await (deps.read??readOwnedKalshiFeeds)(material!,observed);
   requireProof(feed.ok,'recovery_signed_exchange_unavailable');
   if(!feed.ok)throw Error('recovery_signed_exchange_unavailable');
   requireProof(feed.historicalCoverageComplete===true&&feed.observedAtMs===observed,
    'recovery_complete_signed_history_required');
   const snapshot=personalAccountSnapshot(identity(a),feed,history);
   requireProof('identity' in snapshot,'recovery_exchange_history_unreconciled');
   if(!('identity' in snapshot))throw Error('recovery_exchange_history_unreconciled');
   requireProof(migrationFlatHistoryCheck(snapshot,history).ok,'recovery_exchange_not_proven_flat');
   await ledger.finalAccountProof(tx,a,snapshot,now());
   await ledger.assertConservation(tx,a);
   requireProof(canonical(history)===canonical(requests((await tx.query(HISTORY,[id])).rows)),
    'recovery_history_changed');
   requireProof(now()>=observed&&now()-observed<=5000&&!deps.isScheduled(owner,id),
    'recovery_signed_evidence_expired_or_worker_running');
   const evidence=digest(snapshot);
   await ledger.observe(tx,'OWNER_TRANSIENT_FREEZE_RECOVERY',{owner,accountId:id,
    priorReason:a.blocked_reason,priorRevision:a.revision,fencingToken:String(lease.fencing_token),
    observedAtMs:observed,evidenceDigest:evidence,tradingAuthorized:false});
   // Include a DB-clock freshness CAS after the audit write. Keep authority shut
   // even if pre-existing reviews/grants are still valid; none are renewed.
   const updated=await tx.query(`UPDATE public.v13_production_account SET
    blocked_reason=NULL,reconciled_at=$4,evidence_digest=$5,revision=revision+1,
    execution_enabled=false,kill_switch=true
    WHERE id=$1 AND owner_user_id=$2::uuid AND revision=$3 AND blocked_reason=$6
     AND clock_timestamp() BETWEEN $4::timestamptz AND $4::timestamptz+interval '5 seconds'
    RETURNING id`,[id,owner,a.revision,new Date(observed),evidence,TRANSIENT_DATABASE_FREEZE]);
   requireProof(updated.rows.length===1,'recovery_final_freshness_or_cas_refused');
   clearanceWritten=true;
   return {ok:true as const,reason:'transient_freeze_reconciled_account_remains_disarmed',
    ordersSubmitted:false,workerStarted:false,tradingAuthorized:false,riskFreezeCleared:true};
  },{lockTimeoutMs:1200});
 }catch(error){
  if(clearanceWritten)return {...no('recovery_commit_outcome_unverified'),riskFreezeCleared:null,
   outcomeUnknown:true};
  const reason=error instanceof Error&&/^recovery_[a-z_]+$/.test(error.message)
   ?error.message:'recovery_verification_failed';
  return no(reason);
 }
}
