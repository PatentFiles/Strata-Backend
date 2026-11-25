import {runtimeAuthSql} from './runtimeAuthRelation';
import {deployedGitSha} from "./deployedGitSha";
import {publicSelfServiceReleaseQualified} from "./ownerSelfServiceEligibility";

type Row=Record<string,unknown>;
type Query={query(text:string,params?:unknown[]):Promise<{rows:Row[]}>};
type Scope={authenticatedUserId:string;financialAccountId:string;providerConnectionId:string;attemptId:string};
type Operation="create_subaccount"|"generate_api_key"|"provision_execution_account";

/** Caller already holds the exact prepared operation and credential checks.
 * Only a qualified public build may substitute new-owner isolation for the
 * legacy master shutdown. Never use this for an existing account or recovery.
 * No changes to global gates, financial state or execution permission.
 */
export async function technicalSetupMasterSafe(client:Query,master:{rows:Row[]},scope:Scope,operation:Operation):Promise<boolean>{
 if(master.rows.length!==1)return false;
 const gate=master.rows[0]!;
 if(gate.live_execution_enabled===false&&gate.manual_kill_switch===true)return true;
 if(gate.live_execution_enabled!==true||gate.manual_kill_switch!==false||
  !publicSelfServiceReleaseQualified(deployedGitSha()))return false;
 const args=[scope.authenticatedUserId,scope.financialAccountId,scope.providerConnectionId,scope.attemptId,operation];
 // The actual reviewed technical setup records this immutable plan in the
 // claim transaction. A direct/manual legacy request cannot use this path.
 const lock=await client.query(runtimeAuthSql(`
 SELECT pc.id FROM private.provider_connections pc
 JOIN public.financial_accounts f ON f.id=pc.financial_account_id
 JOIN auth.users u ON u.id=f.user_id
 WHERE u.id=$1::uuid AND f.id=$2::uuid AND pc.id=$3::uuid AND f.provider='kalshi'
 AND u.email_confirmed_at IS NOT NULL AND (u.banned_until IS NULL OR u.banned_until<=clock_timestamp())
 AND pc.vault_secret_id IS NOT NULL
 FOR UPDATE OF pc`),args.slice(0,3));
 if(lock.rows.length!==1)return false;
 // Separate statement after locking: a waiting claimant must reread current
 // account/connection state, rather than rely on its earlier SQL snapshot.
 const fresh=await client.query(`
 SELECT a.id FROM private.kalshi_account_operation_attempts a
 WHERE a.owner_user_id=$1::uuid AND a.financial_account_id=$2::uuid
 AND a.provider_connection_id=$3::uuid AND a.id=$4::uuid AND a.operation=$5
 AND a.state='prepared' AND a.owner_technical_plan_digest ~ '^[a-f0-9]{64}$'
 AND a.owner_technical_authorized_at<=clock_timestamp()
 AND a.owner_technical_authorized_at>=clock_timestamp()-interval '2 minutes'
 AND (SELECT count(*) FROM public.financial_accounts f WHERE f.user_id=$1::uuid AND f.provider='kalshi')=1
 AND (SELECT count(*) FROM private.provider_connections pc WHERE pc.financial_account_id=$2::uuid)=1
 AND NOT EXISTS(SELECT 1 FROM public.v13_production_account x WHERE x.owner_user_id=$1::uuid OR x.kalshi_connection_id=$2::uuid)
 FOR UPDATE OF a`,args);
 return fresh.rows.length===1;
}
