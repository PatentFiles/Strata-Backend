import {randomUUID} from 'node:crypto';
import {OWNER_UNKNOWN_ACCOUNTING_CONFIRMATION,ownerUnknownEvidenceDigest} from './ownerUnknownRecoveryPlan';

/** Dependency-injected accounting fence. A caller must already
 * have authenticated the AAL2 owner. No default database, signer or transport is
 * provided here. This is a safety KILL, not lease takeover, order cancellation,
 * financial reconciliation, liquidation, or execution authorization.
 */
type Row=Record<string,unknown>;
type Query={query(sql:string,args?:unknown[]):Promise<{rows:Row[]}>};
type Client=Query&{release(error?:Error):void};
type Db=Query&{connect():Promise<Client>};
type Input={ownerId:string;targetIntentId:string;confirmation:unknown};
type Dependencies={db:Db;isScheduled:(owner:string,account:string)=>boolean};
const uuid=(x:unknown):x is string=>typeof x==='string'&&
 /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(x);
const uint=(x:unknown):x is string=>typeof x==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(x);
const requireProof=(ok:unknown,reason:string)=>{if(!ok)throw Error(reason);};
const no=(reason:string,attemptId:string|null=null,outcomeUnknown=false)=>({
 ok:false as const,reason,attemptId,outcomeUnknown,
 ordersSubmitted:false as const,workerStarted:false as const,tradingAuthorized:false as const,
 riskFreezeCleared:false as const,accountingCommitted:false as const,reservationsReleased:false as const,
});

export async function fenceOwnerUnknownForAccounting(input:Input,deps:Dependencies){
 if(!uuid(input.ownerId)||!uuid(input.targetIntentId)||
   input.confirmation!==OWNER_UNKNOWN_ACCOUNTING_CONFIRMATION)
  return no('explicit_authenticated_owner_confirmation_required');
 if(typeof deps?.isScheduled!=='function'||!deps.db||typeof deps.db.connect!=='function')
  return no('recovery_dependencies_unavailable');
 let client:Client|null=null,commitSent=false,committed=false,attemptId:string|null=null;
 try{
  // The owner determines the account. The client cannot select account, key,
  // exchange, cash, tokens, revisions, or a replacement financial request.
  const accounts=await deps.db.query(`SELECT id FROM public.v13_production_account
   WHERE owner_user_id=$1::uuid AND subaccount=1 AND exchange_index=2 LIMIT 2`,[input.ownerId]);
  requireProof(accounts.rows.length===1&&typeof accounts.rows[0]!.id==='string',
   'recovery_owned_account_missing_or_ambiguous');
  const accountId=accounts.rows[0]!.id as string;
  requireProof(deps.isScheduled(input.ownerId,accountId)===false,'recovery_worker_not_proven_stopped');
  client=await deps.db.connect();
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout='1200ms'");
  await client.query("SET LOCAL statement_timeout='8000ms'");
  // Match the final dispatch lock order. Any already-running final wire section
  // completes before this lock can be acquired. Its outcome remains UNKNOWN.
  const accountsLocked=await client.query(`SELECT id,owner_user_id::text,revision::text,
   key_fingerprint,subaccount,exchange_index FROM public.v13_production_account
   WHERE id=$1 AND owner_user_id=$2::uuid FOR UPDATE`,[accountId,input.ownerId]);
  requireProof(accountsLocked.rows.length===1,'recovery_account_changed');
  const account=accountsLocked.rows[0]!;
  requireProof(account.id===accountId&&account.owner_user_id===input.ownerId&&
   (account.subaccount===1||account.subaccount==='1')&&(account.exchange_index===2||account.exchange_index==='2')&&uint(account.revision)&&
   typeof account.key_fingerprint==='string'&&/^[a-f0-9]{64}$/.test(account.key_fingerprint),
   'recovery_account_scope_unverified');
  const leases=await client.query(`SELECT execution_account_id,owner_user_id::text,state,
   fencing_token::text,credential_fingerprint FROM private.kalshi_account_worker_lease
   WHERE execution_account_id=$1 AND owner_user_id=$2::uuid FOR UPDATE`,[accountId,input.ownerId]);
  requireProof(leases.rows.length===1,'recovery_worker_fence_missing');
  const lease=leases.rows[0]!;
  requireProof(lease.execution_account_id===accountId&&lease.owner_user_id===input.ownerId&&
   (lease.state==='owned'||lease.state==='killed')&&uint(lease.fencing_token)&&
   BigInt(lease.fencing_token)<9223372036854775807n&&
   lease.credential_fingerprint===account.key_fingerprint,'recovery_worker_fence_unverified');
  const intents=await client.query(`SELECT id,account_id,kind,state,terminal,reserved_micros::text
   FROM public.v13_production_intent WHERE id=$1 AND account_id=$2 FOR UPDATE`,
   [input.targetIntentId,accountId]);
  requireProof(intents.rows.length===1&&intents.rows[0]!.id===input.targetIntentId&&
   intents.rows[0]!.account_id===accountId&&intents.rows[0]!.kind==='ENTRY'&&
   intents.rows[0]!.state==='UNKNOWN'&&intents.rows[0]!.terminal===false&&
   uint(intents.rows[0]!.reserved_micros),'recovery_target_unknown_entry_required');
  requireProof(deps.isScheduled(input.ownerId,accountId)===false,'recovery_worker_not_proven_stopped');
  const killed=await client.query(`UPDATE public.v13_production_account SET kill_switch=true,
   execution_enabled=false,revision=revision+1 WHERE id=$1 AND owner_user_id=$2::uuid AND revision=$3
   RETURNING revision::text`,[accountId,input.ownerId,account.revision]);
  requireProof(killed.rows.length===1&&uint(killed.rows[0]!.revision)&&
   BigInt(killed.rows[0]!.revision)===BigInt(account.revision as string)+1n,'recovery_account_kill_cas_refused');
  const fenced=await client.query(`UPDATE private.kalshi_account_worker_lease SET state='killed',
   account_kill=true,arm_requested=false,fencing_token=fencing_token+1,
   released_at=clock_timestamp(),heartbeat_at=clock_timestamp()
   WHERE execution_account_id=$1 AND owner_user_id=$2::uuid AND fencing_token=$3::bigint
   RETURNING fencing_token::text`,[accountId,input.ownerId,lease.fencing_token]);
  requireProof(fenced.rows.length===1&&uint(fenced.rows[0]!.fencing_token)&&
   BigInt(fenced.rows[0]!.fencing_token)===BigInt(lease.fencing_token as string)+1n,
   'recovery_kill_fence_cas_refused');
  attemptId=randomUUID();
  const event={ownerId:input.ownerId,accountId,targetIntentId:input.targetIntentId,
   priorToken:lease.fencing_token,nextToken:fenced.rows[0]!.fencing_token,
   priorRevision:account.revision,nextRevision:killed.rows[0]!.revision,
   financialStateChanged:false,tradingAuthorized:false};
  const payload=JSON.stringify(event),digest=ownerUnknownEvidenceDigest(event);
  await client.query(`INSERT INTO public.v13_production_observation(id,account_id,kind,payload,digest)
   VALUES($1,$2,'OWNER_UNKNOWN_ACCOUNTING_KILL_FENCE',$3::jsonb,$4)`,[attemptId,accountId,payload,digest]);
  commitSent=true;await client.query('COMMIT');committed=true;
  return {ok:true as const,reason:'unknown_accounting_safety_fence_committed',attemptId,
   accountId,targetIntentId:input.targetIntentId,priorToken:lease.fencing_token as string,
   nextToken:fenced.rows[0]!.fencing_token as string,accountRevision:killed.rows[0]!.revision as string,
   ordersSubmitted:false as const,workerStarted:false as const,tradingAuthorized:false as const,
   riskFreezeCleared:false as const,accountingCommitted:false as const,reservationsReleased:false as const,
   outcomeUnknown:false as const};
 }catch(error){
  // A failed COMMIT acknowledgement is not proof of rollback. The owner-scoped
  // attempt receipt and durable account/lease must be read before any retry.
  if(commitSent)return no('recovery_fence_commit_outcome_unverified',attemptId,true);
  const reason=error instanceof Error&&/^recovery_[a-z_]+$/.test(error.message)?error.message:
   'recovery_fence_transaction_failed';
  return no(reason,attemptId);
 }finally{
  if(client){
   let discard=commitSent&&!committed;
   if(!committed)try{await client.query('ROLLBACK');}catch{discard=true;}
   try{client.release(discard?new Error('recovery_fence_connection_discarded'):undefined);}catch{/* result remains conservative */}
  }
 }
}
