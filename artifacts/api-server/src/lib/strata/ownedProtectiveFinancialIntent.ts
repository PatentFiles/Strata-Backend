import {requestQuantityHundredths,formatContractHundredths} from "../v13-production/requestQuantity";
import {planFractionalIocExit} from "../v13-production/fractionalExitPlanner";
import type {Request,MarketEvidence} from "../v13-production/types";
import type {ProtectiveExitDispatch} from "../v13-production/consumer";
import type {EmergencyExitOrder} from "./ownerFeeEmergencyExit";

type Selection=Parameters<ProtectiveExitDispatch>[0];
const CLIENT=/^v13p-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * The V13 ledger and signed exit ledger MUST have the SAME client ID,
 * contracts, side and price. prepareExit commits the authenticated intent.
 * A separately refreshed order book must support the unchanged sealed IOC.
 * Better bids may execute it; never reprice or resize the sealed request.
 */
export function sealedFinancialProtectiveExitOrder(
 selection:Selection,financial:Request,book:MarketEvidence,
):EmergencyExitOrder {
 if(!selection||!/^KXBTC15M-[A-Za-z0-9-]+$/.test(selection.market)||
    !/^[0-9a-f-]{36}$/i.test(selection.positionId)||
    !/^[0-9]+$/.test(selection.quantityHundredths)||
    (selection.side!=="YES"&&selection.side!=="NO")||
    !Number.isSafeInteger(selection.minimumExitMicros)||
    selection.minimumExitMicros<1||selection.minimumExitMicros>=1_000_000)
  throw Error("protective_exit_owner_selection_invalid");
 const owned=BigInt(selection.quantityHundredths),quantity=requestQuantityHundredths(financial);
 if(owned<1n||
    financial.market!==selection.market||financial.side!==selection.side||
    financial.action!=="SELL"||financial.reduceOnly!==true||
    financial.timeInForce!=="IOC"||!CLIENT.test(financial.clientOrderId)||
    quantity<1n||quantity>100000n||quantity>owned||
    !Number.isSafeInteger(financial.limitMicros)||financial.limitMicros<100||
    financial.limitMicros>999_900||financial.limitMicros%100!==0||
    financial.limitMicros<selection.minimumExitMicros)
  throw Error("protective_exit_sealed_financial_intent_invalid");
 // Test admissibility of exactly the sealed quantity at its sealed SELL
 // limit. Reoptimizing all owned units would reject better bids or deeper
 // liquidity even though neither change requires modifying this request.
 const plan=planFractionalIocExit({ownedHundredths:quantity.toString(),
   bestBidDollars:book.bestBidDollars,bidLevels:book.bids,
   minimumExitMicros:financial.limitMicros});
 if(!plan.ok||BigInt(plan.plan.plannedHundredths)!==quantity||
    plan.plan.limitMicros<financial.limitMicros)
  throw Error("protective_exit_orderbook_changed_after_financial_preparation");
 const ticks=financial.limitMicros/100;
 const yesTicks=selection.side==="YES"?ticks:10_000-ticks;
 if(yesTicks<1||yesTicks>9999)throw Error("protective_exit_yes_price_invalid");
 return Object.freeze({
  ticker:financial.market,
  side:selection.side==="YES"?"ask":"bid",
  count:formatContractHundredths(quantity),
  price:"0."+String(yesTicks).padStart(4,"0"),
  client_order_id:financial.clientOrderId,
  time_in_force:"immediate_or_cancel",
  self_trade_prevention_type:"taker_at_cross",
  post_only:false,reduce_only:true,subaccount:1,exchange_index:2,
 });
}
