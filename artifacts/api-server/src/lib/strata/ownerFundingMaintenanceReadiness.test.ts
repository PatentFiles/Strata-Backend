import assert from "node:assert/strict";
import test from "node:test";
import { readOwnerFundingMaintenanceReadiness, OWNER_FUNDING_MAINTENANCE_READ_SQL }
  from "./ownerFundingMaintenanceReadiness";

const OWNER="d32617a1-3de4-4a85-aefb-d2abcaa122a0";
const ready={
  commissioned:true,execution_enabled:false,kill_switch:true,
  cash_precision_verified:true,blocked_reason:"awaiting_account_commissioning",
  cash_micros:"25000000",reserved_micros:"0",
  reconciled_at:"2026-10-21T15:00:00Z",
  open_positions:0,unresolved_orders:0,owned_worker_leases:0,
};
function db(rows:Record<string,unknown>[]){
 return {query:async(sql:string,params?:unknown[])=>{
  assert.equal(sql,OWNER_FUNDING_MAINTENANCE_READ_SQL);
  assert.deepEqual(params,[OWNER]);
  return {rows};
 }};
}
test("commissioned but locally stopped owner can request signed funding preview regardless of GLOBAL mode",async()=>{
 const result=await readOwnerFundingMaintenanceReadiness(db([ready]),OWNER);
 assert.equal(result.ok,true);
 assert.equal(result.accountScopedMaintenanceEligible,true);
 assert.equal(result.recordedBotCashCents,2500);
 assert.equal(result.executable,false);
 assert.equal(result.transferAttempted,false);
 assert.equal(result.variableTransferImplemented,false);
 assert.equal(result.requiresSignedKalshiCashRead,true);
 assert.equal(result.requiresAuthenticatedExchangeReconciliation,true);
 assert.equal(result.requiresOwnerTransferConsent,true);
 assert.ok(!OWNER_FUNDING_MAINTENANCE_READ_SQL.includes("live_execution_enabled=false"));
 assert.ok(!OWNER_FUNDING_MAINTENANCE_READ_SQL.includes("commissioned=false"));
 assert.ok(!OWNER_FUNDING_MAINTENANCE_READ_SQL.includes("UPDATE "));
 assert.ok(!OWNER_FUNDING_MAINTENANCE_READ_SQL.includes("INSERT "));
});
test("foreign or multiple owner accounts never qualify",async()=>{
 for(const rows of [[],[ready,ready]]){
  const v=await readOwnerFundingMaintenanceReadiness(db(rows),OWNER);
  assert.equal(v.ok,false);
  assert.equal(v.reason,"owner_execution_account_missing_or_ambiguous");
 }
 const bad=await readOwnerFundingMaintenanceReadiness(db([ready]),"not-a-uuid");
 assert.equal(bad.reason,"owner_identity_invalid");
});
test("disarm and preserved account/global safety invariants block unsafe maintenance",async()=>{
 const cases:[Record<string,unknown>,string][]=[
  [{execution_enabled:true},"stop_and_disarm_account_before_funding_review"],
  [{kill_switch:false},"stop_and_disarm_account_before_funding_review"],
  [{commissioned:false},"account_not_commissioned"],
  [{blocked_reason:"excessive_loss"},"risk_freeze_requires_resolution"],
  [{reserved_micros:"1"},"funds_reserved_or_unknown"],
  [{cash_precision_verified:false},"execution_cash_precision_unverified"],
  [{open_positions:1},"maintenance_exposure_or_worker_lease_present"],
  [{unresolved_orders:1},"maintenance_exposure_or_worker_lease_present"],
  [{owned_worker_leases:1},"maintenance_exposure_or_worker_lease_present"],
  [{unresolved_orders:"unknown"},"maintenance_exposure_unproven"],
  [{cash_micros:"100.00"},"recorded_cash_unverified"],
 ];
 for(const [patch,reason] of cases){
  const a=await readOwnerFundingMaintenanceReadiness(db([{...ready,...patch}]),OWNER);
  assert.equal(a.ok,false,JSON.stringify(patch));
  assert.equal(a.reason,reason);
  assert.equal(a.recordedBotCashCents,null);
 }
});
test("database outage fails closed and does not provide a transfer route",async()=>{
 const d={query:async()=>{throw Error("secret connection error");}};
 const result=await readOwnerFundingMaintenanceReadiness(d,OWNER);
 assert.equal(result.reason,"owner_maintenance_database_unavailable");
 assert.equal(result.transferAttempted,false);
 assert.equal(result.variableTransferImplemented,false);
});
