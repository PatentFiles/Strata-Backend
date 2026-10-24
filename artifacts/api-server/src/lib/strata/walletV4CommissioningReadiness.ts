/**
 * Issue #165: Wallets-only, authenticated owner-scoped V4 release diagnostics.
 * READ-ONLY. Zero grant issuance, account mutation, policy amendment or orders.
 * "ready" is deliberately false until signed-POST V4 enforcement exists.
 */
import {pool} from "@workspace/db";
import {deployedGitSha} from "./deployedGitSha";
import {approvedDynamicStakeSnapshot} from "./approvedDynamicStakeSnapshot";

type Row=Record<string,unknown>;
type Q={query(sql:string,args?:unknown[]):Promise<{rows:Row[]}>};
type Deps={db?:Q;getSha?:()=>string;now?:()=>number};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA=/^[0-9a-f]{40}$/i;
const iso=(x:unknown)=>x instanceof Date?x.getTime():Date.parse(String(x??""));
export type WalletV4Readiness={
 ok:boolean;reason:string;accountId:string|null;deployedSha:string|null;
 checks:{accountOwned:boolean;commissioned:boolean;approvedStakePolicy:boolean;
   cashReconciled:boolean;modelEvidence:boolean;feeAuthority:boolean;
   ownerShaApproval:boolean;protectiveExitRelease:boolean;
   signedPostAuthority:boolean};
 blockers:string[];tradingAuthorized:false;ordersSubmitted:false;
};
const empty=():WalletV4Readiness["checks"]=>({
 accountOwned:false,commissioned:false,approvedStakePolicy:false,
 cashReconciled:false,modelEvidence:false,feeAuthority:false,
 ownerShaApproval:false,protectiveExitRelease:false,
 signedPostAuthority:false,
});
const fail=(reason:string):WalletV4Readiness=>({
 ok:false,reason,accountId:null,deployedSha:null,checks:empty(),
 blockers:[reason],tradingAuthorized:false,ordersSubmitted:false,
});
const ACCOUNT_SQL=`
 SELECT a.id,a.commissioned,a.cash_precision_verified,a.reconciled_at,
 a.cash_micros::text AS cash_micros,a.reserved_micros::text AS reserved_micros,
 s.configured_stake_cents,s.risk_capital_cents,s.risk_preset_id,s.risk_preset_revision,
 p.policy_hash,p.fee_policy_version,p.state,
 p.capital_limit_cents,p.max_entry_stake_cents,p.max_entry_all_in_cents,
 p.max_daily_loss_cents,p.max_total_loss_cents
 FROM public.v13_production_account a
 LEFT JOIN public.strata_configured_stake s ON s.execution_account_id=a.id
 LEFT JOIN public.v13_live_money_policy p ON p.id=a.policy_id
 WHERE a.owner_user_id=$1::uuid AND a.subaccount=1 AND a.exchange_index=2
`;
const AUTH_SQL=`
 SELECT
 EXISTS(SELECT 1 FROM private.strata_wallet_v4_fee_evidence e
  WHERE e.owner_user_id=$1::uuid AND e.execution_account_id=$2
    AND e.deployed_sha=$3 AND e.revoked_at IS NULL
    AND e.observed_at<=now() AND e.expires_at>now()) AS model_evidence,
 EXISTS(SELECT 1 FROM private.strata_wallet_v4_fee_authority g
  JOIN private.strata_wallet_v4_fee_evidence e
    ON e.evidence_id=g.evidence_id AND e.owner_user_id=g.owner_user_id
   AND e.execution_account_id=g.execution_account_id
   AND e.model_digest=g.model_digest AND e.deployed_sha=g.deployed_sha
  WHERE g.owner_user_id=$1::uuid AND g.execution_account_id=$2
    AND g.deployed_sha=$3 AND g.policy_hash=$4
    AND g.revoked_at IS NULL AND g.approved_at<=now()
    AND g.expires_at>now() AND e.revoked_at IS NULL
    AND e.expires_at>now()
    AND 'ORDER_ENTRY'=ANY(g.authorized_stages)) AS fee_authority,
 EXISTS(SELECT 1 FROM private.strata_owner_sha_approvals r
  WHERE r.owner_user_id=$1::uuid AND r.execution_account_id=$2
    AND r.release_commit_sha=$3 AND r.revoked_at IS NULL) AS owner_sha_approval,
 EXISTS(SELECT 1 FROM private.strata_protective_exit_release pr
  WHERE pr.release_commit_sha=$3 AND pr.state='approved'
    AND pr.revoked_at IS NULL AND pr.expires_at>now()) AS protective_exit_release
`;
/** Only the JWT-supplied subject may be passed; no request-body account IDs. */
export async function inspectWalletV4Readiness(
 ownerId:string,deps:Deps={},
):Promise<WalletV4Readiness>{
 if(!UUID.test(ownerId))return fail("wallet_v4_authenticated_owner_required");
 const sha=(deps.getSha??deployedGitSha)().toLowerCase();
 const deployedSha=SHA.test(sha)?sha:null;
 const now=(deps.now??Date.now)();
 if(!Number.isSafeInteger(now)||now<1)return fail("wallet_v4_clock_unverified");
 try{
  const db=deps.db??pool;
  const {rows}=await db.query(ACCOUNT_SQL,[ownerId]);
  if(rows.length!==1)
   return fail("wallet_v4_owned_account_missing_or_ambiguous");
  const a=rows[0]!;
  const accountId=typeof a.id==="string"?a.id:null;
  if(!accountId)return fail("wallet_v4_account_identity_unverified");
  const checks=empty();
  checks.accountOwned=true;
  checks.commissioned=a.commissioned===true;
  const approved=approvedDynamicStakeSnapshot(a);
  checks.approvedStakePolicy=approved.ok;
  const cash=/^\d+$/.test(String(a.cash_micros??""))?
   BigInt(String(a.cash_micros)):0n;
  const reserved=/^\d+$/.test(String(a.reserved_micros??""))?
   BigInt(String(a.reserved_micros)):cash+1n;
  const reconciled=iso(a.reconciled_at);
  checks.cashReconciled=a.cash_precision_verified===true&&
   reserved<=cash&&approved.ok&&approved.capitalCents!==null&&
   cash-reserved>=BigInt(approved.capitalCents)*10_000n&&
   Number.isFinite(reconciled)&&reconciled<=now&&now-reconciled<=900_000;
  if(deployedSha&&/^[a-f0-9]{64}$/.test(String(a.policy_hash??""))){
   const proof=await db.query(AUTH_SQL,
    [ownerId,accountId,deployedSha,a.policy_hash]);
   if(proof.rows.length===1){
    checks.modelEvidence=proof.rows[0]!.model_evidence===true;
    checks.feeAuthority=proof.rows[0]!.fee_authority===true;
    checks.ownerShaApproval=proof.rows[0]!.owner_sha_approval===true;
    checks.protectiveExitRelease=proof.rows[0]!.protective_exit_release===true;
   }
  }
  // Explicitly NOT a go-live release: V4 signed-POST checks are still absent.
  const blockers=Object.entries(checks).filter(([,value])=>!value)
   .map(([name])=>"wallet_v4_"+name+"_required");
  if(!deployedSha)blockers.unshift("wallet_v4_deployed_sha_unavailable");
  return {ok:true,reason:"wallet_v4_read_only_gate_report",
   accountId,deployedSha,checks,blockers,
   tradingAuthorized:false,ordersSubmitted:false};
 }catch{
  return fail("wallet_v4_readiness_database_unavailable");
 }
}
