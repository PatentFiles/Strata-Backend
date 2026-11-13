import {validEntryCashRisk} from "../v13EntryCashRisk";
import type {V13VerifiedFeeEvidence} from '../v13LiveMoneyEntryPreflight';
import {requireProof} from './types';

/** Scale an EXISTING verified conservative EXIT reserve, never a new fee model.
 * ownedMarketEvidence's per-contract bound already budgets 100 independently
 * rounded .01-contract fills. If R cents covers C whole contracts, ceil(R*Q /
 * (100*C)) cents covers Q hundredths. Round upward in integer arithmetic; never
 * credit expected rebates, convert the fee basis to decimals or change ENTRY.
 * Caller still proves fee policy/fingerprint, freshness, quantity authority and
 * inventory, and compares this result with the parent's remaining reservation.
 * The helper does not authorize an order or authenticate a supplied fee object.
 */
export function conservativeExitFeeMicros(
 fee:Pick<V13VerifiedFeeEvidence,'contracts'|'reservedExitFeeCents'>&Partial<V13VerifiedFeeEvidence>,
 quantityHundredths:string,
):bigint {
 requireProof(fee&&Number.isSafeInteger(fee.contracts)&&fee.contracts>0&&
  Number.isSafeInteger(fee.reservedExitFeeCents)&&fee.reservedExitFeeCents>=0&&
  typeof quantityHundredths==='string'&&/^[1-9][0-9]{0,10}$/.test(quantityHundredths)&&
  BigInt(quantityHundredths)<=99_999_999_900n,'production_exit_fee_quantity_invalid');
 // This upper range preserves the historical whole-count request bound. New
 // fractional EXIT requests remain capped at 100000 by requestQuantityHundredths.
 if(fee.cashRisk){
  requireProof(validEntryCashRisk(fee as V13VerifiedFeeEvidence),"production_exit_fee_quantity_invalid");
  const exact=BigInt(fee.cashRisk.exitLossPerContractMicros)*BigInt(quantityHundredths);
  return ((exact+1_000_000n-1n)/1_000_000n)*10000n;
 }
 const denominator=BigInt(fee.contracts)*100n;
 const numerator=BigInt(fee.reservedExitFeeCents)*BigInt(quantityHundredths);
 return ((numerator+denominator-1n)/denominator)*10_000n;
}
