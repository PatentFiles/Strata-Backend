import test from 'node:test';import assert from 'node:assert/strict';
import {readOwnedKalshiFeeds} from './personalExchangeRead';
test('actual owned reader caps each feed at20 pages, does not checkpoint between scans',async()=>{
 for(let run=0;run<2;run++){
  const calls:Array<[string,string]>=[];let page=0;
  const result=await readOwnedKalshiFeeds({keyId:'synthetic-unused',privateKey:'synthetic-unused'},Date.now(),async(_c,path,query='')=>{
   calls.push([path,query]);if(path.endsWith('/balance'))return {balance_dollars:'25.0000',subaccount:1,exchange_index:2};
   assert.equal(path,'/trade-api/v2/portfolio/orders');return {orders:[],cursor:'page-'+(++page)};
  });
  assert.deepEqual(result,{ok:false,reason:'personal_exchange_history_unreconciled'});assert.equal(calls.length,21);assert.equal(page,20);
  assert.equal(calls[1]![1],'?limit=200&subaccount=1&exchange_index=2');assert.equal(calls[20]![1],'?limit=200&subaccount=1&exchange_index=2&cursor=page-19');
  assert.ok(calls.every(([,q])=>!q.includes('min_ts')));
 }
});
