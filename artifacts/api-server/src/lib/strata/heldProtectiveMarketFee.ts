import {API_SOURCE_POLICY_VERSION,API_SOURCE_FORMULA_VERSION,parseReviewedApiSource} from './apiFeeSourceStage';
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
    input.formulaVersion!==API_SOURCE_FORMULA_VERSION)throw Error('held_protective_fee_source_unsupported');
 const proof=await(deps.verify??verifyReviewedProtectiveExitFee)(input.ownerId,input.accountId,input.market);
 const verifiedAt=Date.parse(proof.verifiedAt??'');
 if(!proof.ok||!proof.monetaryFeeAuthorized||proof.marketTicker!==input.market||
    proof.sourceDigest!==input.digest||!Number.isSafeInteger(verifiedAt)||verifiedAt<=0||
    !(deps.fresh??isReviewedProtectiveExitFeeFresh)(proof))throw Error('held_protective_fee_evidence_unverified');
 return verifiedAt;
}
