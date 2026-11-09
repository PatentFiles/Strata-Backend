import {dedicatedSignerFingerprint} from './commissioning';
type Row=Record<string,unknown>;
export type DiagnosticClient={query:(sql:string,args?:unknown[])=>Promise<{rows:Row[]}>;release:(error?:Error)=>void;on:(event:string,listener:()=>void)=>unknown;removeListener:(event:string,listener:()=>void)=>unknown};
export type DiagnosticDatabase={connect:()=>Promise<DiagnosticClient>};
const SCOPE_SQL=`SELECT a.id,a.owner_user_id::text,a.key_fingerprint,p.policy_hash,
 c.financial_account_id::text,c.provider_connection_id::text,c.vault_secret_id::text,
 w.fencing_token::text,current_user AS database_role,current_setting('session_replication_role') AS replication_role
 FROM public.v13_production_account a
 JOIN private.kalshi_account_worker_lease w ON w.execution_account_id=a.id AND w.owner_user_id=a.owner_user_id
 JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id AND p.state='APPROVED'
 JOIN private.kalshi_connection_credentials c ON c.owner_user_id=a.owner_user_id AND c.financial_account_id=a.kalshi_connection_id
 JOIN public.financial_accounts fa ON fa.id=c.financial_account_id AND fa.user_id=a.owner_user_id AND fa.provider='kalshi'
 JOIN private.provider_connections pc ON pc.id=c.provider_connection_id AND pc.financial_account_id=fa.id
 WHERE a.owner_user_id=$1::uuid AND a.commissioned=true AND a.subaccount=1 AND a.exchange_index=2
 AND a.kill_switch=true AND a.execution_enabled=false AND a.reserved_micros=0
 AND w.state='killed' AND w.arm_requested=false AND w.account_kill=true
 AND c.role='restricted_execution' AND c.revoked_at IS NULL AND c.verified_at IS NOT NULL
 AND c.verification_reason='credential_verified' AND c.key_fingerprint=a.key_fingerprint
 AND w.credential_fingerprint=c.key_fingerprint AND w.financial_account_id=c.financial_account_id
 AND w.provider_connection_id=c.provider_connection_id AND w.vault_secret_id=c.vault_secret_id
 AND NOT EXISTS(SELECT 1 FROM public.v13_production_position pos WHERE pos.account_id=a.id AND pos.quantity_hundredths<>0)
 AND NOT EXISTS(SELECT 1 FROM private.strata_emergency_exit_reservations e WHERE e.execution_account_id=a.id AND e.state IN ('PREPARED','DISPATCHED','UNKNOWN'))
 AND NOT EXISTS(SELECT 1 FROM public.v13_production_intent i WHERE i.account_id=a.id AND i.terminal=false)
 LIMIT 2`;
/** Uses existing backend access only. No credentials are created or granted.
 * Read-only transaction plus advisory lock gives cross-process single flight.
 * Its connection remains leased until all pending collector work has drained. */
export async function loadHeldReadDiagnosticScope(db:DiagnosticDatabase,owner:string,signal:AbortSignal,onLoss:()=>void=()=>{}){
 signal.throwIfAborted();const client=await db.connect();let closed=false,lost=false;
 const loss=()=>{if(closed)return;lost=true;try{onLoss();}catch{}};
 client.on('error',loss);client.on('end',loss);
 const close=async()=>{if(closed)return;closed=true;try{if(!lost)await client.query('ROLLBACK');}finally{client.removeListener('error',loss);client.removeListener('end',loss);client.release(new Error('diagnostic_connection_discard'));}};
 try{
  signal.throwIfAborted();await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
  await client.query("SET LOCAL statement_timeout='2000ms'");
  const lock=await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended('strata:held-read-diagnostic:'||$1,0)) AS acquired",[owner]);
  if(lock.rows[0]?.acquired!==true)throw Error('diagnostic_busy');
  const capture=async()=>{if(lost)throw Error('diagnostic_lock_lost');signal.throwIfAborted();const result=await client.query(SCOPE_SQL,[owner]);signal.throwIfAborted();
   if(result.rows.length!==1||result.rows[0].owner_user_id!==owner||result.rows[0].replication_role!=='origin')throw Error('diagnostic_scope_refused');
   return result.rows[0];};
  const row=await capture(),identity=JSON.stringify(row);
  const secret=await client.query('SELECT decrypted_secret FROM vault.decrypted_secrets WHERE id=$1::uuid',[row.vault_secret_id]);
  signal.throwIfAborted();
  if(secret.rows.length!==1)throw Error('diagnostic_signer_missing');
  const raw=secret.rows[0].decrypted_secret;
  const data=typeof raw==='string'?JSON.parse(raw):raw;
  if(!data||typeof data!=='object')throw Error('diagnostic_signer_invalid');
  const parsed=data as Record<string,unknown>;
  const keyId=parsed.keyId??parsed.apiKeyId??parsed.api_key_id??parsed.key_id;
  const privateKey=parsed.privateKey??parsed.private_key;
  if(typeof keyId!=='string'||typeof privateKey!=='string'||dedicatedSignerFingerprint(keyId,privateKey)!==row.key_fingerprint)throw Error('diagnostic_signer_mismatch');
  return {material:{keyId,privateKey},databaseRole:String(row.database_role),replicationRole:'origin' as const,
   authorize:async()=>{if(JSON.stringify(await capture())!==identity)throw Error('diagnostic_scope_changed');},close};
 }catch(error){await close();throw error;}
}
