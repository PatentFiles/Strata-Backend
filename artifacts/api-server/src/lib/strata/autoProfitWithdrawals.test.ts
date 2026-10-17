import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTO_CONFIRMATION, processAutoRule, saveAutoRule,
} from "./autoProfitWithdrawals";

test("auto withdrawals reject impossible threshold/reserve without database calls", async () => {
  const input={thresholdCents:100000,withdrawCents:75000,minimumRetainedCents:50000,
    enabled:true,expectedRevision:0,confirmation:AUTO_CONFIRMATION};
  const result=await saveAutoRule("invalid-owner",input);
  assert.equal(result.ok,false);
  assert.equal(result.reason,"invalid_values");
});

test("auto rules must be explicitly owner-authorized before enabling", async () => {
  const result=await saveAutoRule("invalid-owner",{thresholdCents:100000,
    withdrawCents:75000,minimumRetainedCents:25000,enabled:true,expectedRevision:0});
  assert.equal(result.ok,false);
  assert.equal(result.reason,"owner_authorization_required");
});

test("automatic scheduler refuses all money movement when release flags are off", async () => {
  const before={
    manual:process.env.STRATA_MANUAL_WITHDRAWALS_ENABLED,
    routing:process.env.STRATA_WITHDRAWAL_ROUTING_VERIFIED,
    automatic:process.env.STRATA_AUTOMATIC_WITHDRAWALS_ENABLED,
  };
  delete process.env.STRATA_MANUAL_WITHDRAWALS_ENABLED;
  delete process.env.STRATA_WITHDRAWAL_ROUTING_VERIFIED;
  delete process.env.STRATA_AUTOMATIC_WITHDRAWALS_ENABLED;
  try{
    assert.equal(await processAutoRule("invalid-owner"),"money_movement_disabled");
  }finally{
    for(const [key,value] of [
      ["STRATA_MANUAL_WITHDRAWALS_ENABLED",before.manual],
      ["STRATA_WITHDRAWAL_ROUTING_VERIFIED",before.routing],
      ["STRATA_AUTOMATIC_WITHDRAWALS_ENABLED",before.automatic],
    ] as const){
      if(value===undefined)delete process.env[key];else process.env[key]=value;
    }
  }
});
