import assert from "node:assert/strict";
import test, {after, before} from "node:test";
import {pool} from "@workspace/db";
import {unresolvedEconomicExposureSQL} from "./economicExitDischargeScope";
import {safetyExposureSql} from "./accountScopedExecution";

/**
 * Disposable-DB projection contract, not exchange evidence or settlement
 * authorization. The stub is deliberately STRICT, so NULL yields SQL NULL.
 * Production uses the real canonical receipt verifier, never this stub.
 */
const prior=process.env.STRATA_ECONOMIC_EXIT_FINALITY_ENABLED;
before(async()=>{
 process.env.STRATA_ECONOMIC_EXIT_FINALITY_ENABLED="true";
 await pool.query("CREATE SCHEMA IF NOT EXISTS private");
 await pool.query(`CREATE OR REPLACE FUNCTION private.strata_has_economic_exit_discharge(
   account text,client text) RETURNS boolean LANGUAGE SQL IMMUTABLE STRICT
   AS $$ SELECT account='account-a' AND client='verified-exit' $$`);
});
after(async()=>{
 if(prior===undefined)delete process.env.STRATA_ECONOMIC_EXIT_FINALITY_ENABLED;
 else process.env.STRATA_ECONOMIC_EXIT_FINALITY_ENABLED=prior;
 await pool.end();
});

test("only the canonical discharged EXIT is excluded; null and non-EXIT remain unresolved",async()=>{
 const filter=unresolvedEconomicExposureSQL("i.account_id","i.client_order_id","i.kind");
 assert.match(filter,/COALESCE/);
 const r=await pool.query(`WITH candidate(account_id,kind,client_order_id) AS (
  VALUES ('account-a'::text,'EXIT'::text,'verified-exit'::text),
         ('account-a','EXIT','missing-exit'),
         ('account-a','ENTRY','verified-exit'),
         ('account-a','EXIT',NULL),
         ('account-b','EXIT','verified-exit')
 ) SELECT kind,client_order_id,account_id FROM candidate i
 WHERE true ${filter}
 ORDER BY account_id,kind,client_order_id NULLS FIRST`);
 assert.equal(r.rows.length,4);
 assert.deepEqual(r.rows.map(x=>[x.account_id,x.kind,x.client_order_id]),[
  ["account-a","ENTRY","verified-exit"],
  ["account-a","EXIT",null],
  ["account-a","EXIT","missing-exit"],
  ["account-b","EXIT","verified-exit"],
 ]);
});

test("protective exit projections do not drop NULL IDs or another account",async()=>{
 const filter=unresolvedEconomicExposureSQL("i.account_id","i.client_order_id");
 const r=await pool.query(`WITH candidate(account_id,client_order_id) AS (
  VALUES ('account-a'::text,'verified-exit'::text),
         ('account-a','missing-exit'),('account-a',NULL),
         ('account-b','verified-exit')
 ) SELECT account_id,client_order_id FROM candidate i WHERE true ${filter}`);
 assert.equal(r.rows.length,3);
});

test("rollout-off defaults to conservative legacy counts and unsafe identifiers fail",()=>{
 const filter=unresolvedEconomicExposureSQL("i.account_id","i.client_order_id","i.kind");
 assert.match(safetyExposureSql(),/strata_has_economic_exit_discharge/);
 assert.match(filter,/IS DISTINCT FROM 'EXIT'/);
 assert.throws(()=>unresolvedEconomicExposureSQL("i.account_id); DELETE FROM x--","i.client_order_id"),/identifier_invalid/);
 process.env.STRATA_ECONOMIC_EXIT_FINALITY_ENABLED="false";
 try{
  assert.equal(unresolvedEconomicExposureSQL("i.account_id","i.client_order_id"),"");
  assert.doesNotMatch(safetyExposureSql(),/strata_has_economic_exit_discharge/);
 }finally{process.env.STRATA_ECONOMIC_EXIT_FINALITY_ENABLED="true";}
});
