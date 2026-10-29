import test from 'node:test';
import assert from 'node:assert/strict';
import {createEntryWireClockFetch,isEntryWireClockRefusal} from './entryWireClock';
const URL='https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders';
const clientOrderId='v13p-11111111-1111-4111-8111-111111111111';
test('late asynchronous fee work cannot send an expired entry',async()=>{
 let now=0,sends=0,checks=0;
 const raw:typeof fetch=async()=>{sends++;return new Response('{}')};
 const wire=createEntryWireClockFetch(()=>{checks++;if(now>5000)throw Error('expired')},raw);
 const feeLayer:typeof fetch=async(request,init)=>{
  await Promise.resolve();now=5001;return wire(request,init);
 };
 await assert.rejects(feeLayer(URL,{method:'POST',body:JSON.stringify({reduce_only:false,client_order_id:clientOrderId})}),error=>{
  assert.equal(isEntryWireClockRefusal(error,clientOrderId),true);
  assert.equal(isEntryWireClockRefusal(error,'other'),false);
  assert.equal(isEntryWireClockRefusal(new Error('expired'),clientOrderId),false);
  return error instanceof Error&&error.message==='expired';
 });
 assert.equal(checks,1);assert.equal(sends,0);
});
test('fresh entries check synchronously while exits/cancels retain their own gates',async()=>{
 const order:string[]=[];
 const raw:typeof fetch=async()=>{order.push('send');return new Response('{}')};
 const wire=createEntryWireClockFetch(()=>order.push('check'),raw);
 await wire(URL,{method:'POST',body:JSON.stringify({reduce_only:false,client_order_id:clientOrderId})});
 assert.deepEqual(order,['check','send']);order.length=0;
 await wire(URL,{method:'POST',body:JSON.stringify({reduce_only:true})});
 await wire(URL+'/id',{method:'DELETE'});
 assert.deepEqual(order,['send','send']);
});
test('unverified entry bodies are refused without touching the transport',()=>{
 let sends=0;
 const wire=createEntryWireClockFetch(()=>{},async()=>{sends++;return new Response('{}')});
 for(const body of ['{}','[]','null'])assert.throws(()=>wire(URL,{method:'POST',body}));
 assert.equal(sends,0);
});
