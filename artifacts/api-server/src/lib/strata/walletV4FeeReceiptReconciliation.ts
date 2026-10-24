/**
 * Wallets-only V4 settlement-fee reconciliation primitive. Observations
 * originate from authenticated exact-account exchange fills, NEVER a browser.
 *
 * A model quote is a pretrade UPPER BOUND, not evidence of what Kalshi charged.
 * The ledger remains pending until every known fill and charged fee reconcile
 * with the provider's complete order/fill records. No new permission is issued.
 */
import {createHash} from "node:crypto";
const UUID=/^[a-zA-Z0-9_:.-]{8,160}$/;
const DIGEST=/^[a-f0-9]{64}$/;
type Fill={tradeId:string;orderId:string;ticker:string;quantityHundredths:string;
  executionPriceTicks:number;exchangeFeeMicros:string;feeVerified:boolean;};
type Ledger={ownerId:string;accountId:string;orderId:string;ticker:string;
  expectedModelDigest:string;authorizedGrossMicros:string;maximumEntryFeesMicros:string;
  expectedFilledHundredths:string;feeReservedMicros:string;};
export type FeeReconcileResult=
 |{ok:true;receiptDigest:string;actualFeeMicros:string;filledHundredths:string;netCashDebitMicros:string;needsAdjustment:boolean;tradingAuthorized:false}
 |{ok:false;reason:string;tradingAuthorized:false};
const fail=(reason:string):FeeReconcileResult=>({ok:false,reason,tradingAuthorized:false});
const amount=(raw:string)=>/^(0|[1-9]\d{0,20})$/.test(raw)?BigInt(raw):null;
const price=(n:number)=>Number.isSafeInteger(n)&&n>0&&n<10000;
export function reconcileWalletV4OrderFees(
 l:Ledger, fills:readonly Fill[], providerComplete:boolean,
):FeeReconcileResult{
 if(!l||!Array.isArray(fills)||!providerComplete||
    !UUID.test(l.ownerId)||!UUID.test(l.accountId)||
    !UUID.test(l.orderId)||!/^KXBTC15M-[A-Za-z0-9-]+$/.test(l.ticker)||
    !DIGEST.test(l.expectedModelDigest))
   return fail("v4_wallet_authoritative_fee_scope_or_history_unverified");
 const expected=amount(l.expectedFilledHundredths);
 const allowedGross=amount(l.authorizedGrossMicros);
 const maxFee=amount(l.maximumEntryFeesMicros);
 const reserved=amount(l.feeReservedMicros);
 if(expected===null||allowedGross===null||maxFee===null||reserved===null||
    expected<0n||expected>100_000_000n||reserved<maxFee)
   return fail("v4_wallet_fee_budget_invalid");
 let filled=0n,gross=0n,fee=0n;
 const seen=new Set<string>();
 for(const f of fills){
   const qty=amount(f.quantityHundredths),tradeFee=amount(f.exchangeFeeMicros);
   if(!f.tradeId||f.tradeId.length>160||seen.has(f.tradeId)||
      f.orderId!==l.orderId||f.ticker!==l.ticker||
      qty===null||qty<=0n||!price(f.executionPriceTicks)||
      tradeFee===null||f.feeVerified!==true)
     return fail("v4_wallet_fill_identity_fee_or_precision_unverified");
   seen.add(f.tradeId);
   filled+=qty;
   gross+=qty*BigInt(f.executionPriceTicks);
   fee+=tradeFee;
   if(filled>expected||gross>allowedGross||fee>maxFee)
     return fail("v4_wallet_provider_fee_or_exposure_exceeded");
 }
 if(filled!==expected)
   return fail("v4_wallet_order_fill_ledger_mismatch");
 // Fingerprint accepted fee-bearing provider data, including ZERO-fill cases.
 // The calling transaction must still verify order finality and exact owner.
 const canonical={ownerId:l.ownerId,accountId:l.accountId,orderId:l.orderId,
   ticker:l.ticker,modelDigest:l.expectedModelDigest,
   fills:[...fills].sort((a,b)=>a.tradeId.localeCompare(b.tradeId)).map(f=>({
     tradeId:f.tradeId,quantityHundredths:f.quantityHundredths,
     executionPriceTicks:f.executionPriceTicks,exchangeFeeMicros:f.exchangeFeeMicros,
   }))};
 return {ok:true,receiptDigest:createHash("sha256")
   .update(JSON.stringify(canonical)).digest("hex"),
   actualFeeMicros:fee.toString(),filledHundredths:filled.toString(),
   netCashDebitMicros:(gross+fee).toString(),
   needsAdjustment:fee!==reserved,tradingAuthorized:false};
}
