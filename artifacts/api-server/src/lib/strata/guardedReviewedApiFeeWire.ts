import { pool } from "@workspace/db";
import {
 parseReviewedApiSource, verifyReviewedApiFeeSourceStage
} from "./apiFeeSourceStage";
/**
 * Last exact-market API-source fee fence for the alternative PDF-free source.
 * Runs WITH a DB transaction and row-share locks until the signed exchange
 * POST returns. New exposure is explicitly paused: reduce-only IOC exits
 * require current independent source reviews, owner consent, fee model and
 * fresh exact-market API metadata. This is not a trading activation toggle.
 */
export function createGuardedReviewedApiFeeFetch(
 ownerUserId:string,sourceUrl:string,transport:typeof fetch,
 deps:{connect?:()=>ReturnType<typeof pool.connect>;
   verify?:typeof verifyReviewedApiFeeSourceStage}={},
):typeof fetch {
 if(!parseReviewedApiSource(sourceUrl))
  throw new Error("reviewed_api_source_url_invalid");
 return async (request,init)=>{
  if(init?.method!=="POST")return transport(request,init);
  if(typeof request!=="string" ||
     request!=="https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders"||
     typeof init.body!=="string")
    throw new Error("api_fee_unexpected_order_endpoint");
  let order:Record<string,unknown>;
  try{
   const raw=JSON.parse(init.body);
   if(!raw||typeof raw!=="object"||Array.isArray(raw))
    throw Error("invalid");
   order=raw as Record<string,unknown>;
  }catch{throw new Error("api_fee_order_body_invalid");}
  const ticker=order.ticker;
  if(typeof ticker!=="string" || !/^KXBTC15M-[A-Za-z0-9-]+$/.test(ticker) ||
     order.subaccount!==1 || order.exchange_index!==2)
    throw new Error("api_fee_order_scope_invalid");
  // Entry/increase remains closed until independently validated exit procedure
  // and real exchange reconciliation evidence is approved. No browser override.
  if(order.reduce_only!==true)
    throw new Error("api_fee_source_new_entry_blocked_pending_exit_validation");
  if(order.time_in_force!=="immediate_or_cancel"||
     order.self_trade_prevention_type!=="taker_at_cross"||
     order.post_only!==false || order.expiration_time!==undefined ||
     typeof order.client_order_id!=="string" ||
     !/^v13p-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(order.client_order_id) ||
     (order.side!=="bid"&&order.side!=="ask") ||
     typeof order.count!=="string"||!/^[0-9]{1,9}\.[0-9]{2}$/.test(order.count) ||
     Number(order.count)<=0 ||
     typeof order.price!=="string"||!/^0\.[0-9]{4}$/.test(order.price) ||
     Number(order.price)<=0)
    throw new Error("api_fee_exit_order_shape_unverified");
  const client=await(deps.connect?.()??pool.connect());
  let committed=false;
  try{
   await client.query("BEGIN");
   await client.query("SET LOCAL lock_timeout='1000ms'");
   await client.query("SET LOCAL statement_timeout='15000ms'");
   const checked=await (deps.verify??verifyReviewedApiFeeSourceStage)(
    ownerUserId,"ORDER_ENTRY",sourceUrl,ticker,{db:client});
   if(!checked.ok || checked.identity.marketTicker!==ticker)
    throw new Error("api_fee_final_order_grant_or_market_closed");
   const response=await transport(request,init);
   await client.query("COMMIT");committed=true;
   return response;
  }finally{
   if(!committed){try{await client.query("ROLLBACK");}catch{}}
   client.release();
  }
 };
}
