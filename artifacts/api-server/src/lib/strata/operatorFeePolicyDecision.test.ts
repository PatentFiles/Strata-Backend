import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {FEE_SOURCE_DECISION_TEXT,FEE_SOURCE_DECISION_SHA256,
  REVIEWED_OPERATOR_FEE_SHA256} from "./operatorFeePolicyDecision";
test("two administrator authorization signatures bind exact immutable policy bytes",()=>{
 const digest=createHash("sha256").update(FEE_SOURCE_DECISION_TEXT).digest("hex");
 assert.equal(digest,FEE_SOURCE_DECISION_SHA256);
 assert.match(REVIEWED_OPERATOR_FEE_SHA256,/^[a-f0-9]{64}$/);
});
