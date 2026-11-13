/** OFFLINE DESIGN CANDIDATE ONLY. Not mounted and has no production issuer.
 * Synthetic verifier in tests is NOT valid recovery evidence. This writer never
 * arms or starts a worker and does not clear any global gate or release approval.
 */
type Tx={query:(sql:string,args?:unknown[])=>Promise<{rows:any[]}>;release:(e?:Error)=>void};
export type ReleaseScope={accountId:string;ownerId:string;revision:string;sequence:string;fence:string;epoch:string;releaseSha:string;requestId:string};
type ReleaseDeps={enabled:boolean;db:{connect:()=>Promise<Tx>};verifyTrustedAuthority?:(tx:Tx,scope:ReleaseScope)=>Promise<{validUntil:number;digest:string}|null>};
/** Production-facing entry cannot mutate: actual writer barrier is not qualified. */
export async function releaseOwnerRecoveryCandidate(_s:ReleaseScope,d:ReleaseDeps){return {status:d.enabled?'actual_writer_barrier_unqualified':'feature_disabled',released:false,tradingAuthorized:false};}
/** Explicit synthetic-only laboratory entry. Refuses any non-disposable database. */
export async function exerciseSyntheticReleaseTransaction(s:ReleaseScope,d:ReleaseDeps){
 const out=(status:string,extra:Record<string,unknown>={}):Record<string,unknown>&{status:string}=>({status,released:false,tradingAuthorized:false,armed:false,...extra});
 if(!d.enabled)return out('feature_disabled');
 // Missing real issuer must fail before connecting, not quietly trust a boolean
 // passed by a browser or a read-only evaluation result.
 if(!d.verifyTrustedAuthority)return out('trusted_recovery_issuer_unavailable');
 let tx:Tx;try{tx=await d.db.connect();}catch{return out('store_unavailable');}
 let commit=false,discard:Error|undefined;
 try{
 const sandbox=await tx.query("SELECT current_database() AS db,inet_server_addr()::text AS address,inet_server_port() AS port");
 if(sandbox.rows.length!==1||sandbox.rows[0].db!=='compatible_disposable'||sandbox.rows[0].address!=='127.0.0.1/32'&&sandbox.rows[0].address!=='127.0.0.1'||sandbox.rows[0].port!==55459)throw Error('synthetic_database_required');
 await tx.query('BEGIN');await tx.query("SET LOCAL lock_timeout='750ms'");await tx.query("SET LOCAL statement_timeout='3000ms'");
 const a=await tx.query('SELECT revision::text,execution_enabled,kill_switch,reserved_micros::text FROM public.v13_production_account WHERE id=$1 AND owner_user_id=$2::uuid FOR UPDATE',[s.accountId,s.ownerId]);
 if(a.rows.length!==1||a.rows[0].revision!==s.revision||a.rows[0].execution_enabled!==false||a.rows[0].kill_switch!==true||a.rows[0].reserved_micros!=='0')throw Error('account_changed');
 const h=await tx.query('SELECT sequence::text FROM private.strata_owner_control_heads WHERE execution_account_id=$1 AND owner_user_id=$2::uuid FOR UPDATE',[s.accountId,s.ownerId]);
 if(h.rows.length!==1||h.rows[0].sequence!==s.sequence)throw Error('control_changed');
 const l=await tx.query('SELECT fencing_token::text,consent_epoch::text,state,account_kill,arm_requested FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1 AND owner_user_id=$2::uuid FOR UPDATE',[s.accountId,s.ownerId]);
 if(l.rows.length!==1||l.rows[0].fencing_token!==s.fence||l.rows[0].consent_epoch!==s.epoch||l.rows[0].state!=='killed'||l.rows[0].account_kill!==true||l.rows[0].arm_requested!==false)throw Error('lease_changed');
 const auth=await d.verifyTrustedAuthority(tx,s); // Synthetic test oracle, not production trust.
 if(!auth||!Number.isFinite(auth.validUntil)||auth.validUntil<=Date.now()||!/^[a-f0-9]{64}$/.test(auth.digest))throw Error('trusted_authority_missing');
 // Mandatory issuer contract: verify and consume persisted one-use authority
 // in THIS transaction, tied to exact owner/session/consent, release SHA,
 // account revision, head, fence, epoch, and fresh complete signed provider
 // evidence, plus retained-history reconciliation. No implementation supplied.
 const i=await tx.query("SELECT id FROM public.v13_production_intent WHERE account_id=$1 AND (terminal IS DISTINCT FROM true OR state IS NULL OR state IN ('PREPARED','DISPATCHED','UNKNOWN') OR reserved_micros IS NULL OR reserved_micros<>0) LIMIT 1",[s.accountId]);
 const p=await tx.query('SELECT id FROM public.v13_production_position WHERE account_id=$1 AND (quantity_hundredths IS NULL OR quantity_hundredths<>0) LIMIT 1',[s.accountId]);
 const e=await tx.query("SELECT reservation_id FROM private.strata_emergency_exit_reservations WHERE execution_account_id=$1 AND (state IS NULL OR state IN ('PREPARED','DISPATCHED','UNKNOWN')) LIMIT 1",[s.accountId]);
 if(i.rows.length||p.rows.length||e.rows.length)throw Error('exposure_or_outcome_unresolved');
 const consumed=await tx.query(`UPDATE private.synthetic_recovery_authority SET consumed_at=clock_timestamp() WHERE request_id=$1::uuid AND account_id=$2 AND owner_id=$3::uuid AND revision=$4::bigint AND sequence=$5::bigint AND fence=$6::bigint AND epoch=$7::bigint AND release_sha=$8 AND digest=$9 AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING request_id`,[s.requestId,s.accountId,s.ownerId,s.revision,s.sequence,s.fence,s.epoch,s.releaseSha,auth.digest]);if(consumed.rows.length!==1)throw Error('persisted_scoped_authority_unavailable');
 const changed=await tx.query("UPDATE private.kalshi_account_worker_lease SET state='released',account_kill=false,arm_requested=false,fencing_token=fencing_token+1,released_at=clock_timestamp() WHERE execution_account_id=$1 AND owner_user_id=$2::uuid AND state='killed' AND fencing_token=$3::bigint AND consent_epoch=$4::bigint RETURNING fencing_token::text",[s.accountId,s.ownerId,s.fence,s.epoch]);
 if(changed.rows.length!==1)throw Error('lease_changed');
 // Account remains execution-disabled; its local kill flag is recoverable only
 // with the same scoped authority. START remains a separate owner operation.
 await tx.query('UPDATE public.v13_production_account SET kill_switch=false,revision=revision+1 WHERE id=$1 AND owner_user_id=$2::uuid',[s.accountId,s.ownerId]);
 await tx.query('INSERT INTO private.strata_owner_recovery_release_receipt(request_id,account_id,owner_id,release_sha,authority_digest) VALUES($1::uuid,$2,$3::uuid,$4,$5)',[s.requestId,s.accountId,s.ownerId,s.releaseSha,auth.digest]);
 const fresh=await tx.query('SELECT clock_timestamp()<to_timestamp($1::double precision/1000) AS fresh',[auth.validUntil]);if(fresh.rows[0]?.fresh!==true)throw Error('authority_expired');
 commit=true;await tx.query('COMMIT');return out('released_disarmed',{released:true});
 }catch(error){if(commit)discard=Error('commit_unknown');try{await tx.query('ROLLBACK');}catch{discard=Error('rollback_failed');}return out(commit?'outcome_unknown':error instanceof Error?error.message:'release_refused',commit?{released:null,readbackRequired:true,retryAuthorized:false}:{});}finally{tx.release(discard);}
}
