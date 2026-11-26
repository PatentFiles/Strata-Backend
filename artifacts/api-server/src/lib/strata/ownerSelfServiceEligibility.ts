import {runtimeAuthSql} from './runtimeAuthRelation';
/**
 * Public self-service identity boundary. This is neither a fee grant nor
 * permission to activate a worker. Each caller must still execute its existing
 * phase-specific signed evidence, consent, accounting and locking checks.
 *
 * The platform can qualify a release once. Customer identities are discovered
 * from trusted owner/account relationships at request time, never from a
 * configured cohort or a browser-supplied account selector.
 */
import {configuredOwnerSelfScope,type OwnerSelfEnrollmentScope} from "./ownerSelfReviewMode";
type Row=Record<string,unknown>;
export type EligibilityQuery={query(sql:string,params?:unknown[]):Promise<{rows:Row[]}>};
export type ScopePurpose="authority"|"recovery";
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{40}$/;
export function publicSelfServiceRequested(env:NodeJS.ProcessEnv=process.env):boolean{
 return env.STRATA_PUBLIC_SELF_SERVICE_ENABLED!==undefined&&env.STRATA_PUBLIC_SELF_SERVICE_ENABLED!=="false";
}
export function publicSelfServiceReleaseQualified(sha:string,env:NodeJS.ProcessEnv=process.env):boolean{
 return env.NODE_ENV==="production"&&env.STRATA_PUBLIC_SELF_SERVICE_ENABLED==="true"&&
  SHA.test(sha)&&env.RAILWAY_GIT_COMMIT_SHA===sha&&env.STRATA_PUBLIC_SELF_SERVICE_QUALIFIED_SHA===sha;
}
export const OWNED_SELF_SERVICE_SCOPE_SQL=runtimeAuthSql(`
 SELECT a.id AS account_id,a.owner_user_id::text AS owner_id,
        a.key_fingerprint, a.policy_id, p.policy_hash,
        a.commissioned,a.execution_enabled,a.kill_switch,a.blocked_reason,
        a.cash_precision_verified,a.cash_micros::text AS cash_micros,
        a.reserved_micros::text AS reserved_micros,
        a.reconciled_at,
        a.cash_micros=a.initial_cash_micros+COALESCE(
          (SELECT sum(e.cash_delta_micros) FROM public.v13_production_event e WHERE e.account_id=a.id),0
        ) AS conserved,
        inv.active_count,inv.role_count,inv.key_count,inv.secret_count,inv.restricted_count,
        inv.verified_count,
        s.configured_stake_cents
 FROM auth.users u
 JOIN public.v13_production_account a ON a.owner_user_id=u.id AND a.subaccount=1 AND a.exchange_index=2
 JOIN public.financial_accounts fa ON fa.id=a.kalshi_connection_id AND fa.user_id=u.id AND fa.provider='kalshi'
 JOIN private.provider_connections pc ON pc.financial_account_id=fa.id AND pc.vault_secret_id IS NOT NULL
 JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
      AND p.created_by=u.id::text AND p.approved_by=u.id::text AND p.state='APPROVED'
 JOIN public.strata_configured_stake s ON s.execution_account_id=a.id
 CROSS JOIN LATERAL (
  SELECT count(*)::int AS active_count,count(DISTINCT c.role)::int AS role_count,
    count(DISTINCT c.key_fingerprint)::int AS key_count,count(DISTINCT c.vault_secret_id)::int AS secret_count,
    count(*) FILTER (WHERE c.role='restricted_execution' AND c.key_fingerprint=a.key_fingerprint
      AND c.verified_at IS NOT NULL AND c.verified_at<=clock_timestamp()
      AND c.verification_reason='credential_verified' AND c.vault_secret_id IS NOT NULL
      AND c.vault_secret_id<>pc.vault_secret_id)::int AS restricted_count,
    count(*) FILTER (WHERE c.verified_at IS NOT NULL AND c.verified_at<=clock_timestamp()
      AND c.verification_reason='credential_verified' AND c.key_fingerprint ~ '^[a-f0-9]{64}$'
      AND c.vault_secret_id IS NOT NULL AND c.vault_secret_id<>pc.vault_secret_id)::int AS verified_count
  FROM private.kalshi_connection_credentials c
  WHERE c.owner_user_id=u.id AND c.financial_account_id=fa.id AND c.provider_connection_id=pc.id
   AND c.revoked_at IS NULL
   AND c.role=ANY(ARRAY['provisioning','verification','account_setup_execution','restricted_execution']::text[])
 ) inv
 WHERE u.id=$1::uuid AND u.email_confirmed_at IS NOT NULL
   AND (u.banned_until IS NULL OR u.banned_until<=clock_timestamp())
   AND (SELECT count(*) FROM public.v13_production_account x WHERE x.owner_user_id=u.id AND x.subaccount=1 AND x.exchange_index=2)=1
   AND (SELECT count(*) FROM public.financial_accounts x WHERE x.user_id=u.id AND x.provider='kalshi')=1
   AND (SELECT count(*) FROM private.provider_connections x WHERE x.financial_account_id=fa.id)=1
   AND a.key_fingerprint ~ '^[a-f0-9]{64}$' AND p.policy_hash ~ '^[a-f0-9]{64}$'
   AND s.configured_stake_cents BETWEEN 500 AND 2500000
   AND s.configured_stake_cents<=p.max_entry_stake_cents AND s.configured_stake_cents<=p.max_entry_all_in_cents
 LIMIT 2
`);
export type OwnedSelfServiceScope=OwnerSelfEnrollmentScope&{
 keyFingerprint:string;policyHash:string;commissioned:boolean;executionEnabled:boolean;killSwitchOn:boolean;
 blocked:boolean;cashConserved:boolean;cashReconciled:boolean;cashMicros:string;reservedMicros:string;stakeCents:number;
};
/** Ownership admission deliberately does not require fee authority before the
 * fee-authority endpoint. Recovery can admit a nonconserving basis for the
 * specialized signed repair, but can never treat that basis as ready to trade.
 */
export async function readOwnedSelfServiceScope(db:EligibilityQuery,owner:string,sha:string,
 purpose:ScopePurpose="authority",env:NodeJS.ProcessEnv=process.env):Promise<OwnedSelfServiceScope|undefined>{
 if(!UUID.test(owner)||!SHA.test(sha)||sha!==env.RAILWAY_GIT_COMMIT_SHA||
  env.STRATA_PUBLIC_SELF_SERVICE_ENABLED!=="true"||
  (purpose==="authority"&&!publicSelfServiceReleaseQualified(sha,env)))return undefined;
 try{
  const r=(await db.query(OWNED_SELF_SERVICE_SCOPE_SQL,[owner])).rows;
  if(r.length!==1)return undefined;
  const a=r[0]!;
  if(a.owner_id!==owner||typeof a.account_id!=="string"||!a.account_id||a.restricted_count!==1||
   typeof a.key_fingerprint!=="string"||!/^[a-f0-9]{64}$/.test(a.key_fingerprint)||
   typeof a.policy_hash!=="string"||!/^[a-f0-9]{64}$/.test(a.policy_hash)||
   (purpose==="authority"&&(a.active_count!==4||a.role_count!==4||a.key_count!==4||a.secret_count!==4||a.verified_count!==4)))return undefined;
  const stake=Number(a.configured_stake_cents),at=a.reconciled_at instanceof Date?a.reconciled_at.getTime():Date.parse(String(a.reconciled_at));
  if(!Number.isSafeInteger(stake)||stake<500||stake>2500000||typeof a.cash_micros!=="string"||!/^\d+$/.test(a.cash_micros)||
    typeof a.reserved_micros!=="string"||!/^\d+$/.test(a.reserved_micros))return undefined;
  return {ownerId:owner,accountId:a.account_id,keyFingerprint:a.key_fingerprint,policyHash:a.policy_hash,
    commissioned:a.commissioned===true,executionEnabled:a.execution_enabled===true,killSwitchOn:a.kill_switch!==false,
    blocked:a.blocked_reason!==null,cashConserved:a.conserved===true,
    cashReconciled:a.cash_precision_verified===true&&Number.isFinite(at)&&at<=Date.now()&&Date.now()-at<=900000,
    cashMicros:a.cash_micros,reservedMicros:a.reserved_micros,stakeCents:stake};
 }catch{return undefined;}
}
/** Legacy pilot compatibility is deliberately unreachable in public mode.
 * An invalid/missing platform qualification in public mode fails closed.
 * Only the explicitly disabled/not-yet-migrated release retains its previous
 * pilot settings; no new public customer depends on those settings.
 */
export async function resolveOwnerSelfScope(db:EligibilityQuery,owner:string,sha:string,
 purpose:ScopePurpose="authority",env:NodeJS.ProcessEnv=process.env):Promise<OwnerSelfEnrollmentScope|undefined>{
 if(publicSelfServiceRequested(env)){
  const current=await readOwnedSelfServiceScope(db,owner,sha,purpose,env);
  return current?{ownerId:current.ownerId,accountId:current.accountId}:undefined;
 }
 return configuredOwnerSelfScope(owner,sha,env);
}


/** Initialize the stopped lease for a newly commissioned, never-run account.
 * The caller MUST hold its execution-account row lock and transaction.
 * Do not use this to repair existing leases, orders or financial history.
 * A concurrent insert fails closed; no mutation of an existing lease. */
export async function initializePublicStoppedLease(tx:EligibilityQuery,owner:string,account:string,sha:string,
 env:NodeJS.ProcessEnv=process.env):Promise<boolean>{
 const scope=await readOwnedSelfServiceScope(tx,owner,sha,"authority",env);
 if(!scope||scope.accountId!==account||!scope.commissioned||scope.executionEnabled||
  !scope.killSwitchOn||scope.blocked||!scope.cashConserved||!scope.cashReconciled||
  BigInt(scope.reservedMicros)!==0n)return false;
 const r=await tx.query(INSERT_PUBLIC_STOPPED_LEASE_SQL,[owner,account,scope.keyFingerprint]);
 return r.rows.length===1;
}
export const INSERT_PUBLIC_STOPPED_LEASE_SQL=`
 INSERT INTO private.kalshi_account_worker_lease
 (execution_account_id,owner_user_id,financial_account_id,provider_connection_id,holder_id,
  fencing_token,state,heartbeat_at,released_at,account_kill,arm_requested,credential_fingerprint,vault_secret_id)
 SELECT a.id,a.owner_user_id,a.kalshi_connection_id,pc.id,'initial-commissioning',1,'killed',
  clock_timestamp(),clock_timestamp(),true,false,c.key_fingerprint,c.vault_secret_id
 FROM public.v13_production_account a
 JOIN public.financial_accounts f ON f.id=a.kalshi_connection_id AND f.user_id=a.owner_user_id AND f.provider='kalshi'
 JOIN private.provider_connections pc ON pc.financial_account_id=f.id
 JOIN private.kalshi_connection_credentials c ON c.provider_connection_id=pc.id AND c.financial_account_id=f.id
  AND c.owner_user_id=a.owner_user_id AND c.role='restricted_execution'
  AND c.revoked_at IS NULL AND c.verified_at IS NOT NULL AND c.verification_reason='credential_verified'
  AND c.key_fingerprint=a.key_fingerprint AND c.vault_secret_id IS NOT NULL
 WHERE a.owner_user_id=$1::uuid AND a.id=$2 AND a.key_fingerprint=$3
  AND a.subaccount=1 AND a.exchange_index=2 AND a.commissioned AND NOT a.execution_enabled
  AND a.kill_switch AND a.blocked_reason IS NULL AND a.reserved_micros=0
  AND NOT EXISTS(SELECT 1 FROM public.v13_production_intent i WHERE i.account_id=a.id)
  AND NOT EXISTS(SELECT 1 FROM public.v13_production_event e WHERE e.account_id=a.id)
  AND NOT EXISTS(SELECT 1 FROM public.v13_production_position p WHERE p.account_id=a.id)
 ON CONFLICT (execution_account_id) DO NOTHING RETURNING execution_account_id
`;
