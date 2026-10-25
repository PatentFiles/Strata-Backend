import test from "node:test";
import assert from "node:assert/strict";
import {
  isUsableFeeCapture,parseBridgeMode,GENERAL_FEE_CAPTURE_MAX_AGE_MS,
  V4_FEE_CAPTURE_MAX_AGE_MS,STRICT_V4_QUERY,
  V5_REVIEWED_DOCUMENT_QUERY,V5_DOCUMENT_POLICY_VERSION,
} from "./cachePolicy";

const now=Date.parse("2026-10-24T13:00:00Z");
const recorded=(age:number)=>new Date(now-age).toISOString();
const lease=new Date(now+10*60_000).toISOString();

test("only exact V4 strict query can force an actual fresh provider capture",()=>{
 assert.equal(parseBridgeMode(""),"general");
 assert.equal(parseBridgeMode(STRICT_V4_QUERY),"v4_strict");
 assert.equal(parseBridgeMode(V5_REVIEWED_DOCUMENT_QUERY),"v5_document");
 assert.equal(V5_DOCUMENT_POLICY_VERSION,"strata_fee_document_v5_observation_only");
 for(const untrusted of [
  "?max_age_seconds=59","?max_age_seconds=61","?max_age_seconds=60&url=attacker",
  "?url=https://attacker.invalid","?max_age_seconds=060","?MAX_AGE_SECONDS=60",
  "?fresh=1","?max_age_seconds=60&max_age_seconds=60",
  "?document_policy=v5-reviewed-55m&url=evil","?document_policy=v5-reviewed-55m&max_age_seconds=60",
  "?document_policy=v5-reviewed-60m",
 ])assert.equal(parseBridgeMode(untrusted),null,untrusted);
});

test("V4 refuses old cached PDF while general cache still serves old immutable bytes",()=>{
 assert.equal(V4_FEE_CAPTURE_MAX_AGE_MS,60_000);
 assert.equal(GENERAL_FEE_CAPTURE_MAX_AGE_MS,55*60_000);
 assert.equal(isUsableFeeCapture(recorded(30_000),lease,now,"v4_strict"),true);
 assert.equal(isUsableFeeCapture(recorded(59_999),lease,now,"v4_strict"),true);
 assert.equal(isUsableFeeCapture(recorded(60_000),lease,now,"v4_strict"),false);
 assert.equal(isUsableFeeCapture(recorded(25*60_000),lease,now,"v4_strict"),false);
 assert.equal(isUsableFeeCapture(recorded(25*60_000),lease,now,"general"),true);
 assert.equal(isUsableFeeCapture(recorded(55*60_000),lease,now,"general"),false);
});

test("clock, storage lease and fabricated fresh capture fail closed in both modes",()=>{
 for(const mode of ["general","v4_strict","v5_document"] as const){
   assert.equal(isUsableFeeCapture("invalid",lease,now,mode),false);
   assert.equal(isUsableFeeCapture(recorded(-2000),lease,now,mode),false);
   assert.equal(isUsableFeeCapture(recorded(10_000),recorded(1),now,mode),false);
   assert.equal(isUsableFeeCapture(recorded(10_000),
      new Date(now+61*60_000).toISOString(),now,mode),false);
   assert.equal(isUsableFeeCapture(recorded(10_000),lease,NaN,mode),false);
 }
});

test("V5 versioned observation reuses original verified publication without fabricating 60-second capture",()=>{
 assert.equal(isUsableFeeCapture(recorded(30_000),lease,now,"v5_document"),true);
 assert.equal(isUsableFeeCapture(recorded(25*60_000),lease,now,"v5_document"),true);
 assert.equal(isUsableFeeCapture(recorded(54*60_000),lease,now,"v5_document"),true);
 assert.equal(isUsableFeeCapture(recorded(55*60_000),lease,now,"v5_document"),false);
 assert.equal(isUsableFeeCapture(recorded(25*60_000),lease,now,"v4_strict"),false);
 assert.equal(isUsableFeeCapture(recorded(-1),lease,now,"v5_document"),false);
 assert.equal(isUsableFeeCapture(recorded(20_000),recorded(1),now,"v5_document"),false);
});
