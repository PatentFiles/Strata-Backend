import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverOwnerSettledCashFreeze,OWNER_SETTLED_CASH_RECOVERY_CONFIRM,SETTLED_CASH_FREEZE,settledCashRecoveryAccountEligible} from './ownerSettledCashFreezeRecovery';
const owner='11111111-1111-4111-8111-111111111111';
const scope={confirmation:OWNER_SETTLED_CASH_RECOVERY_CONFIRM,accountId:'a',expectedRevision:'1',settlementEventId:'settlement:fixture'};
test('owner consent and closed exact revision/settlement scope are required before database access',async()=>{
 for(const change of [{confirmation:'wrong'},{accountId:''},{expectedRevision:'1.0'},{settlementEventId:'anything'}]){
  let calls=0;const r=await recoverOwnerSettledCashFreeze(owner,{...scope,...change},{db:{query:async()=>{calls++;throw Error('not allowed');}} as never,isScheduled:()=>false});
  assert.equal(r.ok,false);assert.equal(calls,0);
 }
});
test('reason-specific eligibility retains all accounting and owner guards without equating eligibility with activity',()=>{
 const a={owner_user_id:owner,blocked_reason:SETTLED_CASH_FREEZE,commissioned:true,cash_precision_verified:true,reserved_micros:'0',subaccount:1,exchange_index:2,execution_enabled:true,kill_switch:false};
 assert.equal(settledCashRecoveryAccountEligible(a,owner),true);
 for(const change of [{owner_user_id:'foreign'},{blocked_reason:null},{blocked_reason:'production_uncertain_order'},{commissioned:false},{cash_precision_verified:false},{reserved_micros:'1'},{subaccount:0},{exchange_index:1}])assert.equal(settledCashRecoveryAccountEligible({...a,...change},owner),false);
});
