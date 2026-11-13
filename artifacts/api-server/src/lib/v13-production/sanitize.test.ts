import test from "node:test";
import assert from "node:assert/strict";
import {sanitizePublic} from "./sanitize";

test("Postgres timestamp dates survive safe release response serialization as ISO8601",()=>{
 const expiry=new Date("2026-10-20T15:53:19.272Z");
 const response=sanitizePublic({
  ok:true,ownerId:"owner",qualificationId:"qual",
  qualificationExpiresAt:expiry,
  releaseExpiresAt:expiry,
  nested:{expiresAt:expiry},
  api_key:"do-not-expose",
  private_key:"-----BEGIN PRIVATE KEY-----\nsecret",
 });
 assert.equal(response.qualificationExpiresAt,expiry.toISOString());
 assert.equal(response.releaseExpiresAt,expiry.toISOString());
 assert.equal(response.nested.expiresAt,expiry.toISOString());
 assert.equal("api_key" in response,false);
 assert.equal("private_key" in response,false);
 assert.equal(Date.parse(response.qualificationExpiresAt),expiry.getTime());
});
test("Invalid date cannot yield a valid release expiry",()=>{
 assert.equal(sanitizePublic({qualificationExpiresAt:new Date(NaN)}).qualificationExpiresAt,null);
});
