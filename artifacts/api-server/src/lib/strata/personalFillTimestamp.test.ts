import test from 'node:test';
import assert from 'node:assert/strict';
import {personalAccountSnapshot,readOwnedKalshiFeeds,type OwnedKalshiRead} from './personalExchangeRead';
import {ProductionLedger,type Account} from '../v13-production/ledger';
import type {Request} from '../v13-production/types';

const NOW=Date.parse('2026-11-08T22:57:18.000Z');
const SECONDS=1_794_178_637;
const request:Request={market:'KXBTC15M-FIXTURE',side:'NO',action:'BUY',contracts:3,
 limitMicros:430_000,timeInForce:'IOC',reduceOnly:false,clientOrderId:'offline-request'};
const identity={subaccount:1 as const,exchangeIndex:2 as const,keyFingerprint:'offline-fixture'};
function feed(timestamp:Record<string,unknown>):OwnedKalshiRead {
 return {ok:true,historicalCoverageComplete:true,observedAtMs:NOW,cashMicros:'23710000',
  orders:[{order_id:'offline-order',client_order_id:request.clientOrderId,ticker:request.market,
   status:'executed',book_side:'ask',side:'no',action:'buy',yes_price_dollars:'0.5700',
   initial_count_fp:'3.00',fill_count_fp:'3.00'}],
  fills:[{trade_id:'offline-fill',order_id:'offline-order',ticker:request.market,count_fp:'3.00',
   yes_price_dollars:'0.5700',no_price_dollars:'0.4300',fee_cost:'0.0100',...timestamp}],
  positions:[{ticker:request.market,position_fp:'-3.00'}],settlements:[]};
}
const failed={ok:false,reason:'personal_exchange_history_unreconciled'};
function map(timestamp:Record<string,unknown>){return personalAccountSnapshot(identity,feed(timestamp),[request]);}
test('valid documented ts-only fill maps Unix seconds to milliseconds',()=>{
 assert.ok(Number.isNaN(Date.parse(String(SECONDS))),'baseline fallback rejects this valid Unix timestamp');
 const snapshot=map({ts:SECONDS});assert.ok('identity' in snapshot);
 if(!('identity' in snapshot))return;
 assert.equal(snapshot.fills[0].occurredAtMs,SECONDS*1000);
 assert.equal(snapshot.observedAtMs,NOW);assert.equal(snapshot.authenticated,true);assert.equal(snapshot.complete,true);
 assert.equal(snapshot.fills[0].quantityHundredths,'300');assert.equal(snapshot.fills[0].grossMicros,'1290000');
 assert.equal(snapshot.fills[0].feeMicros,'10000');assert.equal(snapshot.fills[0].side,'NO');
 assert.deepEqual(snapshot.positions,[{market:request.market,side:'NO',quantityHundredths:'300'}]);
});
test('created_time keeps its original millisecond precision and precedence',()=>{
 const iso='2026-11-08T22:57:17.085Z';
 for(const timestamp of [{created_time:iso},{created_time:iso,ts:SECONDS},{created_time:iso,ts:'invalid'}]){
  const snapshot=map(timestamp);assert.ok('identity' in snapshot);
  if('identity' in snapshot)assert.equal(snapshot.fills[0].occurredAtMs,Date.parse(iso));
 }
});
test('absent, nonnumeric, fractional, negative, unsafe and out-of-range seconds fail closed',()=>{
 for(const ts of [undefined,null,'1794178637','2026-11-08T22:57:17Z',false,{},[],NaN,Infinity,-1,0,SECONDS+.5,
   Number.MAX_SAFE_INTEGER,8_640_000_000_001])assert.deepEqual(map({ts}),failed);
});
test('wrong-type or unparsable present created_time is not rescued by a valid ts',()=>{
 for(const created_time of [undefined,'',null,0,SECONDS,{},[],'invalid'])assert.deepEqual(map({created_time,ts:SECONDS}),failed);
});
test('Unix seconds conversion includes Date maximum but rejects overflow by one second',()=>{
 const snapshot=map({ts:8_640_000_000_000});assert.ok('identity' in snapshot);
 if('identity' in snapshot)assert.equal(snapshot.fills[0].occurredAtMs,8_640_000_000_000_000);
 assert.deepEqual(map({ts:8_640_000_000_001}),failed);
});
test('timestamp support cannot weaken history, binding, amount or fee checks',()=>{
 const mutations=[
  (r:OwnedKalshiRead)=>{r.historicalCoverageComplete=false;},
  (r:OwnedKalshiRead)=>{r.orders=[];},
  (r:OwnedKalshiRead)=>{(r.orders[0] as Record<string,unknown>).initial_count_fp='4.00';},
  (r:OwnedKalshiRead)=>{(r.fills[0] as Record<string,unknown>).ticker='wrong';},
  (r:OwnedKalshiRead)=>{(r.fills[0] as Record<string,unknown>).fee_cost=undefined;},
  (r:OwnedKalshiRead)=>{r.fills.push({...r.fills[0] as Record<string,unknown>});},
 ];
 for(const change of mutations){const read=feed({ts:SECONDS});change(read);assert.deepEqual(personalAccountSnapshot(identity,read,[request]),failed);}
});
test('real seven-feed reader preserves ts-only current and historical fills for mapping',async()=>{
 for(const archived of [false,true]){
  const fixture=feed({ts:SECONDS});const paths:string[]=[];
  const read=await readOwnedKalshiFeeds({keyId:'offline',privateKey:'offline'},NOW,async(_creds,path,query)=>{
   paths.push(path);assert.match(query??'',/subaccount=1&exchange_index=2/);
   if(path.endsWith('/balance'))return {balance_dollars:'23.7100',subaccount:1,exchange_index:2};
   if(path.endsWith('/orders'))return {orders:path.includes('/historical/')===archived?fixture.orders:[],cursor:''};
   if(path.endsWith('/fills'))return {fills:path.includes('/historical/')===archived?fixture.fills:[],cursor:''};
   if(path.endsWith('/positions'))return {market_positions:fixture.positions,cursor:''};
   if(path.endsWith('/settlements'))return {settlements:[],cursor:''};
   throw Error('unexpected signed feed');
  });
  assert.equal(paths.length,7);assert.equal(read.ok,true);if(!read.ok)continue;
  assert.equal(read.historicalCoverageComplete,true);assert.deepEqual(read.fills,fixture.fills);
  const snapshot=personalAccountSnapshot(identity,read,[request]);assert.ok('identity' in snapshot);
  if('identity' in snapshot)assert.equal(snapshot.fills[0].occurredAtMs,SECONDS*1000);
 }
});
test('incident-shaped ts-only fill preserves improved NO execution, five-cent fee and losing settlement',()=>{
 // Synthetic regression only: the incident's signed provider rows and exact
 // commissioned-account binding have not been obtained.
 const read=feed({ts:SECONDS});read.cashMicros='23720000';
 Object.assign(read.fills[0] as Record<string,unknown>,{
  yes_price_dollars:'0.5900',no_price_dollars:'0.4100',fee_cost:'0.0500',
 });
 const held=personalAccountSnapshot(identity,read,[request]);assert.ok('identity' in held);
 if(!('identity' in held))return;
 assert.equal(held.orders[0].request.limitMicros,430000);
 assert.equal(held.fills[0].priceMicros,410000);assert.equal(held.fills[0].grossMicros,'1230000');
 assert.equal(held.fills[0].feeMicros,'50000');assert.equal(held.positions[0].quantityHundredths,'300');
 assert.equal(BigInt(held.fills[0].grossMicros)+BigInt(held.fills[0].feeMicros),1280000n);
 read.positions=[{ticker:request.market,position_fp:'0.00'}];
 read.settlements=[{ticker:request.market,yes_count_fp:'0.00',no_count_fp:'3.00',
  market_result:'yes',revenue:0,settled_time:new Date(NOW).toISOString()}];
 const settled=personalAccountSnapshot(identity,read,[request]);assert.ok('identity' in settled);
 if(!('identity' in settled))return;
 assert.deepEqual(settled.positions,[]);assert.equal(settled.settlements[0].payoutMicros,'0');
 assert.equal(settled.settlements[0].side,'NO');assert.equal(settled.settlements[0].result,'YES');
 assert.equal(settled.settlements[0].quantityHundredths,'300');assert.equal(settled.cashMicros,'23720000');
});
test('ts-only protective SELL preserves reduce-only binding and original observation clock',()=>{
 const exit={...request,action:'SELL' as const,reduceOnly:true};const read=feed({ts:SECONDS});
 Object.assign(read.orders[0] as Record<string,unknown>,{book_side:'bid',action:'sell'});
 Object.assign(read.fills[0] as Record<string,unknown>,{yes_price_dollars:'0.5500',no_price_dollars:'0.4500'});
 const mapped=personalAccountSnapshot(identity,read,[exit]);assert.ok('identity' in mapped);
 if(!('identity' in mapped))return;
 assert.equal(mapped.orders[0].request.reduceOnly,true);assert.equal(mapped.fills[0].action,'SELL');
 assert.equal(mapped.fills[0].priceMicros,450000);assert.equal(mapped.fills[0].occurredAtMs,SECONDS*1000);
 assert.equal(mapped.observedAtMs,NOW);
 Object.assign(read.orders[0] as Record<string,unknown>,{reduce_only:false});
 assert.deepEqual(personalAccountSnapshot(identity,read,[exit]),failed);
});
test('milliseconds are not guessed: converted future fill is rejected by actual ledger before writes',async()=>{
 const snapshot=map({ts:SECONDS*1000});assert.ok('identity' in snapshot);if(!('identity' in snapshot))return;
 assert.equal(snapshot.fills[0].occurredAtMs,SECONDS*1_000_000);
 const account={id:'offline-account',revision:'1',subaccount:'1',exchange_index:'2',key_fingerprint:identity.keyFingerprint,
  cash_micros:'25000000',initial_cash_micros:'25000000',reserved_micros:'6000000'} as Account;
 const intent={id:'offline-intent',account_id:account.id,client_order_id:request.clientOrderId,request,
  market:request.market,side:request.side,kind:'ENTRY',state:'UNKNOWN',exchange_order_id:null,
  terminal:false,reserved_micros:'6000000',filled_hundredths:'0',created_at:new Date(NOW-1000)};
 const queries:string[]=[];let frozen=false;
 const tx={async query(sql:string){
  queries.push(sql);
  if(sql.startsWith('BEGIN; SELECT'))return [{command:'BEGIN',rows:[]},{command:'SELECT',rows:[account]}];
  if(sql.includes('FROM v13_production_intent'))return {rows:[intent]};
  if(sql.startsWith('SELECT digest FROM v13_production_event')||sql==='ROLLBACK')return {rows:[]};
  throw Error('unexpected SQL before time validation');
 },release(){}};
 class Ledger extends ProductionLedger{override async freeze(){frozen=true;}}
 const ledger=new Ledger({connect:async()=>tx} as never,account.id);
 await assert.rejects(ledger.reconcile(snapshot,'1',NOW),/production_fill_precision_or_time_invalid/);
 assert.equal(frozen,true);assert.equal(queries.at(-1),'ROLLBACK');
 assert.equal(queries.some(sql=>/^(INSERT|UPDATE|DELETE|COMMIT)/.test(sql)),false);
});
