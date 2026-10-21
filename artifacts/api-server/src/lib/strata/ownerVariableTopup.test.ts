import assert from "node:assert/strict";
import test from "node:test";
import {exactSignedCash,OWNER_TOPUP_CONFIRM,executeOwnerTopup,prepareOwnerTopup} from "./ownerVariableTopup";
test("exact provider USD microdollars, reject wrong identity and fractional monetary precision",()=>{
 assert.equal(exactSignedCash({subaccount:0,exchange_index:2,balance_dollars:"100.123456"},0,2),100123456n);
 assert.equal(exactSignedCash({subaccount:1,exchange_index:2,balance:2500},1,2),25000000n);
 assert.equal(exactSignedCash({subaccount:0,exchange_index:2,balance_dollars:"100.00"},1,2),null);
 assert.equal(exactSignedCash({balance_dollars:"100.0000001"},0,2),null);
 assert.equal(exactSignedCash({balance:-5},0,2),null);
});
const unsafeDb={query:async()=>{throw Error("never read");},connect:async()=>{throw Error("never connect");}};
test("malformed and unauthorized amounts cause zero Kalshi operations",async()=>{
 for(const amount of [-1,0,99,2500001,100.5,NaN]){
  const r=await prepareOwnerTopup(unsafeDb as never,"owner",amount);
  assert.equal(r.ok,false);assert.equal(r.transferAttempted,false);
 }
 const v=await executeOwnerTopup(unsafeDb as never,"owner",{
   attemptId:"00000000-0000-4000-8000-000000000000",confirmation:"wrong",
 });
 assert.equal(v.reason,"topup_explicit_owner_consent_required");
 assert.equal(v.transferAttempted,false);
});
test("live exchange POST is disabled by default regardless of submitted consent",async()=>{
 const v=await executeOwnerTopup(unsafeDb as never,"owner",{
   attemptId:"00000000-0000-4000-8000-000000000000",confirmation:OWNER_TOPUP_CONFIRM,
 });
 assert.equal(v.reason,"variable_topup_post_not_activated");
 assert.equal(v.transferAttempted,false);
});
