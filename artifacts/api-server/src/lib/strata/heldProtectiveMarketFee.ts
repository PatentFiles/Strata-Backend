import {parseDurableFeeSource,verifyDurableFeeStage} from './durableFeeConsumers';
import {DURABLE_FEE_VERSION,isDurableFeeVersion} from './durableOwnerFeePolicy';
import {API_SOURCE_POLICY_VERSION,API_SOURCE_FORMULA_VERSION,parseReviewedApiSource} from './apiFeeSourceStage';
import {PDF_FREE_API_RATE_REVIEW_DECISION_SHA256} from './apiFeeRateReference';
import {verifyReviewedProtectiveExitFee,isReviewedProtectiveExitFeeFresh} from './reviewedProtectiveExitFee';
import {parseV3FeeSource,V3_FEE_POLICY_VERSION,V3_FEE_FORMULA_VERSION} from './ownerFeeV3Authority';
import {verifyOwnerV3ProtectiveFee} from './ownerStandingFeeAuthorization';
/** Held-session market preparation is read-only protective fee evidence. It must
 * never call the ordinary ORDER_ENTRY verifier or renew an entry observation.
 * Final protective authority, freshness and dispatch remain independently checked.
 */
export async function readHeldProtectiveMarketFee(input:{ownerId:string;accountId:string;market:string;
 sourceUrl:string;policyVersion:string;formulaVersion:string;digest:string},deps:{
 verify?:typeof verifyReviewedProtectiveExitFee;fresh?:typeof isReviewedProtectiveExitFeeFresh;
 verifyV3?:typeof verifyOwnerV3ProtectiveFee;clock?:()=>number;
}={}):Promise<number>{
 // Owner V3 protective recovery is not a new entry or automatic extension
 // of an expired fee grant. It requires unchanged genuine source provenance,
 // the exact owned account and a live official market/fee re-observation.
 if(parseDurableFeeSource(input.sourceUrl)){
  if(!isDurableFeeVersion(input.policyVersion)||input.formulaVersion!==V3_FEE_FORMULA_VERSION)throw Error('held_durable_fee_policy_invalid');
  const checked=await verifyDurableFeeStage(input.ownerId,input.accountId,input.sourceUrl,'PROTECTIVE_EXIT',input.market);
  const now=(deps.clock??Date.now)();
  if(!checked.ok||checked.sourceDigest!==input.digest||now<checked.verifiedAtMs||now-checked.verifiedAtMs>=5000)throw Error('held_durable_fee_current_market_unverified');
  return checked.verifiedAtMs;
 }
 if(parseV3FeeSource(input.sourceUrl)){
  if(input.policyVersion!==V3_FEE_POLICY_VERSION||
     input.formulaVersion!==V3_FEE_FORMULA_VERSION||
     !/^[a-f0-9]{64}$/.test(input.digest))
   throw Error('held_owner_v3_fee_policy_identity_invalid');
  const checked=await(deps.verifyV3??verifyOwnerV3ProtectiveFee)(
    input.ownerId,input.accountId,input.sourceUrl,input.market);
  const observed=checked.ok?checked.verifiedAtMs:NaN,now=(deps.clock??Date.now)();
  if(!checked.ok||checked.sourceDigest!==input.digest||
     !Number.isSafeInteger(observed)||!Number.isSafeInteger(now)||
     observed>now||now-observed>=5000)
   throw Error('held_owner_v3_protective_fee_current_issuer_unverified');
  return observed;
 }
 if(!parseReviewedApiSource(input.sourceUrl)||input.policyVersion!==API_SOURCE_POLICY_VERSION||
    input.formulaVersion!==API_SOURCE_FORMULA_VERSION||!/^[a-f0-9]{64}$/.test(input.digest))throw Error('held_protective_fee_source_unsupported');
 // Commissioning stores an observation-specific reviewCandidateDigest. The
 // protective verifier proves the separately signed fixed rate-model digest.
 // Do not compare these different identities: original artifact provenance is
 // retained in market evidence; locked policy and final dispatch bind authority.
 const proof=await(deps.verify??verifyReviewedProtectiveExitFee)(input.ownerId,input.accountId,input.market);
 const verifiedAt=Date.parse(proof.verifiedAt??'');
 if(!proof.ok||!proof.monetaryFeeAuthorized||proof.marketTicker!==input.market||
    proof.sourceDigest!==PDF_FREE_API_RATE_REVIEW_DECISION_SHA256||!Number.isSafeInteger(verifiedAt)||verifiedAt<=0||
    !(deps.fresh??isReviewedProtectiveExitFeeFresh)(proof))throw Error('held_protective_fee_evidence_unverified');
 return verifiedAt;
}
