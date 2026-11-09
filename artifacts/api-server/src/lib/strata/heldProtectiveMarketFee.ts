import {API_SOURCE_POLICY_VERSION,API_SOURCE_FORMULA_VERSION,parseReviewedApiSource} from './apiFeeSourceStage';
import {PDF_FREE_API_RATE_REVIEW_DECISION_SHA256} from './apiFeeRateReference';
import {verifyReviewedProtectiveExitFee,isReviewedProtectiveExitFeeFresh} from './reviewedProtectiveExitFee';
/** Held-session market preparation is read-only protective fee evidence. It must
 * never call the ordinary ORDER_ENTRY verifier or renew an entry observation.
 * Final protective authority, freshness and dispatch remain independently checked.
 */
export async function readHeldProtectiveMarketFee(input:{ownerId:string;accountId:string;market:string;
 sourceUrl:string;policyVersion:string;formulaVersion:string;digest:string},deps:{
 verify?:typeof verifyReviewedProtectiveExitFee;fresh?:typeof isReviewedProtectiveExitFeeFresh;
}={}):Promise<number>{
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
