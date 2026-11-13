import type {PoolClient} from '@workspace/db';
export type RecoveryProviderIdentity = {authenticated:boolean;active:boolean;restricted:boolean;observedAtMs:number;ownerId:string;financialAccountId:string;providerConnectionId:string;credentialFingerprint:string;subaccount:number;exchangeIndex:number};
/** Candidate contract only. No genuine provider adapter is supplied by this
 * module. Caller input/assertions alone are not production authentication. */
export function recoveryCredentialGuard(scope:{accountId:string;ownerId:string;credentialFingerprint:string},readIdentity?: (tx:PoolClient)=>Promise<RecoveryProviderIdentity>){
 let held:PoolClient|undefined,identity:Readonly<RecoveryProviderIdentity>|undefined;
 let financial='',connection='',started=0;
 const attempts=async(tx:PoolClient)=>{
  const r=await tx.query(`SELECT id FROM private.kalshi_account_operation_attempts
   WHERE financial_account_id=$1::uuid
   AND (state IS NULL OR state NOT IN ('completed','cancelled')) LIMIT 1`,[financial]);
  if(r.rows.length)throw Error('account_operation_outcome_unresolved');
 };
 const fresh=()=>{const now=Date.now();if(!identity||!Number.isSafeInteger(identity.observedAtMs)||identity.observedAtMs<started||identity.observedAtMs>now||now-identity.observedAtMs>5000)throw Error('provider_identity_not_fresh');};
 return {
  lock:async(tx:PoolClient)=>{
   if(!readIdentity)throw Error('trusted_provider_identity_reader_missing');
   const row=await tx.query(`SELECT l.financial_account_id::text,l.provider_connection_id::text
    FROM private.kalshi_account_worker_lease l JOIN private.provider_connections pc
     ON pc.id=l.provider_connection_id AND pc.financial_account_id=l.financial_account_id
    JOIN public.financial_accounts fa ON fa.id=pc.financial_account_id AND fa.user_id=l.owner_user_id
    WHERE l.execution_account_id=$1 AND l.owner_user_id=$2::uuid FOR UPDATE OF pc,fa`,[scope.accountId,scope.ownerId]);
   if(row.rows.length!==1)throw Error('owned_credential_connection_unverified');
   financial=row.rows[0].financial_account_id;connection=row.rows[0].provider_connection_id;held=tx;
   await attempts(tx);started=Date.now();identity=Object.freeze({...await readIdentity(tx)});
   if(identity.authenticated!==true||identity.active!==true||identity.restricted!==true||identity.ownerId!==scope.ownerId||identity.financialAccountId!==financial||identity.providerConnectionId!==connection||identity.credentialFingerprint!==scope.credentialFingerprint||identity.subaccount!==1||identity.exchangeIndex!==2)throw Error('provider_identity_unverified');
   fresh();
  },
  beforeCommit:async(tx:PoolClient)=>{if(tx!==held)throw Error('credential_guard_transaction_changed');await attempts(tx);fresh();}
 };
}
