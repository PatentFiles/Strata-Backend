import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { INDEPENDENT_OFFICIAL_FEE_SNAPSHOT, officialFeeSnapshotLeaseValid,
 recentPinnedOfficialFeeSnapshot, verifyOfficialFeePdfBytes,
 CANONICAL_FEE_SCHEDULE_URL, establishOfficialFeeDigest } from "./microLiveFeeArtifact";
import { REVIEWED_REFERENCE_PDF_SHA256 } from "./strata/twoSourceFeeEvidence";

test("first-party browser observation is tied to the pre-reviewed exact PDF",async()=>{
 const source=INDEPENDENT_OFFICIAL_FEE_SNAPSHOT;
 assert.equal(source.url,CANONICAL_FEE_SCHEDULE_URL);
 assert.equal(source.sha256,REVIEWED_REFERENCE_PDF_SHA256);
 assert.equal(source.byteLength,281129);
 const time=Date.parse(source.checkedAt);
 assert.equal(officialFeeSnapshotLeaseValid(time-1),false);
 assert.equal(officialFeeSnapshotLeaseValid(time),true);
 assert.equal(officialFeeSnapshotLeaseValid(time+3600000),true);
 assert.equal(officialFeeSnapshotLeaseValid(Date.parse(source.expiresAt)),false);
 assert.equal(officialFeeSnapshotLeaseValid(NaN),false);
});
test("only the complete, fixed-point parsed 12-page PDF may satisfy the limited lease",async()=>{
 const t=Date.parse(INDEPENDENT_OFFICIAL_FEE_SNAPSHOT.checkedAt)+1000;
 const response=await recentPinnedOfficialFeeSnapshot(t);
 assert.ok(response,"pinned audited bytes must be present in repository or compiled dist");
 assert.equal(response.status,200);
 assert.equal(response.headers.get("x-strata-fee-evidence"),"independently-checked-bounded-provider-snapshot");
 assert.equal(response.headers.get("x-strata-snapshot-expires"),INDEPENDENT_OFFICIAL_FEE_SNAPSHOT.expiresAt);
 const bytes=Buffer.from(await response.arrayBuffer());
 assert.equal(bytes.length,INDEPENDENT_OFFICIAL_FEE_SNAPSHOT.byteLength);
 assert.equal(createHash("sha256").update(bytes).digest("hex"),INDEPENDENT_OFFICIAL_FEE_SNAPSHOT.sha256);
 const proven=await verifyOfficialFeePdfBytes(bytes);
 assert.equal(proven.ok,true);
 if(proven.ok) assert.equal(proven.effectiveDate,"2026-07-07");
});
test("expired source observation does not create fee-authorizing PDF bytes",async()=>{
 const expiry=Date.parse(INDEPENDENT_OFFICIAL_FEE_SNAPSHOT.expiresAt);
 assert.equal(await recentPinnedOfficialFeeSnapshot(expiry),null);
 assert.equal(await recentPinnedOfficialFeeSnapshot(expiry+86400000),null);
});
test("production transport refuses the bundled snapshot as fresh fee authority",async()=>{
 const savedNow=Date.now;
 const savedJwt=process.env.STRATA_FEE_BRIDGE_ANON_JWT;
 try{
  Date.now=()=>Date.parse(INDEPENDENT_OFFICIAL_FEE_SNAPSHOT.checkedAt)+120000;
  // No issuer-authenticated Edge read can occur with this intentionally
  // invalid bridge key. A historical, hash-valid PDF must not grant fees.
  process.env.STRATA_FEE_BRIDGE_ANON_JWT="";
  const proof=await establishOfficialFeeDigest();
  assert.equal(proof.ok,false);
  if(!proof.ok)assert.equal(proof.reason,"official_fee_schedule_unavailable");
  assert.equal("digest" in proof,false);
 }finally{
  Date.now=savedNow;
  if(savedJwt===undefined)delete process.env.STRATA_FEE_BRIDGE_ANON_JWT;
  else process.env.STRATA_FEE_BRIDGE_ANON_JWT=savedJwt;
 }
});
test("after expiry real digest entry refuses an unavailable canonical provider",async()=>{
 const savedFetch=globalThis.fetch,savedNow=Date.now;
 try{
  Date.now=()=>Date.parse(INDEPENDENT_OFFICIAL_FEE_SNAPSHOT.expiresAt)+1;
  globalThis.fetch=(async()=>new Response(null,{status:429})) as typeof fetch;
  const proof=await establishOfficialFeeDigest();
  assert.equal(proof.ok,false);
  if(!proof.ok)assert.equal(proof.reason,"official_fee_schedule_http_429");
 }finally{globalThis.fetch=savedFetch;Date.now=savedNow;}
});

test("mocked fetch never inherits first-party snapshot authorization",async()=>{
 const original=globalThis.fetch,savedNow=Date.now;
 let calls=0;
 try{
  Date.now=()=>Date.parse(INDEPENDENT_OFFICIAL_FEE_SNAPSHOT.checkedAt)+120000;
  globalThis.fetch=(async()=>{calls++;return new Response(null,{status:429});}) as typeof fetch;
  const proof=await establishOfficialFeeDigest();
  assert.equal(proof.ok,false);
  if(!proof.ok)assert.equal(proof.reason,"official_fee_schedule_http_429");
  assert.equal(calls,1);
 }finally{globalThis.fetch=original;Date.now=savedNow;}
});
