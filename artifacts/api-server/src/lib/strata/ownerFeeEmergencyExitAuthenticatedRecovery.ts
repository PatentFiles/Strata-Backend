import {pool} from "@workspace/db";
import {dedicatedSignerFingerprint} from "./commissioning";
import {readOwnedKalshiFeeds} from "./personalExchangeRead";
import type {EmergencyExitOrder} from "./ownerFeeEmergencyExit";
import type {IocRecoveryObservation} from "./ownerFeeEmergencyExitReconcile";

/**
 * Protected post-IOC recovery evidence. Reads the immutable original position
 * snapshot from the reservation ledger, then independently reads ALL available
 * signed, account-scoped exchange history. A missing page, ambiguous fill,
 * simultaneous fill, or unprovable position change is UNKNOWN, never a zero fill.
 * This adapter cannot submit an order, authorize a retry, or change any ledger.
 */
type Material={keyId:string;privateKey:string};
type Input={ownerId:string;accountId:string;reservationId:string;material:Material;
  order:Readonly<EmergencyExitOrder>};
type Receipt=IocRecoveryObservation["response"];
type DB={query(sql:string,args?:unknown[]):Promise<{rows:Record<string,unknown>[]}>};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const COUNT=/^\d{1,9}\.\d{2}$/;
const SIGNED=/^-?\d{1,9}\.\d{2}$/;
function fail(reason:string):never {throw Error(reason);}
function object(x:unknown):Record<string,unknown>{
 if(!x||typeof x!=="object"||Array.isArray(x))return fail("exit_recovery_row_invalid");
 return x as Record<string,unknown>;
}
function text(x:unknown):string {
 if(typeof x!=="string"||!x.trim())return fail("exit_recovery_text_invalid");
 return x;
}
function count(x:unknown):bigint {
 if(typeof x!=="string"||!COUNT.test(x))return fail("exit_recovery_count_invalid");
 const [major,minor]=x.split(".");
 return BigInt(major!)*100n+BigInt(minor!);
}
function signed(x:unknown):bigint {
 if(typeof x!=="string"||!SIGNED.test(x))return fail("exit_recovery_position_invalid");
 return x[0]==="-"?-count(x.slice(1)):count(x);
}
function position(x:bigint):string{
 const neg=x<0n?"-":"",v=x<0n?-x:x;
 return neg+(v/100n).toString()+"."+(v%100n).toString().padStart(2,"0");
}
export async function readAuthenticatedProtectiveExitOutcome(
 input:Input,receipt:Receipt,
 deps:{db?:DB;readFeeds?:typeof readOwnedKalshiFeeds;now?:()=>number}={},
):Promise<IocRecoveryObservation>{
 if(!UUID.test(input.ownerId)||!UUID.test(input.reservationId)||
    (receipt!==null&&(receipt.httpStatus!==201||
     receipt.client_order_id!==input.order.client_order_id||
     typeof observedReceipt.order_id!=="string"||!receipt.order_id))||
    input.order.ticker===undefined)
  return fail("exit_recovery_receipt_or_owner_invalid");
 const now=(deps.now??Date.now)();
 const fp=dedicatedSignerFingerprint(input.material.keyId,input.material.privateKey);
 if(!fp||!/^[a-f0-9]{64}$/.test(fp))return fail("exit_recovery_signer_invalid");
 const query=await (deps.db??pool).query(
  "SELECT r.initial_position_fp,r.position_observed_at_ms FROM private.strata_emergency_exit_reservations r "+
  "JOIN public.v13_production_account a ON a.id=r.execution_account_id "+
  "AND a.owner_user_id=r.owner_user_id "+
  "WHERE r.reservation_id=$1::uuid AND r.owner_user_id=$2::uuid "+
  "AND r.execution_account_id=$3::text AND r.client_order_id=$4::text "+
  "AND r.market_ticker=$5::text AND r.state='UNKNOWN' "+
  "AND a.key_fingerprint=$6::text AND a.exchange_index=2 AND a.subaccount=1",
  [input.reservationId,input.ownerId,input.accountId,input.order.client_order_id,
   input.order.ticker,fp]);
 if(query.rows.length!==1)return fail("exit_recovery_baseline_not_unique");
 const baseline=query.rows[0]!;
 const initial=text(baseline.initial_position_fp),baselineTime=Number(baseline.position_observed_at_ms);
 if(!Number.isSafeInteger(now)||!Number.isSafeInteger(baselineTime)||
    baselineTime>now||(receipt!==null&&now-baselineTime>30_000))
  return fail("exit_recovery_baseline_stale");
 const initialUnits=signed(initial),requested=count(input.order.count);
 if(initialUnits===0n||requested===0n||
    requested>(initialUnits<0n?-initialUnits:initialUnits)||
    (initialUnits>0n&&input.order.side!=="ask")||
    (initialUnits<0n&&input.order.side!=="bid"))
  return fail("exit_recovery_original_position_invalid");
 const feed=await (deps.readFeeds??readOwnedKalshiFeeds)(input.material,now);
 if(!feed.ok)return fail("exit_recovery_exchange_history_unavailable");
 if(feed.observedAtMs>now||now-feed.observedAtMs>3000)
  return fail("exit_recovery_exchange_snapshot_stale");
 const matchingPositions=feed.positions.map(object).filter(x=>x.ticker===input.order.ticker);
 if(matchingPositions.length!==1)return fail("exit_recovery_position_not_unique");
 const observed=signed(matchingPositions[0]!.position_fp??matchingPositions[0]!.position);
 const orders=feed.orders.map(object).filter(x=>x.client_order_id===input.order.client_order_id);
 if(orders.length!==1)return fail("exit_recovery_order_not_unique");
 const order=orders[0]!;
 // Restart recovery derives an observation from authenticated exchange records,
 // never from an inferred POST success. No network POST is performed here.
 const orderId=text(order.order_id);
 const observedReceipt:NonNullable<Receipt>=receipt??{
  httpStatus:201, // internal reconciler convention; not a witnessed HTTP response
  client_order_id:text(input.order.client_order_id),order_id:orderId,
  fill_count:text(order.fill_count_fp),
  remaining_count:position(count(input.order.count)-count(order.fill_count_fp)),
  ts_ms:baselineTime
 };
 // GET /portfolio/orders uses book_side and subaccount_number, unlike
 // the V2 POST body. The exchange history may omit reduce_only; its proof
 // is the immutable signed request digest and server-side fenced reservation.
 if(order.order_id!==observedReceipt.order_id||order.ticker!==input.order.ticker||
    order.book_side!==input.order.side||
    (order.yes_price_dollars!==undefined&&order.yes_price_dollars!==input.order.price)||
    (order.fill_count_fp!==undefined&&count(order.fill_count_fp)!==count(observedReceipt.fill_count))||
    (order.reduce_only!==undefined&&order.reduce_only!==true)||
    !["executed","canceled","cancelled"].includes(String(order.status))||
    (order.subaccount_number!==undefined&&Number(order.subaccount_number)!==1)||
    (order.subaccount!==undefined&&Number(order.subaccount)!==1)||
    (order.exchange_index!==undefined&&Number(order.exchange_index)!==2))
  return fail("exit_recovery_order_mismatch");
 if(count(order.initial_count_fp??order.initial_count??order.count_fp??order.count)!==requested)
  return fail("exit_recovery_requested_count_mismatch");
 let total=0n;
 const seen=new Set<string>();
 for(const raw of feed.fills){
  const fill=object(raw);
  if(fill.order_id===receipt.order_id&&fill.ticker!==input.order.ticker)
   return fail("exit_recovery_matched_fill_market_mismatch");
  if(fill.ticker!==input.order.ticker)continue;
  const id=text(fill.trade_id??fill.fill_id);
  if(seen.has(id))return fail("exit_recovery_duplicate_fill_id");
  seen.add(id);
  if(fill.order_id===receipt.order_id){
   const units=count(fill.count_fp??fill.count);
   if(units===0n)return fail("exit_recovery_zero_quantity_fill");
   total+=units;
  }else{
   // A concurrent fill in the same market after baseline could also change
   // inventory; we cannot attribute the position delta to this IOC.
   const at=Date.parse(String(fill.created_time??fill.ts??""));
   if(!Number.isFinite(at)||at>=baselineTime)
    return fail("exit_recovery_concurrent_fill_unattributable");
  }
 }
 if(total!==count(receipt.fill_count)||total+count(observedReceipt.remaining_count)!==requested)
  return fail("exit_recovery_fill_receipt_disagreement");
 const expected=initialUnits>0n?initialUnits-total:initialUnits+total;
 if(expected!==observed)return fail("exit_recovery_position_not_attributable");
 return {
  clientOrderId:text(input.order.client_order_id),
  requestedCountFp:text(input.order.count),
  marketTicker:text(input.order.ticker),
  initialPositionFp:initial,
  observedPositionFp:position(observed),
  positionMarketTicker:text(input.order.ticker),
  reducingBookSide:input.order.side==="ask"?"ask":"bid",
  completeExchangeHistory:true,exactMarketAndAccountMatched:true,
  orderAndFillHistoryMatched:true,isolatedPositionDelta:true,
  response:observedReceipt,
 };
}
