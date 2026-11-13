import test from 'node:test';
import assert from 'node:assert/strict';
import {reconciliationObservation} from './reconciliationObservation';
import {digest,type Snapshot} from './types';
const source=():Snapshot=>({identity:{subaccount:1,exchangeIndex:2,keyFingerprint:'private-scope'},observedAtMs:1234,historyFromMs:0,complete:true,authenticated:true,cashExact:true,cashMicros:'25000000',orders:[],fills:[],settlements:[],positions:[],unexplainedCashActivity:false});
test('summary preserves full evidence digest and scope without claiming replayability',()=>{
 const s=source(),before=JSON.stringify(s),r=reconciliationObservation(s);
 assert.equal(r.fullSnapshotDigest,digest(s));assert.equal(r.replayable,false);
 assert.equal(r.observedAtMs,s.observedAtMs);assert.equal(r.identity.exchangeIndex,2);
 assert.equal(JSON.stringify(s),before);assert.equal('orders' in r,false);assert.equal('fills' in r,false);
 assert.equal(JSON.stringify(r).includes('private-scope'),false);
});
test('historical growth does not grow persisted payload and full-state changes remain detectable',()=>{
 const s=source(),empty=reconciliationObservation(s);
 const fill={id:'f',orderId:'o',clientOrderId:'c',market:'M',side:'YES' as const,action:'BUY' as const,quantityHundredths:'1',priceMicros:500000,grossMicros:'5000',feeMicros:'0',occurredAtMs:1};
 s.fills=Array.from({length:4000},(_,i)=>({...fill,id:String(i)}));
 const r=reconciliationObservation(s);
 assert.equal(r.counts.fills,4000);assert.notEqual(r.fullSnapshotDigest,empty.fullSnapshotDigest);
 assert.ok(Buffer.byteLength(JSON.stringify(r))<4096);
 s.fills[0]!.feeMicros='1';assert.notEqual(reconciliationObservation(s).fullSnapshotDigest,r.fullSnapshotDigest);
});
test('current exposure is bounded, omitted explicitly, and independently committed',()=>{
 const s=source();s.positions=Array.from({length:4000},(_,i)=>({market:'M'+i,side:'NO',quantityHundredths:'50'}));
 const r=reconciliationObservation(s);assert.equal(r.exposure.sample.length,8);assert.equal(r.exposure.omittedCount,3992);
 assert.equal(r.counts.nonzeroPositions,4000);assert.equal(r.exposure.digest,digest(s.positions));
 assert.ok(Buffer.byteLength(JSON.stringify(r))<4096);
});
test('maximum-length bounded exposure samples remain compact',()=>{
 const s=source();s.positions=Array.from({length:9},()=>({market:'M'.repeat(128),side:'YES',quantityHundredths:'1'.repeat(32)}));
 assert.ok(Buffer.byteLength(JSON.stringify(reconciliationObservation(s)))<4096);
 s.positions[0]!.market+='X';s.positions[0]!.quantityHundredths+='1';
 const r=reconciliationObservation(s);assert.equal(r.exposure.sample[0]!.market,null);assert.equal(r.exposure.sample[0]!.quantityHundredths,null);
});
