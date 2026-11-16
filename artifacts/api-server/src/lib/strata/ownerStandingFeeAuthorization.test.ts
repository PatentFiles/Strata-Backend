import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {verifyOwnerStandingFee,verifyOwnerV3ProtectiveFee,readOwnerV3ProtectiveSource,verifyOwnerV3ProtectiveFeeAuthority,OWNER_STANDING_FEE_CONFIRM} from './ownerStandingFeeAuthorization';
import {verifyMonetaryFeeContract} from './monetaryFeeContract';

const owner='11111111-1111-4111-8111-111111111111';
const other='22222222-2222-4222-8222-222222222222';
const id='33333333-3333-4333-8333-333333333333';
const consentId='44444444-4444-4444-8444-444444444444';
const sha='a'.repeat(40),policy='b'.repeat(64),sourceDigest='c'.repeat(64);
const accountId='strata-account-exact';
const source='strata-owner-fee-v3://kxbtc15m/'+id,market='KXBTC15M-TEST-1';
const current=1763300000000;
const signed=createHash('sha256').update(JSON.stringify({
 kind:'OWNER_STANDING_FEE_V1',owner,account:accountId,sha,policy,id,bytes:sourceDigest,
 confirmation:OWNER_STANDING_FEE_CONFIRM
})).digest('hex');
const observation=(stage:string)=>( {
 ok:true,reason:'provider_monetary_fee_schedule_and_market_verified',stage,
 monetaryFeeAuthorized:true,sourceDigest,marketTicker:market,
 verifiedAt:new Date(current).toISOString(),
 policyApproved:false,tradingAuthorized:false
}) as Awaited<ReturnType<typeof verifyMonetaryFeeContract>>;
const row={
 consent_id:consentId,owner_user_id:owner,execution_account_id:accountId,
 source_authority_id:id,approved_policy_hash:policy,official_source_digest:sourceDigest,
 expires_at:new Date(current+3600000).toISOString(),consent_digest:signed,release_commit_sha:sha
};
function harness(opts:{rows?:Record<string,unknown>[];provider?:boolean;now?:number}={}){
 let calls=0,providerCalls=0;
 const db={query:async()=>{calls++;return {rows:opts.rows??[row]};}};
 const deps={
  db:db as never,sha:()=>sha,enabled:()=>true,clock:()=>opts.now??current,
  verify:(async(stage:string)=>{providerCalls++;return opts.provider===false?{
   ok:false,reason:'issuer_unavailable',stage,monetaryFeeAuthorized:false,
   policyApproved:false,tradingAuthorized:false
  } as Awaited<ReturnType<typeof verifyMonetaryFeeContract>>:observation(stage);}) as typeof verifyMonetaryFeeContract,
 };
 return {deps,get calls(){return calls;},get providerCalls(){return providerCalls;}};
}
test('genuine source SHA, owner policy, immutable consent digest and current issuer evidence all match',async()=>{
 const h=harness();
 const r=await verifyOwnerStandingFee(owner,'ORDER_ENTRY',source,market,h.deps);
 assert.equal(r.ok,true,JSON.stringify(r));
 assert.equal(h.calls,1);assert.equal(h.providerCalls,1);
 if(r.ok){
  assert.equal(r.identity.accountId,accountId);
  assert.equal(r.identity.sourceAuthorityId,id);
  assert.equal(r.identity.sourceDigest,sourceDigest);
  assert.equal(r.identity.sha,sha);
 }
});
test('expired, wrong owner or wrong policy consent cannot authorize new exposure',async()=>{
 for(const changed of [
  {...row,expires_at:new Date(current-5000).toISOString()},
  {...row,owner_user_id:other},
  {...row,approved_policy_hash:'d'.repeat(64)},
  {...row,consent_digest:'e'.repeat(64)}
 ]){
  const h=harness({rows:[changed]});
  const r=await verifyOwnerStandingFee(owner,'ORDER_ENTRY',source,market,h.deps);
  // Real SQL filters wrong owner. The JS integrity check catches other
  // changes even when a hostile mocked DB hands us a row.
  if(changed.owner_user_id===other){
   assert.equal(r.ok,false);
  }else assert.equal(r.ok,false);
 }
});
test('real issuer failure never becomes a standalone fee authorization',async()=>{
 const h=harness({provider:false});
 const r=await verifyOwnerStandingFee(owner,'ORDER_ENTRY',source,market,h.deps);
 assert.equal(r.ok,false);assert.equal(h.providerCalls,1);
});
test('wrong source identity refuses before database and provider',async()=>{
 const h=harness();
 const r=await verifyOwnerStandingFee(owner,'ORDER_ENTRY','fake-source',market,h.deps);
 assert.equal(r.ok,false);assert.equal(h.calls,0);assert.equal(h.providerCalls,0);
});
test('only an authenticated historical V3 source plus fresh provider fee can serve reduce-only exits',async()=>{
 const h=harness({rows:[{source_digest:sourceDigest}]});
 const r=await verifyOwnerV3ProtectiveFee(owner,accountId,source,market,h.deps);
 assert.equal(r.ok,true,JSON.stringify(r));
 const missing=harness({rows:[]});
 assert.equal((await verifyOwnerV3ProtectiveFee(owner,accountId,source,market,missing.deps)).ok,false);
 const issuer=harness({rows:[{source_digest:sourceDigest}],provider:false});
 assert.equal((await verifyOwnerV3ProtectiveFee(owner,accountId,source,market,issuer.deps)).ok,false);
});

test('protective fee mode is selected from approved owner policy, never client input',async()=>{
 const sql:string[]=[];
 const db={query:async(q:string,values?:unknown[])=>{
  sql.push(q);assert.deepEqual(values,[owner,accountId]);
  return {rows:[{fee_policy_version:'strata_owner_official_monetary_fee_v3',
   fee_formula_version:'standard-quadratic-0.07-v1',
   fee_source_url:source,policy_hash:policy}]};
 }};
 const result=await readOwnerV3ProtectiveSource(owner,accountId,db);
 assert.equal(result.mode,'OWNER_V3');
 if(result.mode==='OWNER_V3')assert.equal(result.sourceAuthorityId,id);
 assert.ok(sql.every(q=>q.includes("p.state='APPROVED'")));
 const invalid={query:async()=>({rows:[{fee_policy_version:'strata_owner_official_monetary_fee_v3',
   fee_formula_version:'invalid',fee_source_url:source,policy_hash:policy}]})};
 assert.equal((await readOwnerV3ProtectiveSource(owner,accountId,invalid)).mode,'UNAVAILABLE');
});
test('final reduce-only authority binds immutable original owner, release, approved policy and PDF bytes',async()=>{
 const rows=[{policy_hash:policy,fee_source_url:source,authority_id:id,
  official_source_digest:sourceDigest,attestation_id:consentId}];
 const queries:string[]=[];
 const db={query:async(q:string,params?:unknown[])=>{
  queries.push(q);assert.deepEqual(params?.slice(0,3),[owner,accountId,sha]);
  return {rows};
 }};
 const authority=await verifyOwnerV3ProtectiveFeeAuthority(owner,accountId,sha,db);
 assert.equal(authority.ok,true);
 if(authority.ok){
  assert.match(authority.authorityFingerprint,/^[a-f0-9]{64}$/);
  assert.ok(authority.validForMs<=5000);
 }
 assert.ok(queries[0]?.includes('FOR SHARE OF g,e,a,p'));
 assert.ok(queries[0]?.includes('a.fee_artifact_digest=g.official_source_digest'));
 assert.ok(queries[0]?.includes("p.state='APPROVED'"));
 const missing={query:async()=>({rows:[]})};
 assert.equal((await verifyOwnerV3ProtectiveFeeAuthority(owner,accountId,sha,missing)).ok,false);
});
