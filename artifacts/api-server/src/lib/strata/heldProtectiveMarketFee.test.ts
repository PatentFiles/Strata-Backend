import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PDF_FREE_API_RATE_REVIEW_DECISION_SHA256} from './apiFeeRateReference';
import {readHeldProtectiveMarketFee} from './heldProtectiveMarketFee';
import {API_SOURCE_POLICY_VERSION,API_SOURCE_FORMULA_VERSION} from './apiFeeSourceStage';
const input={ownerId:'owner',accountId:'account',market:'KXBTC15M-TEST',
 sourceUrl:'strata-api-reviewed://kxbtc15m/12345678-1234-1234-1234-123456789abc',
 policyVersion:API_SOURCE_POLICY_VERSION,formulaVersion:API_SOURCE_FORMULA_VERSION,digest:'a'.repeat(64)};
const proof={ok:true,reason:'verified',monetaryFeeAuthorized:true,marketTicker:input.market,
 sourceDigest:PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,verifiedAt:'2026-11-09T13:00:00.000Z',policyApproved:false as const,tradingAuthorized:false as const};
test('held market uses protective evidence without requiring or renewing an entry grant',async()=>{
 let calls=0;const at=await readHeldProtectiveMarketFee(input,{verify:async(o,a,m)=>{
 calls++;assert.deepEqual([o,a,m],[input.ownerId,input.accountId,input.market]);return proof;},fresh:()=>true});
 assert.equal(at,Date.parse(proof.verifiedAt));assert.equal(calls,1);
 assert.notEqual(input.digest,proof.sourceDigest,'commissioned observation and reviewed rate model are distinct identities');
});
for(const [label,change] of Object.entries({refused:{ok:false},unauthorized:{monetaryFeeAuthorized:false},
 wrongMarket:{marketTicker:'KXBTC15M-OTHER'},wrongDigest:{sourceDigest:'b'.repeat(64)},invalidDate:{verifiedAt:'invalid'}})){
 test(`held market rejects ${label}`,async()=>{
 await assert.rejects(readHeldProtectiveMarketFee(input,{verify:async()=>({...proof,...change}),fresh:()=>true}),/evidence_unverified/);
 });
}
test('held market rejects stale proof and unsupported fee model before provider read',async()=>{
 await assert.rejects(readHeldProtectiveMarketFee(input,{verify:async()=>proof,fresh:()=>false}),/evidence_unverified/);
 for(const changed of [{sourceUrl:'https://example.com'},{policyVersion:'wrong'},{formulaVersion:'wrong'},{digest:'malformed'}]){
 await assert.rejects(readHeldProtectiveMarketFee({...input,...changed},{verify:async()=>{throw Error('must_not_read');}}),/source_unsupported/);
 }
});
test('supervisor held fee branch precedes ordinary entry verifier without fallback',()=>{
 const source=readFileSync('src/lib/strata/personalExecutionSupervisor.ts','utf8');
 assert.match(source,/if\(heldRecoveryScope\)\{\s*feeVerifiedAt=await readHeldProtectiveMarketFee[\s\S]*?\}else if\(apiSource\)\{\s*const checked=await verifyReviewedApiFeeSourceStage/);
});

test('actual protective verifier accepts fresh protective model without reading or renewing expired entry observation',async()=>{
 const {verifyReviewedProtectiveExitFee}=await import('./reviewedProtectiveExitFee');
 const at=Date.now(),queries:string[]=[];
 const scoped={...input,ownerId:'11111111-1111-4111-8111-111111111111'};
 const verified=await readHeldProtectiveMarketFee(scoped,{verify:(owner,account,market)=>
  verifyReviewedProtectiveExitFee(owner,account,market,{
   now:()=>at,sha:()=>'a'.repeat(40),
   db:{query:async sql=>{queries.push(sql);return {rows:sql.includes('AS standing_history')?
    [{standing_history:false}]:[{grant_id:'12345678-1234-1234-1234-123456789abc',legacy_valid:true,valid_for_ms:60000}]};}},
   readFee:async market=>({ok:true,marketTicker:market,marketOpen:true,observedAtMs:at,fingerprint:'b'.repeat(64)}),
  })});
 assert.equal(verified,at);assert.equal(queries.length,2);
 for(const sql of queries){assert.doesNotMatch(sql,/\b(INSERT|UPDATE|DELETE)\b/);assert.doesNotMatch(sql,/strata_api_fee_observation_leases/);}
 assert.doesNotMatch(queries[0]!,/g\.expires_at\s*>/);
});

test('owner V3 held risk-reducing exit accepts only fresh actual issuer-backed evidence',async()=>{
 const at=Date.now(),actualDigest='c'.repeat(64),market='KXBTC15M-TEST';
 const v3={ownerId:'11111111-1111-4111-8111-111111111111',
  accountId:'owner-account',market,
  sourceUrl:'strata-owner-fee-v3://kxbtc15m/44444444-4444-4444-8444-444444444444',
  policyVersion:'strata_owner_official_monetary_fee_v3',
  formulaVersion:'standard-quadratic-0.07-v1',digest:actualDigest};
 const result={ok:true as const,reason:'owner_protective_issuer_fee_verified' as const,
  sourceDigest:actualDigest,verifiedAtMs:at,monetaryFeeAuthorized:true as const,
  tradingAuthorized:false as const,ordersSubmitted:false as const,workerStarted:false as const};
 const passed=await readHeldProtectiveMarketFee(v3,{
  verifyV3:async(owner,account,source,ticker)=>{
   assert.deepEqual([owner,account,source,ticker],
    [v3.ownerId,v3.accountId,v3.sourceUrl,v3.market]);return result;
  },clock:()=>at+1000
 });
 assert.equal(passed,at);
 await assert.rejects(readHeldProtectiveMarketFee(v3,{
  verifyV3:async()=>result,clock:()=>at+5000
 }),/current_issuer_unverified/);
 await assert.rejects(readHeldProtectiveMarketFee({...v3,digest:'d'.repeat(64)},{
  verifyV3:async()=>result,clock:()=>at
 }),/current_issuer_unverified/);
 await assert.rejects(readHeldProtectiveMarketFee({...v3,policyVersion:'wrong'},{
  verifyV3:async()=>{throw Error('should_not_call')},clock:()=>at
 }),/policy_identity_invalid/);
});
