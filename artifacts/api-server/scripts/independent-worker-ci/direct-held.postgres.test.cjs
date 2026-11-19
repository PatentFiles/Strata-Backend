'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const {replayDirectHeld}=require('../../src/lib/v13-production/directHeldPgReplay.ts');
const scope={owner:'fixture-member',account:'fixture-account',position:'fixture-held-position',ticker:'KXBTC15M-HELD',
 venue:'held-venue',side:'YES',release:'a'.repeat(40),policy:'b'.repeat(64)};
const strategy={btc_price:89998,target:90000,signed_buffer:-2,velocity:-3,up_offer:.51,down_offer:.51};
const row={id:'native-held',original_scope:scope,raw_strategy:strategy,quantity_hundredths:'137',oldest_ms:'100',observed_ms:'200',closes_ms:'5400',clock_ms:'500'};
const id='native-held';
test('replay contract exact row and original clock; always no-submit',async()=>{
 const fake={query:async(sql,args)=>{
  assert.match(sql,/FOR SHARE OF p,a,o/);assert.doesNotMatch(sql,/forward_test|a\.active|INSERT|DELETE/);
  assert.deepEqual(args,[scope.position,scope.account,scope.owner,scope.ticker,scope.venue,scope.side,scope.policy,id,scope.release]);
  return {rows:[row]};
 }};
 const r=await replayDirectHeld(fake,scope,id,5000);
 assert.equal(r.kind,'READY');assert.equal(r.oldestAtMs,100);assert.equal(r.expiresAtMs,5100);
 assert.equal(r.submissionAuthorized,false);assert.equal(r.quantityHundredths,'137');
 assert.match(r.sourceDigest,/^[a-f0-9]{64}$/);assert.equal(r.sourceDigest,(await replayDirectHeld(fake,scope,id,5000)).sourceDigest);
});
test('noncanonical result, clock overrun, and uncertain query all close',async()=>{
 for(const bad of [{id:'replacement'},{original_scope:{...scope,position:'different-pos'}},{clock_ms:'99'},{clock_ms:'5400'},
  {clock_ms:'5101'},{quantity_hundredths:'0'},{raw_strategy:{...strategy,evaluation_source:'paper'}}]){
  const r=await replayDirectHeld({query:async()=>({rows:[{...row,...bad}]})},scope,id,5000);
  assert.equal(r.kind,'REFUSED');assert.equal(r.submissionAuthorized,false);
 }
 const none=await replayDirectHeld({query:async()=>({rows:[]})},scope,id,5000);
 assert.equal(none.kind,'REFUSED');
 let touched=false;
 assert.equal((await replayDirectHeld({query:async()=>{touched=true;}},scope,id,5001)).kind,'REFUSED');
 assert.equal(touched,false);
 assert.equal((await replayDirectHeld({query:async()=>{throw Error('disconnected');}},scope,id,5000)).kind,'UNKNOWN');
});
test('native immutable exact held source across active rollover; STOP and revoked policy fence',async()=>{
 const {createHeldFixture}=require('./held-pg-fixture.cjs');
 const pg=await createHeldFixture(process.env.FIXTURE_PORT);
 try{
  await pg.initialize(scope,strategy);
  await pg.db.query("UPDATE detached_held.account SET active='KXBTC15M-NEXT' WHERE id=$1",[scope.account]);
  const r=await replayDirectHeld(pg.db,scope,id,5000);assert.equal(r.kind,'READY');assert.equal(r.scope.ticker,'KXBTC15M-HELD');
  const {assembly}=require('./load-replay-worker.cjs');
  const workerScope={ownerId:scope.owner,accountId:scope.account};
  const gate={...workerScope,revision:'1',fence:'1',stop:false,unknown:false,revoked:false,
    positionId:scope.position,heldMarket:scope.ticker,maxAgeMs:5000};
  let reads=0;
  const worker=assembly()(workerScope,{entrySelect:async()=>{throw Error('held path must not scan entries')},
    heldDb:{query:(sql,params)=>{reads++;return pg.db.query(sql,params);}},
    gate:async()=>gate,now:Date.now,heldBinding:async()=>({scope,observationId:id})});
  const result=await worker.tick('KXBTC15M-NEXT');
  assert.equal(result.status,'observed_held_exit');assert.equal(result.submissionAuthorized,false);assert.equal(reads,2);
  const wrong=await replayDirectHeld(pg.db,{...scope,ticker:'KXBTC15M-NEXT'},id,5000);assert.equal(wrong.kind,'REFUSED');
  const missing=await replayDirectHeld(pg.db,scope,'not-exact-observation',5000);assert.equal(missing.kind,'REFUSED');
  await assert.rejects(pg.db.query("UPDATE detached_held.observation SET oldest_at=clock_timestamp() WHERE id=$1",[id]),/immutable/);
  const c=await pg.db.connect(),rival=await pg.db.connect();
  try{
   await c.query('BEGIN');assert.equal((await replayDirectHeld(c,scope,id,5000)).kind,'READY');
   await rival.query("BEGIN; SET LOCAL lock_timeout='60ms'");
   await assert.rejects(rival.query("UPDATE detached_held.account SET stopped=true WHERE id=$1",[scope.account]),e=>e.code==='55P03');
  }finally{await c.query('ROLLBACK');await rival.query('ROLLBACK');c.release();rival.release();}
  await pg.db.query("UPDATE detached_held.account SET stopped=true WHERE id=$1",[scope.account]);
  assert.equal((await replayDirectHeld(pg.db,scope,id,5000)).kind,'REFUSED');
  assert.equal((await worker.tick()).status,'stopped_or_unverified');
  await pg.db.query("UPDATE detached_held.account SET stopped=false,policy=$2 WHERE id=$1",[scope.account,'d'.repeat(64)]);
  assert.equal((await replayDirectHeld(pg.db,scope,id,5000)).kind,'REFUSED');
 }finally{await pg.close();}
});
