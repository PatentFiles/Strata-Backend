/**
 * PURE, READ-ONLY IOC recovery reconciliation.
 * This is NOT a dispatcher; it cannot authorize a Kalshi POST, update a
 * production intent, settle a position, or permit a retry.
 *
 * A successful HTTP 201 alone cannot prove the final account inventory.
 * A timed-out/uncertain exchange response NEVER becomes a zero-fill and must
 * block new attempts until authenticated complete history resolves it.
 */
export type IocRecoveryObservation = {
  clientOrderId: string;
  requestedCountFp: string;
  marketTicker: string;
  initialPositionFp: string;
  observedPositionFp: string;
  positionMarketTicker: string;
  reducingBookSide: "bid"|"ask";
  /** Verified from a complete, authenticated, account-scoped exchange read. */
  completeExchangeHistory: boolean;
  exactMarketAndAccountMatched: boolean;
  /** Exchange order and fill history uniquely matched to clientOrderId. */
  orderAndFillHistoryMatched: boolean;
  /** No simultaneous orders, fills or transfer activity in this market. */
  isolatedPositionDelta: boolean;
  /** Null when no conclusive exchange response; never treat as no fill. */
  response: null | {
    httpStatus: number;
    order_id: unknown;
    client_order_id: unknown;
    fill_count: unknown;
    remaining_count: unknown;
    ts_ms: unknown;
  };
};
export type IocRecoveryResult = {
  ok: false;
  tradingAuthorized: false;
  mayRetry: false;
  /** "UNKNOWN" must remain unresolved until independent exchange reconciliation. */
  state: "UNKNOWN"|"RECONCILED"|"REJECTED";
  filledHundredths?: string;
  remainingHundredths?: string;
  reason: string;
};
const CID=/^v13p-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MARKET=/^KXBTC15M-[A-Za-z0-9-]+$/;
const deny=(state:IocRecoveryResult["state"],reason:string):IocRecoveryResult=>({
  ok:false,tradingAuthorized:false,mayRetry:false,state,reason,
});
function decimal(x:unknown, allowZero=true):bigint|null{
  if(typeof x!=="string"||!/^\d{1,9}\.\d{2}$/.test(x))return null;
  const [whole,frac]=x.split(".");
  const value=BigInt(whole!)*100n+BigInt(frac!);
  return value===0n&&!allowZero?null:value;
}
function signed(x:unknown):bigint|null{
  if(typeof x!=="string"||!/^(-)?\d{1,9}\.\d{2}$/.test(x))return null;
  const neg=x.startsWith("-");
  const v=decimal(neg?x.slice(1):x);
  return v===null?null:neg?-v:v;
}
export function reconcileIocEmergencyExit(x:IocRecoveryObservation):IocRecoveryResult{
  if(!CID.test(x.clientOrderId)||!MARKET.test(x.marketTicker)||
     x.positionMarketTicker!==x.marketTicker)
    return deny("REJECTED","emergency_reconcile_identity_invalid");
  const qty=decimal(x.requestedCountFp,false);
  const start=signed(x.initialPositionFp),finish=signed(x.observedPositionFp);
  if(qty===null||start===null||finish===null||start===0n||
     qty>(start<0n?-start:start))
    return deny("REJECTED","emergency_reconcile_position_invalid");
  if((start>0n&&x.reducingBookSide!=="ask")||
     (start<0n&&x.reducingBookSide!=="bid"))
    return deny("REJECTED","emergency_reconcile_side_invalid");
  // No ambiguous history is proof of a completed or zero-fill IOC.
  if(!x.completeExchangeHistory||!x.exactMarketAndAccountMatched||
     !x.orderAndFillHistoryMatched||!x.isolatedPositionDelta)
    return deny("UNKNOWN","emergency_reconcile_exchange_history_unproven");
  if(!x.response)
    return deny("UNKNOWN","emergency_reconcile_response_uncertain");
  const r=x.response;
  if(r.httpStatus!==201||r.client_order_id!==x.clientOrderId||
     typeof r.order_id!=="string"||!/^[a-zA-Z0-9._:-]{1,128}$/.test(r.order_id)||
     typeof r.ts_ms!=="number"||!Number.isSafeInteger(r.ts_ms)||r.ts_ms<=0)
    return deny("UNKNOWN","emergency_reconcile_exchange_receipt_invalid");
  const filled=decimal(r.fill_count),remaining=decimal(r.remaining_count);
  if(filled===null||remaining===null||filled+remaining!==qty)
    return deny("UNKNOWN","emergency_reconcile_fill_count_invalid");
  const expected=start>0n?start-filled:start+filled;
  if(expected!==finish||
     (start>0n&&(finish<0n||finish>start))||
     (start<0n&&(finish>0n||finish<start)))
    return deny("UNKNOWN","emergency_reconcile_position_change_unproven");
  // Even conclusively reconciled fills confer no authority for a second POST.
  return {...deny("RECONCILED","emergency_exit_reconciled_read_only"),
    filledHundredths:String(filled),remainingHundredths:String(remaining)};
}
