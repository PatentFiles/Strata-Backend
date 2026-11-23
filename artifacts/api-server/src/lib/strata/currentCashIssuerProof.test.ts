import assert from 'node:assert/strict';
import test from 'node:test';
import {generateKeyPairSync,sign} from 'node:crypto';
import {verifyCurrentCashIssuerProof} from './currentCashIssuerProof';
import {observeCurrentCashIssuerRecord} from './currentCashIssuerObservation';
const a=generateKeyPairSync('ed25519'),b=generateKeyPairSync('ed25519'),d=(x:string)=>x.repeat(64);
const c={accountScopeDigest:d('a'),buildSha:'b'.repeat(40),nonce:d('c'),stopRevisionDigest:d('d'),issuedAtMs:1000,settlementId:'settlement:fixture',settlementDigest:d('e')};
const pin={issuerKeyId:'issuer-fixture',publicKey:a.publicKey,accountScopeDigest:c.accountScopeDigest,buildSha:c.buildSha,notBeforeMs:100,expiresAtMs:9000};
const p={issuerKeyId:pin.issuerKeyId,accountScopeDigest:c.accountScopeDigest,buildSha:c.buildSha,nonce:c.nonce,stopRevisionDigest:c.stopRevisionDigest,
 issuedAtMs:c.issuedAtMs,observedAtMs:1010,expiresAtMs:6000,subaccount:1,exchangeIndex:2,
 coverage:'complete_all_current_pending_cash_and_exact_posted_settlement',pendingCashItems:0,settlementId:c.settlementId,settlementStatus:'posted',settlementPostedAtMs:900,settlementDigest:c.settlementDigest};
function envelope(q= p,key=a.privateKey){
 const bytes=Buffer.from(JSON.stringify(['STRATA_CURRENT_PENDING_CASH_AND_POSTED_SETTLEMENT_V1',q.issuerKeyId,q.accountScopeDigest,q.buildSha,q.nonce,q.stopRevisionDigest,
  q.issuedAtMs,q.observedAtMs,q.expiresAtMs,q.subaccount,q.exchangeIndex,q.coverage,q.pendingCashItems,q.settlementId,q.settlementStatus,q.settlementPostedAtMs,q.settlementDigest]));
 return {payload:q,signature:sign(null,bytes,key).toString('base64url')};
}
test('exact admitted proof distinguishes verified nonzero from zero without history or clearance',()=>{
 for(const pendingCashItems of [0,2]){
  const r=verifyCurrentCashIssuerProof(envelope({...p,pendingCashItems}),c,[pin],1100);
  assert.ok(r.ok);assert.equal(r.pendingCashItems,pendingCashItems);assert.equal(r.settlementPosted,true);
  assert.equal(r.historicalCoverageVerified,false);assert.equal(r.authenticatedExchangeFlat,false);assert.equal(r.holdCleared,false);assert.equal(r.tradingAuthorized,false);
 }
});
test('wrong scope, challenge, build, revision, settlement and inadequate coverage refuse even when signed',()=>{
 for(const q of [{...p,nonce:d('f')},{...p,stopRevisionDigest:d('f')},{...p,accountScopeDigest:d('f')},
  {...p,buildSha:'f'.repeat(40)},{...p,exchangeIndex:1},{...p,subaccount:2},{...p,settlementStatus:'pending'},{...p,settlementPostedAtMs:0},{...p,settlementPostedAtMs:1011},
  {...p,settlementDigest:d('f')},{...p,coverage:'partial'},{...p,pendingCashItems:-1}])
  assert.equal(verifyCurrentCashIssuerProof(envelope(q),c,[pin],1100).ok,false);
});
test('missing, untrusted, ambiguous or expired pins and forged payload refuse',()=>{
 const good=envelope();
 assert.equal(verifyCurrentCashIssuerProof(good,c,[],1100).ok,false);
 assert.equal(verifyCurrentCashIssuerProof(good,c,[pin,pin],1100).ok,false);
 assert.equal(verifyCurrentCashIssuerProof(good,c,[{...pin,expiresAtMs:5999}],1100).ok,false);
 assert.equal(verifyCurrentCashIssuerProof(envelope(p,b.privateKey),c,[pin],1100).ok,false);
 assert.equal(verifyCurrentCashIssuerProof({...good,payload:{...p,pendingCashItems:1}},c,[pin],1100).ok,false);
 assert.equal(verifyCurrentCashIssuerProof({...good,publicKey:a.publicKey},c,[pin],1100).ok,false);
});
test('future, stale and expiry extensions refuse; next nonce invalidates old packet',()=>{
 for(const [q,now] of [[p,1009],[p,6000],[{...p,expiresAtMs:6001},1100]] as const)
  assert.equal(verifyCurrentCashIssuerProof(envelope(q),c,[pin],now).ok,false);
 assert.equal(verifyCurrentCashIssuerProof(envelope(),{...c,nonce:d('f')},[pin],1100).ok,false);
});
test('stopped assembly requires a configured source, rejects STOP change, and keeps nonces single-use',async()=>{
 const scope={accountScopeDigest:c.accountScopeDigest,buildSha:c.buildSha,stopRevisionDigest:c.stopRevisionDigest,
  settlementId:c.settlementId,settlementDigest:c.settlementDigest};
 const ports={readStoppedScope:async()=>scope,trustPins:()=>[pin],now:()=>1000};
 const reason=(value:Awaited<ReturnType<typeof observeCurrentCashIssuerRecord>>)=>{
  assert.ok(!value.ok);return value.reason;
 };
 assert.equal(reason(await observeCurrentCashIssuerRecord(ports)),'issuer_source_unconfigured');
 let n=0; let packet:ReturnType<typeof envelope>|undefined;
 const fetchRecord:NonNullable<Parameters<typeof observeCurrentCashIssuerRecord>[0]['fetchRecord']>=async challenge=>{
  n++;
  packet??=envelope({...p,nonce:challenge.nonce,observedAtMs:1000});
  return packet;
 };
 assert.equal((await observeCurrentCashIssuerRecord({...ports,fetchRecord})).ok,true);
 assert.equal(reason(await observeCurrentCashIssuerRecord({...ports,fetchRecord})),'challenge_mismatch');
 assert.equal(n,2);
 let reads=0;
 assert.equal(reason(await observeCurrentCashIssuerRecord({...ports,fetchRecord,readStoppedScope:async()=>reads++===0
  ?scope:{...scope,stopRevisionDigest:d('f')}})),'stopped_scope_changed');
});
