import test from "node:test";
import assert from "node:assert/strict";
import {viewForCaller, type ScopedAccount} from "./userExecutionScope";

const OWNER="11111111-1111-4111-8111-111111111111";
function account(amount:number|null,cap:number|null):ScopedAccount {
 return {
   id:"strata-owner",ownerUserId:OWNER,subaccount:1,exchangeIndex:2,
   configuredStakeCents:amount,approvedMaxEntryStakeCents:cap,
   stakeRevision:9,riskPresetId:null,riskPresetRevision:null,riskCapitalCents:null,
   policyApproved:true,workerRunning:false,workerArmRequested:false,
   executionEnabled:false,killSwitch:true,
   commissioned:true,minimumExitApproved:true,commissioningState:"commissioned",
   positions:[],orders:[],fills:[],settlements:[],
 } as unknown as ScopedAccount;
}
test("outdated sub-$5 stake cannot appear as live configured stake or change history",()=>{
 const old=account(150,150);
 const view=viewForCaller(OWNER,old);
 assert.equal(view.configuredStakeCents,null);
 assert.equal(view.stakeRevision,9);
 assert.equal(old.configuredStakeCents,150);
 assert.equal(view.armed,false);
});
test("new owner-approved $5–$25,000 stake is returned without a hardcoded value",()=>{
 for(const stake of [500,5000,1945700,2500000]){
   assert.equal(viewForCaller(OWNER,account(stake,stake)).configuredStakeCents,stake);
 }
});
test("no account, wrong owner, malformed and unapproved stake stay unconfigured",()=>{
 assert.equal(viewForCaller(OWNER,account(2500001,2500001)).configuredStakeCents,null);
 assert.equal(viewForCaller(OWNER,account(500,150)).configuredStakeCents,null);
 assert.equal(viewForCaller(OWNER,account(null,null)).configuredStakeCents,null);
 assert.equal(viewForCaller("22222222-2222-4222-8222-222222222222",account(500,500)).executionAccountExists,false);
});
