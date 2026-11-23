import assert from 'node:assert/strict';
import test from 'node:test';
import {generateKeyPairSync,sign} from 'node:crypto';
import {verifyCurrentObligationsProof,verifyPostedSettlementProof} from './currentCashIssuerProof';
import {observeCurrentCashObligations} from './currentCashIssuerObservation';
const a=generateKeyPairSync('ed25519'),b=generateKeyPairSync('ed25519'),d=(x:string)=>x.repeat(64);
const common={accountScopeDigest:d('a'),buildSha:'b'.repeat(40),nonce:d('c'),stopRevisionDigest:d('d'),issuedAtMs:1000};
const current={...common,currentCutDigest:d('1')};
const incident={...common,settlementId:'settlement:KXBTC15M:2026-11-22T04:01:02.003Z',settlementDigest:d('e')};
const pin={issuerKeyId:'issuer-fixture',publicKey:a.publicKey,accountScopeDigest:common.accountScopeDigest,buildSha:common.buildSha,notBeforeMs:100,expiresAtMs:9000};
const body={issuerKeyId:pin.issuerKeyId,...common,observedAtMs:1010,expiresAtMs:6000,subaccount:1,exchangeIndex:2};
const obligations={...body,coverage:'complete_all_current_pending_cash',currentCutDigest:current.currentCutDigest,pendingCashItems:0};
const settlement={...body,coverage:'exact_posted_settlement',settlementId:incident.settlementId,settlementStatus:'posted',settlementDigest:incident.settlementDigest};
const shared=['issuerKeyId','accountScopeDigest','buildSha','nonce','stopRevisionDigest','issuedAtMs','observedAtMs','expiresAtMs','subaccount','exchangeIndex'];
function envelope(q:Record<string,unknown>,posted=false,key=a.privateKey){
 const fields=[...shared,'coverage',...(posted?['settlementId','settlementStatus','settlementDigest']:['currentCutDigest','pendingCashItems'])];
 const bytes=Buffer.from(JSON.stringify([posted?'STRATA_POSTED_SETTLEMENT_V1':'STRATA_CURRENT_OBLIGATIONS_V1',...fields.map(k=>q[k])]));
 return {payload:q,signature:sign(null,bytes,key).toString('base64url')};
}
test('present proof works without any settlement ID and binds exact cut/pair',()=>{
 for(const pendingCashItems of [0,2]){
  const r=verifyCurrentObligationsProof(envelope({...obligations,pendingCashItems}),current,[pin],1100);
  assert.ok(r.ok);assert.equal(r.pendingCashItems,pendingCashItems);
  assert.equal(r.authenticatedExchangeFlat,false);assert.equal(r.tradingAuthorized,false);
 }
 for(const p of [{...obligations,currentCutDigest:d('2')},{...obligations,subaccount:2},{...obligations,exchangeIndex:1},
  {...obligations,pendingCashItems:-1},{...obligations,coverage:'partial'},{...obligations,settlementId:incident.settlementId}])
  assert.equal(verifyCurrentObligationsProof(envelope(p),current,[pin],1100).ok,false);
});
test('exact posted settlement accepts canonical fractional-second period and grants no obligations credit',()=>{
 const r=verifyPostedSettlementProof(envelope(settlement,true),incident,[pin],1100);
 assert.ok(r.ok);assert.equal(r.settlementPosted,true);assert.equal(Object.hasOwn(r,'pendingCashItems'),false);
 assert.equal(r.historicalCoverageVerified,false);assert.equal(r.holdCleared,false);
 for(const id of [incident.settlementId.replace('.003Z','.004Z'), 'settlement:x/1', 'not-settlement:x']){
  const p={...settlement,settlementId:id};
  assert.equal(verifyPostedSettlementProof(envelope(p,true),incident,[pin],1100).ok,false);
  if(id.includes('/')||id.startsWith('not'))assert.equal(verifyPostedSettlementProof(envelope(p,true),{...incident,settlementId:id},[pin],1100).ok,false);
 }
 assert.equal(verifyPostedSettlementProof(envelope(obligations),incident,[pin],1100).ok,false);
 assert.equal(verifyCurrentObligationsProof(envelope(settlement,true),current,[pin],1100).ok,false);
});
test('both contracts fail closed against tampering, self-signed, stale/replayed nonce, scope and revocation',()=>{
 for(const p of [{...obligations,nonce:d('f')},{...obligations,stopRevisionDigest:d('f')},{...obligations,buildSha:'f'.repeat(40)},
  {...obligations,accountScopeDigest:d('f')},{...obligations,observedAtMs:1101},{...obligations,expiresAtMs:6001}])
  assert.equal(verifyCurrentObligationsProof(envelope(p),current,[pin],1100).ok,false);
 assert.equal(verifyCurrentObligationsProof(envelope(obligations,false,b.privateKey),current,[pin],1100).ok,false);
 assert.equal(verifyCurrentObligationsProof(envelope(obligations),current,[],1100).ok,false);
 assert.equal(verifyCurrentObligationsProof(envelope(obligations),current,[pin,pin],1100).ok,false);
 assert.equal(verifyCurrentObligationsProof(envelope(obligations),current,[pin],6000).ok,false);
 const forged=envelope(obligations);assert.equal(verifyCurrentObligationsProof({...forged,payload:{...obligations,pendingCashItems:1}},current,[pin],1100).ok,false);
 assert.equal(verifyPostedSettlementProof(envelope({...settlement,settlementDigest:d('f')},true),incident,[pin],1100).ok,false);
 assert.equal(verifyPostedSettlementProof(envelope({...settlement,settlementStatus:'pending'},true),incident,[pin],1100).ok,false);
});
test('assembly refuses a changing complete-cut digest even with a signed first cut',async()=>{
 const scope={accountScopeDigest:current.accountScopeDigest,buildSha:current.buildSha,
  stopRevisionDigest:current.stopRevisionDigest,currentCutDigest:current.currentCutDigest};
 let n=0;
 const ret=await observeCurrentCashObligations({now:()=>1000,trustPins:()=>[pin],readStoppedScope:async()=>++n===1?scope:{...scope,currentCutDigest:d('2')},
  fetchRecord:async c=>envelope({...obligations,...c,observedAtMs:1000})});
 assert.equal(ret.ok,false);if(!ret.ok)assert.equal(ret.reason,'stopped_scope_changed');
});
