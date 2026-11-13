import {recoveryCredentialGuard} from './ownerRecoveryCredentialGuardCandidate';
import {createRecoveryProviderIdentityReader} from './ownerRecoveryProviderIdentityCandidate';
import {loadedMaterial} from './inAppProtectiveRelease';
import {readOwnedKalshiFeeds,getOwnedProductionKalshiJson} from './personalExchangeRead';
import {ProductionLedger} from '../v13-production/ledger';
/** Read-only bounded alternative diagnostic using the REAL executor ledger lock.
 * Not a replacement issuer, worker STOP, or durable quiescence lease. */
export async function inspectOwnerScopedQuiescence(db:ConstructorParameters<typeof ProductionLedger>[0],input:{accountId:string;ownerId:string},enabled=false,options:{signedRead?:boolean;requireProviderIdentity?:boolean;providerGet?:typeof getOwnedProductionKalshiJson}={}){
 const result=(status:string)=>({status,recoveryAuthorized:false,tradingAuthorized:false,durableIsolationEstablished:false});
 if(!enabled)return result('candidate_disabled');
 try{return await new ProductionLedger(db,input.accountId).transaction(async(tx,a)=>{
  await tx.query("SET LOCAL statement_timeout='3000ms'");
  if(a.owner_user_id!==input.ownerId||a.execution_enabled!==false||a.kill_switch!==true||String(a.reserved_micros)!=='0')return result('owner_stopped_account_not_verified');
  const l=await tx.query('SELECT state,account_kill,arm_requested FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1 AND owner_user_id=$2::uuid FOR SHARE',[input.accountId,input.ownerId]);
  if(l.rows.length!==1||l.rows[0].state!=='killed'||l.rows[0].account_kill!==true||l.rows[0].arm_requested!==false)return result('killed_disarmed_lease_not_verified');
  const i=await tx.query("SELECT id FROM public.v13_production_intent WHERE account_id=$1 AND (terminal IS DISTINCT FROM true OR state IS NULL OR state IN ('PREPARED','DISPATCHED','UNKNOWN') OR reserved_micros IS NULL OR reserved_micros<>0) LIMIT 1",[input.accountId]);
  const p=await tx.query('SELECT id FROM public.v13_production_position WHERE account_id=$1 AND (quantity_hundredths IS NULL OR quantity_hundredths<>0) LIMIT 1',[input.accountId]);
  const e=await tx.query("SELECT reservation_id FROM private.strata_emergency_exit_reservations WHERE execution_account_id=$1 AND (state IS NULL OR state IN ('PREPARED','DISPATCHED','UNKNOWN')) LIMIT 1",[input.accountId]);
  if(i.rows.length||p.rows.length||e.rows.length)return result('exposure_or_uncertain_outcome_blocks_quiescence');
  if(options.signedRead){
   const identityScope={...input,credentialFingerprint:a.key_fingerprint};
   const credentialGuard=options.requireProviderIdentity?recoveryCredentialGuard(identityScope,
    createRecoveryProviderIdentityReader(identityScope,{get:options.providerGet})):null;
   if(credentialGuard)await credentialGuard.lock(tx);
   // Actual signer/feed adapters run while the SAME account/lease lock is held.
   // A complete nonempty history needs real ledger reconciliation, not this
   // deliberately empty-history diagnostic.
   const material=await loadedMaterial(tx,{...a,owner_id:input.ownerId});if(!material)return result('signer_unavailable');
   const abort=new AbortController(),start=Date.now();let calls=0;
   const timer=setTimeout(()=>abort.abort(),5000);
   const get:typeof getOwnedProductionKalshiJson=async(...args)=>{if(++calls>7||abort.signal.aborted)throw Error('feed_budget');return (options.providerGet??getOwnedProductionKalshiJson)(args[0],args[1],args[2],args[3],args[4],input.ownerId,abort.signal);};
   let f;try{f=await readOwnedKalshiFeeds(material,start,get);}finally{clearTimeout(timer);}
   if(!f.ok||Date.now()<start||Date.now()-start>=5000||!f.historicalCoverageComplete)return result('complete_fresh_provider_evidence_missing');
   if(f.cashMicros!==String(a.cash_micros)||f.orders.length||f.fills.length||f.positions.length||f.settlements.length)return result('provider_empty_history_and_cash_not_verified');
   if(credentialGuard)await credentialGuard.beforeCommit(tx);
   return result(credentialGuard?'signed_identity_and_empty_history_under_account_lock_only':'signed_empty_history_under_account_lock_only');
  }
  return result('local_ledger_drained_under_account_lock_only');
 },{lockTimeoutMs:750});}catch{return result('quiescence_not_verified');}
}

/** Strict assembled runtime diagnostic. Never releases, arms or starts an
 * account. Must be enabled by trusted server wiring, not request flags. */
export function inspectOwnerRecoveryReadinessCandidate(db:ConstructorParameters<typeof ProductionLedger>[0],input:{accountId:string;ownerId:string},enabled=false,providerGet?:typeof getOwnedProductionKalshiJson){
 return inspectOwnerScopedQuiescence(db,input,enabled,{signedRead:true,requireProviderIdentity:true,providerGet});
}
