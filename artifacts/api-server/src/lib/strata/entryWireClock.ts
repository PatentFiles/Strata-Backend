/** Synchronous check at the raw HTTP boundary, after outer fee verifications.
 * This is a freshness refusal only, never trading authority. Protective exits
 * and cancellations retain their independently reviewed paths.
 */
const localRefusals=new WeakMap<Error,string>();
/** Only this module can attest that its synchronous check refused before HTTP.
 * A provider error or lookalike message cannot release another reservation.
 */
export function isEntryWireClockRefusal(error:unknown,clientOrderId:string):boolean {
 return typeof clientOrderId==='string'&&error instanceof Error&&localRefusals.has(error)&&localRefusals.get(error)===clientOrderId;
}
export function createEntryWireClockFetch(check:()=>void,transport:typeof fetch):typeof fetch {
 return (request,init)=>{
  const method=(init?.method??(request instanceof Request?request.method:'GET')).toUpperCase();
  if(method==='POST'){
   const url=new URL(request instanceof Request?request.url:String(request));
   if(url.origin==='https://external-api.kalshi.com'&&
      /^\/trade-api\/v2\/portfolio\/(?:events\/)?orders$/.test(url.pathname)){
    if(typeof init?.body!=='string')throw Error('entry_wire_body_unverified');
    const body=JSON.parse(init.body);
    if(!body||typeof body!=='object'||Array.isArray(body)||typeof body.reduce_only!=='boolean')
     throw Error('entry_wire_body_unverified');
    if(body.reduce_only===false){
     if(typeof body.client_order_id!=='string'||!/^v13p-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(body.client_order_id))
      throw Error('entry_wire_identity_unverified');
     try{check()}catch(cause){
      const reason=cause instanceof Error&&/^[a-z][a-z0-9_]{2,95}$/.test(cause.message)
       ?cause.message:'production_final_wire_clock_refused';
      const error=new Error(reason);localRefusals.set(error,body.client_order_id);throw error;
     }
    }
   }
  }
  // No await or asynchronous work between this check and the raw transport.
  return transport(request,init);
 };
}
