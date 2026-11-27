import {V13_CHAMPION_PARAMETER_HASH,V13_CHAMPION_PARAMETER_SET} from '@workspace/v13-strategy';
import {WARREN_BUFFETT_SPEC} from './warrenBuffett';
type Query={query(sql:string,args?:unknown[]):Promise<{rows:Record<string,unknown>[]}>};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const CHAMPION=Object.freeze({id:V13_CHAMPION_PARAMETER_SET.id,name:'C52/C53',
 parameterHash:V13_CHAMPION_PARAMETER_HASH,status:'EXISTING_OWNER_POLICY',
 executionQualification:'EXISTING_SAFETY_GATES_REQUIRED',
 description:'Original C52/C53 crossing strategy. Allocation policy controls sizing, not strategy.'});
const CANDIDATE=Object.freeze({id:WARREN_BUFFETT_SPEC.id,name:WARREN_BUFFETT_SPEC.name,
 parameterHash:null,status:'RESEARCH_ONLY',executionQualification:'NOT_LIVE_QUALIFIED',
 description:'Bounded post-cross confirmation candidate. Untrained; profitability and live execution are not validated.'});
/** A catalog is descriptive, never a strategy grant. Scope comes solely from
 * authenticated subject. No mutable selection route exists until versioned
 * policy/fee/release authorization and final wire checks support a second bot.
 */
export async function readOwnerBotCatalog(owner:string,db:Query){
 if(!UUID.test(owner))return {ok:false as const,reason:'authenticated_owner_required'};
 const r=await db.query(`SELECT a.id,p.state AS policy_state,p.strategy_parameter_set_id,p.strategy_parameter_hash,
  w.state AS worker_state,w.arm_requested
 FROM public.v13_production_account a
 LEFT JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
  AND p.created_by=a.owner_user_id::text AND p.approved_by=a.owner_user_id::text
 LEFT JOIN private.kalshi_account_worker_lease w ON w.execution_account_id=a.id AND w.owner_user_id=a.owner_user_id
 WHERE a.owner_user_id=$1::uuid AND a.subaccount=1 AND a.exchange_index=2 LIMIT 2`,[owner]);
 if(r.rows.length!==1)return {ok:false as const,reason:'owned_account_missing_or_ambiguous'};
 const a=r.rows[0]!;
 const verified=a.policy_state==='APPROVED'&&a.strategy_parameter_set_id===CHAMPION.id&&a.strategy_parameter_hash===CHAMPION.parameterHash;
 return {ok:true as const,version:'OWNER_BOT_CATALOG_V1' as const,accountId:String(a.id),
  currentBotId:verified?CHAMPION.id:null,currentPolicyVerified:verified,
  workerMayBeActive:a.worker_state==='owned'||a.arm_requested===true,
  selectionEnabled:false as const,executionAuthority:'NONE' as const,
  reason:'strategy_switch_requires_separate_qualified_owner_policy',bots:[CHAMPION,CANDIDATE]};
}
