import {economicExitNotDischarged} from './economicExitDischargeScope';
/** Reason-specific accounting recovery. Owner approval never authorizes trading. */
import {pool,type Pool,type PoolClient} from '@workspace/db';
import {ProductionLedger,decodePolicy,identity,type Account} from '../v13-production/ledger';
import {canonical,digest,requireProof} from '../v13-production/types';
import {computeV13LiveMoneyPolicyHash} from '../v13LiveMoneyRisk';
import {loadedMaterial} from './inAppProtectiveRelease';
import {dedicatedSignerFingerprint} from './commissioning';
import {readOwnedKalshiFeeds,personalAccountSnapshot} from './personalExchangeRead';
import {readBracketedSettledCash} from './settledCashBracket';
import {readReconciledReleaseRenewalHistory,verifyReconciledReleaseRenewalSnapshot} from './reconciledReleaseRenewalHistory';

export const OWNER_SETTLED_CASH_RECOVERY_CONFIRM='I_AUTHORIZE_SIGNED_SETTLED_CASH_FREEZE_RECOVERY_AND_KEEP_MY_ACCOUNT_DISARMED';
export const SETTLED_CASH_FREEZE='production_external_cash_mismatch';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
type Row=Record<string,unknown>;
type Deps={db?:Pool;now?:()=>number;read?:typeof readOwnedKalshiFeeds;isScheduled:(owner:string,account:string)=>boolean};
export type SettledCashRecoveryScope={accountId:string;expectedRevision:string;settlementEventId:string};
const no=(reason:string)=>({ok:false as const,reason,ordersSubmitted:false,workerStarted:false,tradingAuthorized:false,riskFreezeCleared:false});
const ACCOUNT=`SELECT a.* FROM public.v13_production_account a WHERE a.owner_user_id=$1::uuid AND a.subaccount=1 AND a.exchange_index=2 LIMIT 2`;
const COUNTS=`SELECT
 (SELECT count(*)::text FROM public.v13_production_intent WHERE account_id=$1 AND
  (NOT terminal OR state IN ('PREPARED','DISPATCHED','UNKNOWN') OR reserved_micros<>0)${economicExitNotDischarged("account_id","client_order_id")}) intents,
 (SELECT count(*)::text FROM public.v13_production_position WHERE account_id=$1 AND quantity_hundredths<>0) positions,
 (SELECT count(*)::text FROM private.strata_emergency_exit_reservations WHERE execution_account_id=$1 AND state IN ('PREPARED','DISPATCHED','UNKNOWN')${economicExitNotDischarged("execution_account_id","client_order_id")}) exits`;
const json=(v:unknown):unknown=>typeof v==='string'?JSON.parse(v):v;
export function validSettledCashRecoveryScope(v:unknown):v is SettledCashRecoveryScope{
 if(!v||typeof v!=='object'||Array.isArray(v))return false;const s=v as Row;
 return typeof s.accountId==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(s.accountId)&&
  typeof s.expectedRevision==='string'&&/^(0|[1-9]\d{0,18})$/.test(s.expectedRevision)&&
  typeof s.settlementEventId==='string'&&/^settlement:[A-Za-z0-9:._-]{1,200}$/.test(s.settlementEventId);
}
export function settledCashRecoveryAccountEligible(a:Row,owner:string):boolean{
 return a.owner_user_id===owner&&a.blocked_reason===SETTLED_CASH_FREEZE&&a.commissioned===true&&
  a.cash_precision_verified===true&&String(a.reserved_micros)==='0'&&Number(a.subaccount)===1&&Number(a.exchange_index)===2;
}
function failure(error:unknown){
 const message=error instanceof Error?error.message:'';
 if(/^recovery_[a-z_]+$/.test(message))return no(message);
 if(message.startsWith('release_')||message==='owner_renewal_reconciled_history_unverified')return no('recovery_retained_history_unverified');
 return no('recovery_verification_failed');
}

/** Preview uses a READ ONLY client; commit holds account, worker, history,
 * policy and credential locks. Both verify the complete retained ledger. */
async function prove(tx:PoolClient,a:Account,owner:string,deps:Deps,lock:boolean,selected?:string){
 const now=deps.now??Date.now,id=a.id,suffix=lock?' FOR SHARE':'';
 const connection=(a as unknown as Row).kalshi_connection_id;
 requireProof(settledCashRecoveryAccountEligible(a as unknown as Row,owner),'recovery_settled_cash_account_not_eligible');
 requireProof(!deps.isScheduled(owner,id),'recovery_worker_must_be_stopped');
 const leases=(await tx.query(`SELECT * FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1 AND owner_user_id=$2::uuid${lock?' FOR UPDATE':''}`,[id,owner])).rows;
 requireProof(leases.length===1,'recovery_worker_fence_missing');const lease=leases[0]!;
 requireProof(lease.state==='released'&&lease.arm_requested===false&&lease.credential_fingerprint===a.key_fingerprint,
  'recovery_worker_must_be_released_and_disarmed');
 const policies=(await tx.query(`SELECT p.* FROM public.v13_live_money_policy p WHERE p.id=$1 AND p.execution_account_id=$2 AND p.created_by=$3 AND p.state='APPROVED'${suffix}`,[a.policy_id,id,owner])).rows;
 requireProof(policies.length===1,'recovery_current_policy_missing');const policy=decodePolicy(policies[0]!);
 requireProof(policy.policyHash===computeV13LiveMoneyPolicyHash(policy),'recovery_policy_changed');
 const creds=(await tx.query(`SELECT key_fingerprint FROM private.kalshi_connection_credentials
  WHERE owner_user_id=$1::uuid AND financial_account_id=$2 AND role='restricted_execution' AND revoked_at IS NULL
  AND verified_at IS NOT NULL AND verification_reason='credential_verified' AND key_fingerprint=$3${suffix}`,
 [owner,connection,a.key_fingerprint])).rows;
 requireProof(creds.length===1,'recovery_current_credential_missing');
 const material=await loadedMaterial(tx,{owner_id:owner,kalshi_connection_id:connection,key_fingerprint:a.key_fingerprint});
 requireProof(material&&dedicatedSignerFingerprint(material.keyId,material.privateKey)===a.key_fingerprint,'recovery_signer_unverified');
 const counts=(await tx.query(COUNTS,[id])).rows;
 requireProof(counts.length===1&&['intents','positions','exits'].every(k=>counts[0]![k]==='0'),'recovery_exposure_or_uncertainty_requires_independent_reconciliation');
 const history=await readReconciledReleaseRenewalHistory(tx,id,owner,lock),observed=now();
 const feed=await (deps.read??readBracketedSettledCash)(material!,observed);
 requireProof(feed.ok,'recovery_signed_exchange_unavailable');if(!feed.ok)throw Error('recovery_signed_exchange_unavailable');
 requireProof(feed.historicalCoverageComplete===true&&feed.observedAtMs===observed,'recovery_complete_signed_history_required');
 // Map all retained requests to detect provider contradictions of no-send proof.
 const snapshot=personalAccountSnapshot(identity(a),feed,history.requests);
 requireProof('identity' in snapshot,'recovery_exchange_history_unreconciled');if(!('identity' in snapshot))throw Error('recovery_exchange_history_unreconciled');
 verifyReconciledReleaseRenewalSnapshot(history,snapshot);
 const ledger=new ProductionLedger(deps.db??pool,id);
 await ledger.finalAccountProof(tx,a,snapshot,now());await ledger.assertConservation(tx,a);
 const settlement=selected?snapshot.settlements.find(s=>`settlement:${s.id}`===selected):
  snapshot.settlements.slice().sort((x,y)=>y.occurredAtMs-x.occurredAtMs||x.id.localeCompare(y.id))[0];
 requireProof(settlement,'recovery_selected_settlement_missing');
 const settlementEventId=`settlement:${settlement!.id}`;
 const stored=(await tx.query(`SELECT event_id,digest,payload FROM public.v13_production_event WHERE account_id=$1 AND event_id=$2 AND kind='SETTLEMENT'${suffix}`,[id,settlementEventId])).rows;
 requireProof(stored.length===1&&stored[0]!.digest===digest(settlement)&&canonical(json(stored[0]!.payload))===canonical(settlement),'recovery_selected_settlement_unreconciled');
 const finalHistory=await readReconciledReleaseRenewalHistory(tx,id,owner,lock);
 requireProof(history.reconciliationDigest===finalHistory.reconciliationDigest,'recovery_history_changed');
 const current=(await tx.query(ACCOUNT,[owner])).rows;
 requireProof(current.length===1&&current[0]!.id===id&&String(current[0]!.revision)===String(a.revision)&&
  current[0]!.policy_id===a.policy_id&&current[0]!.key_fingerprint===a.key_fingerprint&&
  settledCashRecoveryAccountEligible(current[0]!,owner),'recovery_account_changed');
 requireProof(now()>=observed&&now()-observed<=5000&&!deps.isScheduled(owner,id),'recovery_signed_evidence_expired_or_worker_running');
 return {snapshot,observed,lease,settlement:settlement!,settlementEventId,history};
}

/** No financial writes, audit insertion, approval, or authority change. */
export async function previewOwnerSettledCashFreeze(owner:string,deps:Deps){
 if(!UUID.test(owner))return no('recovery_owner_required');const db=deps.db??pool;let tx:PoolClient|undefined;
 try{
  tx=await db.connect();await tx.query('BEGIN READ ONLY');await tx.query("SET LOCAL statement_timeout='12000ms'");
  const rows=(await tx.query(ACCOUNT,[owner])).rows;requireProof(rows.length===1,'recovery_owned_account_missing_or_ambiguous');
  const a=rows[0] as Account,proof=await prove(tx,a,owner,deps,false);
  const stake=(await tx.query('SELECT configured_stake_cents FROM public.strata_configured_stake WHERE execution_account_id=$1',[a.id])).rows;
  requireProof(stake.length===1&&Number.isSafeInteger(stake[0]!.configured_stake_cents)&&stake[0]!.configured_stake_cents>0,'recovery_stake_unverified');
  return {ok:true as const,reason:'settled_cash_recovery_preview',ownerId:owner,viewerIsOwner:true,
   scope:{accountId:a.id,expectedRevision:String(a.revision),settlementEventId:proof.settlementEventId,subaccount:1,exchangeIndex:2},
   cashMicros:String(a.cash_micros),openingMicros:String(a.initial_cash_micros),stakeCents:stake[0]!.configured_stake_cents as number,
   retainedIntents:proof.history.requests.length,neverPostedIntents:proof.history.neverPosted.length,postedOrders:proof.snapshot.orders.length,
   fills:proof.snapshot.fills.length,settlements:proof.snapshot.settlements.length,openPositions:0,
   settlementAt:new Date(proof.settlement.occurredAtMs).toISOString(),observedAt:new Date(proof.observed).toISOString(),
   ordersSubmitted:false,workerStarted:false,tradingAuthorized:false,riskFreezeCleared:false};
 }catch(error){return failure(error);}finally{if(tx){try{await tx.query('ROLLBACK');}finally{tx.release();}}}
}

/** Exact durable outcome after an ambiguous commit. Never resubmit here. */
export async function ownerSettledCashRecoveryOutcome(owner:string,scope:SettledCashRecoveryScope,db:Pool=pool){
 if(!UUID.test(owner)||!validSettledCashRecoveryScope(scope))return no('recovery_exact_scope_required');
 let tx:PoolClient|undefined;
 try{
  tx=await db.connect();await tx.query('BEGIN');await tx.query("SET LOCAL lock_timeout='1200ms'");
  // Serialize with a pending recovery before taking the receipt query snapshot.
  // Only read locks: no financial data or authority is written.
  const owned=await tx.query('SELECT revision FROM public.v13_production_account WHERE id=$1 AND owner_user_id=$2::uuid FOR SHARE',[scope.accountId,owner]);
  requireProof(owned.rows.length===1,'recovery_owned_account_missing');
  const rows=(await tx.query(`SELECT o.id,o.payload,o.digest,a.blocked_reason,a.execution_enabled,a.kill_switch,
   w.state AS worker_state,w.arm_requested FROM public.v13_production_observation o
   JOIN public.v13_production_account a ON a.id=o.account_id AND a.owner_user_id=$2::uuid
   JOIN private.kalshi_account_worker_lease w ON w.execution_account_id=a.id AND w.owner_user_id=a.owner_user_id
   WHERE o.account_id=$1 AND o.kind='OWNER_SETTLED_CASH_FREEZE_RECOVERY'
    AND o.payload->>'owner'=$2::text AND o.payload->>'priorRevision'=$3 AND o.payload->>'settlementEventId'=$4 LIMIT 2`,
  [scope.accountId,owner,scope.expectedRevision,scope.settlementEventId])).rows;
  if(rows.length===0)return {...no('recovery_receipt_not_found'),status:'NOT_RECORDED' as const,scope};
  requireProof(rows.length===1,'recovery_receipt_ambiguous');const r=rows[0]!,p=json(r.payload) as Row;
  requireProof(p&&p.accountId===scope.accountId&&p.owner===owner&&String(p.priorRevision)===scope.expectedRevision&&
   BigInt(String(owned.rows[0]!.revision))>BigInt(scope.expectedRevision)&&p.settlementEventId===scope.settlementEventId&&p.priorReason===SETTLED_CASH_FREEZE&&p.tradingAuthorized===false&&digest(p)===r.digest,
   'recovery_receipt_unverified');
  return {ok:true as const,status:'RECORDED' as const,reason:'settled_cash_recovery_recorded',scope,receiptId:String(r.id),
   riskFreezeCleared:r.blocked_reason===null,accountStopped:r.execution_enabled===false&&r.kill_switch===true&&r.worker_state==='released'&&r.arm_requested===false,
   ordersSubmitted:false,workerStarted:false,tradingAuthorized:false};
 }catch{return {...no('recovery_outcome_unverified'),status:'UNKNOWN' as const,outcomeUnknown:true};}
 finally{if(tx){try{await tx.query('ROLLBACK');}finally{tx.release();}}}
}

export async function recoverOwnerSettledCashFreeze(owner:string,input:SettledCashRecoveryScope&{confirmation:unknown},deps:Deps){
 if(!UUID.test(owner)||input?.confirmation!==OWNER_SETTLED_CASH_RECOVERY_CONFIRM||!validSettledCashRecoveryScope(input))
  return no('explicit_owner_settled_cash_recovery_scope_required');
 const db=deps.db??pool;let clearanceWritten=false;
 try{
  const rows=(await db.query(ACCOUNT,[owner])).rows;requireProof(rows.length===1,'recovery_owned_account_missing_or_ambiguous');
  const initial=rows[0]!;requireProof(initial.id===input.accountId,'recovery_settled_cash_account_not_eligible');
  if(initial.blocked_reason!==SETTLED_CASH_FREEZE||String(initial.revision)!==input.expectedRevision){
   const receipt=await ownerSettledCashRecoveryOutcome(owner,input,db);
   if(receipt.ok)return receipt;return no('recovery_settled_cash_account_not_eligible');
  }
  requireProof(settledCashRecoveryAccountEligible(initial,owner),'recovery_settled_cash_account_not_eligible');
  requireProof(!deps.isScheduled(owner,input.accountId),'recovery_worker_must_be_stopped');
  const ledger=new ProductionLedger(db,input.accountId);
  return await ledger.transaction(async(tx,a)=>{
   requireProof(String(a.revision)===input.expectedRevision,'recovery_account_changed');
   const proof=await prove(tx,a,owner,deps,true,input.settlementEventId),evidence=digest(proof.snapshot);
   await ledger.observe(tx,'OWNER_SETTLED_CASH_FREEZE_RECOVERY',{owner,accountId:a.id,priorReason:a.blocked_reason,
    priorRevision:a.revision,settlementEventId:input.settlementEventId,fencingToken:String(proof.lease.fencing_token),
    observedAtMs:proof.observed,evidenceDigest:evidence,historyDigest:proof.history.reconciliationDigest,
    neverPostedCount:proof.history.neverPosted.length,postedOrderCount:proof.snapshot.orders.length,tradingAuthorized:false});
   const updated=await tx.query(`UPDATE public.v13_production_account SET blocked_reason=NULL,reconciled_at=$4,evidence_digest=$5,
    revision=revision+1,execution_enabled=false,kill_switch=true WHERE id=$1 AND owner_user_id=$2::uuid AND revision=$3 AND blocked_reason=$6
    AND clock_timestamp() BETWEEN $4::timestamptz AND $4::timestamptz+interval '5 seconds' RETURNING id`,
   [a.id,owner,a.revision,new Date(proof.observed),evidence,SETTLED_CASH_FREEZE]);
   requireProof(updated.rows.length===1,'recovery_final_freshness_or_cas_refused');clearanceWritten=true;
   return {ok:true as const,reason:'settled_cash_freeze_reconciled_account_remains_disarmed',ordersSubmitted:false,workerStarted:false,tradingAuthorized:false,riskFreezeCleared:true};
  },{lockTimeoutMs:1200});
 }catch(error){return clearanceWritten?{...no('recovery_commit_outcome_unverified'),riskFreezeCleared:null,outcomeUnknown:true}:failure(error);}
}
