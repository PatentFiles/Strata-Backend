import test,{after} from "node:test";
import assert from "node:assert/strict";
import {pool} from "@workspace/db";
import {PIN_SQL} from "./ownerProtectiveHistoryPreviewPin";
import {installFullRecoverySchema,backendRole} from "./ownerUnknownRecoverySchema.fixture";
after(()=>pool.end());
test("exact pin SELECT compiles and denies absence on native recovery schema under nonowner",async()=>{
 const c=await pool.connect();
 try{
  await installFullRecoverySchema(c);
  await c.query("BEGIN READ ONLY");
  await c.query("SET LOCAL ROLE "+backendRole);
  const r=await c.query(PIN_SQL,["11111111-1111-4111-8111-111111111111"]);
  assert.equal(r.rowCount,0);
 }finally{await c.query("ROLLBACK");c.release()}
});
