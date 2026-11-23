/**
 * Transitional release containment, not an independent live signal adapter.
 * Until a reviewed account-bound live source is available, no production ENTRY
 * may reach the actual HTTP transport. Existing reduce-only/cancel/reconciliation
 * authority is NOT granted or changed by this guard. Do not deploy this candidate
 * as an independently functioning live engine.
 */
export const LIVE_ENTRY_SOURCE_UNAVAILABLE="production_independent_entry_source_unavailable";
export function assertIndependentEntryAvailable():never {
  throw new Error(LIVE_ENTRY_SOURCE_UNAVAILABLE);
}

/** The production transport constructs a fixed string URL, explicit method and
 * serialized order object. Reject other input shapes rather than guess whether
 * a request is reducing. This is a narrowing fence, not an exit authorization. */
export function assertContainedProductionRequest(input:Parameters<typeof fetch>[0],init?:RequestInit):void {
  if(typeof input!=="string"||!init||typeof init.method!=="string")assertIndependentEntryAvailable();
  const method=init.method.toUpperCase();
  let url:URL;
  try{url=new URL(input);}catch{assertIndependentEntryAvailable();}
  if(url.origin!=="https://external-api.kalshi.com"||url.username||url.password||url.hash)
    assertIndependentEntryAvailable();
  if(method==="GET"||method==="HEAD")return;
  const orderPath="/trade-api/v2/portfolio/events/orders";
  if(method==="DELETE"&&url.pathname.startsWith(orderPath+"/"))return;
  if(method!=="POST"||url.pathname!==orderPath||url.search||typeof init.body!=="string")
    assertIndependentEntryAvailable();
  let value:unknown;
  try{value=JSON.parse(init.body);}catch{assertIndependentEntryAvailable();}
  if(!value||typeof value!=="object"||Array.isArray(value))assertIndependentEntryAvailable();
  const order=value as Record<string,unknown>;
  if(order.reduce_only!==true||order.subaccount!==1||order.exchange_index!==2||
    order.time_in_force!=="immediate_or_cancel"||order.post_only!==false)
    assertIndependentEntryAvailable();
}
export const containedProductionFetch:typeof fetch=async(input,init)=>{
  assertContainedProductionRequest(input,init);
  // Do not follow redirects with signed order material.
  return fetch(input,{...init,redirect:"error"});
};
