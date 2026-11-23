import {getOwnedProductionKalshiJson} from './personalExchangeRead';
import {readStrictUnsettledPositions} from './strictUnsettledPositions';
/** Unmounted: does not obtain credentials, schedule work, or enable transport by default. */
export function readOwnedUnsettledPositions(
 creds:Parameters<typeof getOwnedProductionKalshiJson>[0],verifiedOwnerId:string,signal:AbortSignal,
){
 return readStrictUnsettledPositions((query,abort)=>getOwnedProductionKalshiJson(
  creds,'/trade-api/v2/portfolio/positions',query,undefined,undefined,verifiedOwnerId,abort,
 ),signal);
}
