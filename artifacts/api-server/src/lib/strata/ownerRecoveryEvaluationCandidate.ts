import {verifySupabaseAccessToken} from './supabaseAuth';
import {readReleaseOwner,loadedMaterial} from './inAppProtectiveRelease';
import {readOwnedKalshiFeeds,getOwnedProductionKalshiJson,personalAccountSnapshot} from './personalExchangeRead';
import {deployedGitSha} from './deployedGitSha';
import type {JWTVerifyGetKey} from 'jose';
type Client={query:(sql:string,args?:unknown[])=>Promise<{rows:any[]}>;release:(error?:Error)=>void};
type Binding={ok:true;releaseSha:string;evidenceDigest:string;validUntil:number}|{ok:false;reason:string};
/** Read-only, disabled recovery evaluator. It never authorizes recovery. Uses
 * actual commissioning/credential/signed-feed readers, but no legacy review
 * writer, no account/lease mutation and no shared-global gate changes.
 */
export async function evaluateOwnerRecovery(input:{token:string;accountId:string;consentRequestId:string},deps:{enabled:boolean;supabaseUrl:string;keys:JWTVerifyGetKey;db:{connect:()=>Promise<Client>};verifyCurrentSession:(token:string,ownerId:string)=>Promise<boolean>;resolveMachineBinding:(signal?:AbortSignal)=>Promise<Binding>;providerGet?:typeof getOwnedProductionKalshiJson}){
 const blockers:string[]=[];
 const facts:Record<string,unknown>={machineArtifactVerified:false,providerReadVerified:false};
 const out=()=>({evaluationCompleted:true,blockers:[...new Set(blockers)],facts,recoveryAuthorized:false,tradingAuthorized:false,ordersSubmitted:false,stateChanged:false});
 if(deps.enabled!==true){blockers.push('owner_recovery_evaluator_disabled');return out();}
 let actor;try{actor=await verifySupabaseAccessToken(input.token,deps);if(!await deps.verifyCurrentSession(input.token,actor.subject))throw Error('session');}catch{blockers.push('current_owner_session_required');return out();}
 if(typeof input.accountId!=='string'||!input.accountId||!/^[a-f0-9-]{36}$/i.test(input.consentRequestId)){blockers.push('exact_owner_account_and_consent_required');return out();}
 const sha=deployedGitSha();if(!/^[a-f0-9]{40}$/.test(sha)){blockers.push('runtime_release_unavailable');return out();}
 const abort=new AbortController();const timer=setTimeout(()=>abort.abort(),15000);
 let binding:Binding;try{binding=await deps.resolveMachineBinding(abort.signal);}catch{binding={ok:false,reason:'machine_read_failed'};}finally{clearTimeout(timer);}
 if(!binding.ok||binding.releaseSha!==sha||!Number.isSafeInteger(binding.validUntil)||binding.validUntil<=Date.now()){blockers.push('verified_current_machine_binding_unavailable');return out();}
 facts.machineArtifactVerified=true;
 // Artifact verification is deliberately NOT an authority issuer or runtime proof.
 blockers.push('machine_recovery_authority_not_implemented','deployed_artifact_identity_not_verified');
 let account:any,scope:any,material:{keyId:string;privateKey:string}|null=null,hadHistory=false;
 async function read<T>(work:(tx:Client)=>Promise<T>):Promise<T>{const tx=await deps.db.connect();let discard:Error|undefined;try{await tx.query('BEGIN READ ONLY');await tx.query("SET LOCAL statement_timeout='1500ms'");await tx.query("SET LOCAL lock_timeout='500ms'");const r=await work(tx);await tx.query('ROLLBACK');return r;}catch(e){discard=Error('recovery_evaluation_read_failed');throw e;}finally{if(discard)try{await tx.query('ROLLBACK');}catch{}tx.release(discard);}}
 try{
  await read(async tx=>{
   const owner=await readReleaseOwner(tx,actor.subject);if(!owner.ok){blockers.push(owner.reason);return;}
   account=owner.account;if(account.id!==input.accountId){blockers.push('commissioned_owner_account_mismatch');return;}
   facts.accountId=account.id;
   if(account.blocked_reason!=null)blockers.push('account_freeze_requires_remediation');
   const heads=await tx.query('SELECT sequence::text FROM private.strata_owner_control_heads WHERE execution_account_id=$1 AND owner_user_id=$2::uuid LIMIT 2',[account.id,actor.subject]);
   const leases=await tx.query('SELECT state,account_kill,arm_requested,fencing_token::text,consent_epoch::text FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1 AND owner_user_id=$2::uuid LIMIT 2',[account.id,actor.subject]);
   if(heads.rows.length!==1||leases.rows.length!==1){blockers.push('control_or_lease_telemetry_missing');return;}
   const h=heads.rows[0],l=leases.rows[0];facts.leaseState=l.state;
   if(!/^\d+$/.test(h.sequence)||typeof l.account_kill!=='boolean'||typeof l.arm_requested!=='boolean'||!/^\d+$/.test(l.fencing_token))blockers.push('control_or_lease_telemetry_invalid');
   if(l.state==='killed'||l.account_kill===true)blockers.push('killed_account_requires_explicit_recovery_not_routine_restart');
   else if(l.state!=='released'||l.arm_requested!==false)blockers.push('worker_not_released_and_disarmed');
   const receipt=await tx.query(`SELECT c.control_sequence::text,c.worker_fence::text,c.lease_consent_epoch::text,c.release_sha,c.credential_fingerprint,c.policy_hash,c.machine_evidence_digest,
    (c.revoked_at IS NULL AND c.expires_at>clock_timestamp()) AS current
    FROM private.strata_owner_recovery_consent_receipt r JOIN private.strata_owner_recovery_consent_challenge c ON c.id=r.challenge_id
    WHERE r.request_id=$1::uuid AND r.owner_id=$2::uuid AND r.account_id=$3 AND c.owner_id=r.owner_id AND c.account_id=r.account_id
    AND c.consumed_request_id=r.request_id AND c.consent_digest=r.consent_digest LIMIT 2`,[input.consentRequestId,actor.subject,account.id]);
   const c=receipt.rows[0];if(receipt.rows.length!==1||!c.current||c.control_sequence!==h.sequence||c.worker_fence!==l.fencing_token||c.lease_consent_epoch!==l.consent_epoch||c.release_sha!==sha||c.credential_fingerprint!==account.key_fingerprint||c.policy_hash!==account.policy_hash||c.machine_evidence_digest!==(binding as Extract<Binding,{ok:true}>).evidenceDigest)blockers.push('current_scoped_owner_consent_missing');
   const intents=await tx.query("SELECT id FROM public.v13_production_intent WHERE account_id=$1 AND (terminal IS DISTINCT FROM true OR state IS NULL OR state IN ('PREPARED','DISPATCHED','UNKNOWN') OR reserved_micros IS NULL OR reserved_micros<>0) LIMIT 1",[account.id]);
   const positions=await tx.query('SELECT id FROM public.v13_production_position WHERE account_id=$1 AND (quantity_hundredths IS NULL OR quantity_hundredths<>0) LIMIT 1',[account.id]);
   const exits=await tx.query("SELECT reservation_id FROM private.strata_emergency_exit_reservations WHERE execution_account_id=$1 AND state IN ('PREPARED','DISPATCHED','UNKNOWN') LIMIT 1",[account.id]);
   if(intents.rows.length)blockers.push('unresolved_local_order_or_reservation');if(positions.rows.length)blockers.push('local_exposure_present');if(exits.rows.length)blockers.push('unresolved_protective_exit');
   hadHistory=(await tx.query('SELECT id FROM public.v13_production_intent WHERE account_id=$1 LIMIT 1',[account.id])).rows.length>0;
   if(hadHistory)blockers.push('retained_history_requires_full_signed_ledger_reconciliation');
   scope={revision:String(account.revision),head:h.sequence,fence:l.fencing_token,epoch:l.consent_epoch,state:l.state,kill:l.account_kill,arm:l.arm_requested};
   if(blockers.length===2)material=await loadedMaterial(tx,account);
  });
 }catch{blockers.push('local_recovery_telemetry_unavailable');return out();}
 if(blockers.length>2||!account||!scope)return out();
 if(!material){blockers.push('restricted_signer_unavailable');return out();}
 // Seven calls cover one page per required feed. Extra pagination is missing
 // evidence, never a flat account. No retries; abort bounds provider work.
 let calls=0,budgetExceeded=false;const providerAbort=new AbortController();const providerTimer=setTimeout(()=>providerAbort.abort(),5000);const observedAt=Date.now();
 const boundedGet:typeof getOwnedProductionKalshiJson=async(...args)=>{if(++calls>7||providerAbort.signal.aborted){budgetExceeded=true;throw Error('provider_read_budget');}return (deps.providerGet??getOwnedProductionKalshiJson)(args[0],args[1],args[2],args[3],args[4],actor.subject,providerAbort.signal);};
 let feeds;try{feeds=await readOwnedKalshiFeeds(material,observedAt,boundedGet);}catch{feeds={ok:false as const,reason:'provider_read_failed'};}finally{clearTimeout(providerTimer);}
 facts.providerRequests=Math.min(calls,7);
 if(!feeds.ok||budgetExceeded){blockers.push(budgetExceeded?'provider_read_budget_exhausted':'signed_provider_read_unavailable');return out();}
 if(feeds.observedAtMs!==observedAt||Date.now()-observedAt>=5000||Date.now()<observedAt||feeds.historicalCoverageComplete!==true){blockers.push('fresh_complete_provider_read_unverified');return out();}
 const snapshot=personalAccountSnapshot({subaccount:1,exchangeIndex:2,keyFingerprint:String(account.key_fingerprint)},feeds,[]);
 if(!('identity' in snapshot)||feeds.cashMicros!==String(account.cash_micros)||snapshot.orders.length||snapshot.fills.length||snapshot.positions.length||snapshot.settlements.length){blockers.push('provider_flat_empty_history_or_cash_unverified');return out();}
 try{await read(async tx=>{const r=await tx.query(`SELECT a.revision::text,h.sequence::text,l.fencing_token::text,l.consent_epoch::text,l.state,l.account_kill,l.arm_requested
 FROM public.v13_production_account a JOIN private.strata_owner_control_heads h ON h.execution_account_id=a.id AND h.owner_user_id=a.owner_user_id
 JOIN private.kalshi_account_worker_lease l ON l.execution_account_id=a.id AND l.owner_user_id=a.owner_user_id WHERE a.id=$1 AND a.owner_user_id=$2::uuid LIMIT 2`,[account.id,actor.subject]);const r0=r.rows[0];if(r.rows.length!==1||r0.revision!==scope.revision||r0.sequence!==scope.head||r0.fencing_token!==scope.fence||r0.consent_epoch!==scope.epoch||r0.state!==scope.state||r0.account_kill!==scope.kill||r0.arm_requested!==scope.arm)blockers.push('control_changed_during_provider_read');});}catch{blockers.push('final_control_read_unavailable');}
 try{await read(async tx=>{const receipt=await tx.query(`SELECT c.id FROM private.strata_owner_recovery_consent_receipt r JOIN private.strata_owner_recovery_consent_challenge c ON c.id=r.challenge_id WHERE r.request_id=$1::uuid AND r.owner_id=$2::uuid AND r.account_id=$3 AND c.owner_id=r.owner_id AND c.account_id=r.account_id AND c.consumed_request_id=r.request_id AND c.consent_digest=r.consent_digest AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp() LIMIT 2`,[input.consentRequestId,actor.subject,account.id]);if(receipt.rows.length!==1)blockers.push('owner_consent_changed_during_provider_read');});}catch{blockers.push('final_owner_consent_read_unavailable');}
 let sessionCurrent=false;try{sessionCurrent=await deps.verifyCurrentSession(input.token,actor.subject);}catch{}
 if(!sessionCurrent||deployedGitSha()!==sha||Date.now()>=binding.validUntil||Date.now()-observedAt>=5000||Date.now()<observedAt)blockers.push('evidence_or_session_changed_before_completion');
 facts.providerReadVerified=blockers.length===2;
 return out();
}
