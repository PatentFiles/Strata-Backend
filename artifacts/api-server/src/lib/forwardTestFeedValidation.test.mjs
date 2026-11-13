import test from 'node:test';
import assert from 'node:assert/strict';
import {forwardTestFeedError} from './forwardTestFeedValidation.ts';
const now=new Date('2026-10-30T03:30:02Z');
const btc={price:100000,providerAt:now,receivedAt:now};
const market={ticker:'KXBTC15M-TEST',target:100000,startsAt:new Date(now.getTime()-2000),
 endsAt:new Date(now.getTime()+898000),status:'active',fetchedAt:now,result:null,
 yesAsk:.5,noAsk:.5,yesBid:.49,noBid:.49,yesPrice:.5,noPrice:.5};
test('producer rejection names exact missing field without fabricating a current evaluation',()=>{
 assert.equal(forwardTestFeedError(btc,market,now,false),null);
 for(const target of [null,0,-1,NaN,Infinity])assert.equal(forwardTestFeedError(btc,{...market,target},now,false),'Kalshi exact market strike is missing or invalid');
 assert.equal(forwardTestFeedError(btc,{...market,ticker:'OTHER'},now,false),'Kalshi market ticker is invalid');
 assert.equal(forwardTestFeedError(btc,{...market,endsAt:null},now,false),'Kalshi market end time is missing or invalid');
 assert.equal(forwardTestFeedError(btc,{...market,fetchedAt:new Date(now.getTime()-15001)},now,false),'Kalshi market snapshot is missing or stale');
 assert.equal(forwardTestFeedError(btc,{...market,target:null,endsAt:null},now,false),'Kalshi market end time is missing or invalid','malformed end cannot be classified as retryable strike');
 assert.equal(forwardTestFeedError(btc,{...market,target:null,fetchedAt:new Date(now.getTime()-15001)},now,false),'Kalshi market snapshot is missing or stale','stale snapshot cannot be classified as retryable strike');
});
test('BTC, executable offers, active status and owned-position gates are unchanged',()=>{
 assert.equal(forwardTestFeedError({...btc,price:NaN},market,now,false),'Coinbase BTC feed is missing, malformed, or stale');
 assert.equal(forwardTestFeedError({...btc,providerAt:new Date(now.getTime()-15001)},market,now,false),'Coinbase BTC feed is missing, malformed, or stale');
 for(const changed of [{yesAsk:null},{noAsk:0},{status:'closed'},{startsAt:new Date(now.getTime()+1)},{endsAt:now}])
  assert.equal(forwardTestFeedError(btc,{...market,...changed},now,false),'Kalshi market is closed or a required side offer is missing');
 assert.equal(forwardTestFeedError(btc,{...market,status:'closed'},now,true),"Open paper position's Kalshi market is no longer active without settlement");
 assert.equal(forwardTestFeedError(btc,{...market,yesBid:null},now,true),'Open paper position cannot be marked or exited with a missing executable bid');
 assert.equal(forwardTestFeedError(btc,{...market,status:'settled',result:'yes',endsAt:now,yesBid:null},now,true),null);
});
