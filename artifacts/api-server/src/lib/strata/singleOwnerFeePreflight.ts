/**
 * Issue #165: owner-scoped, evidence-only preview for fee onboarding V3.
 * This is NOT a grant or a replacement for any existing trading admission gate.
 *
 * The server supplies the owner identity from the authenticated session and
 * fetches official monetary evidence itself. The browser supplies no rate,
 * review signature, issuance timestamp, or other authority.
 */
import { pool } from "@workspace/db";
import { deployedGitSha } from "./deployedGitSha";
import { verifyMonetaryFeeContract, type MonetaryFeeEvidenceContract } from "./monetaryFeeContract";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Row=Record<string,unknown>;
type Queryable={query:(sql:string,args:unknown[])=>Promise<{rows:Row[]}>};
type Evidence=()=>Promise<MonetaryFeeEvidenceContract>;
export type OwnerFeePreflight={
  ok:boolean;
  reason:string;
  evidenceVerified:boolean;
  ownerAuthenticated:boolean;
  ownerConsentRecorded:false;
  sourceGrantRecorded:false;
  reviewAuthorityRecorded:false;
  tradingAuthorized:false;
  ordersSubmitted:false;
  suggestedNextActions:string[];
  /** Database objects exist; never indicates executable V3 authority. */
  v3SchemaInstalled:boolean;
  /** Current owner/account/SHA consent receipt, evidence-only. */
  v3EvidenceReceiptPresent:boolean;
  sourceDigest?:string;
  marketTicker?:string;
};
const fail=(reason:string,next:string[]=[]):OwnerFeePreflight=>({
  ok:false,reason,evidenceVerified:false,ownerAuthenticated:false,
  ownerConsentRecorded:false,sourceGrantRecorded:false,reviewAuthorityRecorded:false,
  tradingAuthorized:false,ordersSubmitted:false,suggestedNextActions:next,
  v3SchemaInstalled:false,v3EvidenceReceiptPresent:false,
});
const str=(value:unknown)=>typeof value==="string"?value:"";
const int=(value:unknown)=>typeof value==="number"&&Number.isSafeInteger(value)?value:
  typeof value==="string"&&/^\d+$/.test(value)&&Number.isSafeInteger(Number(value))?Number(value):null;

const OWNER_SQL=`
 SELECT a.id,a.commissioned,a.execution_enabled,a.kill_switch,a.blocked_reason,
   a.subaccount,a.exchange_index,p.fee_policy_version,p.state AS policy_state,
   s.configured_stake_cents,l.state AS lease_state
 FROM public.v13_production_account a
 LEFT JOIN public.v13_live_money_policy p ON p.id=a.policy_id
 LEFT JOIN public.strata_configured_stake s ON s.execution_account_id=a.id
 LEFT JOIN private.kalshi_account_worker_lease l
   ON l.execution_account_id=a.id AND l.owner_user_id=a.owner_user_id
 WHERE a.owner_user_id=$1::uuid AND a.subaccount=1 AND a.exchange_index=2
 LIMIT 2
`;

/** Safe to invoke without a reviewer. Never inserts policy, grant or order rows. */
export async function inspectSingleOwnerFeePreflight(
  ownerId:string,
  deps:{db?:Queryable;observe?:Evidence;sha?:()=>string}={},
):Promise<OwnerFeePreflight> {
  if(!UUID.test(ownerId))return fail("owner_identity_invalid");
  const db=deps.db??pool as unknown as Queryable;
  let account:Row;
  try{
    const q=await db.query(OWNER_SQL,[ownerId]);
    if(q.rows.length!==1)return fail("owned_execution_account_missing_or_ambiguous");
    account=q.rows[0]!;
  }catch{return fail("owner_fee_preflight_database_unavailable");}
  const actions:string[]=[];
  if(account.lease_state==="owned")actions.push("recover_stale_worker_with_signed_kalshi");
  // Durable eligibility is not an active worker. A killed lease with
  // the owner/account kill switches engaged is the safe stopped state.
  // Do not report a false STOP blocker solely because execution_enabled
  // remains true from historical commissioning.
  if(account.kill_switch!==true)
    actions.push("stop_and_disarm_before_policy_migration");
  if(int(account.configured_stake_cents)!==500)
    actions.push("approve_and_save_five_dollar_policy");
  if(account.commissioned!==true||str(account.blocked_reason)==="awaiting_account_commissioning")
    actions.push("refresh_owner_commissioning");
  // #165: report installed database state, not the old permanent "schema not released" message.
  // The schema and receipt confer NO fee grant, policy migration, or trading permission.
  // Both reads are scoped and bounded. Missing schema or unavailable reads fail closed.
  let v3SchemaInstalled=false,v3EvidenceReceiptPresent=false;
  try {
    const schema=await db.query(
      "SELECT to_regclass('private.strata_owner_fee_evidence_v3') IS NOT NULL AS installed",
      [],
    );
    v3SchemaInstalled=schema.rows.length===1&&schema.rows[0]?.installed===true;
    if(v3SchemaInstalled) {
      // A receipt is a non-executable owner consent candidate, not a fee-source grant.
      // Only an exact current runtime SHA is relevant; never reuse prior deployments.
      const sha=(deps.sha??deployedGitSha)();
      if(/^[a-f0-9]{40}$/.test(sha)){
        const receipt=await db.query(`
          SELECT attestation_id FROM private.strata_owner_fee_evidence_v3
          WHERE owner_user_id=$1::uuid AND execution_account_id=$2
            AND release_commit_sha=$3 AND revoked_at IS NULL AND expires_at>now()
          LIMIT 2
        `,[ownerId,account.id,sha]);
        v3EvidenceReceiptPresent=receipt.rows.length===1;
      }else actions.push("exact_runtime_sha_unavailable_for_v3_evidence");
    }
    actions.push(v3SchemaInstalled
      ?v3EvidenceReceiptPresent
        ?"owner_fee_v3_evidence_only_grant_and_migration_still_required"
        :"owner_fee_v3_evidence_consent_not_recorded"
      :"owner_fee_v3_schema_migration_required");
  }catch{
    v3SchemaInstalled=false;
    v3EvidenceReceiptPresent=false;
    actions.push("owner_fee_v3_schema_or_receipt_read_unavailable");
  }
  actions.push("owner_fee_v3_execution_grant_and_policy_migration_not_released");
  actions.push("exact_sha_protective_exit_exchange_qualification_required");
  let evidence:MonetaryFeeEvidenceContract;
  try{evidence=await (deps.observe??(()=>verifyMonetaryFeeContract("STEP_9")))();}
  catch{return {...fail("official_monetary_fee_source_unavailable",actions),ownerAuthenticated:true,
    v3SchemaInstalled,v3EvidenceReceiptPresent};}
  if(!evidence.ok||!evidence.monetaryFeeAuthorized||evidence.stage!=="STEP_9"||
     !/^[a-f0-9]{64}$/.test(str(evidence.sourceDigest)) ||
     !/^KXBTC15M-[A-Za-z0-9-]+$/.test(str(evidence.marketTicker)))
    return {...fail("official_monetary_fee_source_unverified",actions),ownerAuthenticated:true,
      v3SchemaInstalled,v3EvidenceReceiptPresent};
  return {
    ok:true,reason:"owner_official_fee_evidence_read_only_candidate",
    evidenceVerified:true,ownerAuthenticated:true,
    ownerConsentRecorded:false,sourceGrantRecorded:false,
    reviewAuthorityRecorded:false,tradingAuthorized:false,ordersSubmitted:false,
    sourceDigest:evidence.sourceDigest,marketTicker:evidence.marketTicker,
    suggestedNextActions:actions,
    v3SchemaInstalled,v3EvidenceReceiptPresent,
  };
}
