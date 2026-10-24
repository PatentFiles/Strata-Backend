/**
 * Wallets-only V4 settlement-fee reconciliation primitive. Observations
 * originate from authenticated exact-account exchange fills, NEVER a browser.
 *
 * A model quote is a pretrade UPPER BOUND, not evidence of what Kalshi charged.
 * The ledger remains pending until every known fill and charged fee reconcile
 * with the provider's complete order/fill records. No new permission is issued.
 */
import {createHash} from "node:crypto";
import {readOwnedKalshiFeeds,personalAccountSnapshot} from "./personalExchangeRead";
import type {Identity,Request} from "../v13-production/types";
const UUID=/^[a-zA-Z0-9_:.-]{8,160}$/;
const DIGEST=/^[a-f0-9]{64}$/;
type Fill={tradeId:string;orderId:string;ticker:string;quantityHundredths:string;
  executionPriceTicks:number;exchangeFeeMicros:string;feeVerified:boolean;};
/**
 * A boolean from caller data is NOT proof of authenticated Kalshi receipts.
 * Keep all existing research/test callers fail-closed until a server-owned
 * exchange adapter supplies independent, scope-bound provenance.
 */
export type AuthenticatedKalshiReceiptProof={
 source:"kalshi_server_authenticated";ownerId:string;accountId:string;
 orderId:string;marketTicker:string;observedAtMs:number;complete:true;
 authoritativeFillDigest:string;
};
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
 proof?:AuthenticatedKalshiReceiptProof,
):FeeReconcileResult{
 if(!proof||proof.source!=="kalshi_server_authenticated"||
    proof.complete!==true||proof.ownerId!==l?.ownerId||
    proof.accountId!==l?.accountId||proof.orderId!==l?.orderId||
    proof.marketTicker!==l?.ticker||
    !DIGEST.test(proof.authoritativeFillDigest)||
    !Number.isSafeInteger(proof.observedAtMs)||
    Math.abs(Date.now()-proof.observedAtMs)>15_000)
   return fail("v4_wallet_authenticated_receipt_provenance_required");
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

/**
 * Server-only authenticated Kalshi receipt connector. Does not expose keys or
 * permit any POST. The existing exact-subaccount/exchange-index reader obtains
 * current+historical orders/fills/settlements and validates complete pagination.
 * personalAccountSnapshot confirms every matched order and fee-bearing fill.
 */
export async function reconcileWalletV4AuthenticatedKalshiReceipts(
 input:{credentials:{keyId:string;privateKey:string};identity:Identity;
        requests:Request[];ledger:Ledger;nowMs?:number},
):Promise<FeeReconcileResult>{
 const observedAtMs=input.nowMs??Date.now();
 if(!Number.isSafeInteger(observedAtMs)||Math.abs(Date.now()-observedAtMs)>15_000||
    input.identity.subaccount!==1||input.identity.exchangeIndex!==2)
   return fail("v4_wallet_authenticated_identity_or_clock_invalid");
 const read=await readOwnedKalshiFeeds(input.credentials,observedAtMs);
 if(!read.ok)return fail(read.reason);
 const snapshot=personalAccountSnapshot(input.identity,read,input.requests);
 if("ok" in snapshot)return fail(snapshot.reason);
 if(!snapshot.authenticated||!snapshot.complete||!snapshot.cashExact||
    snapshot.unexplainedCashActivity)
   return fail("v4_wallet_authenticated_snapshot_incomplete");
 const order=snapshot.orders.find(o=>o.orderId===input.ledger.orderId);
 if(!order||!order.terminal||order.request.market!==input.ledger.ticker||
    !/^\d+$/.test(order.filledHundredths)||
    order.filledHundredths!==input.ledger.expectedFilledHundredths)
   return fail("v4_wallet_order_finality_or_fill_count_unverified");
 const scoped=snapshot.fills.filter(f=>f.orderId===order.orderId);
 if(scoped.some(f=>f.market!==input.ledger.ticker||
    !/^\d+$/.test(f.feeMicros)||!/^\d+$/.test(f.quantityHundredths)||
    !Number.isSafeInteger(f.priceMicros)||f.priceMicros%100!==0))
   return fail("v4_wallet_provider_fill_precision_unverified");
 const accepted:Fill[]=scoped.map(f=>({
   tradeId:f.id,orderId:f.orderId,ticker:f.market,
   quantityHundredths:f.quantityHundredths,
   executionPriceTicks:f.priceMicros/100,
   exchangeFeeMicros:f.feeMicros,feeVerified:true,
 }));
 const authoritativeFillDigest=createHash("sha256").update(JSON.stringify(
   [...accepted].sort((a,b)=>a.tradeId.localeCompare(b.tradeId))
 )).digest("hex");
 return reconcileWalletV4OrderFees(input.ledger,accepted,true,{
   source:"kalshi_server_authenticated",ownerId:input.ledger.ownerId,
   accountId:input.ledger.accountId,orderId:order.orderId,
   marketTicker:order.request.market,observedAtMs,
   complete:true,authoritativeFillDigest,
 });
}
