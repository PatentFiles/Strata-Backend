import test from 'node:test';
import assert from 'node:assert/strict';
import {bookAfterDelta} from './book.mjs';
const snapshot={yes_dollars_fp:[['0.4800','2.50'],['0.4400','4']],no_dollars_fp:[['0.4900','6.25'],['0.4500','3']]};
const delta={side:'no',price_dollars:'0.4900',delta_fp:'-1.25'};
test('derives same-sequence literal bids and reciprocal asks, retaining fractional size',()=>{
 const {yes,no}=bookAfterDelta(snapshot,delta);
 assert.deepEqual(yes,{entryAskLevels:[[5100,500],[5500,300]],exitBidLevels:[[4800,250],[4400,400]]});
 assert.deepEqual(no,{entryAskLevels:[[5200,250],[5600,400]],exitBidLevels:[[4900,500],[4500,300]]});
});
test('zero levels disappear and empty liquidity stays empty',()=>{
 const s={yes_dollars_fp:[],no_dollars_fp:[['0.4900','6.25']]};
 assert.deepEqual(bookAfterDelta(s,{...delta,delta_fp:'-6.25'}).yes,{entryAskLevels:[],exitBidLevels:[]});
});
test('rejects negative depth, wrong side, invalid precision/range and crossed changes',()=>{
 for (const d of [{delta_fp:'-6.26'},{side:'NO'},{delta_fp:'1.001'},{delta_fp:'1\n'},{price_dollars:'0.48999'},
   {price_dollars:'1',delta_fp:'1'},{price_dollars:'0.5300',delta_fp:'1'},{delta_fp:'0'}]) {
   assert.throws(()=>bookAfterDelta(snapshot,{...delta,...d}));
 }
});
test('rejects duplicate levels and a crossed starting picture even when a delta would uncross it',()=>{
 assert.throws(()=>bookAfterDelta({...snapshot,yes_dollars_fp:[['0.48','1'],['0.4800','1']]},delta));
 assert.throws(()=>bookAfterDelta({...snapshot,yes_dollars_fp:[['0.60','1']]},{...delta,delta_fp:'-6.25'}));
});
