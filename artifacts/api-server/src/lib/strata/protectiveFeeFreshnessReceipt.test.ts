import test from 'node:test';
import assert from 'node:assert/strict';
import {isReviewedProtectiveExitFeeFresh,verifyReviewedProtectiveExitFee} from './reviewedProtectiveExitFee';
const owner='11111111-1111-4111-8111-111111111111',grant='22222222-2222-4222-8222-222222222222';
const market='KXBTC15M-26NOV031945-45';
test('private provider freshness receipt preserves inclusive boundary, original timestamp and exact object identity',async t=>{
 let throwClock=false,monotonic=100;const wall=Date.parse('2026-11-03T15:00:00Z');
 t.mock.method(performance,'now',()=>{if(throwClock)throw Error('clock_unavailable');return monotonic;});
 // Freshness must never consult host wall time after receipt creation.
 let wallClock=wall,throwWall=false;
 t.mock.method(Date,'now',()=>{if(throwWall)throw Error('post-proof-wall-clock-is-untrusted');return wallClock;});
 for(const age of [0,1000,3000,-1000]){
  monotonic=100;
  const proof=await verifyReviewedProtectiveExitFee(owner,'account',market,{
   now:()=>wall,sha:()=>'a'.repeat(40),
   db:{query:async sql=>({rows:sql.includes('AS standing_history')?[{standing_history:false}]:[{grant_id:grant,legacy_valid:true,valid_for_ms:60000}]})},
   readFee:async()=>({ok:true,marketTicker:market,marketOpen:true,observedAtMs:wall-age,fingerprint:'c'.repeat(64)}) as never,
  });
  assert.equal(proof.ok,true);assert.equal(proof.verifiedAt,new Date(wall-age).toISOString());assert.equal(Object.isFrozen(proof),true);
  assert.equal(isReviewedProtectiveExitFeeFresh(proof),true);
  wallClock=0;assert.equal(isReviewedProtectiveExitFeeFresh(proof),true);
  throwWall=true;assert.equal(isReviewedProtectiveExitFeeFresh(proof),true);throwWall=false;wallClock=wall;
  throwClock=true;assert.equal(isReviewedProtectiveExitFeeFresh(proof),false);throwClock=false;
  assert.equal(isReviewedProtectiveExitFeeFresh({...proof}),false);
  for(const mutation of [{verifiedAt:new Date(wall).toISOString()},{marketTicker:'OTHER'},{authorityFingerprint:'d'.repeat(64)},{monetaryFeeAuthorized:false},{ok:false}])
   assert.throws(()=>Object.assign(proof,mutation),TypeError);
  monotonic=100+3000-Math.max(0,age);assert.equal(isReviewedProtectiveExitFeeFresh(proof),true,'inclusive exact existing boundary');
  monotonic+=0.001;assert.equal(isReviewedProtectiveExitFeeFresh(proof),false,'beyond original budget');
  for(const invalid of [99,-1,NaN,Infinity]){monotonic=invalid;assert.equal(isReviewedProtectiveExitFeeFresh(proof),false);}
 }
 for(const forged of [null,{}, {ok:true,verifiedAt:new Date(wall).toISOString()},'proof'])assert.equal(isReviewedProtectiveExitFeeFresh(forged),false);
});
