/** Default-off integration candidate. Called only by the authenticated
 * server-held session, never with client supplied owner/account/fence.
 * Establishes the existing STOP-style hold without KILL or any financial write.
 * A successful hold is NOT authority to read, reconcile, renew, or sell.
 */
type Row=Record<string,unknown>;
type Client={query(sql:string,params?:unknown[]):Promise<{rows:Row[]}>;release(error?:Error):void};
type DB={connect():Promise<Client>};
export type RecoveryHoldScope=Readonly<{ownerId:string;accountId:string;intentId:string;holderId:string;fencingToken:string;keyFingerprint:string;policyHash:string;financialAccountId:string;providerConnectionId:string;vaultSecretId:string}>;
export type RecoveryHoldResult=Readonly<{held:boolean;uncertain:boolean;reason:string;tradingAuthorized:false;mayRetry:false}>;
const response=(held:boolean,uncertain:boolean,reason:string):RecoveryHoldResult=>({held,uncertain,reason,tradingAuthorized:false,mayRetry:false});
export async function holdUnknownEntryRecovery(db:DB,input:RecoveryHoldScope):Promise<RecoveryHoldResult>{
 const s=Object.freeze({...input});
 if(!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(s.ownerId)||
    ![s.accountId,s.intentId,s.holderId].every(v=>typeof v==='string'&&/^[a-zA-Z0-9:_.-]{1,200}$/.test(v))||
    !/^[1-9][0-9]{0,18}$/.test(s.fencingToken)||
    ![s.keyFingerprint,s.policyHash].every(v=>/^[a-f0-9]{64}$/.test(v))||
    ![s.financialAccountId,s.providerConnectionId,s.vaultSecretId].every(v=>/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v)))return response(false,false,'recovery_hold_scope_invalid');
 let client:Client;
 try{client=await db.connect();}catch{return response(false,false,'recovery_hold_connection_unavailable');}
 let commitStarted=false,discard:Error|undefined;
 try{
  await client.query('BEGIN');
  await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
  await client.query("SET LOCAL lock_timeout='750ms'");
  await client.query("SET LOCAL statement_timeout='5000ms'");
  const a=await client.query(`SELECT id FROM public.v13_production_account
   WHERE id=$1 AND owner_user_id=$2::uuid AND kill_switch=false AND execution_enabled=true
   AND commissioned=true AND subaccount=1 AND exchange_index=2 AND key_fingerprint=$3 FOR UPDATE`,[s.accountId,s.ownerId,s.keyFingerprint]);
  if(a.rows.length!==1)throw Error('recovery_hold_account_unavailable');
  const lease=await client.query(`SELECT fencing_token::text FROM private.kalshi_account_worker_lease
   WHERE execution_account_id=$1 AND owner_user_id=$2::uuid AND holder_id=$3
   AND fencing_token=$4::bigint AND state='owned' AND account_kill=false
   AND credential_fingerprint=$5 AND financial_account_id=$6::uuid AND provider_connection_id=$7::uuid
   AND vault_secret_id=$8::uuid AND heartbeat_at>clock_timestamp()-interval '5 seconds' FOR UPDATE`,[s.accountId,s.ownerId,s.holderId,s.fencingToken,s.keyFingerprint,s.financialAccountId,s.providerConnectionId,s.vaultSecretId]);
  if(lease.rows.length!==1||lease.rows[0].fencing_token!==s.fencingToken)throw Error('recovery_hold_fence_changed');
  const metadata=await client.query(`SELECT p.policy_hash FROM public.v13_production_account a
   JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
   JOIN private.kalshi_connection_credentials c ON c.owner_user_id=a.owner_user_id
    AND c.financial_account_id=a.kalshi_connection_id AND c.key_fingerprint=a.key_fingerprint
   JOIN public.financial_accounts fa ON fa.id=a.kalshi_connection_id AND fa.user_id=a.owner_user_id AND fa.provider='kalshi'
   JOIN private.provider_connections pc ON pc.id=c.provider_connection_id AND pc.financial_account_id=fa.id
   WHERE a.id=$1 AND a.owner_user_id=$2::uuid AND p.policy_hash=$3 AND p.state='APPROVED'
    AND c.key_fingerprint=$4 AND c.financial_account_id=$5::uuid AND c.provider_connection_id=$6::uuid
    AND c.vault_secret_id=$7::uuid AND c.role='restricted_execution' AND c.revoked_at IS NULL
    AND c.verified_at IS NOT NULL AND c.verification_reason='credential_verified'
   FOR SHARE OF p,c,fa,pc`,[s.accountId,s.ownerId,s.policyHash,s.keyFingerprint,s.financialAccountId,s.providerConnectionId,s.vaultSecretId]);
  if(metadata.rows.length!==1||metadata.rows[0].policy_hash!==s.policyHash)throw Error('recovery_hold_metadata_changed');
  const intent=await client.query(`SELECT id FROM public.v13_production_intent
   WHERE account_id=$1 AND id=$2 AND kind='ENTRY' AND state='UNKNOWN' AND terminal=false
   AND dispatch_at IS NOT NULL AND request->>'action'='BUY' AND request->>'reduceOnly'='false'
   AND request->>'timeInForce'='IOC' AND EXISTS (SELECT 1 FROM public.v13_production_observation o
    WHERE o.account_id=$1 AND o.kind='POST_ATTEMPT' AND o.payload->>'id'=$2
    AND o.payload->>'outcome'='GET_RECONCILIATION_REQUIRED') FOR UPDATE`,[s.accountId,s.intentId]);
  if(intent.rows.length!==1)throw Error('recovery_hold_unknown_entry_unproven');
  const hold=await client.query(`UPDATE private.kalshi_account_worker_lease SET arm_requested=false
   WHERE execution_account_id=$1 AND owner_user_id=$2::uuid AND holder_id=$3
   AND fencing_token=$4::bigint AND state='owned' AND account_kill=false
   RETURNING fencing_token::text`,[s.accountId,s.ownerId,s.holderId,s.fencingToken]);
  if(hold.rows.length!==1||hold.rows[0].fencing_token!==s.fencingToken)throw Error('recovery_hold_write_unverified');
  commitStarted=true;
  await client.query('COMMIT');
  return response(true,false,'recovery_entry_hold_committed');
 }catch(error){
  const reason=error instanceof Error?error.message:'recovery_hold_failed';
  discard=error instanceof Error?error:new Error(reason);
  // COMMIT transport ambiguity is not proof of rollback. Never issue another
  // write or authorize recovery; discard and require scoped state inspection.
  if(commitStarted)return response(false,true,'recovery_hold_commit_uncertain');
  try{await client.query('ROLLBACK');}catch{discard=new Error('recovery_hold_rollback_failed');}
  return response(false,false,reason);
 }finally{try{client.release(discard);}catch{/* Never erase committed/uncertain outcome during cleanup. */}}
}
