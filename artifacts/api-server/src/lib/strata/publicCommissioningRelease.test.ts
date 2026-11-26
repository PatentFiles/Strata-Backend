import test from "node:test";
import assert from "node:assert/strict";
import {parsePublicReleaseConsent,REVIEW_PUBLIC_RELEASE,CONFIRM_PUBLIC_RELEASE} from "./publicCommissioningRelease";
const owner="11111111-1111-4111-8111-111111111111";
const review={expectedOwnerId:owner,confirmation:REVIEW_PUBLIC_RELEASE};
test("release review is owner-scoped; a confirm requires an exact server review digest",()=>{
 assert.equal(parsePublicReleaseConsent(owner,review)?.preview,true);
 assert.equal(parsePublicReleaseConsent("22222222-2222-4222-8222-222222222222",review),null);
 assert.equal(parsePublicReleaseConsent(owner,{...review,confirmation:CONFIRM_PUBLIC_RELEASE}),null);
 assert.equal(parsePublicReleaseConsent(owner,{...review,confirmation:CONFIRM_PUBLIC_RELEASE,scopeDigest:"a".repeat(64)})?.preview,false);
 for(const extra of [{accountId:"other"},{start:true},{role:"ADMIN"},{feeDigest:"a".repeat(64)},{scopeDigest:"a".repeat(64)}])
  assert.equal(parsePublicReleaseConsent(owner,{...review,...extra}),null);
});
