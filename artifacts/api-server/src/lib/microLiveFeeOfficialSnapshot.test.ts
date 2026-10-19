import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { INDEPENDENT_OFFICIAL_FEE_SNAPSHOT, officialFeeSnapshotLeaseValid,
 recentPinnedOfficialFeeSnapshot, verifyOfficialFeePdfBytes,
 CANONICAL_FEE_SCHEDULE_URL } from "./microLiveFeeArtifact";
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