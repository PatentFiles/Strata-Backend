import test from "node:test";
import assert from "node:assert/strict";
import {inspectIsolatedIssuerFeeSourceStatus,ISOLATED_ISSUER_SQL} from "./isolatedIssuerFeeSourceStatus";
const now=Date.parse("2026-10-25T12:40:00.000Z");
function inspect(row:Record<string,unknown>,requests:string[]){
 const db={async query(sql:string,args?:unknown[]){
  requests.push(sql);
  assert.equal(args?.[0],"https://kalshi.com/docs/kalshi-fee-schedule.pdf");
  return {rows:[row]};
 }};
 return inspectIsolatedIssuerFeeSourceStatus({db,now:()=>now});
}
test("issuer source lease and PDF capture are read-only and separate from account gates",async()=>{
 const sql:string[]=[];
 const r=await inspect({last_capture_at:null,capture_expiry:null,
  next_allowed_at:new Date(now-30_000)},sql);
 assert.equal(r.ok,true);
 assert.equal(r.captureState,"never_captured");
 assert.equal(r.retryState,"shared_lease_expired");
 assert.equal(r.rateLimitOrigin,"unknown");
 assert.equal(r.issuerRequestAttempted,false);
 assert.equal(r.grantRecorded,false);
 assert.equal(r.tradingAuthorized,false);
 assert.equal(r.ordersSubmitted,false);
 assert.equal(r.currentForV4,false);
 assert.equal(sql.length,1);
 assert.doesNotMatch(sql[0]!,/\\b(?:INSERT|UPDATE|DELETE)\\b/);
 assert.match(ISOLATED_ISSUER_SQL,/strata_official_fee_captures/);
 assert.match(ISOLATED_ISSUER_SQL,/strata_official_fee_capture_throttle/);
 assert.doesNotMatch(ISOLATED_ISSUER_SQL,/owner_user_id|protective|commissioning/);
});
test("active shared lease cannot be described as a provider-origin 429",async()=>{
 const r=await inspect({last_capture_at:null,capture_expiry:null,
  next_allowed_at:new Date(now+600_000)},[]);
 assert.equal(r.ok,true);
 assert.equal(r.retryState,"shared_lease_active");
 assert.equal(r.rateLimitOrigin,"unknown");
});
test("only original issuer-captured PDF within versioned V4 lease is a viable source",async()=>{
 const fresh=await inspect({last_capture_at:new Date(now-35_000),
  capture_expiry:new Date(now+10_000),next_allowed_at:null},[]);
 assert.equal(fresh.currentForV4,true);assert.equal(fresh.captureState,"fresh_capture");
 const original=await inspect({last_capture_at:new Date(now-35*60_000),
  capture_expiry:new Date(now+60_000),next_allowed_at:null},[]);
 assert.equal(original.currentForV4,true);
 assert.equal(original.lastCaptureAt,new Date(now-35*60_000).toISOString());
 assert.equal(original.grantRecorded,false);
 const old=await inspect({last_capture_at:new Date(now-55*60_000),
  capture_expiry:new Date(now+60_000),next_allowed_at:null},[]);
 assert.equal(old.currentForV4,false);assert.equal(old.captureState,"expired_capture");
 const future=await inspect({last_capture_at:new Date(now+1000),
  capture_expiry:new Date(now+600_000),next_allowed_at:null},[]);
 assert.equal(future.currentForV4,false);
});
test("no database access or ambiguous rows fail without grants or provider fetch",async()=>{
 const r=await inspectIsolatedIssuerFeeSourceStatus({
  db:{async query(){throw Error("simulated DB denial")}},now:()=>now});
 assert.equal(r.ok,false);assert.equal(r.issuerRequestAttempted,false);
 const many=await inspectIsolatedIssuerFeeSourceStatus({
  db:{async query(){return {rows:[{},{}]}}},now:()=>now});
 assert.equal(many.ok,false);
});

test("actual provider 429 audit is distinct from a shared lease denial",async()=>{
 const observed=now-10_000;
 const r=await inspect({
  last_capture_at:null,capture_expiry:null,
  next_allowed_at:new Date(now+1_700_000),
  last_provider_http_status:429,last_provider_at:new Date(observed)
 },[]);
 assert.equal(r.ok,true);
 assert.equal(r.captureState,"never_captured");
 assert.equal(r.retryState,"shared_lease_active");
 assert.equal(r.lastProviderHttpStatus,429);
 assert.equal(r.lastProviderAt,new Date(observed).toISOString());
 assert.equal(r.rateLimitOrigin,"unknown");
 assert.equal(r.tradingAuthorized,false);
});
test("missing or malformed provider status is not a fabricated issuer rejection",async()=>{
 const r=await inspect({last_capture_at:null,capture_expiry:null,
  next_allowed_at:new Date(now+1_000),
  last_provider_http_status:null,last_provider_at:null},[]);
 assert.equal(r.lastProviderHttpStatus,null);
 assert.equal(r.lastProviderAt,null);
 assert.equal(r.rateLimitOrigin,"unknown");
});
