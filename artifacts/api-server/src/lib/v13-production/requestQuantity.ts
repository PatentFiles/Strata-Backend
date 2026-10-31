import {requireProof} from './types';
export const EXIT_QUANTITY_VERSION='EXIT_HUNDREDTHS_V1' as const;
/** Exactly one quantity authority. New fractional quantities are reduce-only EXIT
 * only; historical whole-count requests retain their original encoding/digests. */
export function requestQuantityHundredths(value:unknown):bigint {
 requireProof(value!==null&&typeof value==='object'&&!Array.isArray(value),'production_request_quantity_invalid');
 const r=value as Record<string,unknown>,has=(k:string)=>Object.prototype.hasOwnProperty.call(r,k);
 if(has('quantityVersion')||has('quantityHundredths')){
  requireProof(r.quantityVersion===EXIT_QUANTITY_VERSION&&!has('contracts')&&r.action==='SELL'&&r.reduceOnly===true&&r.timeInForce==='IOC'&&
   typeof r.quantityHundredths==='string'&&/^[1-9][0-9]{0,5}$/.test(r.quantityHundredths)&&BigInt(r.quantityHundredths)<=100000n,
   'production_request_quantity_invalid');return BigInt(r.quantityHundredths);
 }
 requireProof(typeof r.contracts==='number'&&Number.isSafeInteger(r.contracts)&&r.contracts>0&&r.contracts<=999999999,
  'production_request_quantity_invalid');return BigInt(r.contracts)*100n;
}
export function formatContractHundredths(q:bigint):string {
 requireProof(q>0n,'production_request_quantity_invalid');return `${q/100n}.${String(q%100n).padStart(2,'0')}`;
}
/** UI-only number conversion; never use this value for order or money math. */
export function requestQuantityContractsForDisplay(value:unknown):number|null {
 try{return Number(requestQuantityHundredths(value))/100;}catch{return null;}
}
