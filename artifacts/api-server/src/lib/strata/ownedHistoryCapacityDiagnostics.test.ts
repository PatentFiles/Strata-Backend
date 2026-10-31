import test from 'node:test';import assert from 'node:assert/strict';
import {createOwnedHistoryCapacityReporter} from './ownedHistoryCapacityDiagnostics';
test('near cap deduplicates; reaching incomplete cap escalates immediately; no secrets',()=>{
 const rows:Record<string,unknown>[]=[];let now=0;const report=createOwnedHistoryCapacityReporter(v=>rows.push(v),()=>now);
 report('secret','orders',15,3000,true);assert.equal(rows.length,0);
 report('secret','orders',16,3200,true);report('secret','orders',19,3800,true);assert.equal(rows.length,1);
 report('secret','orders',20,4000,true);assert.equal(rows.length,2);assert.equal(rows[1]!.status,'PAGE_CAP_REACHED');
 report('secret','orders',20,4000,true);assert.equal(rows.length,2);
 now=300000;report('secret','orders',20,4000,true);assert.equal(rows.length,3);
 assert.equal(JSON.stringify(rows).includes('secret'),false);
});
test('terminal twentieth page is only capacity warning; feeds/scopes independent and reporter failure harmless',()=>{
 const rows:Record<string,unknown>[]=[];const report=createOwnedHistoryCapacityReporter(v=>rows.push(v),()=>0);
 report('a','orders',20,4000,false);assert.equal(rows[0]!.status,'APPROACHING_PAGE_CAP');
 report('a','fills',16,1,true);report('b','orders',16,1,true);assert.equal(rows.length,3);
 assert.doesNotThrow(()=>createOwnedHistoryCapacityReporter(()=>{throw Error('sink');})('a','orders',16,1,true));
});
test('bounded dedup map evicts oldest scope without suppressing fresh warnings',()=>{
 let emitted=0;const report=createOwnedHistoryCapacityReporter(()=>emitted++,()=>0);
 for(let i=0;i<129;i++)report(String(i),'orders',16,1,true);
 report('0','orders',16,1,true);assert.equal(emitted,130);
});
