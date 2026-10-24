/**
 * #165: final V4 order-admission component for the EXISTING V13 executor.
 * This never submits an order, issues a release, or bypasses the owner or
 * protective-exit fences. Its DB locks remain held by the caller through POST.
 */
import {deployedGitSha} from "./deployedGitSha";
import {observeDynamicKalshiFees,type DynamicFeeResult} from "./dynamicOfficialFeeSchedule";
import {boundDynamicFeeEntryV4,DYNAMIC_FEE_POLICY_VERSION_V4} from "./dynamicFeeOrderRiskV4";
import {approvedDynamicStakeSnapshot} from "./approvedDynamicStakeSnapshot";
import type {Request} from "../v13-production/types";

const SHA=/^[a-f0-9]{40}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
const MARKET=/^KXBTC15M-[A-Za-z0-9-]+$/;
type Row=Record<string,unknown>;
export type V4Tx={query(sql:string,args?:unknown[]):Promise<{rows:Row[]}>};
export type V4EntryContext={
 ownerId:string;accountId:string;policyHash:string;stakeRevision:number;
 request:Request;reservedExitFeeCents:number;
 availableCashMicros:string;reservedCashMicros:string;nowMs:number;
};
type Ports={sha?:()=>string;observe?:(ticker:string)=>Promise<DynamicFeeResult>;enabled?:()=>boolean};

/** SQL locks ALL fee, credential, owner, policy and exit approvals through signed POST. */
export const FINAL_V4_ADMISSION_SQL=[
 "SELECT a.id,a.owner_user_id::text AS owner_user_id,",
 " a.cash_micros::text AS cash_micros,a.reserved_micros::text AS reserved_micros,",
 " p.policy_hash,p.fee_policy_version,p.state,p.capital_limit_cents,",
 " p.max_entry_stake_cents,p.max_entry_all_in_cents,p.max_daily_loss_cents,p.max_total_loss_cents,",
 " s.configured_stake_cents,s.revision AS stake_revision,s.risk_preset_id,s.risk_preset_revision,s.risk_capital_cents,",
 " g.authority_id::text AS authority_id,g.model_digest,g.approved_at,g.expires_at,g.revoked_at,g.authorized_stages,",
 " e.official_source_digest,e.market_ticker,e.observed_at,e.expires_at AS evidence_expires_at,e.revoked_at AS evidence_revoked_at,",
 " oa.approval_id::text AS owner_approval_id,x.release_id::text AS exit_release_id",
 " FROM public.v13_production_account a",
 " JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id",
 " JOIN public.strata_configured_stake s ON s.execution_account_id=a.id",
 " JOIN public.live_execution_config live ON live.id='singleton'",
 " JOIN private.kalshi_account_worker_lease lease ON lease.execution_account_id=a.id",
 " AND lease.owner_user_id=a.owner_user_id AND lease.financial_account_id=a.kalshi_connection_id",
 " AND lease.credential_fingerprint=a.key_fingerprint",
 " JOIN private.kalshi_connection_credentials c ON c.owner_user_id=a.owner_user_id",
 " AND c.financial_account_id=a.kalshi_connection_id AND c.key_fingerprint=a.key_fingerprint",
 " JOIN private.strata_wallet_v4_fee_authority g ON g.owner_user_id=a.owner_user_id",
 " AND g.execution_account_id=a.id AND g.policy_hash=p.policy_hash",
 " AND g.policy_version=p.fee_policy_version",
 " JOIN private.strata_wallet_v4_fee_evidence e ON e.evidence_id=g.evidence_id",
 " AND e.owner_user_id=g.owner_user_id AND e.execution_account_id=g.execution_account_id",
 " AND e.deployed_sha=g.deployed_sha AND e.model_digest=g.model_digest",
 " JOIN private.strata_owner_sha_approvals oa ON oa.owner_user_id=a.owner_user_id",
 " AND oa.execution_account_id=a.id AND oa.release_commit_sha=g.deployed_sha",
 " JOIN private.strata_protective_exit_release x ON x.release_commit_sha=g.deployed_sha",
 " WHERE a.id=$1 AND a.owner_user_id=$2::uuid AND a.subaccount=1 AND a.exchange_index=2",
 " AND a.commissioned=true AND a.execution_enabled=true AND a.kill_switch=false",
 " AND a.blocked_reason IS NULL AND a.cash_precision_verified=true",
 // Match the Wallets 15-minute freshness gate, but recheck transactionally
 // at the signed POST boundary: UI refresh cannot authorize stale cash.
 " AND a.reconciled_at<=now() AND a.reconciled_at>now()-interval '15 minutes'",
 " AND p.fee_policy_version='strata_owner_provider_dynamic_fee_v4'",
 " AND p.state='APPROVED' AND p.policy_hash=$3",
 " AND s.revision=$4 AND s.configured_stake_cents BETWEEN 500 AND 2500000",
 " AND live.live_execution_enabled=true AND live.manual_kill_switch=false",
 " AND lease.state='owned' AND lease.account_kill=false AND lease.arm_requested=true",
 " AND lease.heartbeat_at>now()-interval '5 seconds' AND lease.fencing_token>0",
 " AND lease.holder_id IS NOT NULL",
 " AND c.role='restricted_execution' AND c.revoked_at IS NULL",
 " AND c.verified_at IS NOT NULL AND c.verification_reason='credential_verified'",
 " AND g.deployed_sha=$5 AND e.deployed_sha=$5",
 " AND g.revoked_at IS NULL AND g.approved_at<=now()",
 " AND g.expires_at>now()+interval '30 seconds'",
 " AND e.revoked_at IS NULL AND e.observed_at<=now()",
 " AND e.expires_at>now()+interval '30 seconds' AND e.market_ticker=$6",
 " AND 'ORDER_ENTRY'=ANY(g.authorized_stages) AND oa.revoked_at IS NULL",
 " AND x.state='approved' AND x.revoked_at IS NULL AND x.created_at<=now()",
 " AND x.expires_at>now()+interval '20 minutes'",
 " AND x.independent_reviewer_id<>a.owner_user_id",
 " AND x.operator_approver_id<>x.independent_reviewer_id",
 " FOR SHARE OF a,p,s,live,lease,c,g,e,oa,x",
].join("\n");
const deny=(reason:string)=>({ok:false as const,reason,tradingAuthorized:false as const});
const numeric=(value:unknown):number|null=>{
 if(typeof value==="number")return Number.isSafeInteger(value)&&value>=0?value:null;
 if(typeof value==="string"&&/^(?:0|[1-9]\d*)$/.test(value)){
  const n=Number(value);return Number.isSafeInteger(n)?n:null;
 }
 return null;
};
const micros=(value:unknown):bigint|null=>
 typeof value==="string"&&/^\d+$/.test(value)?BigInt(value):null;
const timestamp=(v:unknown)=>v instanceof Date?v.getTime():Date.parse(String(v??""));

/** A positive result is one necessary condition, NEVER sufficient trade authority. */
export async function verifyWalletV4FinalSignedAdmission(
 tx:V4Tx,ctx:V4EntryContext,ports:Ports={},
):Promise<{ok:true;modelDigest:string;allInCents:number;tradingAuthorized:false}
 |{ok:false;reason:string;tradingAuthorized:false}>{
 if(!(ports.enabled??(()=>process.env.STRATA_WALLET_V4_SIGNED_POST_ENABLED==="true"))()||
    process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE!=="true")
  return deny("wallet_v4_final_signed_order_or_exit_feature_disabled");
 if(process.env.NODE_ENV!=="test"&&(ports.observe||ports.sha||ports.enabled))
  return deny("wallet_v4_final_override_not_permitted");
 const sha=(ports.sha??deployedGitSha)().toLowerCase(),r=ctx.request;
 if(!SHA.test(sha)||!UUID.test(ctx.ownerId)||!ctx.accountId||
    !HASH.test(ctx.policyHash)||!MARKET.test(r.market)||
    !Number.isSafeInteger(ctx.stakeRevision)||ctx.stakeRevision<1||
    !Number.isSafeInteger(ctx.nowMs)||ctx.nowMs<1)
  return deny("wallet_v4_final_identity_sha_or_policy_invalid");
 if(r.action!=="BUY"||r.reduceOnly!==false||r.timeInForce!=="IOC"||
    (r.side!=="YES"&&r.side!=="NO")||
    !Number.isSafeInteger(r.contracts)||r.contracts<1||
    !Number.isSafeInteger(r.limitMicros)||r.limitMicros<100||
    r.limitMicros>999900||r.limitMicros%100!==0||
    !Number.isSafeInteger(ctx.reservedExitFeeCents)||ctx.reservedExitFeeCents<0||
    !/^v13p-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r.clientOrderId))
  return deny("wallet_v4_final_ioc_order_invalid");
 const cash=micros(ctx.availableCashMicros),reserved=micros(ctx.reservedCashMicros);
 if(cash===null||reserved===null||reserved>cash)
  return deny("wallet_v4_final_cash_invalid");
 let rows:Row[];
 try{rows=(await tx.query(FINAL_V4_ADMISSION_SQL,
    [ctx.accountId,ctx.ownerId,ctx.policyHash,ctx.stakeRevision,sha,r.market])).rows;}
 catch{return deny("wallet_v4_final_sql_fence_unavailable");}
 if(rows.length!==1)return deny("wallet_v4_final_owner_fee_exit_or_lease_closed");
 const p=rows[0]!,policy=approvedDynamicStakeSnapshot(p);
 if(!policy.ok||p.fee_policy_version!==DYNAMIC_FEE_POLICY_VERSION_V4||
    p.owner_user_id!==ctx.ownerId||p.id!==ctx.accountId||
    p.policy_hash!==ctx.policyHash||numeric(p.stake_revision)!==ctx.stakeRevision)
  return deny("wallet_v4_final_approved_policy_changed");
 const dbCash=micros(p.cash_micros),dbReserved=micros(p.reserved_micros);
 if(dbCash===null||dbReserved===null||dbCash!==cash||dbReserved!==reserved||
    dbReserved>dbCash)
  return deny("wallet_v4_final_account_cash_changed");
 const capitalRemaining=(cash-reserved)/10000n;
 if(capitalRemaining>BigInt(Number.MAX_SAFE_INTEGER)||!policy.capitalCents)
  return deny("wallet_v4_final_capital_unknown");
 let proof:DynamicFeeResult;
 try{proof=await (ports.observe??observeDynamicKalshiFees)(r.market);}
 catch{return deny("wallet_v4_final_official_provider_unavailable");}
 if(!proof.ok)return deny("wallet_v4_final_official_provider_unverified");
 const approvedAt=timestamp(p.approved_at),expiresAt=timestamp(p.expires_at),
  evidenceExpiry=timestamp(p.evidence_expires_at);
 if(!Number.isFinite(approvedAt)||!Number.isFinite(expiresAt)||
    !Number.isFinite(evidenceExpiry)||evidenceExpiry-ctx.nowMs<=30000||
    typeof p.model_digest!=="string"||typeof p.official_source_digest!=="string"||
    p.revoked_at!==null||p.evidence_revoked_at!==null)
  return deny("wallet_v4_final_authority_expired_or_revoked");
 const result=boundDynamicFeeEntryV4({
  policyVersion:DYNAMIC_FEE_POLICY_VERSION_V4,
  ownerId:ctx.ownerId,executionAccountId:ctx.accountId,
  marketTicker:r.market,modelDigest:p.model_digest,
  officialPublicationDigest:p.official_source_digest,
  deployedSha:sha,approvedAtMs:approvedAt,expiresAtMs:expiresAt,
  revokedAtMs:null,authorizedStages:Array.isArray(p.authorized_stages)?p.authorized_stages as string[]:[],
  maxGrossEntryCents:policy.stakeCents!,maxAllInEntryCents:numeric(p.max_entry_all_in_cents)??0,
 },proof.model,{
  ownerId:ctx.ownerId,executionAccountId:ctx.accountId,deployedSha:sha,
  marketTicker:r.market,side:r.side,action:r.action,
  reduceOnly:false,timeInForce:"IOC",postOnly:false,
  limitPriceTicks:r.limitMicros/100,contractsHundredths:r.contracts*100,
  availableCashCents:Number(capitalRemaining),
  capitalRemainingCents:Math.min(Number(capitalRemaining),policy.capitalCents),
  approvedPolicyGrossCents:policy.stakeCents!,
  approvedPolicyAllInCents:numeric(p.max_entry_all_in_cents)??0,
  reservedExitFeeCents:ctx.reservedExitFeeCents,nowMs:ctx.nowMs,
 });
 if(!result.ok)return deny(result.reason);
 if(process.env.NODE_ENV!=="test"&&Date.now()-ctx.nowMs>15000)
  return deny("wallet_v4_final_quote_expired");
 return {ok:true,modelDigest:result.modelDigest,
  allInCents:result.allInCents,tradingAuthorized:false};
}
