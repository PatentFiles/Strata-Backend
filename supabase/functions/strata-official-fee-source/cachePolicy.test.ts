import test from "node:test";
import assert from "node:assert/strict";
import {
  isUsableFeeCapture,parseBridgeMode,GENERAL_FEE_CAPTURE_MAX_AGE_MS,
  V4_FEE_CAPTURE_MAX_AGE_MS,STRICT_V4_QUERY,
  feeProvenanceHeaders,V4_VERSIONED_FEE_LEASE_POLICY,
  V4_VERSIONED_LEASE_MS,VERSIONED_V4_QUERY,
} from "./cachePolicy";

const now=Date.parse("2026-10-24T13:00:00Z");
const recorded=(age:number)=>new Date(now-age).toISOString();
const lease=new Date(now+10*60_000).toISOString();

test("only exact V4 strict query can force an actual fresh provider capture",()=>{
 assert.equal(parseBridgeMode(""),"general");
 assert.equal(parseBridgeMode(STRICT_V4_QUERY),"v4_strict");
 assert.equal(parseBridgeMode(VERSIONED_V4_QUERY),"v4_versioned");
 for(const untrusted of [
  "?max_age_seconds=59","?max_age_seconds=61","?max_age_seconds=60&url=attacker",
  "?url=https://attacker.invalid","?max_age_seconds=060","?MAX_AGE_SECONDS=60",
  "?fresh=1","?max_age_seconds=60&max_age_seconds=60",
  "?max_age_seconds=3301","?max_age_seconds=3300&source=client",
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
 for(const mode of ["general","v4_strict"] as const){
   assert.equal(isUsableFeeCapture("invalid",lease,now,mode),false);
   assert.equal(isUsableFeeCapture(recorded(-2000),lease,now,mode),false);
   assert.equal(isUsableFeeCapture(recorded(10_000),recorded(1),now,mode),false);
   assert.equal(isUsableFeeCapture(recorded(10_000),
      new Date(now+61*60_000).toISOString(),now,mode),false);
   assert.equal(isUsableFeeCapture(recorded(10_000),lease,NaN,mode),false);
 }
});

test("versioned official V4 source retains actual capture timestamp and hash lease",()=>{
 assert.equal(V4_VERSIONED_LEASE_MS,55*60_000);
 // Real provenance expiry is bounded to capture + 1h, not test-now + 10m.
 const validLease=new Date(now+60_000).toISOString();
 assert.equal(isUsableFeeCapture(recorded(35*60_000),validLease,now,"v4_versioned"),true);
 assert.equal(isUsableFeeCapture(recorded(54*60_000),validLease,now,"v4_versioned"),true);
 assert.equal(isUsableFeeCapture(recorded(55*60_000),validLease,now,"v4_versioned"),false);
 assert.equal(isUsableFeeCapture(recorded(-1000),lease,now,"v4_versioned"),false);
 assert.equal(isUsableFeeCapture(recorded(30*60_000),recorded(1),now,"v4_versioned"),false);
});

test("issuer GET and verified replay are clearly attributed without asserting a new capture",()=>{
 const original=feeProvenanceHeaders("v4_versioned","edge_issuer_get");
 const reused=feeProvenanceHeaders("v4_versioned","immutable_verified_storage");
 assert.equal(original["x-strata-fee-response-origin"],"edge_issuer_get");
 assert.equal(reused["x-strata-fee-response-origin"],"immutable_verified_storage");
 assert.equal(original["x-strata-fee-document-lease-policy"],V4_VERSIONED_FEE_LEASE_POLICY);
 assert.equal(reused["x-strata-fee-document-lease-policy"],V4_VERSIONED_FEE_LEASE_POLICY);
 assert.equal("x-strata-captured-at" in reused,false,
   "provenance helper cannot fabricate or refresh a capture timestamp");
 assert.equal("x-strata-fee-document-lease-policy" in
   feeProvenanceHeaders("v4_strict","edge_issuer_get"),false,
   "strict V4 never claims to use the versioned 55-minute policy");
});
