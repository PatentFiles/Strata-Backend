/** Inactive local candidate. No production caller or migration is supplied.
 * A lease claim is NOT permission to submit orders or a complete START operation.
 */
import {deployedGitSha} from './deployedGitSha';
import {ARM_LEASE_SQL,ACQUIRE_LEASE_SQL} from './accountScopedExecution';
type Row=Record<string,unknown>;
type Client={query(sql:string,args?:unknown[]):Promise<{rows:Row[]}>;release(error?:Error):void};
type Db={connect():Promise<Client>};
export type BarrierInput={ownerId:string;accountId:string;controlSequence:string;consentGeneration:string;holderId:string;fingerprint:string;secretId:string;providerId:string;financialId:string;now:string;staleBefore:string;releaseSha:string;policyHash:string;expectedFence:string;challengeId:string;evidenceId:string;requestId:string};
type Proof=({ok:true;validUntil:number;consumedInTransaction?:true}&BarrierInput)|{ok:false};
export async function claimThroughOwnerBarrier(db:Db,input:BarrierInput,options:{enabled?:boolean;verifyLocked?:(tx:Client,input:BarrierInput)=>Promise<Proof>}={}){
 const deny=(reason:string,uncertain=false)=>({ok:false as const,reason,uncertain,ordersSubmitted:false as const});
 if(options.enabled!==true)return deny('owner_barrier_candidate_disabled');
 if(!options.verifyLocked)return deny('owner_barrier_proof_verifier_missing');
 if(!input.ownerId||!input.accountId||!input.holderId||!input.fingerprint||!/^\d+$/.test(input.controlSequence)||!/^\d+$/.test(input.consentGeneration))return deny('owner_barrier_input_invalid');
 if(input.releaseSha!==deployedGitSha())return deny('owner_barrier_runtime_sha_mismatch');
 let tx:Client|null=null,commitAttempted=false,committed=false;let discard:Error|undefined;
 try{
  tx=await db.connect();await tx.query('BEGIN');await tx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');await tx.query("SET LOCAL lock_timeout='750ms'");await tx.query("SET LOCAL statement_timeout='5000ms'");
  const a=(await tx.query('SELECT id,commissioned,execution_enabled,kill_switch,key_fingerprint,blocked_reason,policy_id,kalshi_connection_id FROM public.v13_production_account WHERE id=$1 AND owner_user_id=$2::uuid FOR UPDATE',[input.accountId,input.ownerId])).rows;
  if(a.length!==1||a[0].commissioned!==true||a[0].execution_enabled!==true||a[0].kill_switch!==false||a[0].blocked_reason!=null||a[0].key_fingerprint!==input.fingerprint)return deny('owner_barrier_account_not_ready');
  // Proposed schema; missing table/head is a refusal, never legacy fallback.
  const h=(await tx.query('SELECT sequence::text sequence,stopped FROM private.strata_owner_control_heads WHERE execution_account_id=$1 AND owner_user_id=$2::uuid FOR UPDATE',[input.accountId,input.ownerId])).rows;
  if(h.length!==1||h[0].sequence!==input.controlSequence||h[0].stopped!==false)return deny('owner_barrier_control_superseded');
  const g=(await tx.query('SELECT generation::text generation FROM private.strata_owner_consent_heads WHERE execution_account_id=$1 AND owner_user_id=$2::uuid FOR UPDATE',[input.accountId,input.ownerId])).rows;
  if(g.length!==1||g[0].generation!==input.consentGeneration)return deny('owner_barrier_consent_superseded');
  const canonical=(await tx.query(`SELECT c.vault_secret_id::text secret_id,c.provider_connection_id::text provider_id,c.financial_account_id::text financial_id,p.policy_hash
 FROM private.kalshi_connection_credentials c
 JOIN public.financial_accounts fa ON fa.id=c.financial_account_id AND fa.user_id=c.owner_user_id AND fa.provider='kalshi'
 JOIN private.provider_connections pc ON pc.id=c.provider_connection_id AND pc.financial_account_id=fa.id
 JOIN public.v13_live_money_policy p ON p.id=$3 AND p.execution_account_id=$1 AND p.state='APPROVED' AND p.created_by=$2::text
 WHERE c.owner_user_id=$2::uuid AND c.financial_account_id=$4::uuid AND c.role='restricted_execution'
 AND c.revoked_at IS NULL AND c.verified_at IS NOT NULL AND c.key_fingerprint=$5
 FOR SHARE OF c,fa,pc,p`,[input.accountId,input.ownerId,a[0].policy_id,a[0].kalshi_connection_id,input.fingerprint])).rows;
  if(canonical.length!==1||canonical[0].secret_id!==input.secretId||canonical[0].provider_id!==input.providerId||canonical[0].financial_id!==input.financialId||canonical[0].policy_hash!==input.policyHash)return deny('owner_barrier_canonical_scope_mismatch');
  const lease=(await tx.query('SELECT owner_user_id::text owner_id,financial_account_id::text financial_id,provider_connection_id::text provider_id,vault_secret_id::text secret_id,credential_fingerprint,fencing_token::text fence,state,account_kill,arm_requested FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1 FOR UPDATE',[input.accountId])).rows;
  if(lease.length!==1||lease[0].owner_id!==input.ownerId||lease[0].financial_id!==input.financialId||lease[0].provider_id!==input.providerId||lease[0].secret_id!==input.secretId||lease[0].credential_fingerprint!==input.fingerprint||lease[0].fence!==input.expectedFence||lease[0].state!=='released'||lease[0].account_kill!==false||lease[0].arm_requested!==false)return deny('owner_barrier_lease_scope_mismatch');
  if(!/^[a-f0-9]{40}$/.test(input.releaseSha)||!input.challengeId||!input.evidenceId||!input.requestId)return deny('owner_barrier_authority_scope_invalid');
  const clock=(await tx.query("SELECT clock_timestamp()::text now, (extract(epoch FROM clock_timestamp())*1000)::bigint::text ms, (clock_timestamp()-interval '30 seconds')::text stale_before")).rows[0];
  const serverMs=Number(clock?.ms);if(!Number.isSafeInteger(serverMs))return deny('owner_barrier_clock_unavailable');
  const p=await options.verifyLocked(tx,input);
  if(!p.ok||!Number.isSafeInteger(p.validUntil)||p.validUntil<=serverMs||['ownerId','accountId','controlSequence','consentGeneration','fingerprint','secretId','providerId','financialId','releaseSha','policyHash','expectedFence','challengeId','evidenceId','requestId'].some(k=>(p as any)[k]!== (input as any)[k]))return deny('owner_barrier_fresh_scoped_proof_required');
  const evidence=(await tx.query(`SELECT evidence_id,(extract(epoch FROM expires_at)*1000)::bigint::text expires_ms FROM private.strata_owner_admission_evidence WHERE evidence_id=$1 AND challenge_id=$2 AND owner_user_id=$3::uuid AND execution_account_id=$4 AND release_sha=$5 AND policy_hash=$6 AND credential_fingerprint=$7 AND secret_id=$8::uuid AND provider_id=$9::uuid AND financial_id=$10::uuid AND control_sequence=$11::bigint AND consent_generation=$12::bigint AND expected_fence=$13::bigint AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE`,[input.evidenceId,input.challengeId,input.ownerId,input.accountId,input.releaseSha,input.policyHash,input.fingerprint,input.secretId,input.providerId,input.financialId,input.controlSequence,input.consentGeneration,input.expectedFence])).rows;
  if(evidence.length!==1||!Number.isSafeInteger(Number(evidence[0].expires_ms)))return deny('owner_barrier_evidence_unavailable');
  const deadline=Math.min(p.validUntil,Number(evidence[0].expires_ms));
  if((await tx.query('SELECT request_id FROM private.strata_owner_admission_outcomes WHERE request_id=$1 OR evidence_id=$2',[input.requestId,input.evidenceId])).rows.length)return deny('owner_barrier_already_consumed_readback_required');
  const armed=await tx.query(ARM_LEASE_SQL,[input.accountId,input.ownerId,input.fingerprint,input.secretId,clock.now,input.providerId,input.financialId]);if(armed.rows.length!==1)return deny('owner_barrier_released_lease_required');
  const acquired=await tx.query(ACQUIRE_LEASE_SQL,[input.accountId,input.holderId,clock.now,input.fingerprint,input.secretId,input.providerId,input.financialId,input.ownerId,clock.stale_before]);
  if(acquired.rows.length!==1||! /^[1-9][0-9]*$/.test(String(acquired.rows[0].fencing_token)))return deny('owner_barrier_claim_failed');
  const finalMs=Number((await tx.query('SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint::text ms')).rows[0]?.ms);if(input.releaseSha!==deployedGitSha())return deny('owner_barrier_runtime_sha_mismatch');if(!Number.isSafeInteger(finalMs)||deadline<=finalMs)return deny('owner_barrier_proof_expired');
  const scope={...input};delete (scope as any).now;delete (scope as any).staleBefore;
  const receipt=await tx.query('INSERT INTO private.strata_owner_admission_outcomes(request_id,evidence_id,owner_user_id,execution_account_id,scope,fencing_token) VALUES($1,$2,$3::uuid,$4,$5::jsonb,$6::bigint) RETURNING request_id',[input.requestId,input.evidenceId,input.ownerId,input.accountId,JSON.stringify(scope),acquired.rows[0].fencing_token]);
  if(receipt.rows.length!==1)return deny('owner_barrier_outcome_not_recorded');
  const commitMs=Number((await tx.query('SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint::text ms')).rows[0]?.ms);
  if(!Number.isSafeInteger(commitMs)||deadline<=commitMs)return deny('owner_barrier_evidence_or_proof_expired_before_commit');
  if(input.releaseSha!==deployedGitSha())return deny('owner_barrier_runtime_sha_mismatch');
  commitAttempted=true;await tx.query('COMMIT');committed=true;
  return {ok:true as const,reason:'lease_claimed_not_trading_authority',fencingToken:String(acquired.rows[0].fencing_token),ordersSubmitted:false as const,tradingAuthorized:false as const};
 }catch{if(commitAttempted)discard=new Error('owner_barrier_commit_outcome_unknown');return deny(commitAttempted?'owner_barrier_commit_outcome_unknown':'owner_barrier_unavailable',commitAttempted);}
 finally{if(tx){if(!committed)try{await tx.query('ROLLBACK');}catch(e){discard=e instanceof Error?e:new Error('owner_barrier_rollback_failed');}tx.release(discard);}}
}

/** Historical outcome only. Never resumes a worker or treats a receipt as current authority. */
export async function readOwnerBarrierOutcome(db:{query(sql:string,args?:unknown[]):Promise<{rows:Row[]}>},input:BarrierInput){
 try{const rows=(await db.query('SELECT scope,fencing_token::text fencing_token,committed_at FROM private.strata_owner_admission_outcomes WHERE request_id=$1 AND owner_user_id=$2::uuid AND execution_account_id=$3',[input.requestId,input.ownerId,input.accountId])).rows;
 if(rows.length!==1)return {status:'NOT_OBSERVED' as const,retryAuthorized:false,tradingAuthorized:false};
 const expected={...input};delete (expected as any).now;delete (expected as any).staleBefore;
 const recorded=rows[0].scope as Record<string,unknown>;
 if(Object.keys(expected).some(k=>(expected as any)[k]!==recorded[k])||Object.keys(recorded).length!==Object.keys(expected).length)return {status:'SCOPE_CONFLICT' as const,retryAuthorized:false,tradingAuthorized:false};
 return {status:'COMMITTED_HISTORICAL' as const,fencingToken:rows[0].fencing_token,committedAt:rows[0].committed_at,retryAuthorized:false,tradingAuthorized:false};
 }catch{return {status:'UNKNOWN' as const,retryAuthorized:false,tradingAuthorized:false};}
}
