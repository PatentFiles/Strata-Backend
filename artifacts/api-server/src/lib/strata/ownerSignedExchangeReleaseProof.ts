/**
 * #165: Explicit owner-initiated signed-exchange release diagnostic.
 * Not an issuer grant, reconciliation write, review, exit approval or live order.
 * Private signer stays server-side. No client account selector or credentials.
 */
import {pool} from "@workspace/db";
import {loadedMaterial} from "./inAppProtectiveRelease";
import {readOwnedKalshiFeeds,personalAccountSnapshot} from "./personalExchangeRead";
import {migrationFlatHistoryCheck} from "./ownerApiFeePolicyMigration";
import {probeCurrentKalshiFeeApi} from "./twoSourceFeeEvidence";
import {inspectWalletV4Readiness} from "./walletV4CommissioningReadiness";
import type {Identity,Request} from "../v13-production/types";

type Row=Record<string,unknown>;
type Db={query(sql:string,params?:unknown[]):Promise<{rows:Row[]}>};
type ProofDeps={
 db?:Db;now?:()=>number;
 material?:typeof loadedMaterial;read?:typeof readOwnedKalshiFeeds;
 map?:typeof personalAccountSnapshot;flat?:typeof migrationFlatHistoryCheck;
 feeProbe?:typeof probeCurrentKalshiFeeApi;v4?:typeof inspectWalletV4Readiness;
};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const digits=(x:unknown)=>typeof x==="string"&&/^(0|[1-9]\d*)$/.test(x);
const no=(reason:string)=>({
 ok:false as const,reason,readOnly:true as const,ordersSubmitted:false as const,
 tradingAuthorized:false as const,liveEligible:false as const,
 signedExchangeReadAttempted:false as const,
 authenticatedExchangeFlat:false as const,exchangeCashMatchesLedger:false as const,
 apiMarketFeeMetadataVerified:false as const,
 completeIssuerMonetaryAuthorityVerified:false as const,
 protectiveExitQualified:false as const,ownerShaReleasePresent:false as const,
 recordPersisted:false as const,
});
export type SignedReleaseProof=ReturnType<typeof no>|{
 ok:true;reason:"owner_signed_exchange_diagnostic_completed";readOnly:true;
 ordersSubmitted:false;tradingAuthorized:false;liveEligible:false;
 signedExchangeReadAttempted:true;authenticatedExchangeFlat:boolean;
 exchangeCashMatchesLedger:boolean;apiMarketFeeMetadataVerified:boolean;
 completeIssuerMonetaryAuthorityVerified:false;
 protectiveExitQualified:boolean;ownerShaReleasePresent:boolean;
 recordPersisted:false;observedAt:string;blockedReasons:string[];
};
export const OWNER_SIGNED_PROOF_ACCOUNT_SQL=[
 "SELECT a.id,a.owner_user_id::text AS owner_id,a.kalshi_connection_id,",
 "a.key_fingerprint,a.commissioned,a.kill_switch,a.blocked_reason,",
 "a.cash_precision_verified,a.cash_micros,a.reserved_micros,",
 "a.policy_id,p.state AS policy_state,p.fee_policy_version",
 "FROM public.v13_production_account a",
 "JOIN public.v13_live_money_policy p ON p.id=a.policy_id",
 "AND p.execution_account_id=a.id AND p.created_by=a.owner_user_id::text",
 "WHERE a.owner_user_id=$1::uuid AND a.subaccount=1 AND a.exchange_index=2 LIMIT 2"
].join(" ");
export const OWNER_SIGNED_PROOF_INTENTS_SQL=[
 "SELECT request FROM public.v13_production_intent",
 "WHERE account_id=$1 ORDER BY created_at,id"
].join(" ");
/**
 * Bounded explicit action. A failing first signed Kalshi balance GET stops
 * further history reads in the existing reader. No provider PDF/cooldown.
 */
export async function inspectOwnerSignedExchangeReleaseProof(
 ownerId:string,deps:ProofDeps={},
):Promise<SignedReleaseProof>{
 if(!UUID.test(ownerId))return no("authenticated_execution_owner_required");
 const db=deps.db??pool as unknown as Db;
 const clock=deps.now??Date.now;
 let account:Row;const requests:Request[]=[];
 try{
  const a=await db.query(OWNER_SIGNED_PROOF_ACCOUNT_SQL,[ownerId]);
  if(a.rows.length!==1)return no("owned_execution_account_missing_or_ambiguous");
  account=a.rows[0]!;
  if(account.commissioned!==true||account.policy_state!=="APPROVED")
   return no("approved_commissioned_account_required");
  if(account.kill_switch!==true)
   return no("kill_switch_must_remain_on_for_diagnostic");
  if(account.blocked_reason!=null &&
    account.blocked_reason!=="awaiting_account_commissioning")
   return no("unresolved_non_provisional_risk_freeze");
  if(!digits(String(account.cash_micros??""))||
     !digits(String(account.reserved_micros??"")))
   return no("ledger_cash_or_reservation_unverified");
  if(String(account.reserved_micros)!=="0")
   return no("ledger_reservations_must_be_zero");
  const intents=await db.query(OWNER_SIGNED_PROOF_INTENTS_SQL,[account.id]);
  for(const row of intents.rows){
   const r=typeof row.request==="string"?JSON.parse(row.request):row.request;
   if(!r||typeof r!=="object"||Array.isArray(r))
    return no("ledger_intent_unreadable");
   requests.push(r as Request);
  }
 }catch{return no("owner_read_only_database_unavailable");}
 let creds:Awaited<ReturnType<typeof loadedMaterial>>=null;
 try{creds=await (deps.material??loadedMaterial)(db as never,
  account as never);}catch{return no("restricted_signer_read_unavailable");}
 if(!creds)return no("restricted_signer_not_verified");
 const started=clock();
 if(!Number.isSafeInteger(started)||started<=0)
  return no("signed_exchange_clock_invalid");
 let read:Awaited<ReturnType<typeof readOwnedKalshiFeeds>>;
 try{read=await (deps.read??readOwnedKalshiFeeds)(creds,started);}
 catch{return no("authenticated_exchange_read_unavailable");}
 finally{creds=null;}
 if(!read.ok)return no("authenticated_exchange_"+read.reason);
 if(read.observedAtMs!==started||clock()<started||
   clock()-started>45_000)return no("signed_exchange_read_stale");
 const identity:Identity={subaccount:1,exchangeIndex:2,
  keyFingerprint:String(account.key_fingerprint??"")};
 const mapped=(deps.map??personalAccountSnapshot)(identity,read,requests);
 if(!("identity" in mapped))return no(mapped.reason);
 const flat=(deps.flat??migrationFlatHistoryCheck)(mapped,requests);
 const cashMatch=digits(read.cashMicros)&&read.cashMicros===String(account.cash_micros);
 const exchangeFlat=flat.ok===true;
 // Kalshi series multiplier alone is never a full issuer monetary authority.
 // Full formula, rounding, exceptions and owner fee authority are separate.
 let feeMetadata=false;
 if(exchangeFlat&&cashMatch){
  try{
   const f=await (deps.feeProbe??probeCurrentKalshiFeeApi)();
   feeMetadata=f.ok===true;
  }catch{feeMetadata=false;}
 }
 let exit=false,ownerSha=false;
 try{
  const v=await (deps.v4??inspectWalletV4Readiness)(ownerId);
  exit=v.ok&&v.checks.protectiveExitRelease===true;
  ownerSha=v.ok&&v.checks.ownerShaApproval===true;
 }catch{/* remain false; never grant permission */}
 const blockedReasons:string[]=[];
 if(!exchangeFlat)blockedReasons.push(flat.ok?"exchange_flatness_unverified":flat.reason);
 if(!cashMatch)blockedReasons.push("exchange_cash_differs_from_persisted_ledger");
 if(!feeMetadata)blockedReasons.push("current_series_market_fee_metadata_unverified");
 blockedReasons.push("complete_issuer_monetary_terms_and_owner_fee_authority_not_verified_here");
 if(!exit)blockedReasons.push("exact_sha_protective_exit_release_missing");
 if(!ownerSha)blockedReasons.push("exact_sha_owner_mfa_release_missing");
 return {
  ok:true,reason:"owner_signed_exchange_diagnostic_completed",
  readOnly:true,ordersSubmitted:false,tradingAuthorized:false,liveEligible:false,
  signedExchangeReadAttempted:true,authenticatedExchangeFlat:exchangeFlat,
  exchangeCashMatchesLedger:cashMatch,apiMarketFeeMetadataVerified:feeMetadata,
  completeIssuerMonetaryAuthorityVerified:false,
  protectiveExitQualified:exit,ownerShaReleasePresent:ownerSha,
  recordPersisted:false,observedAt:new Date(started).toISOString(),
  blockedReasons,
 };
}
