import test from "node:test";
import assert from "node:assert/strict";
import {providerRetryDeadline} from "./providerRetryPolicy";
const now=Date.parse("2026-10-25T13:10:00Z");
test("real numeric Retry-After extended without shortening",()=>{
 assert.equal(providerRetryDeadline(" 3600 ",now),new Date(now+3600_000).toISOString());
 assert.equal(providerRetryDeadline("999999999",now),new Date(now+86_400_000).toISOString());
});
test("RFC 7231 IMF-fixdate is respected and bounded",()=>{
 const after=new Date(now+60_000).toUTCString();
 assert.equal(providerRetryDeadline(after,now),new Date(now+60_000).toISOString());
});
test("malformed/expired retry header does not fabricate a retry deadline",()=>{
 for(const raw of ["invalid","-1","","infinity","1h","Fri, 01 Jan 2021 00:00:00 GMT"]){
  assert.equal(providerRetryDeadline(raw,now),null);
 }
 assert.equal(providerRetryDeadline(null,now),null);
});
