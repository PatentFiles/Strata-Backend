/**
 * Read-only emergency exit candidate validator for V2 Kalshi event orders.
 *
 * Unlike operator fee-source entry authorization, closing an EXISTING position
 * may need to remain possible after a short-lived document grant expires.
 * Kalshi's native reduce_only option is restricted to immediate_or_cancel.
 *
 * The caller MUST obtain evidence from independently signed, scoped, fresh
 * Kalshi responses and verified private worker identity. This pure function
 * does not authenticate claims, perform network I/O, sign orders, insert audit
 * records, release kill switches, or authorize a POST. No production caller
 * may use a positive advisory decision directly as order authority.
 *
 * Activation requires a dedicated transactionally fenced exchange/ledger
 * integration, independent review, and controlled sandbox tests (issue #46).
 * See https://docs.kalshi.com/api-reference/orders/create-order-v2
 */
export interface EmergencyExitOrder {
  ticker: unknown;
  side: unknown;
  count: unknown;
  price: unknown;
  client_order_id: unknown;
  time_in_force: unknown;
  // Mandatory Kalshi V2 self-trade prevention must be explicit and safe.
  self_trade_prevention_type?: unknown;
  reduce_only: unknown;
  post_only?: unknown;
  subaccount: unknown;
  exchange_index: unknown;
  expiration_time?: unknown;
}

export interface EmergencyExitEvidence {
  /** Both identities must be verified by backend trusted session, not user input. */
  authenticatedOwnerId: string;
  accountOwnerId: string;
  accountSubaccount: number;
  accountExchangeIndex: number;
  signerVerified: boolean;
  /** Owner-approved exit proceeds floor, from persisted account state.
   * Never accept this field from the caller's request body.
   * A bid which closes a NO position receives (1 - YES bid price).
   */
  minimumExitMicros: number;
  /** Current *independent* execution boundaries are never ignored. */
  globalKillActive: boolean;
  accountKillActive: boolean;
  executionEnabled: boolean;
  /** This is a complete, exchange-authenticated, no-cursor position page. */
  positionsComplete: boolean;
  positionMarket: string;
  positionFp: string;
  positionsObservedAtMs: number;
  /** Any resting / dispatched / unknown operation is a hard blocker. */
  restingOrderCount: number;
  uncertainOrderCount: number;
  /**
   * Direct Kalshi market/series/event metadata, NOT a stale PDF. The caller
   * must reject pagination, overrides, scheduled changes and API failure.
   */
  kalshiFee: {
    source: "kalshi_live_api";
    market: string;
    fingerprint: string;
    observedAtMs: number;
    feeType: "quadratic";
    feeMultiplier: 1;
    noUnverifiedOverridesOrChanges: true;
    marketOpen: boolean;
  } | null;
}

export interface EmergencyExitDecision {
  ok: false;
  reason: string;
  /** No advisory assessment can grant trading authority. */
  tradingAuthorized: false;
  needsIndependentApproval: true;
  /** Indicates only whether the presented read-only evidence was internally consistent. */
  diagnosticEligible: boolean;
  verifiedPositionFp?: string;
  verifiedPositionObservedAtMs?: number;
}

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT_ORDER_ID=/^v13p-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MARKET=/^KXBTC15M-[A-Za-z0-9-]+$/;
const SHA=/^[0-9a-f]{64}$/;
const DENY=(reason:string):EmergencyExitDecision=>({
  ok:false,reason,tradingAuthorized:false,needsIndependentApproval:true,
  diagnosticEligible:false,
});
function fixedHundredths(value:unknown):bigint|null{
  if(typeof value!=="string"||!/^\d{1,9}\.\d{2}$/.test(value))return null;
  const [whole,fraction]=value.split(".");
  const n=BigInt(whole!)*100n+BigInt(fraction!);
  return n>0n?n:null;
}
function signedPositionHundredths(value:string):bigint|null{
  if(!/^-?\d{1,9}\.\d{2}$/.test(value))return null;
  const negative=value.startsWith("-");
  const raw=negative?value.slice(1):value;
  const amount=fixedHundredths(raw);
  return amount===null?null:negative?-amount:amount;
}
function strictPrice(value:unknown):boolean {
  if(typeof value!=="string"||!/^0\.\d{4}$/.test(value))return false;
  const cents=Number(value.slice(2));
  return cents>=1&&cents<=9999;
}
/**
 * A stricter-than-exchange advisory check. An IOC reduce_only order is not
 * sufficient evidence by itself: the exchange-reported current holdings,
 * order side, quantity, identity, and live fee evidence must all agree.
 *
 * Always returns tradingAuthorized=false; specifically not a live bypass.
 */
export function inspectEmergencyExitCandidate(
  ownerUserId:string,order:EmergencyExitOrder,
  evidence:EmergencyExitEvidence|null,nowMs:number,
):EmergencyExitDecision {
  if(!Number.isSafeInteger(nowMs)||nowMs<=0||!UUID.test(ownerUserId))
    return DENY("emergency_exit_owner_invalid");
  if(!evidence||!UUID.test(evidence.authenticatedOwnerId)||
      evidence.authenticatedOwnerId!==ownerUserId||
      evidence.accountOwnerId!==ownerUserId||
      evidence.accountSubaccount!==1||evidence.accountExchangeIndex!==2||
      evidence.signerVerified!==true)
    return DENY("emergency_exit_authenticated_pair_unverified");
  if(evidence.globalKillActive||evidence.accountKillActive||
      evidence.executionEnabled!==true)
    return DENY("emergency_exit_execution_gate_closed");
  if(order.subaccount!==1||order.exchange_index!==2||
      typeof order.ticker!=="string"||!MARKET.test(order.ticker)||
      typeof order.client_order_id!=="string"||!CLIENT_ORDER_ID.test(order.client_order_id))
    return DENY("emergency_exit_order_identity_invalid");
  if(order.reduce_only!==true||order.time_in_force!=="immediate_or_cancel"||
      order.self_trade_prevention_type!=="taker_at_cross"||
      order.post_only!==false||order.expiration_time!==undefined||
      !strictPrice(order.price))
    return DENY("emergency_exit_order_constraints_invalid");
  const quantity=fixedHundredths(order.count);
  if(quantity===null||quantity>100000n)
    return DENY("emergency_exit_quantity_invalid");
  if(evidence.positionsComplete!==true||evidence.positionMarket!==order.ticker||
      !Number.isSafeInteger(evidence.positionsObservedAtMs)||
      evidence.positionsObservedAtMs>nowMs||
      nowMs-evidence.positionsObservedAtMs>3_000)
    return DENY("emergency_exit_live_position_unverified");
  const position=signedPositionHundredths(evidence.positionFp);
  if(position===null||quantity>(position<0n?-position:position))
    return DENY("emergency_exit_exceeds_position");
  // Check side and inventory first, then validate the approved exit floor.
  // In V2, ask reduces a YES long; bid reduces a NO long.
  if((position>0n&&order.side!=="ask")||
     (position<0n&&order.side!=="bid"))
    return DENY("emergency_exit_side_not_reducing");
  if(!Number.isSafeInteger(evidence.minimumExitMicros)||
     evidence.minimumExitMicros<1||evidence.minimumExitMicros>=1_000_000)
    return DENY("emergency_exit_approved_floor_unverified");
  // Kalshi's V2 book uses YES prices. Liquidating NO via bid receives
  // 1 - YES price; liquidating YES via ask receives the YES price.
  // Parse exact four-decimal integer price, never binary floating point.
  const yesPriceMicros=Number((order.price as string).slice(2))*100;
  const proceedsMicros=position>0n?yesPriceMicros:1_000_000-yesPriceMicros;
  if(proceedsMicros<evidence.minimumExitMicros)
    return DENY("emergency_exit_below_approved_floor");

  if(!Number.isSafeInteger(evidence.restingOrderCount)||
     evidence.restingOrderCount!==0||
     !Number.isSafeInteger(evidence.uncertainOrderCount)||
     evidence.uncertainOrderCount!==0)
    return DENY("emergency_exit_orders_unreconciled");
  const fee=evidence.kalshiFee;
  if(!fee||fee.source!=="kalshi_live_api"||fee.market!==order.ticker||
      !SHA.test(fee.fingerprint)||fee.feeType!=="quadratic"||
      fee.feeMultiplier!==1||fee.noUnverifiedOverridesOrChanges!==true||
      fee.marketOpen!==true||!Number.isSafeInteger(fee.observedAtMs)||
      fee.observedAtMs>nowMs||nowMs-fee.observedAtMs>3_000)
    return DENY("emergency_exit_exact_fee_evidence_unverified");
  // No signed live or risk-bearing authority is issued here.
  return {...DENY("emergency_exit_candidate_verified_requires_fenced_dispatch"),
    diagnosticEligible:true,verifiedPositionFp:evidence.positionFp,
    verifiedPositionObservedAtMs:evidence.positionsObservedAtMs};
}
