import assert from 'node:assert/strict';
import test from 'node:test';
import type {Intent} from './ledger';
import {reconciledIntentState,reconciliationIntentChanged} from './reconciliationIntentPersistence';
const intent=()=>({id:'intent',state:'BLOCKED',exchange_order_id:null,filled_hundredths:'0',reserved_micros:'0',terminal:true} as Intent);
test('five unchanged terminal no-send rows require zero writes across three reconciliations',()=>{
  let writes=0;
  for(let tick=0;tick<3;tick++) for(let n=0;n<5;n++){
    const i=intent(),before=reconciledIntentState(i);
    if(reconciliationIntentChanged(before,i)) writes++;
  }
  assert.equal(writes,0); // old unconditional persistence loop issued 5 * 3 = 15 UPDATEs
});
for(const [field,value] of Object.entries({state:'UNKNOWN',exchange_order_id:'exchange-1',filled_hundredths:'100',reserved_micros:'30000',terminal:false})){
  test(`persists changed ${field}`,()=>{
    const i=intent(),before=reconciledIntentState(i);
    Object.assign(i,{[field]:value});
    assert.equal(reconciliationIntentChanged(before,i),true);
  });
}
test('snapshot does not alias mutable intent and contains only persistence fields',()=>{
  const i=intent(),before=reconciledIntentState(i);
  assert.ok(Object.isFrozen(before));
  i.state='TERMINAL';i.filled_hundredths='100';
  assert.equal(before.state,'BLOCKED');assert.equal(before.filled_hundredths,'0');
  assert.equal(reconciliationIntentChanged(before,i),true);
});
test('null-to-order and order-to-null are both changes',()=>{
  const i=intent(),before=reconciledIntentState(i);i.exchange_order_id='order';
  assert.equal(reconciliationIntentChanged(before,i),true);
  const withOrder=reconciledIntentState(i);i.exchange_order_id=null;
  assert.equal(reconciliationIntentChanged(withOrder,i),true);
});
test('every durable intent state can be retained unchanged without assuming terminal safety',()=>{
  for(const state of ['PREPARED','DISPATCHED','UNKNOWN','TERMINAL','BLOCKED']){
    const i=intent();i.state=state;i.terminal=state==='TERMINAL'||state==='BLOCKED';
    assert.equal(reconciliationIntentChanged(reconciledIntentState(i),i),false);
  }
});
test('partial fill, reservation release and terminal transition are persisted together',()=>{
  const i=intent();Object.assign(i,{state:'UNKNOWN',terminal:false,reserved_micros:'5050000'});
  const before=reconciledIntentState(i);
  Object.assign(i,{state:'TERMINAL',terminal:true,exchange_order_id:'order',filled_hundredths:'100',reserved_micros:'30000'});
  assert.equal(reconciliationIntentChanged(before,i),true);
});
